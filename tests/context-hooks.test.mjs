import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

// Source-only component tests: no shared build, daemon, native CLI, SDK, or network.
const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['cli/hook.ts', 'hooks/context.ts', 'cli/agent-client.ts', 'protocol/index.ts', 'protocol/agent.ts'].map(file => new URL(file, root).href));
const loaded = new Set();
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Unexpected hook dependency: ${url}`);
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
const { hookMain } = await import(new URL('cli/hook.ts', root));
const { HOOK_EVENTS, MAX_HOOK_INPUT_BYTES, MAX_HOOK_OUTPUT_BYTES } = await import(new URL('hooks/context.ts', root));
const { AgentClient } = await import(new URL('cli/agent-client.ts', root));
loader.deregister();

const connection = Object.freeze({ protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: '1'.repeat(64), launchId: 'launch-one',
  projectId: 'project-one', sessionId: 'session-one', taskId: 'task-one', agentToken: 'private-agent-secret_'.padEnd(43, 'z') });
const nativeId = 'native-session-123';
const core = (overrides = {}) => ({ projectId: connection.projectId, task: { id: connection.taskId, ownerSessionId: connection.sessionId, revision: 7 },
  tasks: [{ id: connection.taskId, revision: 7, intent: { revision: 2 } }], decisions: [{ id: 'decision-one', revision: 3 }], alerts: [],
  briefing: 'Tasks\nImplement the scoped endpoint.\nAccepted decisions\nUse the agreed interface.\nAlerts\n(none)', events: [], nextCursor: 0,
  truncated: { tasks: false, taskDetails: false, decisions: false, alerts: false, events: false, briefing: false },
  delivery: { id: 'delivery-one', generatedAt: 1, meaning: 'generated_context_event_metadata_only' }, ...overrides });
const identity = (overrides = {}) => ({ role: 'agent', protocolVersion: 1, stateId: connection.stateId, instanceId: 'instance-one', launchId: connection.launchId,
  projectId: connection.projectId, sessionId: connection.sessionId, taskId: connection.taskId, expiresAt: Date.now() + 120000, ...overrides });
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Murmur-State-Id': connection.stateId, 'X-Murmur-Protocol-Version': '1' } });
}
function capture() {
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return { output, text: () => Buffer.concat(chunks).toString('utf8') };
}
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'murmur-hook-test-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace'), state = path.join(temporary, 'private-state');
  await mkdir(workspace); await mkdir(path.join(workspace, 'nested')); await mkdir(state, { mode: 0o700 });
  const env = { MURMUR_AGENT_MODE: '1', MURMUR_AGENT_CONNECTION: JSON.stringify(connection), MURMUR_HOOK_WORKSPACE: workspace,
    MURMUR_HOOK_STATE_DIR: state, MURMUR_HOOK_NATIVE_SESSION_ID: nativeId, MURMUR_HOME: '/do-not-discover', HOME: '/do-not-discover' };
  const calls = [], factories = [];
  const invoke = async (options = {}) => {
    const event = options.event ?? 'PreToolUse', sink = capture();
    const input = options.input ?? Readable.from([options.raw ?? JSON.stringify({ session_id: nativeId, cwd: workspace, hook_event_name: event, ...options.payload })]);
    const chosenOutput = options.output ?? sink.output;
    const clientFactory = options.clientFactory ?? ((bound, transport) => {
      factories.push({ bound, transport });
      return { context: async (after = 0) => { calls.push(after); return options.context ? options.context(after) : core({ nextCursor: after }); } };
    });
    const before = new Map(['data', 'end', 'error', 'close'].map(name => [name, input.listenerCount(name)]));
    await hookMain([options.tool ?? 'claude', '--event', event], { env: { ...env, ...options.env }, input, output: chosenOutput,
      clientFactory, clock: options.clock ?? (() => 100), timeouts: options.timeouts });
    if (!options.output) {
      const text = sink.text();
      assert(Buffer.byteLength(text) <= MAX_HOOK_OUTPUT_BYTES);
      assert.equal(text.trim().split('\n').length, 1, 'exactly one stdout JSON object');
      for (const name of ['permissionDecision', 'permissionDecisionReason', 'updatedInput', 'decision', 'continue', 'stopReason', 'suppressOutput']) assert(!Object.hasOwn(JSON.parse(text).hookSpecificOutput ?? {}, name));
      for (const [name, count] of before) assert.equal(input.listenerCount(name), count, `input ${name} listener cleanup`);
      assert.equal(chosenOutput.listenerCount('error'), 0);
      assert.equal(chosenOutput.listenerCount('close'), 0);
      return { value: JSON.parse(text), text, input };
    }
    return { text: sink.text(), input };
  };
  return { temporary, workspace, state, env, calls, factories, invoke };
}
const contextText = result => result.value.hookSpecificOutput?.additionalContext ?? '';
function advisory(result, event = 'PreToolUse') {
  assert.deepEqual(Object.keys(result.value), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(result.value.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(result.value.hookSpecificOutput.hookEventName, event);
  assert.match(contextText(result), /ADVISORY; UNTRUSTED PROJECT DATA/);
  assert.match(contextText(result), /Core briefing \(untrusted project data\)/);
}
function unavailable(result) { assert.match(contextText(result), /Murmur advisory: fresh coordination context is unavailable/); }
async function cacheFile(f) {
  const files = await readdir(f.state);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f\d]{64}\.json$/);
  return path.join(f.state, files[0]);
}

test('import graph contains only hook, scoped client and protocol modules', () => {
  assert.deepEqual(loaded, modules);
});

test('all supported events produce both host envelopes without permission effects', async t => {
  for (const tool of ['claude', 'codex']) for (const event of HOOK_EVENTS) {
    const f = await fixture(t);
    const result = await f.invoke({ tool, event, payload: { source: 'compact', tool_name: 'Read', tool_input: { secret: 'raw-input' }, tool_response: 'raw-response',
      prompt: 'raw-prompt', transcript_path: '/raw/transcript', scratchpad_dir: '/ignored/new-field', mcp_server: 'ignored-new-field' } });
    advisory(result, event);
    assert(!result.text.includes('raw-'));
    if (event === 'PreToolUse') assert.match(contextText(result), /not evidence that the current call was replanned/);
    assert.equal(f.factories[0].bound.projectId, connection.projectId);
    assert.equal(f.factories[0].transport.timeoutMs, 500);
  }
});

test('invalid CLI arguments are static errors, with no echo or stdin read', async () => {
  for (const argv of [[], ['claude'], ['claude', '--event', 'Stop'], ['codex', '--event', 'SessionStart', '--token', 'not-public'],
    ['foreign', '--event', 'SessionStart'], ['claude', 'SessionStart'], ['claude', '--event', 'SessionStart', '--event', 'SessionStart']]) {
    const sink = capture();
    await assert.rejects(hookMain(argv, { output: sink.output }), error => error.code === 'HOOK_ARGUMENTS' && !error.message.includes('not-public'));
    assert.equal(sink.text(), '');
  }
});

test('malformed, empty, non-object, invalid UTF-8 and oversized stdin safely warn', async t => {
  const f = await fixture(t);
  for (const raw of ['', '{', 'null', '[]', '{}\n{}', '{"prompt":"secret-value"', 'x'.repeat(MAX_HOOK_INPUT_BYTES + 1), Buffer.from([0xff])]) {
    const result = await f.invoke({ raw, event: 'UserPromptSubmit' }); unavailable(result);
    assert.equal(result.value.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert(!result.text.includes('secret-value'));
  }
  assert.deepEqual(f.calls, []);
});

test('clean EOF accepts chunked UTF-8 and rejects absent payload without hanging', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify({ session_id: nativeId, cwd: f.workspace, hook_event_name: 'SessionStart', prompt: 'Split Unicode: 界' }));
  advisory(await f.invoke({ event: 'SessionStart', input: Readable.from(Array.from(bytes, byte => Buffer.from([byte]))) }), 'SessionStart');
  unavailable(await f.invoke({ input: Readable.from([]) }));
});

test('stalled, prematurely closed and errored stdin are bounded and leave no listeners', async t => {
  const f = await fixture(t);
  for (const input of [new Readable({ read() {} }), new Readable({ read() { this.destroy(); } }), new Readable({ read() { this.destroy(new Error(connection.agentToken)); } })]) {
    const start = Date.now();
    const result = await f.invoke({ input, timeouts: { inputMs: 15 } });
    unavailable(result); assert(!result.text.includes(connection.agentToken));
    assert(Date.now() - start < 1000);
    input.destroy();
  }
  assert.deepEqual(f.calls, []);
});

test('partial scoped environment cannot discover human credentials or contact transport', async t => {
  const f = await fixture(t);
  for (const env of [{ MURMUR_AGENT_MODE: undefined }, { MURMUR_AGENT_MODE: '0' }, { MURMUR_AGENT_CONNECTION: undefined },
    { MURMUR_AGENT_CONNECTION: '{}' }, { MURMUR_AGENT_CONNECTION: '{secret' }, { MURMUR_HOOK_WORKSPACE: undefined }, { MURMUR_HOOK_WORKSPACE: 'relative' }]) {
    unavailable(await f.invoke({ env }));
  }
  for (const field of Object.keys(connection)) {
    const partial = { ...connection }; delete partial[field];
    unavailable(await f.invoke({ env: { MURMUR_AGENT_CONNECTION: JSON.stringify(partial) } }));
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.factories, []);
});

test('event, session, native identity and canonical workspace checks precede transport', async t => {
  const f = await fixture(t);
  const outside = path.join(f.temporary, 'workspace-sibling'); await mkdir(outside);
  await symlink(outside, path.join(f.workspace, 'escape'));
  for (const payload of [{ hook_event_name: 'PostToolUse' }, { hook_event_name: 'Stop' }, { hook_event_name: null }, { session_id: '' },
    { session_id: 'x'.repeat(129) }, { session_id: '../../escape' }, { session_id: 'foreign' }, { cwd: outside }, { cwd: 'relative' },
    { cwd: path.join(f.workspace, 'escape') }, { cwd: path.join(f.workspace, 'missing') }]) unavailable(await f.invoke({ payload }));
  assert.deepEqual(f.calls, []);
  advisory(await f.invoke({ payload: { cwd: path.join(f.workspace, 'nested') } }));
});

test('Codex unknown native ID is hashed; payload IDs cannot override scoped binding', async t => {
  const f = await fixture(t);
  const result = await f.invoke({ tool: 'codex', env: { MURMUR_HOOK_NATIVE_SESSION_ID: undefined }, payload: {
    session_id: 'codex.native:session', projectId: 'foreign', sessionId: 'foreign', taskId: 'foreign', launchId: 'foreign', stateId: 'foreign' } });
  advisory(result); assert.deepEqual(f.factories[0].bound, connection);
  assert(!result.text.includes('foreign'));
  await cacheFile(f);
});

test('uncooperative context is bounded by whole deadline, never leaks exception details', async t => {
  const f = await fixture(t);
  const start = Date.now();
  unavailable(await f.invoke({ context: () => new Promise(() => {}), timeouts: { totalMs: 20 } }));
  assert(Date.now() - start < 1000);
  const failed = await f.invoke({ context: () => { throw new Error(`Bearer ${connection.agentToken}: raw tool_response`); } });
  unavailable(failed); assert(!failed.text.includes(connection.agentToken)); assert(!failed.text.includes('raw tool_response'));
  assert.deepEqual(await readdir(f.state), []);
});

test('real scoped client uses only HTTP GET identity/context and propagates bound cursor', async t => {
  const f = await fixture(t), calls = [];
  const clientFactory = (bound, transport) => new AgentClient(bound, { ...transport, fetch: async (url, init) => {
    calls.push({ url, init });
    return response(String(url).endsWith('/v1/agent/identity') ? identity() : core());
  } });
  advisory(await f.invoke({ clientFactory }));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init.method, 'GET');
  assert.equal(new URL(calls[1].url).searchParams.get('taskId'), connection.taskId);
  assert.equal(new URL(calls[1].url).searchParams.get('projectId'), connection.projectId);
  assert.equal(new URL(calls[1].url).searchParams.get('after'), '0');
});

test('scoped HTTP timeout, expiry, identity mismatch and server failures are advisory', async t => {
  const f = await fixture(t);
  const cases = [() => new Promise(() => {}), () => response(identity({ expiresAt: Date.now() - 1 })),
    () => response(identity({ projectId: 'foreign' })), () => response({ error: { message: connection.agentToken, code: 'TOKEN_SECRET' } }, 401)];
  for (const fetch of cases) {
    const result = await f.invoke({ clientFactory: (bound, transport) => new AgentClient(bound, { ...transport, timeoutMs: 15, fetch }) });
    unavailable(result); assert(!result.text.includes(connection.agentToken)); assert(!result.text.includes('TOKEN_SECRET'));
  }
});

test('whole deadline aborts injected HTTP transport without recursion or late cache writes', async t => {
  const f = await fixture(t);
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error(connection.agentToken)); }, { once: true });
  }));
  unavailable(await f.invoke({ clientFactory: (bound, transport) => new AgentClient(bound, transport), timeouts: { totalMs: 20 } }));
  assert(aborted);
  assert.deepEqual(await readdir(f.state), []);
});

test('briefings strictly redact token patterns and credential-shaped text; only allowed fields render', async t => {
  const f = await fixture(t);
  const secrets = [connection.agentToken, 'bearer-private', 'short-pass', 'nested-secret', 'sk-synthetic-private-key', 'ghp_syntheticprivate',
    'AKIA1234567890ABCDEF', 'A'.repeat(43), 'password-in-url', 'PEM-CONTENT', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.c2ln', 'short-id'];
  const briefing = ['Useful task text.', connection.agentToken, 'Bearer bearer-private', 'password="short-pass"', 'Task: "api_key=\\"nested-secret\\""',
    'sk-synthetic-private-key', 'ghp_syntheticprivate', 'AKIA1234567890ABCDEF', 'A'.repeat(43), 'https://name:password-in-url@example.invalid/',
    '-----BEGIN PRIVATE KEY-----\nPEM-CONTENT\n-----END PRIVATE KEY-----', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.c2ln', 'AWS_ACCESS_KEY_ID: short-id'].join('\n');
  const result = await f.invoke({ context: () => core({ briefing, secret: 'unused-secret', credential: 'unused-credential',
    events: [{ sequence: 1, type: 'task.updated', raw: 'unused-response' }], nextCursor: 1,
    decisions: [{ id: 'decision-one', revision: 3, apiKey: 'unused-key', value: 'unused-value' }] }) });
  advisory(result); assert.match(contextText(result), /Useful task text/);
  for (const secret of [...secrets, 'unused-secret', 'unused-credential', 'unused-response', 'unused-key', 'unused-value']) assert(!result.text.includes(secret), secret);
  const cached = await readFile(await cacheFile(f), 'utf8');
  assert(!cached.includes('Useful task text')); assert(!cached.includes('REDACTED'));
});

test('serialized output is UTF-8 bounded, even with escaped Unicode-heavy briefing', async t => {
  const f = await fixture(t);
  for (const briefing of ['界😀'.repeat(3000), '\n"\\'.repeat(5000)]) {
    const result = await f.invoke({ event: 'UserPromptSubmit', context: () => core({ briefing }) });
    advisory(result, 'UserPromptSubmit'); assert(Buffer.byteLength(result.text) <= MAX_HOOK_OUTPUT_BYTES);
    assert.match(contextText(result), /Briefing truncated/); assert(!result.text.includes('�'));
  }
});

test('SessionStart including compact source and UserPromptSubmit always refresh full context', async t => {
  const f = await fixture(t);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionStart', 'UserPromptSubmit']) advisory(await f.invoke({ event, payload: { source: 'compact' } }), event);
  assert.deepEqual(f.calls, [0, 0, 0, 0]);
});

test('unchanged tool hooks fetch current state but omit duplicate generation', async t => {
  const f = await fixture(t);
  advisory(await f.invoke());
  assert.deepEqual((await f.invoke()).value, {});
  assert.deepEqual((await f.invoke({ event: 'PostToolUse' })).value, {});
  assert.equal(f.calls.length, 3);
  const metadata = JSON.parse(await readFile(await cacheFile(f), 'utf8'));
  assert.deepEqual(Object.keys(metadata).sort(), ['cursor', 'fingerprint', 'generatedAt', 'version']);
  assert.equal(metadata.generatedAt, 100);
});

test('heartbeat-only and delivery timestamp changes are omitted while cursor advances', async t => {
  const f = await fixture(t);
  await f.invoke();
  const result = await f.invoke({ context: () => core({ events: [{ sequence: 5, type: 'session.heartbeat', createdAt: 99 }], nextCursor: 5,
    delivery: { id: 'new-delivery', generatedAt: 9999 }, tasks: [{ id: connection.taskId, revision: 7, intent: { revision: 2 }, updatedAt: 9999 }] }) });
  assert.deepEqual(result.value, {});
  assert.deepEqual((await f.invoke()).value, {});
  assert.deepEqual(f.calls, [0, 0, 5]);
  assert.equal(JSON.parse(await readFile(await cacheFile(f), 'utf8')).cursor, 5);
});

test('relevant events, briefing changes, intent and decision revisions produce context', async t => {
  for (const override of [
    { briefing: 'New relevant briefing.' },
    { task: { id: connection.taskId, revision: 8 } },
    { tasks: [{ id: connection.taskId, revision: 7, intent: { revision: 3 } }] },
    { decisions: [{ id: 'decision-one', revision: 4 }] },
    { events: [{ sequence: 1, type: 'reservation.acquired' }], nextCursor: 1 },
    { events: [{ sequence: 1, type: 'unknown.new.event' }], nextCursor: 1 },
  ]) {
    const f = await fixture(t); await f.invoke(); advisory(await f.invoke({ context: () => core(override) }));
  }
});

test('event pagination never skips cursor pages or suppresses incomplete heartbeat pages', async t => {
  const f = await fixture(t); await f.invoke();
  const first = await f.invoke({ context: () => core({ events: [{ sequence: 10, type: 'session.heartbeat' }], nextCursor: 10, truncated: { events: true } }) });
  advisory(first); assert.match(contextText(first), /Event page incomplete/);
  advisory(await f.invoke({ context: after => core({ events: [{ sequence: after + 1, type: 'decision.accepted' }], nextCursor: after + 1 }) }));
  assert.deepEqual((await f.invoke()).value, {});
  assert.deepEqual(f.calls, [0, 0, 10, 11]);
});

test('invalid scoped context and cursor regressions warn without replacing safe metadata', async t => {
  const f = await fixture(t);
  await f.invoke({ context: () => core({ events: [{ sequence: 3, type: 'task.updated' }], nextCursor: 3 }) });
  const file = await cacheFile(f), before = await readFile(file, 'utf8');
  for (const override of [{ projectId: 'foreign' }, { task: { id: 'foreign', revision: 1 } }, { task: { id: connection.taskId, ownerSessionId: 'foreign', revision: 1 } },
    { nextCursor: 2 }, { nextCursor: 4 }, { nextCursor: Number.MAX_SAFE_INTEGER + 1 }, { events: [{ sequence: 3, type: 'task.updated' }] },
    { events: [{ sequence: 5, type: 'task.updated' }, { sequence: 4, type: 'task.updated' }], nextCursor: 5 }]) {
    unavailable(await f.invoke({ context: () => core({ nextCursor: 3, ...override }) }));
    assert.equal(await readFile(file, 'utf8'), before);
  }
});

test('cache scope includes native session, launch, workspace and native tool', async t => {
  const f = await fixture(t); await f.invoke();
  advisory(await f.invoke({ tool: 'codex' }));
  advisory(await f.invoke({ payload: { session_id: 'second-native' }, env: { MURMUR_HOOK_NATIVE_SESSION_ID: 'second-native' } }));
  advisory(await f.invoke({ env: { MURMUR_AGENT_CONNECTION: JSON.stringify({ ...connection, launchId: 'launch-two' }) } }));
  assert.equal((await readdir(f.state)).length, 4);
});

test('missing, unsafe, source-tree or symlink cache directories use fresh uncached context', async t => {
  const f = await fixture(t);
  const linked = path.join(f.temporary, 'state-link'); await symlink(f.state, linked);
  const openState = path.join(f.temporary, 'open-state'); await mkdir(openState, { mode: 0o755 });
  const sourceState = path.join(f.workspace, 'state'); await mkdir(sourceState, { mode: 0o700 });
  for (const directory of [undefined, 'relative', path.join(f.temporary, 'missing'), linked, openState, sourceState]) {
    advisory(await f.invoke({ env: { MURMUR_HOOK_STATE_DIR: directory } }));
    advisory(await f.invoke({ env: { MURMUR_HOOK_STATE_DIR: directory } }));
  }
  assert.deepEqual(await readdir(f.state), []); assert.deepEqual(await readdir(openState), []); assert.deepEqual(await readdir(sourceState), []);
  await assert.rejects(lstat(path.join(f.temporary, 'missing')), { code: 'ENOENT' });
});

test('exclusive lock contention uses uncached context and does not remove or guess lock owner', async t => {
  const f = await fixture(t); await f.invoke();
  const file = await cacheFile(f), lock = file.replace(/\.json$/, '.lock'), before = await readFile(file, 'utf8');
  await writeFile(lock, 'unknown lock owner; never kill a PID', { mode: 0o600 });
  advisory(await f.invoke({ clock: () => 200 }));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await readFile(lock, 'utf8'), 'unknown lock owner; never kill a PID');
  assert.deepEqual(f.calls, [0, 0]);
});

test('symlink cache and lock files cannot redirect reads or writes', async t => {
  for (const kind of ['cache', 'lock']) {
    const f = await fixture(t); await f.invoke();
    const file = await cacheFile(f), outside = path.join(f.temporary, 'do-not-touch'); await writeFile(outside, 'private outside contents');
    if (kind === 'cache') { await rm(file); await symlink(outside, file); }
    else await symlink(outside, file.replace(/\.json$/, '.lock'));
    advisory(await f.invoke());
    assert.equal(await readFile(outside, 'utf8'), 'private outside contents');
  }
});

test('malformed, loose-mode and oversized cache metadata cannot cause stale omission', async t => {
  for (const invalid of ['{}', '{"briefing":"raw cached content"}', 'x'.repeat(2048), 'loose-mode']) {
    const f = await fixture(t); await f.invoke(); const file = await cacheFile(f);
    if (invalid === 'loose-mode') await chmod(file, 0o644); else await writeFile(file, invalid);
    advisory(await f.invoke()); assert.deepEqual(f.calls, [0, 0]);
  }
});

test('cache directory substitution during fetch prevents omission and metadata write', async t => {
  const f = await fixture(t); await f.invoke();
  const old = path.join(f.temporary, 'old-state'), substitute = path.join(f.temporary, 'substitute'); await mkdir(substitute, { mode: 0o700 });
  const result = await f.invoke({ context: async after => {
    await rename(f.state, old); await symlink(substitute, f.state); return core({ nextCursor: after });
  } });
  advisory(result); assert.deepEqual(await readdir(substitute), []);
  assert((await readdir(old)).some(file => file.endsWith('.lock')), 'do not guess or delete a lock in a replaced directory');
});

test('cache metadata is owner-private and contains no raw project data or native IDs', async t => {
  const f = await fixture(t); await f.invoke(); const file = await cacheFile(f);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, 'utf8');
  for (const value of [connection.agentToken, nativeId, connection.taskId, connection.launchId, 'scoped endpoint', 'interface', 'briefing', 'password']) assert(!text.includes(value));
  assert(Buffer.byteLength(text) <= 1024);
});

test('failed or stalled stdout never commits cache and runtime error resolves', async t => {
  for (const mode of ['error', 'stall', 'destroyed']) {
    const f = await fixture(t);
    const output = new Writable({ write(_chunk, _encoding, callback) { if (mode === 'error') callback(new Error(connection.agentToken)); } });
    if (mode === 'destroyed') output.destroy();
    const start = Date.now();
    await f.invoke({ output, timeouts: { outputMs: 15 } });
    assert(Date.now() - start < 1000); assert.deepEqual(await readdir(f.state), []);
    assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
    output.destroy();
  }
});

test('cache commit happens after stdout callback; failed emission preserves prior generation', async t => {
  const f = await fixture(t); await f.invoke(); const file = await cacheFile(f), before = await readFile(file, 'utf8');
  let observed = false;
  const output = new Writable({ write(_chunk, _encoding, callback) {
    readFile(file, 'utf8').then(value => { assert.equal(value, before); observed = true; callback(new Error('broken pipe')); }, callback);
  } });
  await f.invoke({ output, context: () => core({ briefing: 'Fresh changed briefing' }), clock: () => 200 });
  assert(observed); assert.equal(await readFile(file, 'utf8'), before);
  advisory(await f.invoke({ context: () => core({ briefing: 'Fresh changed briefing' }) }));
});


test('late stream callbacks after a timeout are contained and listeners are cleaned', async t => {
  const f = await fixture(t);
  let inputCallback;
  const input = new Readable({ read() {}, destroy(_error, callback) { inputCallback = callback; callback(); } });
  unavailable(await f.invoke({ input, timeouts: { inputMs: 10 } }));
  assert(input.destroyed); assert.equal(typeof inputCallback, 'function');
  let writeCallback;
  const output = new Writable({ write(_chunk, _encoding, callback) { writeCallback = callback; } });
  await f.invoke({ output, timeouts: { outputMs: 10 } });
  assert(output.destroyed);
  writeCallback(new Error(connection.agentToken));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
  assert.deepEqual(await readdir(f.state), []);
});


test('the exact stdin byte limit is accepted and one extra byte fails before transport', async t => {
  const f = await fixture(t);
  const value = { session_id: nativeId, cwd: f.workspace, hook_event_name: 'SessionStart', prompt: '' };
  value.prompt = 'x'.repeat(MAX_HOOK_INPUT_BYTES - Buffer.byteLength(JSON.stringify(value)));
  const raw = JSON.stringify(value);
  assert.equal(Buffer.byteLength(raw), MAX_HOOK_INPUT_BYTES);
  advisory(await f.invoke({ event: 'SessionStart', raw }), 'SessionStart');
  unavailable(await f.invoke({ event: 'SessionStart', raw: raw + ' ' }));
  assert.equal(f.calls.length, 1);
});

test('real stdin pipes exit zero after malformed EOF or a stalled host, without native tools', async () => {
  const script = `
    import {readFileSync} from 'node:fs';
    import {registerHooks,stripTypeScriptTypes} from 'node:module';
    const allowed=new Set(${JSON.stringify([...modules])});
    const root=${JSON.stringify(root.href)};
    registerHooks({
      resolve(specifier,context,next) {
        if(context.parentURL?.startsWith(root)&&specifier.startsWith('.')) {
          const url=new URL(specifier.replace(/\\.js$/,'.ts'),context.parentURL).href;
          if(!allowed.has(url)) throw new Error('Unexpected import');
          return {url,shortCircuit:true};
        }
        return next(specifier,context);
      },
      load(url,context,next) {
        if(!allowed.has(url)) return next(url,context);
        return {format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'strip'}),shortCircuit:true};
      }
    });
    const {hookMain}=await import(${JSON.stringify(new URL('cli/hook.ts', root).href)});
    await hookMain(['claude','--event','SessionStart'],{env:{},timeouts:{inputMs:25}});
  `;
  for (const stalled of [false, true]) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal})); });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      if (!stalled) child.stdin.end('{');
      const result = await completed;
      assert.deepEqual(result, {code: 0, signal: null}, stderr);
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /unavailable/);
      assert(!stderr.includes('Hook context unavailable')); assert(!stderr.includes('Invalid hook input'));
    } finally { clearTimeout(timer); child.stdin.destroy(); }
  }
});


test('long punctuation-bearing strings remain bounded during credential redaction', async t => {
  const f = await fixture(t), start = Date.now();
  advisory(await f.invoke({ context: () => core({ briefing: 'a-'.repeat(16000) }) }));
  assert(Date.now() - start < 1000);
});
