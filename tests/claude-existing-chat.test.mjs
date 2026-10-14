import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';

const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['adapters/existing-chat.ts', 'adapters/claude-existing-chat.ts', 'cli/external-helper.ts', 'cli/external-client.ts', 'protocol/index.ts', 'protocol/agent.ts', 'protocol/external.ts'].map(file => new URL(file, root).href));
const loaded = new Set();
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Native adapter must not import human discovery, MCP or generic CLI: ${url}`);
      return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!modules.has(url)) return next(url, context);
    loaded.add(url); return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const { nativeMain, createNativeSetupBundle, exportExistingChatSetup, quoteNativeShell, CLAUDE_NATIVE_SKILL, CLAUDE_EXISTING_CHAT_CAPABILITY } = await import(new URL('adapters/existing-chat.ts', root));
const { parseClaudeConnectPrompt, claudeProjectRoot, claudeHookOutput, claudeRefreshOutput, readClaudeHookInput, CLAUDE_HOOK_INPUT_BYTES, CLAUDE_HOOK_OUTPUT_BYTES } = await import(new URL('adapters/claude-existing-chat.ts', root));
const { ExistingChatHelper } = await import(new URL('cli/external-helper.ts', root));
const { MurmurError } = await import(new URL('protocol/index.ts', root));
hooks.deregister();
const hash = value => createHash('sha256').update(value).digest('hex');
const code = value => error => error instanceof MurmurError && error.code === value;
const text = output => output.hookSpecificOutput?.additionalContext ?? '';
const event = (cwd, prompt = '/murmur:connect status', id = randomUUID(), extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt, ...extra });
const invoke = (descriptorPath, input, options = {}) => nativeMain(['hook', '--descriptor', descriptorPath], { stdin: Readable.from([Buffer.from(JSON.stringify(input))]), ...options });
async function temporary(t) {
  assert(process.env.TMPDIR); const directory = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-claude-adapter-test-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function fixture(t) {
  const directory = await temporary(t), workspace = path.join(directory, 'project'), service = path.join(directory, 'service');
  await mkdir(workspace); await mkdir(path.join(workspace, '.git')); await mkdir(path.join(workspace, 'src'));
  await mkdir(service, { mode: 0o700 }); await mkdir(path.join(service, 'existing-chats'), { mode: 0o700 });
  const privateDirectory = path.join(service, 'existing-chats', 'claude'); await mkdir(privateDirectory, { mode: 0o700 });
  const descriptor = { protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: 'a'.repeat(64), instanceId: randomUUID() };
  const descriptorPath = path.join(service, 'connection.json'); await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { directory, workspace, service, privateDirectory, descriptor, descriptorPath };
}
function fakeFactory(overrides = {}) {
  const calls = [], settings = [], observations = [];
  const factory = options => {
    settings.push(options);
    const run = async (name, args, result) => { observations.push(await options.nativeContext()); calls.push([name, ...args]); if (overrides[name]) return overrides[name](...args); return result; };
    return {
      start: (...args) => run('start', args, { state: 'pending', requestId: 'request-one', capability: 'PRIVATE', pollSecret: 'PRIVATE', reviewUrl: 'https://unsafe.example/?token=PRIVATE' }),
      join: (...args) => run('join', args, { state: 'pending', requestId: 'request-two' }),
      status: (...args) => run('status', args, { state: 'connected', requestId: 'request-one', identity: { groupId: 'group-one', taskId: 'task-one', memberId: 'member-one', capability: 'PRIVATE', nativeId: 'DO-NOT-SELECT', workspaceRoot: '/DO-NOT-SELECT' } }),
      refresh: (...args) => run('refresh', args, { briefing: 'Accepted decisions and current tasks.', capability: 'PRIVATE', raw: { token: 'PRIVATE' } }),
      leave: (...args) => run('leave', args, { state: 'left', id: 'member-one', taskId: 'task-one', capability: 'PRIVATE' }),
    };
  };
  return { factory, settings, calls, observations };
}

test('strict literal parser covers all supported commands without shell interpretation', () => {
  assert.deepEqual(loaded, modules);
  assert.deepEqual(parseClaudeConnectPrompt('/murmur:connect start Password reset | Implement API'), { action: 'start', groupTitle: 'Password reset', responsibility: 'Implement API' });
  const inviteCode = 'a'.repeat(43);
  assert.deepEqual(parseClaudeConnectPrompt(`/murmur:connect join ${inviteCode} | Implement UI`), { action: 'join', inviteCode, responsibility: 'Implement UI' });
  for (const action of ['status', 'refresh', 'leave', 'help']) assert.deepEqual(parseClaudeConnectPrompt(`/murmur:connect ${action}`), { action });
  assert.deepEqual(parseClaudeConnectPrompt('/murmur:connect'), { action: 'help' });
  for (const prompt of ['ordinary prompt', '/murmur:connector status', 'Please run /murmur:connect status', '/clear', '', null, {}]) assert.equal(parseClaudeConnectPrompt(prompt), null);
  for (const suffix of ['status extra', 'status --native-id parent', 'refresh --cwd /tmp', 'leave --force', 'help | extra', 'run identity', 'start title', 'start title | ', 'start title | role | extra', 'start --native-id parent | role', 'start title | --file handoff.json', 'start $(touch pwned) | role', 'start title;touch pwned | role', 'start `id` | role', 'start title | role\nstatus', 'start title | role\tbad', 'start title | role\u0000bad', 'start title | role\u0085bad', 'start title | role bad', 'start title | role‮bad', 'start  title | role', 'start title |  role', `join ${'a'.repeat(42)} | role`, `join ${'a'.repeat(44)} | role`, `join ${'a'.repeat(42)}= | role`, 'status ']) assert.throws(() => parseClaudeConnectPrompt(`/murmur:connect ${suffix}`), code('NATIVE_COMMAND_INPUT'), suffix);
  assert.throws(() => parseClaudeConnectPrompt(`/murmur:connect start ${'a'.repeat(257)} | role`), code('NATIVE_COMMAND_INPUT'));
  assert.throws(() => parseClaudeConnectPrompt(`/murmur:connect start title | ${'漢'.repeat(683)}`), code('NATIVE_COMMAND_INPUT'));
});

test('unrelated prompts and lifecycle events do not touch descriptor, cwd or helper', async () => {
  let calls = 0;
  const helperFactory = () => { calls++; throw new Error('MUST NOT RUN'); };
  for (const input of [event('/absent', 'ordinary prompt', 'invalid'), event('/absent', '/clear', 'invalid'), event('/absent', '/murmur:connector status', 'invalid'), { hook_event_name: 'SessionStart', source: 'clear', session_id: randomUUID(), cwd: '/absent', prompt: '/murmur:connect status' }, { hook_event_name: 'SessionEnd', reason: 'clear', session_id: randomUUID(), cwd: '/absent' }]) assert.deepEqual(await invoke('not-even-a-descriptor', input, { helperFactory }), {});
  assert.equal(calls, 0);
});

test('host UUID and exact canonical cwd are required; help never accesses descriptor', async t => {
  const f = await fixture(t), fake = fakeFactory();
  for (const id of ['', 'parent-id', '../parent', '--session', '00000000-0000-0000-0000-000000000000', randomUUID().toUpperCase(), `${randomUUID()}\n`]) assert.match(text(await invoke(f.descriptorPath, event(f.workspace, '/murmur:connect status', id), { helperFactory: fake.factory })), /NATIVE_CONTEXT_INVALID/);
  const alias = path.join(f.directory, 'alias'); await symlink(f.workspace, alias);
  for (const cwd of ['relative', '/missing-native-workspace', `${f.workspace}/../project`, `${f.workspace}//src`, alias, `${f.workspace}\n`]) assert.match(text(await invoke(f.descriptorPath, event(cwd), { helperFactory: fake.factory })), /NATIVE_CONTEXT_INVALID/);
  assert.equal(fake.calls.length, 0);
  assert.equal(await claudeProjectRoot(path.join(f.workspace, 'src')), f.workspace);
  assert.match(text(await invoke('must-not-read-descriptor', event(f.workspace, '/murmur:connect help'), { helperFactory: fake.factory })), /2\.1\.247/);
  assert.equal(fake.settings.length, 0);
});

test('stdin is bounded to 16 KiB, fatal UTF8, and an explicit deadline', async t => {
  const f = await fixture(t), fake = fakeFactory();
  const raw = { hook_event_name: 'UserPromptSubmit', prompt: 'unrelated', padding: '' };
  raw.padding = 'x'.repeat(CLAUDE_HOOK_INPUT_BYTES - Buffer.byteLength(JSON.stringify(raw)));
  assert.equal(Buffer.byteLength(JSON.stringify(raw)), CLAUDE_HOOK_INPUT_BYTES);
  assert.deepEqual(await invoke('/invalid', raw, { helperFactory: fake.factory }), {});
  raw.padding += 'x'; assert.match(text(await invoke('/invalid', raw, { helperFactory: fake.factory })), /NATIVE_HOOK_INPUT/);
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('{'), Buffer.from('[]'), Buffer.from('null'), Buffer.alloc(0)]) {
    const output = await nativeMain(['hook', '--descriptor', f.descriptorPath], { stdin: Readable.from([bytes]), helperFactory: fake.factory });
    assert.match(text(output), /NATIVE_HOOK_INPUT/);
  }
  const input = Buffer.from(JSON.stringify(event(f.workspace, '/murmur:connect start 漢字 | Work')));
  const output = await nativeMain(['hook', '--descriptor', f.descriptorPath], { stdin: Readable.from(Array.from(input, byte => Buffer.from([byte]))), helperFactory: fake.factory });
  assert.match(text(output), /pending/);
  const stalled = new PassThrough(); t.after(() => stalled.destroy());
  assert.match(text(await nativeMain(['hook', '--descriptor', f.descriptorPath], { stdin: stalled, stdinTimeoutMs: 10, helperFactory: fake.factory })), /NATIVE_HOOK_TIMEOUT/);
  assert.equal(fake.calls.length, 1);
});

test('fixed hook dispatches only explicit actions with fresh host context and safe projections', async t => {
  const f = await fixture(t), fake = fakeFactory(), id = randomUUID(), cwd = path.join(f.workspace, 'src');
  const options = { helperFactory: fake.factory };
  const extra = { nativeId: 'copied-parent', incarnationId: 'copied-parent', workspaceRoot: '/copied-parent', source: 'fork', parent_session_id: 'copied-parent', transcript_path: '/must-not-read-history' };
  const results = [];
  for (const prompt of ['/murmur:connect start API group | Implement API', `/murmur:connect join ${'a'.repeat(43)} | Implement UI`, '/murmur:connect status', '/murmur:connect refresh', '/murmur:connect leave']) results.push(await invoke(f.descriptorPath, event(cwd, prompt, id, extra), options));
  assert.deepEqual(fake.calls, [['start', { groupTitle: 'API group', responsibility: 'Implement API' }], ['join', 'a'.repeat(43), { responsibility: 'Implement UI' }], ['status'], ['status'], ['refresh'], ['leave']]);
  for (const observed of fake.observations) assert.deepEqual(observed, { native: { tool: 'claude', nativeId: id, incarnationId: id }, workspaceRoot: f.workspace, incarnationVerified: true });
  for (const settings of fake.settings) { assert.equal(settings.privateDirectory, f.privateDirectory); assert.equal(settings.descriptorPath, f.descriptorPath); assert.deepEqual(Object.keys(settings).sort(), ['descriptorPath', 'nativeContext', 'privateDirectory']); }
  assert.match(text(results[0]), /Public request ID: request-one/); assert.match(text(results[0]), /http:\/\/127\.0\.0\.1:43123\/ui\//);
  assert(!JSON.stringify(results).includes('PRIVATE')); assert(!JSON.stringify(results).includes('copied-parent')); assert(!JSON.stringify(results).includes('unsafe.example')); assert(!JSON.stringify(results).includes('DO-NOT-SELECT'));
  assert.match(text(results[2]), /taskId: task-one/); assert.match(text(results[3]), /Accepted decisions/); assert.match(text(results[4]), /task and native chat were preserved/);
  for (const result of results) { assert.deepEqual(Object.keys(result), ['hookSpecificOutput']); assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit'); }
});

test('leave requires the actual left membership response, not a synthetic success receipt', async t => {
  const f = await fixture(t), fake = fakeFactory({ leave: () => ({ left: true, taskPreserved: true }) });
  const result = await invoke(f.descriptorPath, event(f.workspace, '/murmur:connect leave'), { helperFactory: fake.factory });
  assert.match(text(result), /NATIVE_ACTION_FAILED/); assert(!text(result).includes('were preserved'));
});

test('pending refresh checks approval but never calls scoped context prematurely', async t => {
  const f = await fixture(t), fake = fakeFactory({ status: () => ({ state: 'pending', requestId: 'r' }) });
  assert.match(text(await invoke(f.descriptorPath, event(f.workspace, '/murmur:connect refresh'), { helperFactory: fake.factory })), /pending/);
  assert.deepEqual(fake.calls, [['status']]);
});

test('hook output and failures are bounded and never echo raw errors or helper secrets', async t => {
  const f = await fixture(t);
  const fake = fakeFactory({ refresh: () => ({ briefing: `${'漢字\\\"\n'.repeat(5000)}END`, capability: 'RAW-SECRET' }) });
  const result = await invoke(f.descriptorPath, event(f.workspace, '/murmur:connect refresh'), { helperFactory: fake.factory });
  assert(Buffer.byteLength(JSON.stringify(result) + '\n') <= CLAUDE_HOOK_OUTPUT_BYTES);
  assert.match(text(result), /Context truncated/); assert(!text(result).includes('�')); assert(!JSON.stringify(result).includes('RAW-SECRET'));
  const astral = String.fromCodePoint(0x1d11e).repeat(5000); const bounded = claudeHookOutput(astral);
  assert(Buffer.byteLength(JSON.stringify(bounded) + '\n') <= CLAUDE_HOOK_OUTPUT_BYTES); assert(!text(bounded).includes('�'));
  for (const error of [new Error('RAW-CAPABILITY RAW-POLL-SECRET'), new MurmurError('RAW-CAPABILITY', 'ATTACKER_CONTROLLED_CODE'), new MurmurError('RAW-CAPABILITY', 'EXTERNAL_EXPIRED', 401)]) {
    const failed = fakeFactory({ status: () => { throw error; } });
    const output = await invoke(f.descriptorPath, event(f.workspace), { helperFactory: failed.factory });
    assert(!JSON.stringify(output).includes('RAW-')); assert(!JSON.stringify(output).includes('ATTACKER_CONTROLLED_CODE')); assert.match(text(output), /Murmur (NATIVE_ACTION_FAILED|EXTERNAL_EXPIRED):/);
  }
});

test('unsafe descriptor and private helper directory are rejected before helper creation', async t => {
  const f = await fixture(t), fake = fakeFactory(), input = event(f.workspace);
  const missing = path.join(f.service, 'daemon.json'); assert.match(text(await invoke(missing, input, { helperFactory: fake.factory })), /NATIVE_DESCRIPTOR_INVALID/);
  await chmod(f.privateDirectory, 0o755);
  assert.match(text(await invoke(f.descriptorPath, input, { helperFactory: fake.factory })), /NATIVE_DESCRIPTOR_INVALID/); await chmod(f.privateDirectory, 0o700);
  await rename(f.privateDirectory, `${f.privateDirectory}-old`); await symlink(`${f.privateDirectory}-old`, f.privateDirectory);
  assert.match(text(await invoke(f.descriptorPath, input, { helperFactory: fake.factory })), /NATIVE_DESCRIPTOR_INVALID/);
  assert.equal(fake.settings.length, 0);
});

async function realHelperFixture(t) {
  const f = await fixture(t), requests = [], network = [], results = [];
  const saved = async () => Promise.all((await readdir(f.privateDirectory)).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(path.join(f.privateDirectory, file), 'utf8'))));
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Murmur-State-Id': f.descriptor.stateId, 'X-Murmur-Protocol-Version': '1' } });
  const fetch = async (url, init) => {
    const endpoint = new URL(url).pathname, headers = new Headers(init.headers); network.push(endpoint);
    if (endpoint === '/v1/enrollment/requests') {
      const input = JSON.parse(init.body), states = await saved(); const state = states.find(item => item.requestKey === headers.get('Idempotency-Key'));
      assert(state); assert.equal(hash(state.candidateCapability), input.capabilityHash); assert.equal(hash(state.pollSecret), input.pollSecretHash);
      const row = { input, capability: state.candidateCapability, pollSecret: state.pollSecret, receipt: { requestId: randomUUID(), state: 'pending', revision: 1, expiresAt: Date.now() + 60_000, decidedAt: null }, grantDeadline: Date.now() + 3600_000 };
      requests.push(row); return response(row.receipt);
    }
    if (endpoint === '/v1/enrollment/status') {
      const row = requests.find(item => item.receipt.requestId === JSON.parse(init.body).requestId); assert(row); assert.equal(headers.get('Authorization'), `Bearer ${row.pollSecret}`); return response(row.receipt);
    }
    const row = requests.find(item => headers.get('Authorization') === `Bearer ${item.capability}`); assert(row);
    if (row.receipt.state !== 'approved' || row.left) return response({ error: { code: 'EXTERNAL_UNAUTHORIZED', message: row.capability } }, 401);
    const n = requests.indexOf(row);
    if (endpoint === '/v1/external/identity') return response({ role: 'external', protocolVersion: 1, stateId: f.descriptor.stateId, instanceId: f.descriptor.instanceId, grantId: `grant-${n}`, projectId: 'project-one', sessionId: `session-${n}`, taskId: `task-${n}`, memberId: `member-${n}`, groupId: 'group-one', workspaceRoot: f.workspace, expiresAt: row.grantDeadline, membershipRevision: 1 });
    if (endpoint === '/v1/external/context') return response({ briefing: `Task ${n}; accepted decision. ${row.capability} ${row.pollSecret}`, capability: row.capability });
    if (endpoint === '/v1/external/leave') { row.left = true; return response({ state: 'left', id: `member-${n}`, taskId: `task-${n}`, kind: 'external', revision: 2 }); }
    throw new Error('Unexpected endpoint');
  };
  const call = async (id, prompt, extra = {}) => { const output = await invoke(f.descriptorPath, event(path.join(f.workspace, 'src'), prompt, id, extra), { helperFactory: options => new ExistingChatHelper({ ...options, transport: { fetch } }) }); results.push(output); return output; };
  return { ...f, requests, network, results, saved, call, approve: () => { for (const row of requests) row.receipt = { ...row.receipt, state: 'approved', revision: 2, decidedAt: Date.now() }; } };
}

test('real helper dispatch isolates current UUIDs, resume, fork and clear without copied selectors', async t => {
  const f = await realHelperFixture(t), a = randomUUID(), b = randomUUID(), fork = randomUUID(), cleared = randomUUID();
  const [ar, br] = await Promise.all([f.call(a, '/murmur:connect start Shared work | Backend'), f.call(b, `/murmur:connect join ${'b'.repeat(43)} | Frontend`)]);
  assert.match(text(ar), /pending/); assert.match(text(br), /pending/); assert.equal(f.requests.length, 2);
  const states = await f.saved(); assert.notEqual(states[0].candidateCapability, states[1].candidateCapability); assert.notEqual(states[0].pollSecret, states[1].pollSecret);
  for (const row of f.requests) { assert.equal(row.input.native.nativeId, row.input.native.incarnationId); assert([a, b].includes(row.input.native.nativeId)); assert.equal(row.input.workspaceRoot, f.workspace); }
  f.approve();
  assert.match(text(await f.call(a, '/murmur:connect refresh')), /Task/); assert.match(text(await f.call(b, '/murmur:connect refresh')), /Task/);
  const resumed = await f.call(a, '/murmur:connect status', { source: 'resume' }); assert.match(text(resumed), /connected/); assert.equal(f.requests.length, 2);
  const before = f.network.length;
  assert.match(text(await f.call(fork, '/murmur:connect refresh', { source: 'fork', parent_session_id: a })), /disconnected/);
  assert.deepEqual(await invoke(f.descriptorPath, { hook_event_name: 'SessionEnd', session_id: a, reason: 'clear', cwd: f.workspace }), {});
  assert.deepEqual(await invoke(f.descriptorPath, { hook_event_name: 'SessionStart', session_id: cleared, source: 'clear', cwd: f.workspace }), {});
  assert.match(text(await f.call(cleared, '/murmur:connect refresh', { source: 'clear', parent_session_id: a })), /disconnected/);
  assert.equal(f.network.length, before);
  for (const prompt of [`/murmur:connect status --session ${a}`, `/murmur:connect refresh --cwd ${f.workspace}`, `/murmur:connect refresh --file ${path.join(f.privateDirectory, 'copied.json')}`]) assert.match(text(await f.call(fork, prompt)), /NATIVE_COMMAND_INPUT/);
  assert.equal(f.network.length, before);
  assert.match(text(await f.call(fork, '/murmur:connect start Fork work | Separate review')), /pending/);
  assert.match(text(await f.call(cleared, '/murmur:connect start Cleared work | Separate review')), /pending/);
  assert.equal(f.requests.length, 4);
  assert.match(text(await f.call(a, '/murmur:connect leave')), /preserved/); assert.match(text(await f.call(a, '/murmur:connect status')), /left/);
  assert.match(text(await f.call(b, '/murmur:connect status')), /connected/);
  const output = JSON.stringify(f.results);
  for (const state of await f.saved()) { assert(!output.includes(state.candidateCapability)); assert(!output.includes(state.pollSecret)); }
});

async function setupFixture(t, version = '2.1.247 (Claude Code)') {
  const f = await fixture(t), cliPath = path.join(f.directory, 'cli.js'), claudeExecutable = path.join(f.directory, 'claude');
  await writeFile(cliPath, '// fixture only\n');
  await writeFile(claudeExecutable, `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 8\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
  return { ...f, options: { tool: 'claude', stateDirectory: f.service, outputDirectory: path.join(f.directory, 'new-plugin'), cliPath, claudeExecutable, nodeExecutable: process.execPath } };
}

test('setup only supports the observed exact version and performs no export on mismatch', async t => {
  assert.equal(CLAUDE_EXISTING_CHAT_CAPABILITY.testedVersion, '2.1.247'); assert.equal(CLAUDE_EXISTING_CHAT_CAPABILITY.hotAttachVerified, false);
  for (const version of ['2.1.246 (Claude Code)', '2.1.248 (Claude Code)', '2.1.247', 'unrelated tool 2.1.247']) {
    const f = await setupFixture(t, version);
    await assert.rejects(exportExistingChatSetup(f.options), code('NATIVE_SETUP_VERSION'));
    await assert.rejects(lstat(f.options.outputDirectory), { code: 'ENOENT' });
  }
});

test('setup rejects target/parent/helper symlinks, nonprivate state and absent actual CLI', async t => {
  const f = await setupFixture(t), existing = path.join(f.directory, 'existing'); await mkdir(existing);
  const targetLink = path.join(f.directory, 'target-link'); await symlink(existing, targetLink);
  await assert.rejects(exportExistingChatSetup({ ...f.options, outputDirectory: targetLink }), code('NATIVE_SETUP_EXISTS'));
  const parentLink = path.join(f.directory, 'parent-link'); await symlink(existing, parentLink);
  await assert.rejects(exportExistingChatSetup({ ...f.options, outputDirectory: path.join(parentLink, 'plugin') }), code('NATIVE_SETUP_PATH'));
  await chmod(f.service, 0o755); await assert.rejects(exportExistingChatSetup(f.options), code('NATIVE_SETUP_PATH')); await chmod(f.service, 0o700);
  await rename(f.privateDirectory, `${f.privateDirectory}-old`); await symlink(`${f.privateDirectory}-old`, f.privateDirectory);
  await assert.rejects(exportExistingChatSetup(f.options), code('NATIVE_SETUP_PATH'));
  await rm(f.privateDirectory); await rename(`${f.privateDirectory}-old`, f.privateDirectory);
  await assert.rejects(exportExistingChatSetup({ ...f.options, cliPath: path.join(f.directory, 'missing-cli.js') }), code('NATIVE_SETUP_FAILED'));
  assert.deepEqual(await readdir(existing), []);
});

test('pure plugin builder quotes every fixed path and leaves no model invocation or identity interpolation', () => {
  const options = { nodeExecutable: "/fixture/node's bin", cliPath: '/fixture/cli $(literal).js', descriptorPath: '/fixture/state;literal/connection.json' };
  const bundle = createNativeSetupBundle(options);
  assert.deepEqual(bundle.files.map(file => file.path), ['.claude-plugin/plugin.json', 'skills/connect/SKILL.md', 'hooks/hooks.json']);
  const manifest = JSON.parse(bundle.files[0].content); assert.equal(manifest.name, 'murmur');
  const hook = JSON.parse(bundle.files[2].content).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.command, `${quoteNativeShell(options.nodeExecutable)} ${quoteNativeShell(options.cliPath)} native hook --descriptor ${quoteNativeShell(options.descriptorPath)}`);
  assert.match(CLAUDE_NATIVE_SKILL, /name: connect/); assert.match(CLAUDE_NATIVE_SKILL, /disable-model-invocation: true/);
  assert(!/!|ARGUMENTS|CLAUDE_SESSION_ID|\$\{/.test(CLAUDE_NATIVE_SKILL));
  assert(!/ARGUMENTS|CLAUDE_SESSION_ID|nativeId|incarnationId|--force|--cwd/.test(hook.command));
  for (const bad of ['relative', '/fixture/../node', '/fixture/node\n']) assert.throws(() => createNativeSetupBundle({ ...options, nodeExecutable: bad }), code('NATIVE_SETUP_PATH'));
});

test('already scoped native processes cannot create a second connection', async t => {
  const f = await fixture(t), fake = fakeFactory();
  for (const env of [{MURMUR_AGENT_MODE:'1'},{MURMUR_AGENT_CONNECTION:'partial'},{MURMUR_EXTERNAL_MODE:'1'},{MURMUR_EXTERNAL_CONNECTION:'partial'}]) {
    const result = await invoke(f.descriptorPath, event(f.workspace, '/murmur:connect start Duplicate | Wrong second scope'), { helperFactory: fake.factory, env });
    assert.match(text(result), /NATIVE_ALREADY_SCOPED/);
  }
});

test('multibyte task text cannot starve accepted decisions or conflict alerts', () => {
  const briefing='Tasks\n'+'界'.repeat(6000)+'\n\nLinked group (reviewed)\n'+'組'.repeat(2000)+'\n\nAccepted decisions\nAccepted api.route@v1: POST /reset\n\nAlerts\nConflict: two producers';
  const result=claudeRefreshOutput('Murmur connection: connected.',briefing);
  assert(Buffer.byteLength(JSON.stringify(result)+'\n')<=CLAUDE_HOOK_OUTPUT_BYTES);
  assert(text(result).includes('Accepted api.route@v1: POST /reset'));
  assert(text(result).includes('Conflict: two producers'));
  assert(text(result).includes('Context truncated'));
});

test('failed native stdin is destroyed and contains late pipe errors', async () => {
  class LatePipe extends PassThrough {
    _destroy(_error, callback) { setTimeout(()=>{ this.emit('error',new Error('late fixture error')); callback(); },5); }
  }
  const input=new LatePipe();
  await assert.rejects(readClaudeHookInput(input,1),code('NATIVE_HOOK_TIMEOUT'));
  assert.equal(input.destroyed,true);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(input.closed,true); assert.equal(input.listenerCount('error'),0);
});
