import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// These component tests execute source in memory: no global build, daemon, native
// tool, descriptor, or network is involved. An unexpected local import is a failure.
const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['cli/agent-client.ts', 'cli/agent.ts', 'protocol/index.ts', 'protocol/agent.ts'].map(file => new URL(file, root).href));
const loaded = new Set();
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Unexpected bridge dependency: ${url}`);
      return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!modules.has(url)) return next(url, context);
    loaded.add(url);
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const { AgentClient } = await import(new URL('cli/agent-client.ts', root));
const { agentMain } = await import(new URL('cli/agent.ts', root));
const { MurmurError } = await import(new URL('protocol/index.ts', root));
const { STATE_HEADER, PROTOCOL_HEADER } = await import(new URL('protocol/agent.ts', root));
hooks.deregister();

const connection = Object.freeze({ protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: '1'.repeat(64),
  launchId: 'launch-one', projectId: 'project-one', sessionId: 'session-one', taskId: 'task-one', agentToken: 'private-agent-secret_'.padEnd(43, 'z') });
const identity = (extra = {}) => ({ role: 'agent', protocolVersion: 1, stateId: connection.stateId, instanceId: 'instance-one',
  launchId: connection.launchId, projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId,
  expiresAt: Date.now() + 120000, ...extra });
const context = () => ({ projectId: connection.projectId, task: { id: connection.taskId, revision: 7 }, tasks: [], decisions: [], alerts: [],
  events: [{ sequence: 9, type: 'task.updated', createdAt: 42 }], nextCursor: 9, truncated: { events: false },
  delivery: { meaning: 'generated_context_event_metadata_only' } });
const environment = (extra = {}) => ({ MURMUR_AGENT_MODE: '1', MURMUR_AGENT_CONNECTION: JSON.stringify(connection),
  MURMUR_HOME: '/not-agent-state', HOME: '/not-agent-home', ...extra });
function response(value, options = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', [STATE_HEADER]: connection.stateId, [PROTOCOL_HEADER]: '1' });
  for (const [key, value] of Object.entries(options.headers ?? {})) { if (value === null) headers.delete(key); else headers.set(key, value); }
  return new Response(options.raw ?? JSON.stringify(value), { status: options.status ?? 200, headers });
}
function fixture(handle, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), method: init.method, body: init.body, headers: new Headers(init.headers),
      redirect: init.redirect, credentials: init.credentials, signal: init.signal };
    calls.push(call);
    return handle ? handle(call, calls.length) : response(call.url.endsWith('/v1/agent/identity') ? identity() : context());
  };
  return { calls, fetch, client: new AgentClient(connection, { fetch, ...options }) };
}
const code = expected => error => error instanceof MurmurError && error.code === expected;
function safeError(error) {
  assert(error instanceof MurmurError);
  assert(!JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(connection.agentToken));
  return true;
}
function installFetch(t, implementation) { t.mock.method(globalThis, 'fetch', implementation); }

test('bridge import graph excludes human client, daemon config, and storage', () => {
  assert.deepEqual(loaded, modules);
  assert.deepEqual(Object.getOwnPropertyNames(AgentClient.prototype).sort(), ['constructor', 'identity', 'context', 'updates', 'intent', 'update', 'checkPlan', 'proposeDecision', 'reserve', 'release', 'submit'].sort());
  const client = new AgentClient(connection, async () => { throw new Error('not called'); });
  assert.equal(client.request, undefined);
  assert.equal(JSON.stringify(client), '{}');
});

test('configuration rejects every missing/unknown field, invalid ID, credential, and foreign origin before transport', () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('must not send'); };
  for (const field of Object.keys(connection)) {
    const invalid = { ...connection }; delete invalid[field];
    assert.throws(() => new AgentClient(invalid, fetch), error => error instanceof MurmurError);
  }
  for (const [field, values] of Object.entries({
    origin: ['http://foreign.invalid:43123', 'https://127.0.0.1:43123', 'http://localhost:43123', 'http://[::1]:43123', 'http://127.0.0.1',
      'http://user:password@127.0.0.1:43123', 'http://127.0.0.1:43123/path', 'http://127.0.0.1:43123/?token=secret',
      'http://127.0.0.1:43123/#secret', 'http://127.0.0.1:43123/a/..', 'http://2130706433:43123', 'http://127.0.0.1:0'],
    protocolVersion: [0, 2, '1'], stateId: ['x'.repeat(64), '1'.repeat(63)], agentToken: ['human-token', 'x'.repeat(44), null],
    launchId: ['../launch', 'launch/name', 'launch?x', ''], projectId: ['../project', ' project'], sessionId: ['session\n'], taskId: ['task#other'],
  })) for (const value of values) assert.throws(() => new AgentClient({ ...connection, [field]: value }, fetch), error => error instanceof MurmurError);
  assert.throws(() => new AgentClient({ ...connection, supervisorToken: 'secret' }, fetch), code('AGENT_CONFIGURATION'));
  assert.equal(calls, 0);
});

test('identity handshake precedes operations and all requests carry only the agent capability and bound headers', async () => {
  const { client, calls } = fixture();
  await Promise.all([client.context(4), client.context(5)]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${connection.origin}/v1/agent/identity`);
  for (const call of calls) {
    assert.equal(call.headers.get('Authorization'), `Bearer ${connection.agentToken}`);
    assert.equal(call.headers.get(STATE_HEADER), connection.stateId);
    assert.equal(call.headers.get(PROTOCOL_HEADER), '1');
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.headers.has('Cookie'), false);
  }
  for (const call of calls.slice(1)) {
    const url = new URL(call.url);
    assert.equal(url.pathname, '/v1/context');
    assert.equal(url.searchParams.get('projectId'), connection.projectId);
    assert.equal(url.searchParams.get('taskId'), connection.taskId);
    assert(['4', '5'].includes(url.searchParams.get('after')));
  }
});

test('human/supervisor identity, changed bindings, unsupported protocol and expiry stop before operations', async () => {
  const variants = [{ role: 'human' }, { role: 'supervisor' }, { protocolVersion: 2 }, { instanceId: '' }, { expiresAt: Date.now() - 1 }, { expiresAt: 'tomorrow' }];
  for (const field of ['stateId', 'launchId', 'projectId', 'sessionId', 'taskId']) variants.push({ [field]: 'another' });
  for (const extra of variants) {
    const { client, calls } = fixture(() => response(identity(extra)));
    await assert.rejects(client.context(), safeError);
    await assert.rejects(client.submit({ revision: 1 }), safeError);
    assert.equal(calls.length, 1, 'failed handshake must not implicitly retry or send the operation');
  }
});

test('explicit identity can observe a restarted instance without changing persistent bindings', async () => {
  let instance = 1;
  const { client, calls } = fixture(call => response(call.url.endsWith('/identity') ? identity({ instanceId: `instance-${instance++}`, agentToken: connection.agentToken }) : context()));
  const first = await client.identity(), second = await client.identity();
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(first.stateId, second.stateId);
  assert(!Object.hasOwn(first, 'agentToken'));
  await client.context();
  assert.equal(calls.length, 3);
});

test('state and protocol response headers are mandatory on handshake, reads, mutations, and failures', async () => {
  for (const [header, expected, wrong] of [[STATE_HEADER, 'AGENT_STATE_MISMATCH', '2'.repeat(64)], [PROTOCOL_HEADER, 'AGENT_PROTOCOL_MISMATCH', '2']]) {
    for (const value of [null, wrong]) {
      const initial = fixture(() => response(identity(), { headers: { [header]: value } }));
      await assert.rejects(initial.client.context(), code(expected));
      assert.equal(initial.calls.length, 1);
      for (const operation of [client => client.context(), client => client.submit({ revision: 7 }, 'stable-key')]) {
        for (const status of [200, 403]) {
          const { client, calls } = fixture((call, count) => count === 1 ? response(identity())
            : response(status === 200 ? {} : { error: { code: 'FORBIDDEN', message: 'denied' } }, { status, headers: { [header]: value } }));
          await assert.rejects(operation(client), code(expected));
          assert.equal(calls.length, 2);
        }
      }
    }
  }
});

test('allowlisted methods bind exactly the required IDs and endpoints', async () => {
  const { client, calls } = fixture();
  const entries = [
    ['intent', { revision: 7, writes: ['src'], produces: [{ key: 'api', version: '1' }] }, '/v1/intents', { taskId: connection.taskId }],
    ['update', { revision: 7, status: 'blocked' }, '/v1/tasks/update', { taskId: connection.taskId }],
    ['checkPlan', { title: 'Candidate only', writes: ['src'] }, '/v1/check-plan', { projectId: connection.projectId, taskId: connection.taskId }],
    ['proposeDecision', { key: 'api', value: 'v1', version: '1', rationale: 'Compatible' }, '/v1/decisions/propose', { projectId: connection.projectId, taskId: connection.taskId }],
    ['reserve', { taskRevision: 7, resources: [{ kind: 'path', value: 'src' }, { kind: 'resource', value: 'api' }], ttlSeconds: 60 }, '/v1/reservations/acquire', { projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId }],
    ['release', { leaseId: 'lease-one', generation: 2 }, '/v1/reservations/release', { sessionId: connection.sessionId }],
    ['submit', { revision: 7 }, '/v1/submissions', { taskId: connection.taskId }],
  ];
  for (const [method, payload, endpoint, ids] of entries) {
    await client[method](payload, 'supplied-key');
    const call = calls.at(-1);
    assert.equal(call.url, `${connection.origin}${endpoint}`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('Idempotency-Key'), 'supplied-key');
    assert.deepEqual(JSON.parse(call.body), { ...payload, ...ids });
    assert.equal(call.headers.get('Content-Type'), 'application/json');
  }
  assert.equal(calls.length, entries.length + 1);
});

test('binding mismatches and unavailable fields/statuses are rejected before even the identity request', async () => {
  const { client, calls } = fixture();
  const entries = [['intent', { revision: 1 }], ['update', { revision: 1, status: 'active' }], ['checkPlan', {}],
    ['proposeDecision', { key: 'key', value: 'value', version: '1', rationale: 'reason' }],
    ['reserve', { taskRevision: 1, resources: [{ kind: 'path', value: 'src' }] }], ['release', { leaseId: 'lease', generation: 1 }], ['submit', { revision: 1 }]];
  for (const [method, payload] of entries) {
    for (const field of ['stateId', 'launchId', 'projectId', 'sessionId', 'taskId']) await assert.rejects(client[method]({ ...payload, [field]: 'different' }), code('AGENT_BINDING_MISMATCH'));
    for (const field of ['admin', 'token', 'operation', 'endpoint', 'handoffSessionId', 'validation', 'accept', 'abandon']) await assert.rejects(client[method]({ ...payload, [field]: true }), code('AGENT_INPUT'));
  }
  for (const status of ['planned', 'abandoned', 'integrated', 'done']) await assert.rejects(client.update({ revision: 1, status }), code('AGENT_INPUT'));
  await assert.rejects(client.update({ revision: 1, status: 'active', title: 'Rename' }), code('AGENT_INPUT'));
  await assert.rejects(client.intent({ revision: 1, produces: [{ key: 'api', version: '1', admin: true }] }), code('AGENT_INPUT'));
  await assert.rejects(client.reserve({ taskRevision: 1, resources: [{ kind: 'path', value: 'src', token: 'secret' }] }), code('AGENT_INPUT'));
  assert.equal(calls.length, 0);
});

test('invalid cursors, revisions, resources, oversized inputs and non-JSON values fail locally', async () => {
  const { client, calls } = fixture();
  for (const after of [-1, 1.5, NaN, Infinity, '7', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(client.context(after), safeError);
  for (const value of [undefined, null, 0, -1, 1.5, '1']) await assert.rejects(client.submit({ revision: value }), safeError);
  await assert.rejects(client.reserve({ taskRevision: 1, resources: [] }), safeError);
  for (const value of ['../secret', '/absolute', 'C:/absolute', 'src\\secret', 'src/*']) await assert.rejects(client.reserve({ taskRevision: 1, resources: [{ kind: 'path', value }] }), code('PATH_ESCAPE'));
  await assert.rejects(client.intent({ revision: 1, produces: Array.from({ length: 32 }, (_, i) => ({ key: `key${i}`, version: '1', value: 'a'.repeat(2048) })) }), code('AGENT_INPUT_TOO_LARGE'));
  const circular = {}; circular.self = circular;
  for (const payload of [null, [], { revision: 1, extra: circular }, { revision: NaN }, { revision: 1n }]) await assert.rejects(client.submit(payload), safeError);
  await assert.rejects(client.submit({ revision: 1 }, 'bad\nkey'), code('AGENT_INPUT'));
  assert.equal(calls.length, 0);
});

test('supplied mutation keys, payload and revisions stay stable, including reordered properties', async () => {
  const { client, calls } = fixture();
  const payload = { revision: 7, produces: [{ key: 'api', version: '1', value: 'v1' }], writes: ['src'] };
  await client.intent(payload, 'replay-key');
  await client.intent({ writes: ['src'], produces: [{ value: 'v1', version: '1', key: 'api' }], revision: 7 }, 'replay-key');
  assert.equal(calls[1].body, calls[2].body);
  assert.equal(calls[1].headers.get('Idempotency-Key'), calls[2].headers.get('Idempotency-Key'));
  assert.deepEqual(payload, { revision: 7, produces: [{ key: 'api', version: '1', value: 'v1' }], writes: ['src'] });
  await client.submit({ revision: 7 });
  assert.match(calls.at(-1).headers.get('Idempotency-Key'), /^[a-f0-9-]{36}$/);
});

test('bindings and mutation payload are snapshotted before an asynchronous identity handshake', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const mutableConnection = { ...connection };
  const client = new AgentClient(mutableConnection, async (url, init) => {
    calls.push({ url, body: init.body, headers: new Headers(init.headers) });
    return calls.length === 1 ? gate : response({ ok: true });
  });
  const payload = { revision: 7, writes: ['src'] };
  const pending = client.intent(payload, 'stable');
  payload.revision = 9; payload.writes[0] = 'other';
  mutableConnection.taskId = 'other'; mutableConnection.origin = 'http://foreign.invalid:1'; mutableConnection.agentToken = 'other';
  finish(response(identity()));
  await pending;
  assert.deepEqual(JSON.parse(calls[1].body), { taskId: connection.taskId, revision: 7, writes: ['src'] });
  assert.equal(calls[1].headers.get('Authorization'), `Bearer ${connection.agentToken}`);
  assert(calls[1].url.startsWith(connection.origin));
});

test('stale revision and idempotency errors are safe structured errors, with no automatic retries', async () => {
  for (const expected of ['STALE_REVISION', 'IDEMPOTENCY_CONFLICT', 'FORBIDDEN']) {
    const { client, calls } = fixture((call, count) => count === 1 ? response(identity()) : response({ error: { code: expected, message: connection.agentToken, details: { token: connection.agentToken } } }, { status: 409 }));
    await assert.rejects(client.submit({ revision: 7 }, 'stable-key'), error => {
      safeError(error); assert.equal(error.code, expected); assert.equal(error.details, undefined);
      if (expected === 'STALE_REVISION') assert.match(error.message, /Refresh context/);
      return true;
    });
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].body).revision, 7);
  }
});

test('redirects, foreign response URLs and unreachable transport never trigger discovery or credential fallback', async () => {
  const redirected = response({}); Object.defineProperty(redirected, 'redirected', { value: true });
  const foreign = response({}); Object.defineProperty(foreign, 'url', { value: 'http://foreign.invalid/' });
  for (const result of [response({}, { status: 302, headers: { Location: 'http://foreign.invalid/' } }), redirected, foreign]) {
    const { client, calls } = fixture(() => result);
    await assert.rejects(client.context(), code('AGENT_REDIRECT'));
    assert.equal(calls.length, 1);
  }
  const { client, calls } = fixture(() => { throw new Error(`connect failed ${connection.agentToken}`); });
  await assert.rejects(client.context(), error => safeError(error) && error.code === 'AGENT_UNAVAILABLE');
  assert.equal(calls.length, 1);
});

test('response content type, JSON encoding, shape, declared size, streaming size and nesting are bounded', async () => {
  const variants = [
    [{ raw: '<html>secret</html>', headers: { 'Content-Type': 'text/html' } }, 'AGENT_RESPONSE_INVALID'],
    [{ raw: '{invalid' }, 'AGENT_RESPONSE_INVALID'], [{ raw: '' }, 'AGENT_RESPONSE_INVALID'],
    [{ raw: 'null' }, 'AGENT_RESPONSE_INVALID'], [{ raw: '[]' }, 'AGENT_RESPONSE_INVALID'],
    [{ raw: new Uint8Array([0xff, 0xfe]) }, 'AGENT_RESPONSE_INVALID'],
    [{ raw: '{}', headers: { 'Content-Length': String(256 * 1024 + 1) } }, 'AGENT_RESPONSE_TOO_LARGE'],
    [{ raw: JSON.stringify({ huge: 'x'.repeat(256 * 1024) }) }, 'AGENT_RESPONSE_TOO_LARGE'],
    [{ raw: `{"nested":${'['.repeat(70)}'x'${']'.repeat(70)}}`.replace("'x'", '"x"') }, 'AGENT_RESPONSE_INVALID'],
    [{ raw: '{"error":{"code":"lowercase","message":"bad"}}', status: 400 }, 'AGENT_RESPONSE_INVALID'],
  ];
  for (const [options, expected] of variants) {
    const { client, calls } = fixture(() => response({}, options));
    await assert.rejects(client.context(), error => safeError(error) && error.code === expected);
    assert.equal(calls.length, 1);
  }
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const { client } = fixture(() => response({}, { raw: stream }));
  await assert.rejects(client.context(), code('AGENT_RESPONSE_TOO_LARGE'));
  assert(cancelled);
});

test('timeouts bound transport and stalled response bodies without exposing secrets', async () => {
  let cancelled = false;
  for (const fetch of [async () => new Promise(() => {}), async () => response({}, { raw: new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
  }) })]) {
    const client = new AgentClient(connection, { fetch, timeoutMs: 15 });
    const started = Date.now();
    await assert.rejects(client.identity(), error => safeError(error) && error.code === 'AGENT_TIMEOUT');
    assert(Date.now() - started < 1000);
  }
  assert(cancelled, 'a stalled body reader must be cancelled on timeout');
});

test('credential-shaped fields and token echoes in successful responses are redacted recursively', async () => {
  const { client } = fixture((call, count) => response(count === 1 ? identity() : {
    message: `value ${connection.agentToken}`, nested: [{ authorization: 'Bearer other-secret', agentToken: connection.agentToken }],
    [connection.agentToken]: 'Bearer opaque-credential',
  }));
  const result = await client.context();
  assert(!JSON.stringify(result).includes(connection.agentToken));
  assert(!JSON.stringify(result).includes('other-secret'));
  assert(!JSON.stringify(result).includes('opaque-credential'));
  assert.match(result.message, /\[REDACTED\]/);
});

test('updates uses scoped context event metadata, never unrestricted events', async () => {
  const { client, calls } = fixture();
  const result = await client.updates(8);
  assert.equal(new URL(calls[1].url).pathname, '/v1/context');
  assert.equal(new URL(calls[1].url).searchParams.get('after'), '8');
  assert.deepEqual(result.events, context().events);
  assert.equal(result.meaning, 'generated_context_event_metadata_only');
  assert.equal(result.taskId, connection.taskId);
});

test('CLI help needs no credentials; missing or partial managed configuration fails without filesystem/transport access', async t => {
  let calls = 0;
  installFetch(t, async () => { calls++; throw new Error('must not send'); });
  for (const env of [{}, { MURMUR_AGENT_MODE: '1' }, { MURMUR_AGENT_CONNECTION: JSON.stringify(connection) },
    { MURMUR_AGENT_MODE: '0', MURMUR_AGENT_CONNECTION: JSON.stringify(connection) }, environment({ MURMUR_AGENT_CONNECTION: '{invalid' }), { MURMUR_AGENT_OTHER: 'partial', MURMUR_HOME: '/fake' }]) {
    assert.match((await agentMain(['--help'], env)).usage, /murmur agent/);
    await assert.rejects(agentMain(['context'], env), error => error instanceof MurmurError);
  }
  assert.equal(calls, 0);
});

test('CLI ignores misleading HOME/MURMUR_HOME and never implicitly reads files', async t => {
  const fake = fixture(); installFetch(t, fake.fetch);
  // Patch the actual builtin behind named imports. Any implicit discovery fails this test.
  const fs = (await import('node:fs/promises')).default;
  for (const name of ['open', 'readFile', 'stat', 'access', 'readdir', 'realpath']) t.mock.method(fs, name, () => { throw new Error(`Unexpected filesystem access: ${name}`); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await agentMain(['context', '--after', '4'], environment({ MURMUR_HOME: '/misleading/human/state', HOME: '/misleading/home' }));
  assert.equal(fake.calls.length, 2);
  assert(fake.calls.every(call => call.url.startsWith(connection.origin)));
  assert(fake.calls.every(call => !call.url.includes('daemon.json')));
});

test('CLI translates supported flags to bound endpoint payloads and passes request IDs through', async t => {
  const fake = fixture(); installFetch(t, fake.fetch);
  const entries = [
    [['intent', '--revision', '7', '--data', '{"writes":["src"]}'], { revision: 7, writes: ['src'], taskId: connection.taskId }],
    [['update', '--revision', '7', '--status', 'ready'], { revision: 7, status: 'ready', taskId: connection.taskId }],
    [['check-plan', '--data', '{"title":"Candidate"}'], { title: 'Candidate', projectId: connection.projectId, taskId: connection.taskId }],
    [['propose-decision', '--key', 'api', '--value', 'v1', '--version', '1', '--rationale', 'Compatible'], { key: 'api', value: 'v1', version: '1', rationale: 'Compatible', projectId: connection.projectId, taskId: connection.taskId }],
    [['reserve', '--revision', '7', '--path', 'src', '--ttl', '60'], { taskRevision: 7, resources: [{ kind: 'path', value: 'src' }], ttlSeconds: 60, projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId }],
    [['release', '--lease', 'lease-one', '--generation', '2'], { leaseId: 'lease-one', generation: 2, sessionId: connection.sessionId }],
    [['submit', '--data', '{"revision":7}'], { revision: 7, taskId: connection.taskId }],
  ];
  for (const [args, expected] of entries) {
    await agentMain([...args, '--request-id', 'explicit-request'], environment());
    assert.deepEqual(JSON.parse(fake.calls.at(-1).body), expected);
    assert.equal(fake.calls.at(-1).headers.get('Idempotency-Key'), 'explicit-request');
  }
  await agentMain(['identity'], environment());
  await agentMain(['updates', '--after', '8'], environment());
  assert.equal(new URL(fake.calls.at(-1).url).searchParams.get('after'), '8');
});

test('CLI rejects administrative commands, binding overrides, ambiguous input, and stale/missing revisions locally', async t => {
  const fake = fixture(); installFetch(t, fake.fetch);
  const args = [
    [], ['task', 'create'], ['session', 'register'], ['accept-decision'], ['promote'], ['validation'], ['daemon', 'stop'], ['abandon'],
    ['context', '--project', 'other'], ['context', '--session', 'other'], ['context', '--task', 'other'], ['context', '--after', '-1'],
    ['submit'], ['update', '--revision', '1', '--status', 'abandoned'], ['update', '--revision', '1', '--title', 'rename'],
    ['submit', '--revision', '1', '--revision', '2'], ['submit', '--revision'], ['submit', '--revision', '1e2'],
    ['submit', '--revision', '2', '--data', '{"revision":1}'], ['submit', '--data', '{}', '--file', 'anything'],
    ['submit', '--data', '[1]'], ['submit', '--data', `{bad ${connection.agentToken}`],
    ['submit', '--data', JSON.stringify({ revision: 7, taskId: 'other' })],
    ['submit', '--data', JSON.stringify({ revision: 7, unused: 'é'.repeat(32768) })],
    ['propose-decision', '--data', '{"key":"api","value":"v1","version":"1","rationale":"why","accept":true}'],
    ['release', '--lease', 'lease-one', '--generation', '1', '--revision', '7'],
  ];
  for (const argv of args) await assert.rejects(agentMain(argv, environment()), safeError);
  assert.equal(fake.calls.length, 0);
});

test('CLI reads only an explicit bounded JSON file and sanitizes file/parse errors', async t => {
  const temporary = await fsPromises.mkdtemp(path.join(tmpdir(), 'murmur-agent-input-'));
  t.after(() => fsPromises.rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'input.json');
  const fake = fixture(); installFetch(t, fake.fetch);
  await fsPromises.writeFile(filename, JSON.stringify({ taskRevision: 7, resources: [{ kind: 'resource', value: 'api' }] }));
  await agentMain(['reserve', '--file', filename, '--request-id', 'file-request'], environment());
  assert.equal(JSON.parse(fake.calls.at(-1).body).taskRevision, 7);
  const before = fake.calls.length;
  await fsPromises.writeFile(filename, 'x'.repeat(65537));
  await assert.rejects(agentMain(['intent', '--file', filename, '--revision', '7'], environment()), code('AGENT_INPUT_TOO_LARGE'));
  await fsPromises.writeFile(filename, `{not json ${connection.agentToken}`);
  await assert.rejects(agentMain(['intent', '--file', filename, '--revision', '7'], environment()), safeError);
  await assert.rejects(agentMain(['intent', '--file', path.join(temporary, connection.agentToken)], environment()), safeError);
  await assert.rejects(agentMain(['intent', '--file', temporary], environment()), code('AGENT_INPUT'));
  assert.equal(fake.calls.length, before);
});

test('CLI rejects foreign connection origins and invalid bound IDs before any request', async t => {
  const fake = fixture(); installFetch(t, fake.fetch);
  for (const invalid of [
    { ...connection, origin: 'http://foreign.invalid:43123' },
    { ...connection, origin: 'http://user:password@127.0.0.1:43123' },
    { ...connection, origin: 'http://127.0.0.1:43123/other' },
    { ...connection, origin: 'http://127.0.0.1:43123/?token=secret' },
    { ...connection, taskId: 'task/other' },
    { ...connection, sessionId: '../session' },
    { ...connection, supervisorToken: connection.agentToken },
  ]) await assert.rejects(agentMain(['context'], environment({ MURMUR_AGENT_CONNECTION: JSON.stringify(invalid) })), safeError);
  assert.equal(fake.calls.length, 0);
});

test('long-lived clients refresh expired identity metadata with the same supervisor-renewed credential', async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let handshakes = 0;
  const { client, calls } = fixture(call => {
    if (call.url.endsWith('/v1/agent/identity')) return response(identity({ expiresAt: clock + (++handshakes === 1 ? 10 : 120000) }));
    return response(context());
  });
  await client.identity();
  clock += 20;
  await Promise.all([client.context(), client.context(4)]);
  assert.equal(handshakes, 2, 'concurrent operations must share the same identity refresh');
  assert.equal(calls.length, 4);
  assert(calls.every(call => call.headers.get('Authorization') === `Bearer ${connection.agentToken}`));
  assert(calls.every(call => new URL(call.url).pathname === '/v1/agent/identity' || new URL(call.url).pathname === '/v1/context'));
});
