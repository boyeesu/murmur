import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMurmurMcpServer, MAX_MCP_RESULT_BYTES } from '../packages/murmur/dist/mcp/server.js';
import { murmurTools } from '../packages/murmur/dist/mcp/tools.js';
import { MAX_MCP_STDIN_BYTES } from '../packages/murmur/dist/cli/mcp.js';
import { AgentClient } from '../packages/murmur/dist/cli/agent-client.js';
import { temporary, repository } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const mcpModule = new URL('../packages/murmur/dist/cli/mcp.js', import.meta.url).href;
const connection = Object.freeze({ protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: '1'.repeat(64),
  launchId: 'launch-mcp', projectId: 'project-mcp', sessionId: 'session-mcp', taskId: 'task-mcp', agentToken: 'mcp-fixture-secret_'.padEnd(43, 'z') });
const names = ['murmur_identity', 'murmur_get_context', 'murmur_get_updates', 'murmur_declare_intent', 'murmur_update_task',
  'murmur_check_plan', 'murmur_propose_decision', 'murmur_reserve_resources', 'murmur_release_resources', 'murmur_submit_task', 'murmur_request_group_link', 'murmur_leave_group'];
const identity = (extra = {}) => ({ role: 'agent', protocolVersion: 1, stateId: connection.stateId, instanceId: 'instance-mcp',
  launchId: connection.launchId, projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId,
  expiresAt: Date.now() + 120000, ...extra });
const identityFetchScript = (body = identity(), headers = {}) => `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, {headers: ${JSON.stringify({
  'Content-Type': 'application/json', 'X-Murmur-State-Id': connection.stateId, 'X-Murmur-Protocol-Version': '1', ...headers,
})}});`;
const context = () => ({ projectId: connection.projectId, task: { id: connection.taskId, revision: 7 }, events: [{ sequence: 4, type: 'task.updated' }],
  nextCursor: 4, truncated: { events: false }, delivery: { meaning: 'generated_context_event_metadata_only' } });
function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json',
    'X-Murmur-State-Id': connection.stateId, 'X-Murmur-Protocol-Version': '1', ...headers } });
}
function env(root, scoped = connection) {
  // Do not inherit arbitrary human/supervisor credentials or provider account variables.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: root,
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(scoped ? { MURMUR_AGENT_MODE: '1', MURMUR_AGENT_CONNECTION: JSON.stringify(scoped) } : {}) };
}
const call = (client, name, args = {}, options = {}) => client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 5000, ...options });
function value(result) {
  assert(result.content.length > 0);
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, result.structuredContent);
  assert(Buffer.byteLength(JSON.stringify(result)) <= MAX_MCP_RESULT_BYTES);
  return parsed;
}
function success(result) { assert.notEqual(result.isError, true, JSON.stringify(result)); return value(result); }
function failure(result, code) { assert.equal(result.isError, true); assert.equal(value(result).error.code, code); }
function noSecrets(value, secrets = [connection.agentToken]) {
  for (const secret of secrets) assert(!JSON.stringify(value).includes(secret), 'credential was reflected');
}
async function memory(t, handle, options = {}) {
  const calls = [];
  const server = createMurmurMcpServer(connection, { ...options, fetch: async (url, init) => {
    const entry = { url: String(url), ...init, headers: new Headers(init.headers) };
    calls.push(entry);
    return handle ? handle(entry, calls.length) : response(entry.url.endsWith('/identity') ? identity() : context());
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages = [];
  clientTransport.onmessage = message => messages.push(message);
  const client = new Client({ name: 'murmur-fixture', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, calls, messages };
}
async function stdio(t, root, args = [cli, 'mcp', 'serve'], scoped = connection) {
  const transport = new StdioClientTransport({ command: process.execPath, args, env: env(root, scoped), cwd: root, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const errors = [], messages = [];
  transport.onmessage = message => messages.push(message);
  const client = new Client({ name: 'murmur-stdio-fixture', version: '1.0.0' });
  client.onerror = error => errors.push(error.message);
  t.after(() => client.close());
  await client.connect(transport);
  return { client, transport, errors, messages, get stderr() { return stderr; } };
}
function allObjectsStrict(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') assert.equal(schema.additionalProperties, false);
  for (const item of Object.values(schema)) {
    if (Array.isArray(item)) item.forEach(allObjectsStrict);
    else if (item && typeof item === 'object') allObjectsStrict(item);
  }
}

// These tests need only the isolated MCP/AgentClient modules and official SDK; no HTTP server.
test('MCP initializes through the official SDK and advertises only strict scoped tools', async t => {
  const f = await memory(t);
  assert.deepEqual(f.client.getServerVersion(), { name: 'murmur', version: '0.3.0' });
  const listed = (await f.client.listTools()).tools;
  assert.deepEqual(listed.map(tool => tool.name), names);
  for (const tool of listed) {
    allObjectsStrict(tool.inputSchema);
    assert.equal(tool.inputSchema.type, 'object');
    for (const name of ['projectId', 'sessionId', 'taskId', 'launchId', 'stateId', 'agentToken', 'supervisorToken', 'endpoint']) {
      assert(!Object.hasOwn(tool.inputSchema.properties, name));
    }
    assert.equal(tool.annotations.readOnlyHint, names.indexOf(tool.name) < 3);
  }
  assert.deepEqual(listed[0].inputSchema.properties, {});
  assert.equal(f.calls.length, 0, 'initialization/listing must not discover or contact a daemon');
  for (const name of ['murmur_accept_decision', 'murmur_validate_task', 'murmur_handoff', 'murmur_register', 'murmur_read_file', 'murmur_heartbeat', '__proto__', connection.agentToken]) {
    failure(await call(f.client, name), 'MCP_UNKNOWN_TOOL');
  }
  // SDK envelope validation happens before any tool handler. Record-key paths
  // in invalid initialize capabilities must not leak the known token either.
  await assert.rejects(f.client.request({ method: 'initialize', params: {
    protocolVersion: '2025-11-25', clientInfo: { name: 'fixture', version: '1' },
    capabilities: { experimental: { [connection.agentToken]: true } },
  } }, CallToolResultSchema), error => { noSecrets(error.message); return true; });
  noSecrets(f.messages);
});

test('MCP maps every tool to AgentClient with bound IDs and separate request IDs', async t => {
  const f = await memory(t, entry => response(entry.url.endsWith('/identity') ? identity() :
    entry.method === 'GET' ? context() : { accepted: true }));
  assert.equal(success(await call(f.client, 'murmur_identity')).taskId, connection.taskId);
  success(await call(f.client, 'murmur_get_context', { after: 3 }));
  const updates = success(await call(f.client, 'murmur_get_updates', { after: 2 }));
  assert.deepEqual(updates.events, context().events);
  assert.equal(updates.meaning, 'generated_context_event_metadata_only');
  for (const after of [3, 2]) {
    const url = new URL(f.calls.find(entry => entry.url.includes(`after=${after}`)).url);
    assert.equal(url.pathname, '/v1/context');
    assert.equal(url.searchParams.get('taskId'), connection.taskId);
    assert.equal(url.searchParams.get('projectId'), connection.projectId);
  }
  const entries = [
    ['murmur_declare_intent', { revision: 7, reads: ['src/a.ts'], writes: ['src/b.ts'], produces: [{ key: 'api', version: '1', value: 'v1' }] }, '/v1/intents', { taskId: connection.taskId }],
    ['murmur_update_task', { revision: 7, status: 'blocked' }, '/v1/tasks/update', { taskId: connection.taskId }],
    ['murmur_check_plan', { title: 'Candidate', writes: ['src'] }, '/v1/check-plan', { projectId: connection.projectId, taskId: connection.taskId }],
    ['murmur_propose_decision', { key: 'api', value: 'v1', version: '1', rationale: 'Compatible' }, '/v1/decisions/propose', { projectId: connection.projectId, taskId: connection.taskId }],
    ['murmur_reserve_resources', { taskRevision: 7, resources: [{ kind: 'path', value: 'src' }, { kind: 'resource', value: 'api' }], ttlSeconds: 60 }, '/v1/reservations/acquire', { projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId }],
    ['murmur_release_resources', { leaseId: 'lease-one', generation: 2 }, '/v1/reservations/release', { sessionId: connection.sessionId }],
    ['murmur_submit_task', { revision: 7 }, '/v1/submissions', { taskId: connection.taskId }],
  ];
  for (const [name, payload, endpoint, ids] of entries) {
    success(await call(f.client, name, { ...payload, requestId: 'same-explicit-key' }));
    const request = f.calls.at(-1);
    assert.equal(request.url, connection.origin + endpoint);
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { ...payload, ...ids });
    assert.equal(request.headers.get('Idempotency-Key'), 'same-explicit-key');
    assert(!Object.hasOwn(JSON.parse(request.body), 'requestId'));
  }
  for (const request of f.calls) {
    assert.equal(request.headers.get('Authorization'), `Bearer ${connection.agentToken}`);
    assert.equal(request.headers.get('X-Murmur-State-Id'), connection.stateId);
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
  }
  assert.equal(f.calls.filter(entry => entry.method === 'POST').length, entries.length);
});

test('MCP rejects cross-ID fields, nested extras and privileged statuses before HTTP', async t => {
  const f = await memory(t);
  const operations = [
    ['murmur_identity', {}], ['murmur_get_context', {}], ['murmur_get_updates', {}],
    ['murmur_declare_intent', { revision: 1 }], ['murmur_update_task', { revision: 1, status: 'active' }],
    ['murmur_check_plan', {}], ['murmur_propose_decision', { key: 'api', value: 'v1', version: '1', rationale: 'reason' }],
    ['murmur_reserve_resources', { taskRevision: 1, resources: [{ kind: 'path', value: 'src' }] }],
    ['murmur_release_resources', { leaseId: 'lease', generation: 1 }], ['murmur_submit_task', { revision: 1 }],
  ];
  for (const [name, args] of operations) {
    for (const key of ['projectId', 'sessionId', 'taskId', 'launchId', 'stateId', 'agentToken', 'supervisorToken', 'endpoint', 'validation', 'handoff', 'file', connection.agentToken]) {
      failure(await call(f.client, name, { ...args, [key]: connection.agentToken }), 'AGENT_INPUT');
    }
  }
  for (const status of ['done', 'integrated', 'abandoned', 'planned', connection.agentToken]) {
    failure(await call(f.client, 'murmur_update_task', { revision: 1, status }), 'AGENT_INPUT');
  }
  for (const list of ['produces', 'consumes']) failure(await call(f.client, 'murmur_declare_intent', {
    revision: 1, [list]: [{ key: 'api', version: '1', [connection.agentToken]: true }],
  }), 'AGENT_INPUT');
  failure(await call(f.client, 'murmur_reserve_resources', { taskRevision: 1,
    resources: [{ kind: 'path', value: 'src', [connection.agentToken]: true }] }), 'AGENT_INPUT');
  assert.equal(f.calls.length, 0);
  noSecrets(f.messages);
});

test('MCP schemas mirror AgentClient field bounds without coercion or path traversal', async t => {
  const f = await memory(t);
  const invalid = [
    ['murmur_get_context', { after: -1 }], ['murmur_get_updates', { after: '1' }],
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER].map(revision => ['murmur_submit_task', { revision }]),
    ['murmur_declare_intent', {}], ['murmur_declare_intent', { revision: 1, acceptanceCriteria: [' '] }],
    ['murmur_declare_intent', { revision: 1, acceptanceCriteria: ['a'.repeat(513)] }],
    ['murmur_declare_intent', { revision: 1, dependencies: ['bad/id'] }],
    ['murmur_declare_intent', { revision: 1, produces: [{ key: 'api', version: 'v'.repeat(65) }] }],
    ['murmur_declare_intent', { revision: 1, produces: [{ key: 'api', version: '1', value: 'v'.repeat(2049) }] }],
    ['murmur_check_plan', { title: 'a\nb' }], ['murmur_check_plan', { title: 'x'.repeat(513) }],
    ['murmur_check_plan', { writes: Array(65).fill('src') }], ['murmur_check_plan', { produces: Array(33).fill({ key: 'api', version: '1' }) }],
    ['murmur_reserve_resources', { taskRevision: 1, resources: [] }],
    ['murmur_reserve_resources', { taskRevision: 1, resources: [{ kind: 'resource', value: 'space here' }] }],
    ['murmur_reserve_resources', { taskRevision: 1, resources: [{ kind: 'path', value: 'src' }], ttlSeconds: 301 }],
    ['murmur_release_resources', { leaseId: 'lease', generation: 0 }],
    ...['bad\nkey', 'x'.repeat(129), 'a/b'].map(requestId => ['murmur_submit_task', { revision: 1, requestId }]),
    ...['../private', 'src/../private', '/absolute', 'C:/absolute', 'a\\b', 'src/*', 'src/?.ts', 'src/[a]', 'a\u007f', 'x'.repeat(1025)]
      .map(value => ['murmur_check_plan', { writes: [value] }]),
  ];
  for (const [name, args] of invalid) failure(await call(f.client, name, args), 'AGENT_INPUT');
  assert.equal(f.calls.length, 0);
  const schema = name => murmurTools.find(tool => tool.name === name).inputSchema;
  assert(schema('murmur_submit_task').safeParse({ revision: Number.MAX_SAFE_INTEGER - 1, requestId: 'x'.repeat(128) }).success);
  assert(schema('murmur_get_context').safeParse({ after: Number.MAX_SAFE_INTEGER }).success);
  assert(schema('murmur_release_resources').safeParse({ leaseId: 'a'.repeat(128), generation: Number.MAX_SAFE_INTEGER }).success);
  assert(schema('murmur_declare_intent').safeParse({ revision: 1, reads: ['./src/a.ts', 'src/..file'],
    produces: [{ key: 'a'.repeat(128), version: '1'.repeat(64), value: 'v'.repeat(2048) }] }).success);
  failure(await call(f.client, 'murmur_declare_intent', { revision: 1,
    produces: Array.from({ length: 32 }, (_, i) => ({ key: `api-${i}`, version: '1', value: 'v'.repeat(2048) })) }), 'AGENT_INPUT_TOO_LARGE');
  assert.equal(f.calls.length, 0, 'aggregate AgentClient request size must fail before handshake');
});

test('MCP handles expiry, wrong service identity and domain errors without retries or secret echoes', async t => {
  for (const [label, identityValue, headers, code] of [
    ['expiry', identity({ expiresAt: Date.now() - 1 }), {}, 'AGENT_CREDENTIAL_EXPIRED'],
    ['wrong task', identity({ taskId: 'another-task' }), {}, 'AGENT_IDENTITY_MISMATCH'],
    ['wrong role', identity({ role: 'supervisor' }), {}, 'AGENT_IDENTITY_MISMATCH'],
    ['wrong state', identity(), { 'X-Murmur-State-Id': '0'.repeat(64) }, 'AGENT_STATE_MISMATCH'],
    ['wrong protocol', identity(), { 'X-Murmur-Protocol-Version': '2' }, 'AGENT_PROTOCOL_MISMATCH'],
  ]) await t.test(label, async t => {
    const f = await memory(t, () => response(identityValue, { headers }));
    failure(await call(f.client, 'murmur_submit_task', { revision: 7 }), code);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'GET');
    noSecrets(f.messages);
  });
  for (const code of ['STALE_REVISION', 'IDEMPOTENCY_CONFLICT', 'FORBIDDEN']) await t.test(code, async t => {
    const f = await memory(t, entry => entry.url.endsWith('/identity') ? response(identity()) :
      response({ error: { code, message: connection.agentToken, details: { supervisorToken: 'do-not-echo' } } }, { status: 409 }));
    failure(await call(f.client, 'murmur_submit_task', { revision: 7, requestId: 'original-key' }), code);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].headers.get('Idempotency-Key'), 'original-key');
    assert.equal(JSON.parse(f.calls[1].body).revision, 7);
    noSecrets(f.messages, [connection.agentToken, 'do-not-echo']);
  });
  const f = await memory(t, () => { throw new Error(connection.agentToken); });
  failure(await call(f.client, 'murmur_identity'), 'AGENT_UNAVAILABLE');
  noSecrets(f.messages);
});

test('MCP redacts successful data and bounds complete duplicated and escaped results', async t => {
  const other = 'other-private-credential';
  const f = await memory(t, entry => response(entry.url.endsWith('/identity') ? identity() : {
    message: `Echo ${connection.agentToken}`, [connection.agentToken]: 'key echo',
    nested: [{ supervisorToken: other, credentials: { access: other }, authorization: `Bearer ${other}`, note: `Bearer ${other}` }],
  }));
  const safe = success(await call(f.client, 'murmur_get_context'));
  assert.match(safe.message, /\[REDACTED\]/);
  noSecrets(f.messages, [connection.agentToken, other]);
  for (const text of ['x'.repeat(140000), '"'.repeat(60000), '\\'.repeat(60000)]) await t.test(`bound ${text.charCodeAt(0)}`, async t => {
    const f = await memory(t, entry => response(entry.url.endsWith('/identity') ? identity() : { text }));
    const result = await call(f.client, 'murmur_submit_task', { revision: 7, requestId: 'bounded-output' });
    failure(result, 'MCP_RESULT_TOO_LARGE');
    assert.equal(f.calls.filter(entry => entry.method === 'POST').length, 1, 'never retry a mutation because its output is oversized');
  });
  await t.test('near boundary stays complete JSON', async t => {
    const f = await memory(t, entry => response(entry.url.endsWith('/identity') ? identity() : { text: 'x'.repeat(120000) }));
    assert.equal(success(await call(f.client, 'murmur_get_context')).text.length, 120000);
  });
});

test('MCP cancellation and server close abort only outstanding scoped HTTP operations', async t => {
  for (const mode of ['cancel', 'close']) await t.test(mode, async t => {
    const started = Promise.withResolvers(), aborted = Promise.withResolvers();
    const f = await memory(t, entry => {
      if (entry.url.endsWith('/identity')) return response(identity());
      started.resolve();
      return new Promise((resolve, reject) => entry.signal.addEventListener('abort', () => {
        aborted.resolve(); reject(new Error('aborted'));
      }, { once: true }));
    });
    const controller = new AbortController();
    const pending = call(f.client, 'murmur_submit_task', { revision: 7, requestId: 'do-not-retry' }, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await started.promise;
    if (mode === 'cancel') controller.abort(); else await f.server.close();
    await rejected;
    await Promise.race([aborted.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP cancellation not propagated')), 1000); timer.unref();
    })]);
    assert.equal(f.calls.filter(entry => entry.method === 'POST').length, 1);
    if (mode === 'cancel') success(await call(f.client, 'murmur_identity'));
  });
});

test('MCP CLI rejects missing/invalid managed env before lazy SDK import and never prints errors to stdout', async t => {
  const root = await temporary(t);
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('@modelcontextprotocol/')) throw new Error(${JSON.stringify(connection.agentToken)}); return next(specifier, context); } });
    const { mcpMain } = await import(${JSON.stringify(mcpModule)}); await mcpMain(['serve']);`;
  const variants = [env(root, null), { ...env(root, null), MURMUR_AGENT_MODE: '1' },
    { ...env(root), MURMUR_AGENT_CONNECTION: '{' + connection.agentToken },
    env(root, { ...connection, supervisorToken: connection.agentToken })];
  for (const childEnv of variants) await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: childEnv, timeout: 5000,
  }), error => {
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /AGENT_CONFIGURATION/);
    noSecrets(error.stderr);
    return true;
  });
  const help = await execute(process.execPath, [cli, 'mcp', '--help'], { cwd: root, env: env(root, null), timeout: 5000 });
  assert.match(help.stdout, /murmur mcp serve/);
  assert.equal(help.stderr, '');
  await assert.rejects(execute(process.execPath, [cli, 'mcp', 'serve', '--task', connection.agentToken], {
    cwd: root, env: env(root), timeout: 5000,
  }), error => { assert.equal(error.stdout, ''); noSecrets(error.stderr); return true; });
});

test('MCP stdio rejects expired, mismatched and human identities before SDK initialization succeeds', async t => {
  const root = await temporary(t);
  for (const [body, headers, code] of [
    [identity({ expiresAt: Date.now() - 1 }), {}, 'AGENT_CREDENTIAL_EXPIRED'],
    [identity({ taskId: 'wrong-task' }), {}, 'AGENT_IDENTITY_MISMATCH'],
    [identity({ role: 'human' }), {}, 'AGENT_IDENTITY_MISMATCH'],
    [identity(), { 'X-Murmur-State-Id': '0'.repeat(64) }, 'AGENT_STATE_MISMATCH'],
  ]) {
    const script = `${identityFetchScript(body, headers)} const { mcpMain } = await import(${JSON.stringify(mcpModule)}); await mcpMain(['serve']);`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', script],
      cwd: root, env: env(root), stderr: 'pipe' });
    let stderr = '';
    const messages = [];
    transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
    transport.onmessage = message => messages.push(message);
    const client = new Client({ name: 'invalid-identity-fixture', version: '1' });
    t.after(() => client.close());
    await assert.rejects(client.connect(transport));
    assert.equal(client.getServerVersion(), undefined);
    assert.equal(messages.length, 0, 'no successful initialization before identity verification');
    assert.match(stderr, new RegExp(code));
    noSecrets(stderr);
  }
});

test('MCP startup identity preflight is aborted by EOF or signals with initialization still pending', async t => {
  const root = await temporary(t);
  for (const ending of ['EOF', 'SIGINT', 'SIGTERM']) await t.test(ending, async t => {
    const script = `const { mcpMain } = await import(${JSON.stringify(mcpModule)});
      globalThis.fetch = async (url, init) => new Promise((resolve, reject) => {
        process.stderr.write('PREFLIGHT_STARTED\\n');
        init.signal.addEventListener('abort', () => { process.stderr.write('PREFLIGHT_ABORTED\\n'); reject(new Error('cancelled')); }, {once:true});
      }); await mcpMain(['serve']);`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', script],
      cwd: root, env: env(root), stderr: 'pipe' });
    let stderr = '';
    const started = Promise.withResolvers(), closed = Promise.withResolvers();
    transport.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.includes('PREFLIGHT_STARTED')) started.resolve(); });
    const messages = [];
    transport.onmessage = message => messages.push(message);
    const client = new Client({ name: 'pending-identity-fixture', version: '1' });
    client.onclose = () => closed.resolve();
    t.after(() => client.close());
    const pending = assert.rejects(client.connect(transport));
    await started.promise;
    assert.equal(messages.length, 0);
    const start = Date.now();
    if (ending === 'EOF') await client.close(); else process.kill(transport.pid, ending);
    await pending;
    await closed.promise;
    assert(Date.now() - start < 1800);
    assert.match(stderr, /PREFLIGHT_ABORTED/);
    assert.equal(messages.length, 0);
  });
});

test('MCP stdio exits promptly on EOF and signals, restores listeners, and keeps stdout protocol-only', async t => {
  const root = await temporary(t);
  for (const ending of ['EOF', 'SIGINT', 'SIGTERM']) await t.test(ending, async t => {
    const script = `${identityFetchScript()} const { mcpMain } = await import(${JSON.stringify(mcpModule)});
      const counts = () => [process.stdin.listenerCount('end'), process.stdin.listenerCount('close'), process.stdin.listenerCount('data'), process.stdin.listenerCount('error'), process.stdout.listenerCount('error'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const before = counts(); await mcpMain(['serve']); process.stderr.write(JSON.stringify({before, after: counts()}) + '\\n');`;
    const f = await stdio(t, root, ['--input-type=module', '-e', script]);
    assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), names);
    const closed = Promise.withResolvers();
    f.client.onclose = () => closed.resolve();
    const start = Date.now();
    if (ending === 'EOF') await f.client.close(); else process.kill(f.transport.pid, ending);
    await Promise.race([closed.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('stdio did not exit')), 1800); timer.unref();
    })]);
    assert(Date.now() - start < 1800, 'must exit before SDK client close escalates after two seconds');
    assert.deepEqual(f.errors, [], 'non-protocol stdout or SDK transport error');
    const counts = JSON.parse(f.stderr.trim());
    assert.deepEqual(counts.after, counts.before, 'stdio and signal listeners must be removed');
    noSecrets(f.messages);
  });
});

test('MCP EOF aborts an in-flight request without ending the managed capability', async t => {
  const root = await temporary(t);
  const script = `${identityFetchScript()} const verifiedFetch = globalThis.fetch; let calls = 0;
    const { mcpMain } = await import(${JSON.stringify(mcpModule)});
    globalThis.fetch = async (url, init) => ++calls === 1 ? verifiedFetch() : new Promise((resolve, reject) => {
      process.stderr.write('FETCH_STARTED\\n');
      init.signal.addEventListener('abort', () => { process.stderr.write('FETCH_ABORTED\\n'); reject(new Error('cancelled')); }, {once:true});
    }); await mcpMain(['serve']);`;
  const f = await stdio(t, root, ['--input-type=module', '-e', script]);
  const started = new Promise(resolve => f.transport.stderr.on('data', chunk => { if (chunk.toString().includes('FETCH_STARTED')) resolve(); }));
  const pending = assert.rejects(call(f.client, 'murmur_identity'));
  await started;
  const start = Date.now();
  await f.client.close();
  await pending;
  assert(Date.now() - start < 1800);
  assert.match(f.stderr, /FETCH_ABORTED/);
  assert.deepEqual(f.errors, []);
});

test('MCP stdio rejects oversized unterminated input and raw parse diagnostics without echoing secrets', async t => {
  const root = await temporary(t);
  for (const input of ['{"' + connection.agentToken + '\n', connection.agentToken + 'x'.repeat(MAX_MCP_STDIN_BYTES)]) {
    const script = `${identityFetchScript()} const { mcpMain } = await import(${JSON.stringify(mcpModule)}); await mcpMain(['serve']);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: env(root), stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdin.on('error', () => {}); // Closing the rejected transport may race the test write.
    child.stdin.write(input);
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('unbounded stdio input')), 3000); timer.unref();
    })]);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /MCP_TRANSPORT/);
    noSecrets(stderr);
  }
});

// Integration uses only a disposable repository/state and fixture-managed launches: no model or account.
test('MCP real fixture daemon supports every mapping, replay, stale revisions and EOF without lifecycle authority', async t => {
  const { startDaemon } = await import('../packages/murmur/dist/daemon/server.js');
  const { request } = await import('../packages/murmur/dist/cli/client.js');
  const root = await temporary(t), home = path.join(root, 'state'), source = await repository(path.join(root, 'source'));
  const daemon = await startDaemon(home);
  try {
    const project = await request(home, 'POST', '/v1/projects', { root: source });
    const prepared = await request(home, 'POST', '/v1/launches/prepare', { projectId: project.id, tool: 'claude', title: 'MCP fixture task' }, { timeoutMs: 60000 });
    const controllerId = randomUUID();
    const control = async (action, fields) => {
      const result = await fetch(prepared.supervisor.origin + '/v1/launch-control/' + action, { method: 'POST', headers: {
        Authorization: `Bearer ${prepared.supervisor.supervisorToken}`, 'Content-Type': 'application/json',
        'X-Murmur-State-Id': prepared.supervisor.stateId, 'X-Murmur-Protocol-Version': String(prepared.supervisor.protocolVersion), 'Idempotency-Key': randomUUID(),
      }, body: JSON.stringify({ launchId: prepared.launch.id, ...fields }) });
      assert(result.ok); return result.json();
    };
    const claimed = await control('claim', { controllerId, revision: prepared.launch.lifecycleRevision });
    const running = await control('started', { controllerId, revision: claimed.lifecycleRevision, pid: process.pid });
    const f = await stdio(t, root, [cli, 'mcp', 'serve'], prepared.agent);
    const invoke = async (name, args) => success(await call(f.client, name, args));
    const direct = new AgentClient(prepared.agent);
    assert.equal((await invoke('murmur_identity')).taskId, prepared.agent.taskId);
    const original = await invoke('murmur_get_context');
    assert.equal(original.task.id, prepared.agent.taskId);
    const updates = await invoke('murmur_get_updates', { after: 0 });
    assert.equal(updates.taskId, prepared.agent.taskId);
    assert(Array.isArray(updates.events));
    const declaration = { revision: original.task.revision, writes: ['src/fixture.ts'], produces: [{ key: 'fixture-api', version: '1' }], requestId: 'fixture-intent' };
    const intent = await invoke('murmur_declare_intent', declaration);
    assert.deepEqual(await invoke('murmur_declare_intent', declaration), intent);
    failure(await call(f.client, 'murmur_declare_intent', { ...declaration, writes: ['other.ts'] }), 'IDEMPOTENCY_CONFLICT');
    failure(await call(f.client, 'murmur_declare_intent', { ...declaration, requestId: 'stale-intent' }), 'STALE_REVISION');
    const revision = (await direct.context()).task.revision;
    failure(await call(f.client, 'murmur_update_task', { revision, status: 'blocked', taskId: 'different-task' }), 'AGENT_INPUT');
    assert.equal((await direct.context()).task.revision, revision);
    await invoke('murmur_check_plan', { title: 'Advisory candidate', writes: ['src/fixture.ts'], requestId: 'fixture-plan' });
    await invoke('murmur_propose_decision', { key: 'fixture-api', value: 'v1', version: '1', rationale: 'Fixture proposal', requestId: 'fixture-decision' });
    const lease = await invoke('murmur_reserve_resources', { taskRevision: (await direct.context()).task.revision,
      resources: [{ kind: 'path', value: 'src/fixture.ts' }], ttlSeconds: 60, requestId: 'fixture-reserve' });
    await invoke('murmur_release_resources', { leaseId: lease.id, generation: lease.generation, requestId: 'fixture-release' });
    await invoke('murmur_update_task', { revision: (await direct.context()).task.revision, status: 'ready', requestId: 'fixture-ready' });
    await invoke('murmur_submit_task', { revision: (await direct.context()).task.revision, requestId: 'fixture-submit' });
    const beforeClose = (await direct.context()).task;
    const start = Date.now();
    await f.client.close();
    assert(Date.now() - start < 1800);
    assert.deepEqual((await direct.context()).task, beforeClose, 'EOF must not update/end the task or revoke its credential');
    assert.equal((await direct.identity()).sessionId, prepared.agent.sessionId);
    assert.deepEqual(f.errors, []);
    assert.equal(f.stderr, '');
    noSecrets(f.messages, [prepared.agent.agentToken, prepared.supervisor.supervisorToken]);
    await control('end', { controllerId, revision: running.lifecycleRevision, reason: 'exited', exitCode: 0 });
  } finally { await daemon.close(); }
});
