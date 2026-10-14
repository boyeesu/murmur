import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';

// Test current source without building or loading generic CLI/human discovery.
const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set([
  'adapters/existing-chat.ts', 'adapters/codex-existing-chat.ts', 'adapters/claude-existing-chat.ts',
  'adapters/native-chat.ts', 'cli/external-helper.ts', 'cli/external-client.ts',
  'protocol/index.ts', 'protocol/agent.ts', 'protocol/external.ts',
].map(file => new URL(file, root).href));
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
    loaded.add(url);
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const { nativeMain } = await import(new URL('adapters/existing-chat.ts', root));
const { CODEX_EXISTING_CHAT_CAPABILITY, CODEX_CONNECT_SYNTAX, parseCodexConnectPrompt, codexPrivateDirectory, codexNativeHook } = await import(new URL('adapters/codex-existing-chat.ts', root));
const { NATIVE_HOOK_INPUT_BYTES, NATIVE_HOOK_OUTPUT_BYTES, nativeProjectRoot, readNativeHookInput, nativeHookOutput, nativeRefreshOutput } = await import(new URL('adapters/native-chat.ts', root));
const { ExistingChatHelper } = await import(new URL('cli/external-helper.ts', root));
const { MurmurError } = await import(new URL('protocol/index.ts', root));
hooks.deregister();

const hash = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error instanceof MurmurError && error.code === expected;
const text = output => output.hookSpecificOutput?.additionalContext ?? '';
const uuid = 'aabbccdd-1234-4abc-8def-0123456789ab';
const invite = 'aB0_-'.repeat(8) + 'xY9';
const event = (cwd, prompt = 'murmur-connect status', id = uuid, extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt, ...extra });
const inputStream = input => Readable.from([Buffer.from(JSON.stringify(input))]);
const invoke = (descriptorPath, input, options = {}) => nativeMain(['codex-hook', '--descriptor', descriptorPath], { env: {}, stdin: inputStream(input), ...options });
function assertOutput(output) {
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(typeof text(output), 'string');
  assert(text(output).isWellFormed(), 'Output must not split Unicode surrogate pairs');
  assert(Buffer.byteLength(JSON.stringify(output) + '\n') <= NATIVE_HOOK_OUTPUT_BYTES);
}
async function temporary(t) {
  assert(process.env.TMPDIR, 'Tests require the runner temporary directory');
  const directory = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-codex-adapter-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture(t) {
  const directory = await temporary(t), workspace = path.join(directory, 'project'), service = path.join(directory, 'service');
  await mkdir(workspace); await mkdir(path.join(workspace, '.git')); await mkdir(path.join(workspace, 'src'));
  await mkdir(service, { mode: 0o700 }); await mkdir(path.join(service, 'existing-chats'), { mode: 0o700 });
  const privateDirectory = path.join(service, 'existing-chats', 'codex');
  const claudeDirectory = path.join(service, 'existing-chats', 'claude');
  await mkdir(privateDirectory, { mode: 0o700 }); await mkdir(claudeDirectory, { mode: 0o700 });
  const descriptor = { protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: 'a'.repeat(64), instanceId: randomUUID() };
  const descriptorPath = path.join(service, 'connection.json');
  await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { directory, workspace, service, privateDirectory, claudeDirectory, descriptor, descriptorPath };
}
function fakeFactory(overrides = {}) {
  const calls = [], settings = [], observations = [];
  const factory = options => {
    settings.push(options);
    const run = async (name, args, fallback) => {
      observations.push(await options.nativeContext()); calls.push([name, ...args]);
      return overrides[name] ? overrides[name](...args) : fallback;
    };
    return {
      start: (...args) => run('start', args, { state: 'pending', requestId: 'request-one', capability: 'PRIVATE', pollSecret: 'PRIVATE', reviewUrl: 'https://unsafe.example/?token=PRIVATE' }),
      join: (...args) => run('join', args, { state: 'pending', requestId: 'request-two' }),
      status: (...args) => run('status', args, { state: 'connected', requestId: 'request-one', identity: { groupId: 'group-one', taskId: 'task-one', memberId: 'member-one', nativeId: 'PRIVATE', workspaceRoot: '/PRIVATE', capability: 'PRIVATE' } }),
      refresh: (...args) => run('refresh', args, { briefing: 'Tasks\nImplement API\n\nAccepted decisions\nAccepted route@v1: POST /reset\n\nAlerts\nConflict: two producers', capability: 'PRIVATE', raw: { token: 'PRIVATE' } }),
      refreshApproved: (...args) => run('refreshApproved', args, { briefing: 'Tasks\nImplement API\n\nAccepted decisions\nAccepted route@v1: POST /reset\n\nAlerts\nConflict: two producers', capability: 'PRIVATE', raw: { token: 'PRIVATE' } }),
      leave: (...args) => run('leave', args, { state: 'left', id: 'member-one', taskId: 'task-one', capability: 'PRIVATE' }),
    };
  };
  return { factory, calls, settings, observations };
}

// Only this in-memory transport receives requests. No daemon, model, native CLI,
// global fetch, environment credential, or user configuration is consulted.
async function realHelperFixture(t) {
  const f = await fixture(t), requests = [], network = [], results = [];
  const saved = async () => {
    const entries = [];
    for (const [tool, directory] of [['codex', f.privateDirectory], ['claude', f.claudeDirectory]]) {
      for (const name of (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const filename = path.join(directory, name);
        entries.push({ tool, filename, state: JSON.parse(await readFile(filename, 'utf8')) });
      }
    }
    return entries;
  };
  const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'X-Murmur-State-Id': f.descriptor.stateId, 'X-Murmur-Protocol-Version': '1', ...headers },
  });
  const fetch = async (url, init) => {
    const address = new URL(url), endpoint = address.pathname, headers = new Headers(init.headers);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    assert.equal(address.origin, f.descriptor.origin);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(headers.get('X-Murmur-State-Id'), f.descriptor.stateId);
    assert.equal(headers.get('X-Murmur-Protocol-Version'), '1');
    assert(['/v1/enrollment/requests', '/v1/enrollment/status', '/v1/external/identity', '/v1/external/context', '/v1/external/leave'].includes(endpoint), `Unexpected endpoint ${endpoint}`);
    network.push({ endpoint, method: init.method, body, authorization: headers.get('Authorization') });
    if (endpoint === '/v1/enrollment/requests') {
      assert.equal(init.method, 'POST'); assert.equal(headers.get('Authorization'), null);
      const entry = (await saved()).find(item => item.state.requestKey === headers.get('Idempotency-Key'));
      assert(entry, 'Private proofs must be persisted before enrollment');
      const { state } = entry;
      assert.equal(hash(state.candidateCapability), body.capabilityHash); assert.equal(hash(state.pollSecret), body.pollSecretHash);
      const row = { input: body, capability: state.candidateCapability, pollSecret: state.pollSecret,
        receipt: { requestId: randomUUID(), state: 'pending', revision: 1, expiresAt: Date.now() + 60_000, decidedAt: null },
        grantDeadline: Date.now() + 3600_000, filename: entry.filename };
      requests.push(row); return response(row.receipt);
    }
    if (endpoint === '/v1/enrollment/status') {
      assert.equal(init.method, 'POST');
      const row = requests.find(item => item.receipt.requestId === body.requestId); assert(row);
      assert.equal(headers.get('Authorization'), `Bearer ${row.pollSecret}`); return response(row.receipt);
    }
    const row = requests.find(item => headers.get('Authorization') === `Bearer ${item.capability}`); assert(row);
    if (row.receipt.state !== 'approved' || row.revoked || row.left) return response({ error: { code: 'EXTERNAL_UNAUTHORIZED', message: row.capability } }, 401);
    const n = requests.indexOf(row);
    if (endpoint === '/v1/external/identity') {
      assert.equal(init.method, 'GET');
      return response({ role: 'external', protocolVersion: 1, stateId: f.descriptor.stateId, instanceId: f.descriptor.instanceId,
        grantId: `grant-${n}`, projectId: 'project-one', sessionId: `session-${n}`, taskId: `task-${n}`, memberId: `member-${n}`,
        groupId: 'group-one', workspaceRoot: f.workspace, expiresAt: row.grantDeadline, membershipRevision: 1 });
    }
    if (endpoint === '/v1/external/context') {
      assert.equal(init.method, 'GET'); assert.equal(address.search, '?after=0');
      if (row.contextFailure) return row.contextFailure(response);
      return response({ briefing: `Tasks\nTask ${n}: ${row.input.responsibility}; ${row.capability} ${row.pollSecret}\n\nAccepted decisions\nAccepted route@v1\n\nAlerts\nConflict: shared write`, capability: row.capability });
    }
    assert.equal(init.method, 'POST'); assert.deepEqual(body, {});
    row.left = true;
    return response({ state: 'left', id: `member-${n}`, taskId: `task-${n}`, kind: 'external', revision: 2 });
  };
  const helperFactory = options => new ExistingChatHelper({ ...options, transport: { fetch } });
  const call = async (id, prompt, extra = {}, tool = 'codex') => {
    const output = await nativeMain([tool === 'codex' ? 'codex-hook' : 'hook', '--descriptor', f.descriptorPath], {
      env: {}, stdin: inputStream(event(path.join(f.workspace, 'src'), prompt, id, extra)), helperFactory,
    });
    results.push(output); return output;
  };
  const approve = (...rows) => { for (const row of rows.length ? rows : requests) row.receipt = { ...row.receipt, state: 'approved', revision: row.receipt.revision + 1, decidedAt: Date.now() }; };
  const endpoints = since => network.slice(since).map(item => item.endpoint);
  return { ...f, requests, network, results, saved, helperFactory, call, approve, endpoints };
}

test('Codex runtime exposes plain current-chat commands and a constrained import surface', () => {
  assert.deepEqual(loaded, modules);
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.tool, 'codex');
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.identitySource, 'UserPromptSubmit.session_id');
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.nativeResumePreservesIdentity, true);
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.nativeForkAndNewChangeIdentity, true);
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.genericMcp, false);
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.hotAttachVerified, false);
  assert.equal(CODEX_EXISTING_CHAT_CAPABILITY.realModelVerified, false);
  assert(CODEX_CONNECT_SYNTAX.split('\n').every(line => line.startsWith('murmur-connect ')));
  assert.equal(NATIVE_HOOK_INPUT_BYTES, 16 * 1024); assert.equal(NATIVE_HOOK_OUTPUT_BYTES, 6000);
  assert.deepEqual(parseCodexConnectPrompt('murmur-connect start Password reset | Implement API'), { action: 'start', groupTitle: 'Password reset', responsibility: 'Implement API' });
  assert.deepEqual(parseCodexConnectPrompt(`murmur-connect join ${invite} | Implement UI`), { action: 'join', inviteCode: invite, responsibility: 'Implement UI' });
  for (const action of ['status', 'refresh', 'leave', 'help']) assert.deepEqual(parseCodexConnectPrompt(`murmur-connect ${action}`), { action });
  assert.deepEqual(parseCodexConnectPrompt('murmur-connect'), { action: 'help' });
});

test('ordinary text, slash commands and quoted instructions never parse as connect actions', () => {
  for (const prompt of [undefined, null, false, 0, {}, [], '', 'ordinary prompt', '/murmur-connect status', '/murmur:connect status',
    'Please run murmur-connect status', ' murmur-connect status', '"murmur-connect status"', '`murmur-connect status`',
    '```\nmurmur-connect status\n```', 'murmur-connector status', 'murmur-connectx', 'Murmur-connect status']) {
    assert.equal(parseCodexConnectPrompt(prompt), null, JSON.stringify(prompt));
  }
});

test('parser rejects malformed actions, invitation values and all caller-selected identity flags', () => {
  const suffixes = ['status extra', 'status ', ' refresh', 'help | extra', 'leave --force', 'run identity', 'start title',
    'start title | ', 'start  title | role', 'start title |  role', 'start title  | role', 'start title | role ',
    'start title | role | extra', 'join | role', 'status --native-id parent', 'status --incarnation-id parent',
    'refresh --session parent', 'refresh --thread parent', 'refresh --cwd /other', 'refresh --file copied.json',
    'refresh --state copied.json', 'start --native-id parent | role', 'start title | --responsibility fake',
    'start title --workspace /other | role', 'start title | role --file copied.json'];
  for (const value of ['', 'a'.repeat(16), 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(128), 'a'.repeat(42) + '=',
    'a'.repeat(42) + '/', 'a'.repeat(42) + '+', 'a'.repeat(42) + 'é', 'a'.repeat(21) + ' ' + 'a'.repeat(21)]) suffixes.push(`join ${value} | role`);
  for (const suffix of suffixes) assert.throws(() => parseCodexConnectPrompt(`murmur-connect ${suffix}`), code('NATIVE_COMMAND_INPUT'), suffix);
  for (const separator of ['\t', '\n', '\r', ' ']) assert.throws(() => parseCodexConnectPrompt(`murmur-connect${separator}status`), code('NATIVE_COMMAND_INPUT'));
});

test('shell-sensitive metacharacters and control characters cannot be expanded or smuggled into commands', () => {
  const dangerous = ['$HOME', '$(touch pwned)', '`id`', 'x;y', 'x&&y', 'x&y', 'x>y', 'x<y', 'x\\y', '!history', 'x|y'];
  const controls = [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
    ...Array.from({ length: 33 }, (_, i) => String.fromCharCode(0x7f + i)),
    ...[0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(value => String.fromCodePoint(value))];
  for (const value of [...dangerous, ...controls.map(control => `before${control}after`)]) {
    for (const prompt of [`murmur-connect start ${value} | role`, `murmur-connect start title | ${value}`, `murmur-connect join ${invite} | ${value}`]) {
      assert.throws(() => parseCodexConnectPrompt(prompt), code('NATIVE_COMMAND_INPUT'), JSON.stringify(prompt));
    }
  }
});

test('literal quote, glob and Unicode values round-trip at deterministic UTF-8 byte boundaries', () => {
  const literal = `O'Reilly "reset" (v2) [draft] * ? ~ # % =`;
  assert.deepEqual(parseCodexConnectPrompt(`murmur-connect start ${literal} | ${literal}`), { action: 'start', groupTitle: literal, responsibility: literal });
  for (const unit of ['x', 'é', '漢', '\u{1d11e}', 'é', '"']) {
    for (const maximum of [256, 2048]) {
      for (const bytes of [maximum - 1, maximum, maximum + 1]) {
        const size = Buffer.byteLength(unit), value = unit.repeat(Math.floor(bytes / size)) + 'x'.repeat(bytes % size);
        assert.equal(Buffer.byteLength(value), bytes);
        const groupTitle = maximum === 256 ? value : 'title', responsibility = maximum === 2048 ? value : 'role';
        const prompt = `murmur-connect start ${groupTitle} | ${responsibility}`;
        if (bytes <= maximum) assert.deepEqual(parseCodexConnectPrompt(prompt), { action: 'start', groupTitle, responsibility });
        else assert.throws(() => parseCodexConnectPrompt(prompt), code('NATIVE_COMMAND_INPUT'));
      }
    }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  for (let seed = 0; seed < alphabet.length; seed++) {
    const inviteCode = Array.from({ length: 43 }, (_, i) => alphabet[(seed + i * 17) % alphabet.length]).join('');
    assert.deepEqual(parseCodexConnectPrompt(`murmur-connect join ${inviteCode} | literal role`), { action: 'join', inviteCode, responsibility: 'literal role' });
  }
});

test('fixed entrypoint rejects direct native actions, extra arguments and spoofed selectors', async () => {
  for (const argv of [[], ['start'], ['codex-hook'], ['codex-hook', '--descriptor'], ['codex-hook', '--native-id', uuid],
    ['codex-hook', '--descriptor', '/unused', '--session', uuid], ['codex-hook', '--descriptor', '/unused', '--cwd', '/other'],
    ['codex-hook', '--descriptor=/unused'], ['codex-hook', '--descriptor', '/unused', '--force']]) {
    await assert.rejects(nativeMain(argv, { env: {}, helperFactory: () => assert.fail('No helper may be created') }), code('NATIVE_ADAPTER_UNVERIFIED'));
  }
});

test('other host lifecycle events and missing or nonstring prompts are no-ops before path access', async () => {
  let creations = 0;
  const helperFactory = () => { creations++; assert.fail('No helper may be created'); };
  for (const hook_event_name of ['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse', 'PostToolUse', 'Notification', 'user_prompt_submit', '', undefined]) {
    assert.deepEqual(await invoke('invalid-descriptor', { hook_event_name, prompt: 'murmur-connect start Group | Role', session_id: 'invalid', cwd: '/absent' }, { helperFactory }), {});
  }
  for (const prompt of [undefined, null, 1, false, [], {}]) assert.deepEqual(await invoke('invalid-descriptor', event('/absent', prompt, 'invalid', { prompt }), { helperFactory }), {});
  assert.equal(creations, 0);
});

test('host identity requires the strict current UUID and exact canonical cwd, never parent or environment selectors', async t => {
  const f = await fixture(t), fake = fakeFactory();
  const spoof = { nativeId: uuid, incarnationId: uuid, thread_id: uuid, parent_session_id: uuid, sessionId: uuid, native: { tool: 'codex', nativeId: uuid }, workspaceRoot: f.workspace };
  const env = { CODEX_THREAD_ID: uuid, CODEX_SESSION_ID: uuid, CLAUDE_SESSION_ID: uuid, PWD: f.workspace, HOME: '/must-not-read-user-config' };
  for (const id of [undefined, null, 1, {}, '', '../parent', 'parent-id', uuid.toUpperCase(), `${uuid}\n`, ` ${uuid}`, uuid.replace('-4abc-', '-0abc-'), uuid.replace('-8def-', '-7def-'), '00000000-0000-0000-0000-000000000000']) {
    const result = await invoke(f.descriptorPath, event(f.workspace, 'murmur-connect status', id, { ...spoof, session_id: id }), { helperFactory: fake.factory, env });
    assert.match(text(result), /NATIVE_CONTEXT_INVALID/);
  }
  const alias = path.join(f.directory, 'alias'); await symlink(f.workspace, alias);
  const notDirectory = path.join(f.directory, 'file'); await writeFile(notDirectory, 'not a directory');
  for (const cwd of [undefined, null, {}, 'relative', path.join(f.directory, 'missing'), `${f.workspace}/../project`, `${f.workspace}//src`, `${f.workspace}/`, alias, path.join(alias, 'src'), notDirectory, `${f.workspace}\n`]) {
    assert.match(text(await invoke(f.descriptorPath, event(cwd), { helperFactory: fake.factory, env })), /NATIVE_CONTEXT_INVALID/);
  }
  assert.equal(fake.settings.length, 0);
});

test('host context ignores injected model, fork, transcript and environment identity on every dispatched action', async t => {
  const f = await fixture(t), fake = fakeFactory(), parent = randomUUID();
  const extra = { source: 'fork', parent_session_id: parent, thread_id: parent, nativeId: parent, incarnationId: parent,
    native: { tool: 'claude', nativeId: parent }, workspaceRoot: '/copied-parent', transcript_path: '/must-not-read-history',
    model: { session_id: parent, cwd: '/copied-parent' } };
  const env = { CODEX_THREAD_ID: parent, CODEX_SESSION_ID: parent, CLAUDE_SESSION_ID: parent, PWD: '/copied-parent', HOME: '/must-not-read-user-config' };
  for (const prompt of ['murmur-connect start API group | Implement API', `murmur-connect join ${invite} | Implement UI`, 'murmur-connect status', 'murmur-connect refresh', 'murmur-connect leave']) {
    const result = await invoke(f.descriptorPath, event(path.join(f.workspace, 'src'), prompt, uuid, extra), { helperFactory: fake.factory, env });
    assertOutput(result); assert(!JSON.stringify(result).includes(parent)); assert(!JSON.stringify(result).includes('PRIVATE'));
  }
  assert.deepEqual(fake.calls, [['start', { groupTitle: 'API group', responsibility: 'Implement API' }], ['join', invite, { responsibility: 'Implement UI' }], ['status'], ['status'], ['refresh'], ['status'], ['leave']]);
  for (const observation of fake.observations) assert.deepEqual(observation, { native: { tool: 'codex', nativeId: uuid, incarnationId: uuid }, workspaceRoot: f.workspace, incarnationVerified: true });
  for (const settings of fake.settings) {
    assert.equal(settings.privateDirectory, f.privateDirectory); assert.equal(settings.descriptorPath, f.descriptorPath);
    assert.deepEqual(Object.keys(settings).sort(), ['descriptorPath', 'nativeContext', 'privateDirectory']);
  }
});

test('project-root metadata and fresh context detect directory changes without reading Git or native histories', async t => {
  const f = await fixture(t);
  assert.equal(await nativeProjectRoot(path.join(f.workspace, 'src')), f.workspace);
  const plain = path.join(f.directory, 'plain'); await mkdir(plain);
  assert.equal(await nativeProjectRoot(plain), plain);
  await writeFile(path.join(plain, '.git'), 'gitdir: /must-not-follow-or-read\n');
  await mkdir(path.join(plain, 'src')); assert.equal(await nativeProjectRoot(path.join(plain, 'src')), plain);
  await rm(path.join(plain, '.git')); await symlink(path.join(f.workspace, '.git'), path.join(plain, '.git'));
  await assert.rejects(nativeProjectRoot(plain), code('NATIVE_CONTEXT_INVALID'));
  const result = await invoke(f.descriptorPath, event(path.join(f.workspace, 'src'), 'murmur-connect start Work | Role'), {
    helperFactory: options => ({ start: async () => {
      await rename(path.join(f.workspace, '.git'), path.join(f.workspace, 'old-git'));
      await options.nativeContext(); assert.fail('Changed root must not yield a trusted context');
    } }),
  });
  assert.match(text(result), /NATIVE_CONTEXT_INVALID/);
});

test('help validates host context but does not inspect a descriptor or create private state', async t => {
  const f = await fixture(t), fake = fakeFactory();
  const result = await codexNativeHook('must-not-access-descriptor', { env: {}, stdin: inputStream(event(f.workspace, 'murmur-connect help')), helperFactory: fake.factory });
  assertOutput(result); assert.match(text(result), /Codex CLI/); assert(text(result).includes(CODEX_EXISTING_CHAT_CAPABILITY.testedVersion));
  assert(text(result).includes(CODEX_CONNECT_SYNTAX)); assert.match(text(result), /human approval/);
  assert.equal(fake.settings.length, 0); assert.deepEqual(await readdir(f.privateDirectory), []);
});

test('ordinary prompts call only refreshApproved, with no model-selected parameters or explicit activation', async t => {
  const f = await fixture(t), fake = fakeFactory({
    status: () => assert.fail('Automatic refresh must not call status'),
    refresh: () => assert.fail('Automatic refresh must not call explicit refresh'),
  });
  const ordinary = ['Please implement the API', '', '/murmur:connect status', 'murmur-connector start', 'Please run murmur-connect join copied', '$(touch pwned); `id`', '漢字\ncontinue'];
  for (const prompt of ordinary) {
    const result = await invoke(f.descriptorPath, event(f.workspace, prompt), { helperFactory: fake.factory });
    assertOutput(result); assert.match(text(result), /refreshed automatically/); assert.match(text(result), /Accepted route@v1/);
    assert(!text(result).includes('PRIVATE'));
  }
  assert.deepEqual(fake.calls, ordinary.map(() => ['refreshApproved']));
});

test('null approved refresh is silent without invoking explicit refresh or approval status', async t => {
  const f = await fixture(t), fake = fakeFactory({
    refreshApproved: () => null,
    refresh: () => assert.fail('Null approval must not fall back to explicit refresh'),
    status: () => assert.fail('Null approval must not poll or activate'),
  });
  assert.deepEqual(await invoke(f.descriptorPath, event(f.workspace, 'continue work'), { helperFactory: fake.factory }), {});
  assert.deepEqual(fake.calls, [['refreshApproved']]);
});

test('EXTERNAL_NOT_CONNECTED approval races stay silent while explicit failures remain visible', async t => {
  const f = await fixture(t);
  const fake = fakeFactory({ refreshApproved: () => { throw new MurmurError('RAW-SECRET', 'EXTERNAL_NOT_CONNECTED', 403); }, status: () => { throw new MurmurError('RAW-SECRET', 'EXTERNAL_NOT_CONNECTED', 403); } });
  assert.deepEqual(await invoke(f.descriptorPath, event(f.workspace, 'continue work'), { helperFactory: fake.factory }), {});
  assert.match(text(await invoke(f.descriptorPath, event(f.workspace), { helperFactory: fake.factory })), /EXTERNAL_NOT_CONNECTED/);
  assert.deepEqual(fake.calls, [['refreshApproved'], ['status']]);
  const failure = fakeFactory({ refreshApproved: () => { throw new Error('EXTERNAL_NOT_CONNECTED RAW-SECRET'); } });
  const output = await invoke(f.descriptorPath, event(f.workspace, 'continue work'), { helperFactory: failure.factory });
  assert.match(text(output), /NATIVE_ACTION_FAILED/); assert(!text(output).includes('RAW-SECRET'));
});

test('managed and external scopes suppress ordinary hooks and reject every explicit connect action', async () => {
  let creations = 0;
  const helperFactory = () => { creations++; assert.fail('Already scoped process must not construct a helper'); };
  for (const env of [{ MURMUR_AGENT_MODE: '1' }, { MURMUR_AGENT_CONNECTION: 'partial' }, { MURMUR_AGENT_UNKNOWN: '' },
    { MURMUR_EXTERNAL_MODE: '1' }, { MURMUR_EXTERNAL_CONNECTION: 'partial' }, { MURMUR_EXTERNAL_UNKNOWN: '' }]) {
    assert.deepEqual(await invoke('invalid-descriptor', event('/absent', 'continue work', 'invalid'), { env, helperFactory }), {});
    for (const prompt of ['murmur-connect', 'murmur-connect start Group | Role', `murmur-connect join ${invite} | Role`,
      'murmur-connect status', 'murmur-connect refresh', 'murmur-connect leave', 'murmur-connect help']) {
      assert.match(text(await invoke('invalid-descriptor', event('/absent', prompt, 'invalid'), { env, helperFactory })), /NATIVE_ALREADY_SCOPED/);
    }
  }
  assert.equal(creations, 0);
});

test('pending, rejected and disconnected explicit refreshes check status without scoped context', async t => {
  const f = await fixture(t);
  for (const state of ['pending', 'approved', 'disconnected', 'left', 'retired', 'rejected', 'expired', 'not-submitted']) {
    const fake = fakeFactory({ status: () => ({ state, requestId: 'public-request' }) });
    const result = await invoke(f.descriptorPath, event(f.workspace, 'murmur-connect refresh'), { helperFactory: fake.factory });
    assertOutput(result); assert(text(result).includes(`Murmur connection: ${state}.`)); assert.deepEqual(fake.calls, [['status']]);
  }
});

test('stdin enforces 16 KiB before descriptor access, accepts split UTF-8, and rejects malformed JSON shapes', async t => {
  const f = await fixture(t), fake = fakeFactory();
  const raw = { hook_event_name: 'SessionStart', padding: '' };
  raw.padding = 'x'.repeat(NATIVE_HOOK_INPUT_BYTES - Buffer.byteLength(JSON.stringify(raw)));
  assert.equal(Buffer.byteLength(JSON.stringify(raw)), NATIVE_HOOK_INPUT_BYTES);
  assert.deepEqual(await invoke('invalid-descriptor', raw, { helperFactory: fake.factory }), {});
  raw.padding += 'x'; assert.match(text(await invoke('invalid-descriptor', raw, { helperFactory: fake.factory })), /NATIVE_HOOK_INPUT/);
  for (const bytes of [Buffer.alloc(0), Buffer.from('{'), Buffer.from('[]'), Buffer.from('null'), Buffer.from('42'), Buffer.from('"string"'), Buffer.from([0xff, 0xfe]), Buffer.from('{"prompt":"\xc3"}', 'binary')]) {
    const result = await codexNativeHook('invalid-descriptor', { env: {}, stdin: Readable.from([bytes]), helperFactory: fake.factory });
    assert.match(text(result), /NATIVE_HOOK_INPUT/); assertOutput(result);
  }
  assert.equal(fake.settings.length, 0);
  const bytes = Buffer.from(JSON.stringify(event(f.workspace, 'murmur-connect start 漢字𝄞 | Unicode work')));
  const result = await codexNativeHook(f.descriptorPath, { env: {}, stdin: Readable.from([...bytes].map(byte => Buffer.from([byte]))), helperFactory: fake.factory });
  assert.match(text(result), /pending/);
  assert.deepEqual(fake.calls, [['start', { groupTitle: '漢字𝄞', responsibility: 'Unicode work' }]]);
});

test('stdin deadline, invalid timeouts and late stream failures are bounded and cleaned up', async () => {
  for (const timeout of [0, -1, 1.5, 10_001, NaN]) await assert.rejects(readNativeHookInput(Readable.from(['{}']), timeout), code('NATIVE_HOOK_INPUT'));
  await assert.rejects(readNativeHookInput(Readable.from([{}])), code('NATIVE_HOOK_INPUT'));
  const failed = new PassThrough();
  const failure = readNativeHookInput(failed); failed.destroy(new Error('RAW-PIPE-SECRET'));
  await assert.rejects(failure, code('NATIVE_HOOK_INPUT'));
  class LatePipe extends PassThrough {
    _destroy(_error, callback) { setTimeout(() => { this.emit('error', new Error('RAW-LATE-SECRET')); callback(); }, 5); }
  }
  const stalled = new LatePipe();
  const result = await codexNativeHook('invalid-descriptor', { env: {}, stdin: stalled, stdinTimeoutMs: 1 });
  assert.match(text(result), /NATIVE_HOOK_TIMEOUT/); assert(!text(result).includes('RAW-'));
  assert.equal(stalled.destroyed, true);
  await new Promise(resolve => stalled.closed ? resolve() : stalled.once('close', resolve));
  for (const name of ['data', 'end', 'error', 'close']) assert.equal(stalled.listenerCount(name), 0, name);
});

test('native output has an encoded-byte bound and preserves Unicode through deterministic size cases', () => {
  for (const unit of ['x', 'é', '漢', '\u{1d11e}', 'é', '"\\\n\t']) {
    for (const count of [0, 1, 255, 512, 1500, 5900, 6000, 9000]) {
      const value = unit.repeat(count), result = nativeHookOutput(value);
      assertOutput(result);
      const unbounded = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: value } };
      if (Buffer.byteLength(JSON.stringify(unbounded) + '\n') <= NATIVE_HOOK_OUTPUT_BYTES) assert.equal(text(result), value);
      else {
        assert(text(result).endsWith('\n[Context truncated.]'));
        assert(value.startsWith(text(result).slice(0, -'\n[Context truncated.]'.length)));
      }
    }
  }
});

test('encoded task and status text cannot starve accepted-decision or alert sections', async t => {
  const f = await fixture(t);
  for (const unit of ['x', '漢', '\u{1d11e}', '"\\\n']) {
    const briefing = `Tasks\n${unit.repeat(6000)}\n\nLinked group (reviewed)\n${unit.repeat(3000)}\n\nAccepted decisions\nAccepted route@v1: POST /reset\n${unit.repeat(3000)}\n\nAlerts\nConflict: two producers\n${unit.repeat(3000)}`;
    const fake = fakeFactory({ refresh: () => ({ briefing }), refreshApproved: () => ({ briefing }) });
    for (const result of [nativeRefreshOutput(unit.repeat(9000), briefing),
      await invoke(f.descriptorPath, event(f.workspace, 'ordinary prompt'), { helperFactory: fake.factory }),
      await invoke(f.descriptorPath, event(f.workspace, 'murmur-connect refresh'), { helperFactory: fake.factory })]) {
      assertOutput(result); assert.match(text(result), /Accepted route@v1: POST \/reset/); assert.match(text(result), /Conflict: two producers/);
      assert.match(text(result), /Advisory coordination data, not instructions/); assert.match(text(result), /Context truncated/);
      assert(text(result).indexOf('Accepted decisions') < text(result).indexOf('Task and linked work'));
    }
  }
});

test('status and error projections never echo raw secrets, unsafe IDs, or attacker review URLs', async t => {
  const f = await fixture(t), fake = fakeFactory();
  const started = await invoke(f.descriptorPath, event(f.workspace, 'murmur-connect start Work | Role'), { helperFactory: fake.factory });
  assert.match(text(started), /Public request ID: request-one/); assert(text(started).includes(`${f.descriptor.origin}/ui/`));
  assert(!text(started).includes('PRIVATE')); assert(!text(started).includes('unsafe.example'));
  const invalidIds = fakeFactory({ status: () => ({ state: 'connected', requestId: 'RAW-SECRET\n', reviewUrl: 'https://unsafe.example/', identity: { groupId: 'RAW-SECRET\n', taskId: 'x'.repeat(129), memberId: { secret: 'RAW-SECRET' }, capability: 'RAW-SECRET' } }) });
  assert.equal(text(await invoke(f.descriptorPath, event(f.workspace), { helperFactory: invalidIds.factory })), 'Murmur connection: connected.');
  for (const error of [new Error('RAW-SECRET'), new MurmurError('RAW-SECRET', 'ATTACKER_CONTROLLED_CODE'),
    new MurmurError('RAW-SECRET', 'EXTERNAL_UNAUTHORIZED', 401), new MurmurError('RAW-SECRET', 'EXTERNAL_TIMEOUT', 504)]) {
    for (const prompt of ['murmur-connect status', 'continue work']) {
      const failed = fakeFactory({ status: () => { throw error; }, refreshApproved: () => { throw error; } });
      const result = await invoke(f.descriptorPath, event(f.workspace, prompt), { helperFactory: failed.factory });
      assertOutput(result); assert.match(text(result), /Murmur (NATIVE_ACTION_FAILED|EXTERNAL_UNAUTHORIZED|EXTERNAL_TIMEOUT):/);
      assert(!text(result).includes('RAW-SECRET')); assert(!text(result).includes('ATTACKER_CONTROLLED_CODE'));
    }
  }
});

test('malformed helper responses cannot claim success or synthesize a leave receipt', async t => {
  const f = await fixture(t);
  for (const response of [null, [], {}, { state: 'attacker\nstate' }, { state: 'connected', identity: [] }]) {
    const fake = fakeFactory({ status: () => response });
    assert.match(text(await invoke(f.descriptorPath, event(f.workspace), { helperFactory: fake.factory })), /NATIVE_ACTION_FAILED/);
  }
  for (const response of [undefined, null, {}, [], { briefing: 1 }, { briefing: ['not text'] }]) {
    const fake = fakeFactory({ refresh: () => response, refreshApproved: () => response });
    assert.match(text(await invoke(f.descriptorPath, event(f.workspace, 'murmur-connect refresh'), { helperFactory: fake.factory })), /NATIVE_ACTION_FAILED/);
    if (response !== null) assert.match(text(await invoke(f.descriptorPath, event(f.workspace, 'continue work'), { helperFactory: fake.factory })), /NATIVE_ACTION_FAILED/);
  }
  for (const response of [{ left: true, taskPreserved: true }, { state: 'active', id: 'member', taskId: 'task' }, { state: 'left', id: 'member' }, { state: 'left', id: 'member', taskId: 'unsafe\n' }]) {
    const fake = fakeFactory({ leave: () => response });
    const result = await invoke(f.descriptorPath, event(f.workspace, 'murmur-connect leave'), { helperFactory: fake.factory });
    assert.match(text(result), /NATIVE_ACTION_FAILED/); assert(!text(result).includes('were preserved'));
  }
});

test('descriptor and Codex private directory reject unsafe files before constructing a helper', async t => {
  const mutations = [
    ['missing descriptor', f => rm(f.descriptorPath)],
    ['public descriptor', f => chmod(f.descriptorPath, 0o644)],
    ['public service', f => chmod(f.service, 0o755)],
    ['public private parent', f => chmod(path.dirname(f.privateDirectory), 0o755)],
    ['public tool directory', f => chmod(f.privateDirectory, 0o755)],
    ['missing tool directory', f => rm(f.privateDirectory, { recursive: true })],
    ['symlink descriptor', async f => { await rename(f.descriptorPath, `${f.descriptorPath}.old`); await symlink(`${f.descriptorPath}.old`, f.descriptorPath); }],
    ['hardlinked descriptor', f => link(f.descriptorPath, path.join(f.service, 'other.json'))],
    ['symlink tool directory', async f => { await rename(f.privateDirectory, `${f.privateDirectory}-old`); await symlink(`${f.privateDirectory}-old`, f.privateDirectory); }],
    ['symlink private parent', async f => { const parent = path.dirname(f.privateDirectory); await rename(parent, `${parent}-old`); await symlink(`${parent}-old`, parent); }],
    ['non-loopback descriptor', f => writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, origin: 'https://unsafe.example' }))],
    ['credential-bearing descriptor', f => writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, token: 'RAW-SECRET' }))],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const f = await fixture(t), fake = fakeFactory(); await mutate(f);
    for (const prompt of ['murmur-connect status', 'ordinary prompt']) {
      const result = await invoke(f.descriptorPath, event(f.workspace, prompt), { helperFactory: fake.factory });
      assert.match(text(result), /NATIVE_DESCRIPTOR_INVALID/); assert(!text(result).includes('RAW-SECRET'));
    }
    assert.equal(fake.settings.length, 0);
  });
});

test('private state must remain outside the source workspace and the descriptor path stays explicit', async t => {
  const f = await fixture(t), fake = fakeFactory();
  assert.equal(codexPrivateDirectory(f.descriptorPath), f.privateDirectory);
  for (const descriptorPath of ['relative/connection.json', path.join(f.service, 'daemon.json'), `${f.service}/../service/connection.json`]) {
    assert.match(text(await invoke(descriptorPath, event(f.workspace), { helperFactory: fake.factory })), /NATIVE_DESCRIPTOR_INVALID/);
  }
  const inside = path.join(f.workspace, 'service'); await rename(f.service, inside);
  const result = await invoke(path.join(inside, 'connection.json'), event(f.workspace), { helperFactory: fake.factory });
  assert.match(text(result), /NATIVE_DESCRIPTOR_INVALID/); assert.equal(fake.settings.length, 0);
});

test('real helper stays silent without membership or while approval waits, including server-approved but unactivated requests', async t => {
  const f = await realHelperFixture(t);
  const emptyEntries = await readdir(f.privateDirectory); assert.deepEqual(emptyEntries, []);
  for (const id of [uuid, randomUUID()]) assert.deepEqual(await f.call(id, 'ordinary absent chat'), {});
  assert.equal(f.network.length, 0);
  assert.deepEqual(await readdir(f.privateDirectory), emptyEntries, 'Unlinked prompts must not create a binding, mutex, or other helper entry');
  assert.equal((await f.saved()).length, 0);
  assert.match(text(await f.call(uuid, 'murmur-connect start Work | Backend')), /pending/);
  assert.deepEqual(f.endpoints(0), ['/v1/enrollment/requests']);
  const row = f.requests[0], before = await readFile(row.filename, 'utf8'), boundary = f.network.length;
  const pendingEntries = (await readdir(f.privateDirectory)).sort();
  assert.deepEqual(await f.call(uuid, 'ordinary pending chat'), {});
  f.approve(row);
  assert.deepEqual(await f.call(uuid, 'ordinary approved but not activated chat'), {});
  assert.equal(f.network.length, boundary); assert.equal(await readFile(row.filename, 'utf8'), before);
  assert.deepEqual((await readdir(f.privateDirectory)).sort(), pendingEntries);
  assert.equal((await f.saved())[0].state.phase, 'pending');
  assert.match(text(await f.call(uuid, 'murmur-connect refresh')), /Murmur connection: connected/);
  assert.deepEqual(f.endpoints(boundary), ['/v1/enrollment/status', '/v1/external/identity', '/v1/external/identity', '/v1/external/context']);
  const active = (await f.saved())[0].state;
  assert.equal(active.phase, 'active'); assert.equal(active.connection.capability, row.capability);
  const refreshedAt = f.network.length;
  const automatic = await f.call(uuid, 'ordinary activated chat');
  assert.match(text(automatic), /refreshed automatically/); assert.match(text(automatic), /Task 0: Backend/);
  assert.deepEqual(f.endpoints(refreshedAt), ['/v1/external/identity', '/v1/external/context']);
  for (const request of f.network.slice(refreshedAt)) assert.equal(request.authorization, `Bearer ${row.capability}`);
  assert.equal(f.requests.length, 1); assertOutput(automatic);
  assert(!text(automatic).includes(row.capability)); assert(!text(automatic).includes(row.pollSecret)); assert.match(text(automatic), /\[REDACTED\]/);
});

test('an expired active grant makes ordinary prompts read-only and silent without renewal or retirement writes', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Work | Role'); f.approve(); await f.call(uuid, 'murmur-connect refresh');
  const row = f.requests[0], before = await readFile(row.filename, 'utf8'), boundary = f.network.length;
  const entries = (await readdir(f.privateDirectory)).sort();
  t.mock.method(Date, 'now', () => row.grantDeadline + 1);
  assert.deepEqual(await f.call(uuid, 'ordinary expired grant prompt'), {});
  assert.equal(f.network.length, boundary); assert.equal(f.requests.length, 1);
  assert.deepEqual((await readdir(f.privateDirectory)).sort(), entries);
  assert.equal(await readFile(row.filename, 'utf8'), before);
});

test('explicit status can activate human approval, but does not fetch context until a subsequent prompt', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Work | Role'); f.approve();
  const before = f.network.length;
  assert.match(text(await f.call(uuid, 'murmur-connect status')), /Murmur connection: connected/);
  assert.deepEqual(f.endpoints(before), ['/v1/enrollment/status', '/v1/external/identity']);
  assert.equal((await f.saved())[0].state.phase, 'active');
  const boundary = f.network.length;
  assert.match(text(await f.call(uuid, 'continue')), /refreshed automatically/);
  assert.deepEqual(f.endpoints(boundary), ['/v1/external/identity', '/v1/external/context']);
});

test('real helper keeps two same-cwd Codex chats distinct; resume reuses proofs but fork and new IDs cannot inherit them', async t => {
  const f = await realHelperFixture(t), a = uuid, b = randomUUID(), fork = randomUUID(), fresh = randomUUID();
  assert.match(text(await f.call(a, 'murmur-connect start Shared | Backend')), /pending/);
  assert.match(text(await f.call(b, `murmur-connect join ${invite} | Frontend`)), /pending/);
  assert.equal(f.requests.length, 2);
  const [ar, br] = f.requests;
  assert.notEqual(ar.filename, br.filename); assert.notEqual(ar.capability, br.capability); assert.notEqual(ar.pollSecret, br.pollSecret);
  assert.equal(br.input.inviteHash, hash(invite)); assert(!JSON.stringify(br.input).includes(invite)); assert(!Object.hasOwn(br.input, 'groupTitle'));
  f.approve(ar); await f.call(a, 'murmur-connect refresh');
  assert.deepEqual(await f.call(b, 'ordinary unapproved peer'), {});
  f.approve(br); await f.call(b, 'murmur-connect refresh');
  const aState = JSON.parse(await readFile(ar.filename, 'utf8')), boundary = f.network.length;
  assert.match(text(await f.call(a, 'resumed ordinary prompt', { source: 'resume' })), /Task 0: Backend/);
  assert.deepEqual(f.endpoints(boundary), ['/v1/external/identity', '/v1/external/context']);
  assert.deepEqual(JSON.parse(await readFile(ar.filename, 'utf8')), aState);
  assert.match(text(await f.call(b, 'peer ordinary prompt')), /Task 1: Frontend/);
  const isolatedAt = f.network.length;
  for (const [id, source] of [[fork, 'fork'], [fresh, 'new']]) {
    const spoof = { source, parent_session_id: a, thread_id: a, nativeId: a, incarnationId: a, connection: aState.connection, stateFile: ar.filename };
    assert.deepEqual(await f.call(id, 'continue from copied parent', spoof), {});
    assert.match(text(await f.call(id, 'murmur-connect refresh', spoof)), /disconnected/);
    assert.match(text(await f.call(id, `murmur-connect status --session ${a}`, spoof)), /NATIVE_COMMAND_INPUT/);
  }
  assert.equal(f.network.length, isolatedAt); assert.equal(f.requests.length, 2);
  for (const id of [fork, fresh]) assert.match(text(await f.call(id, 'murmur-connect start Separate | Needs own approval')), /pending/);
  assert.equal(f.requests.length, 4);
  for (const row of f.requests) {
    assert.equal(row.input.native.tool, 'codex'); assert.equal(row.input.native.nativeId, row.input.native.incarnationId);
    assert.equal(row.input.workspaceRoot, f.workspace);
  }
  assert.equal(new Set(f.requests.map(row => row.capability)).size, 4);
  assert.equal(new Set(f.requests.map(row => row.pollSecret)).size, 4);
  for (const { filename, state } of await f.saved()) {
    assert.equal((await lstat(filename)).mode & 0o777, 0o600); assert.equal((await lstat(filename)).nlink, 1);
    assert.equal((await lstat(`${filename}.lock`)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(`${filename}.lock`, 'mutex.sqlite'))).mode & 0o777, 0o600);
    const output = JSON.stringify(f.results); assert(!output.includes(state.candidateCapability)); assert(!output.includes(state.pollSecret));
  }
});

test('the same host UUID and cwd in Claude and Codex have different tool-private bindings and no cross-activation', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Codex work | Codex role'); f.approve(); await f.call(uuid, 'murmur-connect refresh');
  const before = f.network.length;
  assert.match(text(await f.call(uuid, '/murmur:connect status', {}, 'claude')), /disconnected/);
  assert.deepEqual(await f.call(uuid, 'ordinary Claude prompt', {}, 'claude'), {});
  assert.equal(f.network.length, before);
  assert.match(text(await f.call(uuid, '/murmur:connect start Claude work | Claude role', {}, 'claude')), /pending/);
  assert.equal(f.requests.length, 2); const [codex, claude] = f.requests;
  assert.equal(path.dirname(codex.filename), f.privateDirectory); assert.equal(path.dirname(claude.filename), f.claudeDirectory);
  assert.notEqual(path.basename(codex.filename), path.basename(claude.filename));
  assert.notEqual(codex.capability, claude.capability); assert.notEqual(codex.pollSecret, claude.pollSecret);
  assert.equal(codex.input.native.tool, 'codex'); assert.equal(claude.input.native.tool, 'claude');
  assert.equal(codex.input.native.nativeId, claude.input.native.nativeId);
  f.approve(claude); await f.call(uuid, '/murmur:connect refresh', {}, 'claude');
  assert.match(text(await f.call(uuid, 'ordinary Codex prompt')), /Task 0: Codex role/);
  assert.match(text(await f.call(uuid, '/murmur:connect refresh', {}, 'claude')), /Task 1: Claude role/);
  await f.call(uuid, 'murmur-connect leave');
  assert.deepEqual(await f.call(uuid, 'ordinary left Codex prompt'), {});
  assert.match(text(await f.call(uuid, '/murmur:connect status', {}, 'claude')), /connected/);
  assert.equal(JSON.parse(await readFile(codex.filename, 'utf8')).phase, 'left');
  assert.equal(JSON.parse(await readFile(claude.filename, 'utf8')).phase, 'active');
});

test('leave preserves its task and native chat, and subsequent ordinary prompts do not poll or enroll', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Work | Role'); f.approve(); await f.call(uuid, 'murmur-connect refresh');
  const before = f.network.length, row = f.requests[0];
  assert.match(text(await f.call(uuid, 'murmur-connect leave')), /existing task and native chat were preserved/);
  assert.deepEqual(f.endpoints(before), ['/v1/external/identity', '/v1/external/identity', '/v1/external/leave']);
  const state = JSON.parse(await readFile(row.filename, 'utf8'));
  assert.equal(state.phase, 'left'); assert.equal(state.connection, null); assert.equal(state.observation.native.nativeId, uuid);
  const boundary = f.network.length;
  assert.deepEqual(await f.call(uuid, 'continue after leave'), {});
  assert.match(text(await f.call(uuid, 'murmur-connect status')), /Murmur connection: left/);
  assert.equal(f.network.length, boundary); assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(await readFile(row.filename, 'utf8')), state);
});

test('authoritative revocation retires only the current grant; ordinary prompts never reconnect or replay approval', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Work | Role'); f.approve(); await f.call(uuid, 'murmur-connect refresh');
  const row = f.requests[0], before = f.network.length; row.revoked = true;
  const revoked = await f.call(uuid, 'continue revoked work');
  assert.match(text(revoked), /EXTERNAL_UNAUTHORIZED/); assert(!text(revoked).includes(row.capability));
  assert.deepEqual(f.endpoints(before), ['/v1/external/identity']);
  const retired = JSON.parse(await readFile(row.filename, 'utf8'));
  assert.equal(retired.phase, 'retired'); assert.equal(retired.connection, null);
  const boundary = f.network.length;
  assert.deepEqual(await f.call(uuid, 'continue after revocation'), {});
  assert.match(text(await f.call(uuid, 'murmur-connect refresh')), /Murmur connection: retired/);
  assert.equal(f.network.length, boundary); assert.equal(f.requests.length, 1);
  assert.match(text(await f.call(uuid, `murmur-connect join ${invite} | New reviewed role`)), /pending/);
  assert.equal(f.requests.length, 2); const replacement = f.requests[1];
  assert.notEqual(row.capability, replacement.capability); assert.notEqual(row.pollSecret, replacement.pollSecret);
  const replacementAt = f.network.length;
  assert.deepEqual(await f.call(uuid, 'ordinary replacement pending prompt'), {});
  assert.equal(f.network.length, replacementAt); assert.equal(JSON.parse(await readFile(replacement.filename, 'utf8')).phase, 'pending');
});

test('context revocation is fail-closed while uncertain transport failures preserve the original binding without retries', async t => {
  for (const [name, failure, retired] of [
    ['context unauthorized', respond => respond({ error: { code: 'EXTERNAL_UNAUTHORIZED', message: 'RAW-SECRET' } }, 401), true],
    ['unauthorized non-401', respond => respond({ error: { code: 'EXTERNAL_UNAUTHORIZED', message: 'RAW-SECRET' } }, 503), false],
    ['premature expiry', respond => respond({ error: { code: 'EXTERNAL_EXPIRED', message: 'RAW-SECRET' } }, 401), false],
    ['wrong service identity', respond => respond({ error: { code: 'EXTERNAL_UNAUTHORIZED', message: 'RAW-SECRET' } }, 401, { 'X-Murmur-State-Id': 'b'.repeat(64) }), false],
    ['unavailable service', () => { throw new Error('RAW-SECRET'); }, false],
  ]) await t.test(name, async t => {
    const f = await realHelperFixture(t);
    await f.call(uuid, 'murmur-connect start Work | Role'); f.approve(); await f.call(uuid, 'murmur-connect refresh');
    const row = f.requests[0], original = await readFile(row.filename, 'utf8'), boundary = f.network.length;
    row.contextFailure = failure;
    const result = await f.call(uuid, 'ordinary failing prompt');
    assertOutput(result); assert.match(text(result), /Murmur (EXTERNAL_UNAUTHORIZED|EXTERNAL_EXPIRED|NATIVE_ACTION_FAILED):/);
    assert(!text(result).includes('RAW-SECRET')); assert(!text(result).includes('Task 0'));
    assert.deepEqual(f.endpoints(boundary), ['/v1/external/identity', '/v1/external/context']);
    assert.equal(f.requests.length, 1);
    const state = JSON.parse(await readFile(row.filename, 'utf8'));
    assert.equal(state.phase, retired ? 'retired' : 'active');
    if (!retired) {
      assert.equal(await readFile(row.filename, 'utf8'), original);
      row.contextFailure = undefined;
      assert.match(text(await f.call(uuid, 'ordinary restored transport')), /refreshed automatically/);
    } else {
      assert.equal(state.connection, null);
      const after = f.network.length; assert.deepEqual(await f.call(uuid, 'ordinary retired prompt'), {}); assert.equal(f.network.length, after);
    }
  });
});

test('unsafe private binding files fail closed instead of consulting another chat or enrolling again', async t => {
  for (const [name, mutate] of [
    ['public state', filename => chmod(filename, 0o644)],
    ['symlink state', async filename => { await rename(filename, `${filename}.old`); await symlink(`${filename}.old`, filename); }],
    ['hardlinked state', filename => link(filename, `${filename}.copy`)],
  ]) await t.test(name, async t => {
    const f = await realHelperFixture(t);
    await f.call(uuid, 'murmur-connect start Work | Role'); f.approve(); await f.call(uuid, 'murmur-connect refresh');
    const row = f.requests[0], original = await readFile(row.filename, 'utf8'), boundary = f.network.length;
    await mutate(row.filename);
    const result = await f.call(uuid, 'ordinary prompt after unsafe file');
    assert.match(text(result), /NATIVE_ACTION_FAILED/); assert(!text(result).includes(row.capability));
    assert.equal(f.network.length, boundary); assert.equal(f.requests.length, 1);
    assert.equal(await readFile(row.filename, 'utf8'), original);
  });
});


test('explicit leave revokes human-approved participation before its first local activation', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Work | Role');
  const row = f.requests[0]; f.approve(row);
  assert.equal((await f.saved())[0].state.phase, 'pending');
  const before = f.network.length;
  const result = await f.call(uuid, 'murmur-connect leave');
  assert.match(text(result), /existing task and native chat were preserved/);
  assert.equal(row.left, true);
  assert.deepEqual(f.endpoints(before), ['/v1/enrollment/status', '/v1/external/identity', '/v1/external/identity', '/v1/external/leave']);
  const state = JSON.parse(await readFile(row.filename, 'utf8'));
  assert.equal(state.phase, 'left'); assert.equal(state.connection, null);
  const boundary = f.network.length;
  assert.deepEqual(await f.call(uuid, 'continue after leaving'), {});
  assert.match(text(await f.call(uuid, 'murmur-connect leave')), /Murmur connection: left/);
  assert.equal(f.network.length, boundary); assert.equal(f.requests.length, 1);
});

test('explicit leave never claims to revoke a request that is still awaiting approval', async t => {
  const f = await realHelperFixture(t);
  await f.call(uuid, 'murmur-connect start Work | Role');
  const before = f.network.length;
  const result = await f.call(uuid, 'murmur-connect leave');
  assert.match(text(result), /Murmur connection: pending/);
  assert(!text(result).includes('connection left'));
  assert.deepEqual(f.endpoints(before), ['/v1/enrollment/status']);
  assert.equal(f.requests[0].left, undefined);
  assert.equal((await f.saved())[0].state.phase, 'pending');
});
