import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['cli/external-client.ts', 'cli/external.ts', 'protocol/index.ts', 'protocol/agent.ts', 'protocol/external.ts'].map(file => new URL(file, root).href));
const loaded = new Set();
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Forbidden external client dependency: ${url}`);
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
const { ExternalClient, EnrollmentClient, snapshotExternalJson } = await import(new URL('cli/external-client.ts', root));
const { externalMain } = await import(new URL('cli/external.ts', root));
const { MurmurError } = await import(new URL('protocol/index.ts', root));
hooks.deregister();
const capability = randomBytes(32).toString('base64url'), pollSecret = randomBytes(32).toString('base64url');
const descriptor = { protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: 'a'.repeat(64), instanceId: 'instance-one' };
const expiresAt = Date.now() + 120_000;
const connection = { protocolVersion: 1, origin: descriptor.origin, stateId: descriptor.stateId, grantId: 'grant-one', projectId: 'project-one',
  sessionId: 'session-one', taskId: 'task-one', memberId: 'member-one', groupId: 'group-one', workspaceRoot: '/fixture/workspace', expiresAt, capability };
const identity = (patch = {}) => ({ role: 'external', protocolVersion: 1, stateId: descriptor.stateId, instanceId: 'instance-one',
  grantId: connection.grantId, projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId,
  memberId: connection.memberId, groupId: connection.groupId, workspaceRoot: connection.workspaceRoot, expiresAt, membershipRevision: 2, ...patch });
const digest = value => createHash('sha256').update(value).digest('hex');
const enrollment = (patch = {}) => ({ capabilityHash: digest(capability), pollSecretHash: digest(pollSecret), workspaceRoot: connection.workspaceRoot,
  native: { tool: 'claude', nativeId: 'native-one', incarnationId: 'incarnation-one' }, groupTitle: 'Reset API', responsibility: 'Implement endpoints', ...patch });
const receipt = (patch = {}) => ({ requestId: 'request-one', state: 'pending', revision: 1, expiresAt: Date.now() + 60_000, decidedAt: null, ...patch });
function response(value, options = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Murmur-State-Id': descriptor.stateId, 'X-Murmur-Protocol-Version': '1' });
  for (const [name, value] of Object.entries(options.headers ?? {})) if (value === null) headers.delete(name); else headers.set(name, value);
  return new Response(options.raw ?? JSON.stringify(value), { status: options.status ?? 200, headers });
}
function fixture(handle, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), ...init, headers: new Headers(init.headers) };
    calls.push(call);
    return handle ? handle(call, calls.length) : response(call.url.endsWith('/identity') ? identity() : { ok: true });
  };
  return { calls, fetch, client: new ExternalClient(connection, { fetch, ...options }) };
}
const code = expected => error => error instanceof MurmurError && error.code === expected;
function safeError(error) {
  assert(error instanceof MurmurError);
  const printed = JSON.stringify({ ...error, message: error.message, stack: error.stack });
  assert(!printed.includes(capability)); assert(!printed.includes(pollSecret));
  return true;
}
const env = patch => ({ MURMUR_EXTERNAL_MODE: '1', MURMUR_EXTERNAL_CONNECTION: JSON.stringify(connection), HOME: '/must-not-read', MURMUR_HOME: '/must-not-read', ...patch });

test('external import graph excludes human clients, descriptors, storage, and native execution', () => {
  assert.deepEqual(loaded, modules);
  const client = new ExternalClient(connection);
  assert.equal(client.request, undefined); assert.equal(client.connection, undefined); assert.equal(JSON.stringify(client), '{}');
  assert.equal(JSON.stringify(new EnrollmentClient(descriptor)), '{}');
  for (const name of ['submit', 'register', 'renew', 'updates', 'handoff', 'events', 'run']) assert.equal(client[name], undefined);
});

test('immutable configuration rejects missing fields, URL normalization, mixed capabilities, and getters', () => {
  let called = 0;
  const fetch = async () => { called++; throw new Error('must not run'); };
  for (const field of Object.keys(connection)) { const bad = { ...connection }; delete bad[field]; assert.throws(() => new ExternalClient(bad, fetch), safeError); }
  for (const origin of ['https://127.0.0.1:1', 'http://localhost:1', 'http://127.1:1', 'http://127.0.0.1:0', 'http://127.0.0.1:43123/', 'http://x:y@127.0.0.1:43123', 'http://127.0.0.1:43123/path']) {
    assert.throws(() => new ExternalClient({ ...connection, origin }, fetch), safeError);
  }
  for (const bad of [{ ...connection, launchId: 'managed' }, { ...connection, capability: 'human-secret' }, { ...connection, workspaceRoot: 'relative' }, { ...connection, taskId: '../task' }]) assert.throws(() => new ExternalClient(bad, fetch), safeError);
  const getter = Object.defineProperty({}, 'capability', { enumerable: true, get() { called++; return capability; } });
  assert.throws(() => new ExternalClient(getter, fetch), safeError);
  const sparse = Array(2); assert.throws(() => snapshotExternalJson(sparse), safeError);
  assert.throws(() => snapshotExternalJson({ toJSON() { called++; return {}; } }), safeError);
  for (const timeoutMs of [0, 30001, Infinity]) assert.throws(() => new ExternalClient(connection, { fetch, timeoutMs }), safeError);
  assert.equal(called, 0);
});

test('reads handshake once and carry exact scoped/state/protocol headers with no browser authority', async () => {
  const { client, calls } = fixture();
  await Promise.all([client.context(7), client.memberStatus()]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${descriptor.origin}/v1/external/identity`);
  assert(calls.some(call => call.url === `${descriptor.origin}/v1/external/context?after=7`));
  assert(calls.some(call => call.url === `${descriptor.origin}/v1/external/member-status`));
  for (const call of calls) {
    assert.equal(call.method, 'GET'); assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit'); assert.equal(call.cache, 'no-store');
    assert.equal(call.headers.get('Authorization'), `Bearer ${capability}`);
    assert.equal(call.headers.get('X-Murmur-State-Id'), descriptor.stateId); assert.equal(call.headers.get('X-Murmur-Protocol-Version'), '1');
    assert.equal(call.headers.has('Origin'), false); assert.equal(call.headers.has('Cookie'), false);
  }
});

test('all mutations use separate external operations, stable keys, and no caller-selected binding fields', async () => {
  const { client, calls } = fixture();
  const cases = [
    ['intent', { revision: 2, writes: ['src'], dependencies: ['task-other'] }, 'intent'],
    ['taskStatus', { revision: 2, status: 'blocked', blocker: 'Waiting for schema' }, 'task-status'],
    ['checkPlan', { title: 'Candidate', writes: ['src'] }, 'check-plan'],
    ['proposeDecision', { key: 'api', value: 'POST /reset', version: '1', rationale: 'Reviewed' }, 'propose-decision'],
    ['reserve', { revision: 2, resources: [{ kind: 'path', value: 'src/api' }], ttlSeconds: 300 }, 'reserve'],
    ['release', { leaseId: 'lease-one', generation: 2 }, 'release'],
  ];
  for (const [method, input, endpoint] of cases) {
    await client[method](input, 'same-explicit-key');
    const sent = calls.at(-1);
    assert.equal(sent.url, `${descriptor.origin}/v1/external/${endpoint}`); assert.equal(sent.method, 'POST');
    assert.equal(sent.headers.get('Idempotency-Key'), 'same-explicit-key'); assert.deepEqual(JSON.parse(sent.body), input);
  }
  await client.leave('leave-key'); assert.equal(calls.at(-1).url, `${descriptor.origin}/v1/external/leave`); assert.equal(calls.at(-1).body, '{}');
  const before = calls.length;
  for (const field of ['sessionId', 'taskId', 'grantId', 'projectId', 'nativeId', 'incarnationId', 'capability', 'operation', 'endpoint']) {
    await assert.rejects(client.intent({ revision: 2, [field]: 'other' }), code('EXTERNAL_INPUT'));
  }
  for (const path of ['../secret', '/secret', 'C:/secret', 'src\\secret', 'src/*', '.git/config']) await assert.rejects(client.reserve({ revision: 2, resources: [{ kind: 'path', value: path }] }), code('PATH_ESCAPE'));
  await assert.rejects(client.taskStatus({ revision: 1, status: 'done' }), code('EXTERNAL_INPUT'));
  await assert.rejects(client.intent({ revision: 0 }), safeError);
  await assert.rejects(client.release({ leaseId: 'lease-one', generation: 0 }), safeError);
  await assert.rejects(client.checkPlan({}, 'bad\nkey'), safeError);
  await assert.rejects(client.context(-1), safeError);
  assert.equal(calls.length, before);
});

test('binding or fixed-expiry changes and failed handshakes never trigger automatic retries', async () => {
  for (const patch of [{ role: 'human' }, { role: 'agent' }, { protocolVersion: 2 }, { stateId: 'b'.repeat(64) }, { taskId: 'other' },
    { grantId: 'other' }, { memberId: 'other' }, { groupId: 'other' }, { workspaceRoot: '/another' }, { expiresAt: expiresAt + 1 }]) {
    const { client, calls } = fixture(() => response(identity(patch)));
    await assert.rejects(client.context(), safeError); await assert.rejects(client.intent({ revision: 1 }), safeError);
    assert.equal(calls.length, 1);
  }
  let instance = 0;
  const { client } = fixture(() => response(identity({ instanceId: `instance-${++instance}` })));
  assert.notEqual((await client.identity()).instanceId, (await client.identity()).instanceId);
  let called = 0;
  const expired = new ExternalClient({ ...connection, expiresAt: Date.now() - 1 }, async () => { called++; return response(identity()); });
  await assert.rejects(expired.identity(), code('EXTERNAL_EXPIRED')); assert.equal(called, 0);
});

test('payload is snapshotted before asynchronous identity and explicit replay keeps exact bytes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client, calls } = fixture(async (call, n) => { if (n === 1) { await gate; return response(identity()); } return response({ ok: true }); });
  const input = { revision: 3, writes: ['api'], produces: [{ key: 'api', version: '1' }] };
  const pending = client.intent(input, 'retry-key'); input.writes[0] = 'changed'; input.produces[0].version = '2'; release(); await pending;
  assert.deepEqual(JSON.parse(calls.at(-1).body), { revision: 3, writes: ['api'], produces: [{ key: 'api', version: '1' }] });
  await client.intent({ produces: [{ version: '1', key: 'api' }], writes: ['api'], revision: 3 }, 'retry-key');
  assert.equal(calls[1].body, calls[2].body);
});

test('state/protocol headers, redirects, malformed UTF-8, and streamed byte limits fail closed', async () => {
  for (const [name, expected] of [['X-Murmur-State-Id', 'EXTERNAL_STATE_MISMATCH'], ['X-Murmur-Protocol-Version', 'EXTERNAL_PROTOCOL_MISMATCH']]) {
    for (const status of [200, 403]) {
      const { client } = fixture(() => response(status === 200 ? identity() : { error: { code: 'FORBIDDEN' } }, { status, headers: { [name]: null } }));
      await assert.rejects(client.identity(), code(expected));
    }
  }
  await assert.rejects(fixture(() => response({}, { status: 302 })).client.identity(), code('EXTERNAL_REDIRECT'));
  await assert.rejects(fixture(() => response({}, { headers: { 'Content-Type': 'text/plain' } })).client.identity(), code('EXTERNAL_RESPONSE_INVALID'));
  await assert.rejects(fixture(() => response({}, { raw: new Uint8Array([0xff]) })).client.identity(), code('EXTERNAL_RESPONSE_INVALID'));
  await assert.rejects(fixture(() => response({}, { raw: '{' })).client.identity(), code('EXTERNAL_RESPONSE_INVALID'));
  await assert.rejects(fixture(() => response({}, { headers: { 'Content-Length': '262145' } })).client.identity(), code('EXTERNAL_RESPONSE_TOO_LARGE'));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262145)); controller.close(); } });
  await assert.rejects(fixture(() => response({}, { raw: stream })).client.identity(), code('EXTERNAL_RESPONSE_TOO_LARGE'));
  const large = { revision: 1, produces: Array.from({ length: 32 }, (_, i) => ({ key: `key${i}`, version: '1', value: 'x'.repeat(2048) })) };
  const f = fixture(); await assert.rejects(f.client.intent(large), code('EXTERNAL_INPUT_TOO_LARGE')); assert.equal(f.calls.length, 0);
});

test('timeouts abort stalled fetch/read and sanitize arbitrary capability-bearing failures', async () => {
  let signal;
  const stalled = new ExternalClient(connection, { timeoutMs: 20, fetch: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(stalled.identity(), code('EXTERNAL_TIMEOUT')); assert(signal.aborted);
  let canceled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } });
  await assert.rejects(fixture(() => response({}, { raw: body }), { timeoutMs: 20 }).client.identity(), code('EXTERNAL_TIMEOUT'));
  await new Promise(resolve => setTimeout(resolve, 5)); assert(canceled);
  await assert.rejects(fixture(() => { throw new Error(`${capability} ${pollSecret}`); }).client.identity(), safeError);
  const rejected = fixture(call => response(call.url.endsWith('/identity') ? identity() : { error: { code: 'STALE_REVISION', message: `${capability} ${pollSecret}` } }, { status: call.url.endsWith('/identity') ? 200 : 409 }));
  await assert.rejects(rejected.client.intent({ revision: 1 }), error => safeError(error) && error.code === 'STALE_REVISION'); assert.equal(rejected.calls.length, 2);
  const output = fixture(call => response(call.url.endsWith('/identity') ? identity() : { message: `${capability} ${pollSecret}`, capability, pollSecret, nested: { authorization: `Bearer ${capability}` } }), { redactSecrets: [pollSecret] });
  const value = JSON.stringify(await output.client.context()); assert(!value.includes(capability)); assert(!value.includes(pollSecret));
});

test('enrollment sends hashes only, polls by body plus distinct bearer, and privately activates exact scope', async () => {
  const pending = receipt();
  const { fetch, calls } = fixture(call => response(call.url.endsWith('/identity') ? identity() : pending));
  const client = new EnrollmentClient(descriptor, { fetch, redactSecrets: [capability, pollSecret] });
  assert.deepEqual(await client.request(enrollment(), 'enrollment-key'), pending);
  assert.equal(calls[0].headers.has('Authorization'), false); assert.equal(calls[0].headers.get('Idempotency-Key'), 'enrollment-key');
  assert.equal(calls[0].url, `${descriptor.origin}/v1/enrollment/requests`);
  assert.deepEqual(JSON.parse(calls[0].body), enrollment()); assert(!calls[0].body.includes(capability)); assert(!calls[0].body.includes(pollSecret));
  await client.status(pending.requestId, pollSecret);
  assert.equal(calls[1].method, 'POST'); assert.deepEqual(JSON.parse(calls[1].body), { requestId: pending.requestId });
  assert.equal(calls[1].headers.get('Authorization'), `Bearer ${pollSecret}`); assert.equal(new URL(calls[1].url).search, '');
  const active = await client.activate(capability, connection.workspaceRoot);
  assert.deepEqual(active, connection); assert(Object.isFrozen(active));
  assert.equal(calls[2].headers.get('Authorization'), `Bearer ${capability}`);
  const before = calls.length;
  for (const bad of [{ ...enrollment(), capability }, { ...enrollment(), pollSecretHash: digest(capability) }, { ...enrollment(), native: { ...enrollment().native, sessionId: 'other' } }]) await assert.rejects(client.request(bad, 'new-key'), safeError);
  assert.equal(calls.length, before);
});

test('enrollment response cannot expose private drafts/proofs or bootstrap a different root', async () => {
  for (const result of [{ ...receipt(), handoff: 'PRIVATE' }, { ...receipt(), requestId: pollSecret }]) {
    const f = fixture(() => response(result));
    const client = new EnrollmentClient(descriptor, { fetch: f.fetch, redactSecrets: [capability, pollSecret] });
    await assert.rejects(client.request(enrollment(), 'key'), safeError);
  }
  const f = fixture(() => response(identity({ workspaceRoot: '/different' })));
  await assert.rejects(new EnrollmentClient(descriptor, { fetch: f.fetch }).activate(capability, connection.workspaceRoot), code('EXTERNAL_IDENTITY_MISMATCH'));
});

test('external CLI requires complete explicit env and exposes only allowlisted scoped commands', async () => {
  let calls = 0;
  for (const bad of [{}, { MURMUR_EXTERNAL_MODE: '1' }, env({ MURMUR_EXTERNAL_MODE: '0' }), env({ MURMUR_EXTERNAL_CONNECTION: '{}' }), env({ MURMUR_AGENT_MODE: '1' })]) {
    await assert.rejects(externalMain(['context'], bad, { fetch: async () => { calls++; } }), safeError);
  }
  assert.equal(calls, 0); assert.match((await externalMain(['--help'], {})).scope, /Never discovers/);
  const f = fixture();
  await externalMain(['task-status', '--revision', '2', '--status', 'blocked', '--blocker', 'awaiting review', '--request-id', 'cli-key'], env(), { fetch: f.fetch });
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { revision: 2, status: 'blocked', blocker: 'awaiting review' });
  for (const args of [['context', '--task', 'other'], ['context', '--after', '1', '--after', '2'], ['intent', '--revision', '1', '--data', '{"revision":2}'],
    ['leave', '--data', '{}'], ['identity', '--help', '--force'], ['submit'], ['intent', '--data', '{}', '--file', '/must-not-read']]) {
    await assert.rejects(externalMain(args, env(), { fetch: f.fetch }), safeError);
  }
  assert.equal(f.calls.length, 2);
});

test('enrollment accepts bounded reported changes/checklist without treating them as identity', async () => {
  const f = fixture(() => response(receipt()));
  const client = new EnrollmentClient(descriptor, { fetch: f.fetch });
  const handoff = { summary: 'Reported prior work', changedFiles: Array.from({ length: 64 }, (_, i) => `src/reported-${i}.ts`), remainingWork: Array(16).fill('x'.repeat(512)) };
  await client.request(enrollment({ handoff }), 'checklist-key');
  assert.deepEqual(JSON.parse(f.calls[0].body).handoff, handoff);
  assert.deepEqual(JSON.parse(f.calls[0].body).native, enrollment().native);
  for (const patch of [
    { changedFiles: Array(65).fill('src/file.ts') }, { changedFiles: ['../outside'] },
    { changedFiles: ['/absolute'] }, { changedFiles: ['src\\outside'] },
    { remainingWork: Array(17).fill('step') }, { remainingWork: ['x'.repeat(513)] },
    { remainingWork: ['step\nnext'] }, { nativeId: 'selector-not-allowed' },
  ]) await assert.rejects(client.request(enrollment({ handoff: { summary: 'Summary', ...patch } }), 'invalid-checklist'), safeError);
  assert.equal(f.calls.length, 1);
});
