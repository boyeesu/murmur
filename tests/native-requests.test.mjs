import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['adapters/native-publication.ts', 'mcp/native-requests.ts', 'cli/native-requests.ts', 'protocol/index.ts'].map(file => new URL(file, root).href));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Actorless formatter must not load authority or file discovery: ${url}`);
      return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!modules.has(url)) return next(url, context);
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const { createNativeRequestsServer } = await import(new URL('mcp/native-requests.ts', root));
const { nativeRequestsMain } = await import(new URL('cli/native-requests.ts', root));
const { formatNativeRequest, verifyNativeRequestResult, NATIVE_REQUEST_INPUT_BYTES, NATIVE_REQUEST_RESULT_BYTES } = await import(new URL('adapters/native-publication.ts', root));
hooks.deregister();
const samples = { declare_intent: { revision: 3, reads: ['src/read.ts'], writes: ['src/write.ts'], produces: [{ key: 'api.route', version: 'v1', value: 'POST /reset' }] }, set_status: { revision: 4, status: 'blocked', blocker: 'Awaiting accepted contract' }, propose_decision: { key: 'api.route', version: 'v1', value: 'POST /reset', rationale: 'Reviewed plan' }, check_plan: { writes: ['src/write.ts'] } };
const invalid = error => error.code === 'NATIVE_REQUEST_INPUT';
async function memory(t) {
  const server = createNativeRequestsServer(), client = new Client({ name: 'native-requests-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}
function strict(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') assert.equal(schema.additionalProperties, false);
  for (const value of Object.values(schema)) if (Array.isArray(value)) value.forEach(strict); else strict(value);
}

test('actorless server advertises strict data-only tools and cannot contact a service', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Formatter must not make HTTP requests'));
  const client = await memory(t), listed = (await client.listTools()).tools;
  assert.deepEqual(client.getServerVersion(), { name: 'murmur-native-requests', version: '0.6.0-alpha.1' });
  assert.deepEqual(listed.map(tool => tool.name), Object.keys(samples));
  for (const tool of listed) {
    strict(tool.inputSchema);
    for (const field of ['nativeId', 'sessionId', 'taskId', 'memberId', 'workspaceRoot', 'capability', 'descriptor', 'endpoint', 'idempotencyKey']) assert(!Object.hasOwn(tool.inputSchema.properties, field));
    assert.equal(tool.annotations.readOnlyHint, false);
    const result = await client.callTool({ name: tool.name, arguments: samples[tool.name] }, CallToolResultSchema);
    assert.notEqual(result.isError, true); assert.equal(result.structuredContent.status, 'awaiting_native_bridge');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.deepEqual(result.structuredContent.input, samples[tool.name]);
    assert(Buffer.byteLength(JSON.stringify(result)) <= NATIVE_REQUEST_RESULT_BYTES);
  }
});

test('formatter and result verification never assert publication or select an actor', () => {
  for (const [name, input] of Object.entries(samples)) {
    const result = formatNativeRequest(name, input), verified = verifyNativeRequestResult(name, input, result);
    assert.equal(verified.status, 'awaiting_native_bridge'); assert.deepEqual(verified.input, input);
    for (const changed of [{ ...result, isError: false }, { ...result, extra: 'unknown' }, { ...result, structuredContent: { ...result.structuredContent, status: 'published' } }, { ...result, content: [{ type: 'text', text: '{}' }] }]) assert.throws(() => verifyNativeRequestResult(name, input, changed), invalid);
    assert.throws(() => verifyNativeRequestResult(name, { ...input, revision: 999 }, result), invalid);
  }
});

test('strict validation rejects selector fields, invalid statuses, paths and oversized data', async t => {
  const client = await memory(t);
  for (const [name, input] of Object.entries(samples)) for (const field of ['sessionId', 'taskId', 'nativeId', 'workspaceRoot', 'capability', 'keyForRetry']) {
    const poisoned = { ...input, [field]: 'SENSITIVE-UNKNOWN-FIELD' };
    assert.throws(() => formatNativeRequest(name, poisoned), invalid);
    const result = await client.callTool({ name, arguments: poisoned }, CallToolResultSchema);
    assert.equal(result.isError, true); assert(!JSON.stringify(result).includes('SENSITIVE-UNKNOWN-FIELD'));
  }
  for (const input of [{ revision: 0 }, { revision: 1, writes: ['../outside'] }, { revision: 1, reads: ['/outside'] }, { revision: 1, writes: ['.git/config'] }, { revision: 1, produces: [{ key: 'x', version: 'v1', actor: 'other' }] }, { revision: 1, acceptanceCriteria: ['x'.repeat(NATIVE_REQUEST_INPUT_BYTES)] }]) assert.throws(() => formatNativeRequest('declare_intent', input), invalid);
  for (const status of ['done', 'complete', 'validated', 'submitted', 'idle', 'stopped']) assert.throws(() => formatNativeRequest('set_status', { revision: 1, status }), invalid);
  for (const name of ['identity', 'context', 'start', 'join', 'approve', 'accept_decision', 'leave', '__proto__']) assert.throws(() => formatNativeRequest(name, {}), invalid);
});

test('formatter refuses accessors, toJSON, sparse arrays and non-JSON values without invoking them', () => {
  let called = false;
  const accessor = { get revision() { called = true; return 1; } };
  for (const value of [accessor, { revision: 1, toJSON() { called = true; return {}; } }, { revision: 1, writes: Array(1) }, { revision: Infinity }, { revision: 1n }, Object.assign(new Date(), { revision: 1 })]) assert.throws(() => formatNativeRequest('declare_intent', value), invalid);
  assert.equal(called, false);
});

test('actorless CLI rejects all configuration/identity arguments and closes on EOF', async () => {
  for (const args of [['--state', '/x'], ['--descriptor', '/x/connection.json'], ['--session-id', 'other'], ['serve'], ['--force']]) await assert.rejects(nativeRequestsMain(args), error => error.code === 'NATIVE_REQUEST_ARGUMENTS');
  const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', value => { text += value; });
  const done = nativeRequestsMain([], { input, output }); input.end(); await done;
  assert.equal(text, ''); assert.equal(input.destroyed, true);
});


test('built CLI serves actorless MCP before managed/human guards without private discovery', async t => {
  const directory = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-native-requests-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'native-requests'], cwd: directory,
    env: { HOME: directory, TMPDIR: directory, MURMUR_AGENT_MODE: '1', MURMUR_AGENT_CONNECTION: 'INTENTIONALLY_INVALID_CONFIGURATION' }, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'native-stdio-fixture', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), Object.keys(samples));
  const result = await client.callTool({ name: 'declare_intent', arguments: samples.declare_intent }, CallToolResultSchema);
  assert.equal(result.structuredContent.status, 'awaiting_native_bridge');
  assert.deepEqual(await readdir(directory), []);
  assert(!stderr.includes('INTENTIONALLY_INVALID_CONFIGURATION'));
  await client.close();
});

const initializeMessage = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'utf8-fixture', version: '1' } } };
const formatMessage = title => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_plan', arguments: { title } } });
const immediate = () => new Promise(resolve => setImmediate(resolve));
async function stdioFixture() {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk; });
  const done = nativeRequestsMain([], { input, output }).then(() => null, error => error.code);
  input.write(JSON.stringify(initializeMessage) + '\n'); await immediate();
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); await immediate();
  return { input, done, messages: () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('actorless stdio rejects malformed UTF-8 and incomplete terminal characters without a formatter receipt', async () => {
  const prefix = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_plan","arguments":{"title":"');
  for (const chunks of [
    [prefix, Buffer.from([0xff]), Buffer.from('"}}}\n')],
    [prefix, Buffer.from([0xe2]), Buffer.from([0x28, 0xa1]), Buffer.from('"}}}\n')],
    [prefix, Buffer.from([0xf0, 0x9f])],
  ]) {
    const f = await stdioFixture();
    for (const chunk of chunks) { if (!f.input.destroyed) f.input.write(chunk); await immediate(); }
    f.input.end();
    assert.equal(await f.done, 'NATIVE_REQUEST_TRANSPORT');
    assert.equal(f.messages().some(message => message.id === 2 && message.result?.structuredContent), false);
    assert.equal(f.input.destroyed, true);
  }
});

test('actorless stdio preserves valid multibyte UTF-8 split at every byte boundary', async () => {
  const f = await stdioFixture(), title = 'Before 界 café \u{1f989} after';
  for (const byte of Buffer.from(JSON.stringify(formatMessage(title)) + '\n')) f.input.write(Buffer.from([byte]));
  await immediate(); f.input.end();
  assert.equal(await f.done, null);
  const result = f.messages().find(message => message.id === 2)?.result;
  assert.equal(result?.structuredContent?.status, 'awaiting_native_bridge');
  assert.equal(result.structuredContent.input.title, title);
});

test('actorless stdio retains its byte limit and terminates on source stream failure', async () => {
  for (const action of [input => input.write(Buffer.alloc(32 * 1024 + 1, 120)), input => input.destroy(new Error('PRIVATE-SOURCE-ERROR'))]) {
    const f = await stdioFixture(); action(f.input);
    assert.equal(await f.done, 'NATIVE_REQUEST_TRANSPORT');
    assert(!JSON.stringify(f.messages()).includes('PRIVATE-SOURCE-ERROR'));
    assert.equal(f.input.destroyed, true);
  }
});

test('built actorless CLI rejects malformed UTF-8 and accepts valid split characters', async t => {
  const { spawn } = await import('node:child_process'), { once } = await import('node:events');
  const directory = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-native-requests-utf8-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
  for (const malformed of [false, true]) {
    const child = spawn(process.execPath, [cli, 'native-requests'], { cwd: directory, env: { HOME: directory, TMPDIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const exited = once(child, 'exit');
    child.stdin.write(JSON.stringify(initializeMessage) + '\n');
    if (malformed) child.stdin.end(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_plan","arguments":{"title":"'), Buffer.from([0xff]), Buffer.from('"}}}\n')]));
    else {
      for (const byte of Buffer.from(JSON.stringify(formatMessage('界 \u{1f989}')) + '\n')) child.stdin.write(Buffer.from([byte]));
      child.stdin.end();
    }
    const [code] = await exited;
    const result = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 2)?.result;
    if (malformed) { assert.equal(code, 1); assert.equal(result?.structuredContent, undefined); assert.match(stderr, /NATIVE_REQUEST_TRANSPORT/); }
    else { assert.equal(code, 0); assert.equal(result?.structuredContent?.input.title, '界 \u{1f989}'); }
    assert.deepEqual(await readdir(directory), []);
  }
});
