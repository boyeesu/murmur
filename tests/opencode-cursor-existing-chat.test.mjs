import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['adapters/opencode-existing-chat.ts', 'adapters/cursor-existing-chat.ts', 'adapters/native-chat.ts', 'cli/external-helper.ts', 'cli/external-client.ts', 'protocol/index.ts', 'protocol/agent.ts', 'protocol/external.ts'].map(file => new URL(file, root).href));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Unsupported adapters cannot import discovery, CLI, installers or native histories: ${url}`);
      return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!modules.has(url)) return next(url, context);
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const openCode = await import(new URL('adapters/opencode-existing-chat.ts', root));
const cursor = await import(new URL('adapters/cursor-existing-chat.ts', root));
const { MurmurError } = await import(new URL('protocol/index.ts', root));
hooks.deregister();
const { openCodeProbeEnvironment, openCodeProbePlugin } = await import('../scripts/probe-opencode-existing-chat.mjs');
const code = expected => error => error instanceof MurmurError && error.code === expected;

async function temporary(t) {
  assert(process.env.TMPDIR);
  const directory = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-unverified-native-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('unsupported native capabilities and installer strategies fail closed without inspecting options', () => {
  const bomb = new Proxy({}, { get() { throw new Error('Untrusted option must not be inspected'); } });
  for (const [capability, strategy, bundle] of [
    [openCode.OPENCODE_EXISTING_CHAT_CAPABILITY, openCode.createOpenCodeExistingChatStrategy(), openCode.createOpenCodeExistingChatBundle],
    [cursor.CURSOR_EXISTING_CHAT_CAPABILITY, cursor.createCursorExistingChatStrategy(), cursor.createCursorExistingChatBundle],
  ]) {
    assert.equal(capability.enabled, false); assert.equal(strategy.enabled, false);
    assert.equal(strategy.capability, capability); assert.equal(strategy.provider, capability.tool);
    assert.equal(capability.genericMcp, false); assert.equal(capability.incarnationSource, null);
    assert.equal(capability.automaticContextVerified, false); assert.equal(capability.structuredIntentVerified, false);
    assert.equal(capability.hotAttachVerified, false); assert(Object.isFrozen(capability)); assert(Object.isFrozen(capability.evidence));
    assert.throws(() => bundle(bomb), code('NATIVE_ADAPTER_UNVERIFIED'));
    assert.throws(() => strategy.build(bomb), code('NATIVE_ADAPTER_UNVERIFIED'));
  }
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.testedVersion, '2.0.12');
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.evidence.sharedServerEnvironmentIsCurrentChatIdentity, false);
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.evidence.nativeSessionCreatedAtIsResetProof, false);
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.evidence.nativeApiForkCreatesFreshId, true);
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.nativeResumePreservesIdentity, false);
  assert.equal(cursor.CURSOR_EXISTING_CHAT_CAPABILITY.testedVersion, null);
  assert.equal(cursor.CURSOR_EXISTING_CHAT_CAPABILITY.evidence.generationIdIsIncarnation, false);
});

test('V2 native command argument parser uses prompt.text, never an identity selector', () => {
  const parse = text => openCode.parseOpenCodeConnectArguments({ text, sessionID: 'ses_parent', nativeId: 'parent', files: ['/do/not/read'] });
  assert.deepEqual(parse('start API contract | Implement API'), { action: 'start', groupTitle: 'API contract', responsibility: 'Implement API' });
  assert.deepEqual(parse(`join ${'a'.repeat(43)} | Implement UI`), { action: 'join', inviteCode: 'a'.repeat(43), responsibility: 'Implement UI' });
  assert.deepEqual(parse(''), { action: 'help' });
  for (const action of ['status', 'refresh', 'leave', 'help']) assert.deepEqual(parse(action), { action });
  for (const text of ['status --session ses_parent', 'refresh --cwd /parent', 'leave --force', 'start title | role | extra', 'start $(id) | role', 'start title | role\nstatus', 'start title | role‮', 'status ', ' status']) assert.throws(() => parse(text), code('NATIVE_COMMAND_INPUT'));
  for (const value of [null, [], 'status', { arguments: 'status' }, { text: null }]) assert.throws(() => openCode.parseOpenCodeConnectArguments(value), code('NATIVE_COMMAND_INPUT'));
  assert.throws(() => parse('start x | ' + '界'.repeat(4000)), code('NATIVE_COMMAND_INPUT'));
});

test('Cursor raw command grammar rejects model-selected identities and opaque handles', () => {
  assert.deepEqual(cursor.parseCursorConnectPrompt('/murmur:connect status'), { action: 'status' });
  for (const text of ['ordinary request', 'please /murmur:connect status', '/murmur:connector status']) assert.equal(cursor.parseCursorConnectPrompt(text), null);
  for (const text of ['/murmur:connect status --conversation parent', '/murmur:connect refresh --file proof.json', '/murmur:connect status\nleave']) assert.throws(() => cursor.parseCursorConnectPrompt(text), code('NATIVE_COMMAND_INPUT'));
});

test('fresh V2 callback inspection uses exact current session metadata and remains UNVERIFIED', async t => {
  const directory = await temporary(t), calls = [];
  let id = 'ses_currentA', created = 1000;
  const event = { sessionID: id, workspaceRoot: '/copied-parent', nativeId: 'ses_parent', prompt: { text: 'RAW-PROMPT' }, metadata: { incarnationId: 'copied' } };
  const reader = { get: async request => { calls.push(request); return { id: request.sessionID, location: { directory }, time: { created }, parentID: 'ses_parent', fork: { sessionID: 'ses_parent' }, metadata: { capability: 'PRIVATE' } }; } };
  const first = await openCode.inspectOpenCodeCurrentContext(event, reader);
  assert.deepEqual(first, { nativeId: id, workspaceRoot: directory, createdAt: 1000, incarnationVerified: false });
  event.sessionID = 'ses_currentB'; created = 2000;
  const second = await openCode.inspectOpenCodeCurrentContext(event, reader);
  assert.deepEqual(second, { nativeId: 'ses_currentB', workspaceRoot: directory, createdAt: 2000, incarnationVerified: false });
  assert.deepEqual(calls, [{ sessionID: 'ses_currentA' }, { sessionID: 'ses_currentB' }]);
  assert(!JSON.stringify([first, second]).match(/RAW-PROMPT|PRIVATE|copied|parent/));
  assert(Object.isFrozen(first));
});

test('V2 metadata refuses copied IDs, wrapped API shapes, aliases, missing timestamps and staged rewind', async t => {
  const directory = await temporary(t), link = path.join(directory, 'alias'), actual = path.join(directory, 'actual');
  await mkdir(actual); await symlink(actual, link);
  const valid = { id: 'ses_currentA', location: { directory: actual }, time: { created: 1 } };
  for (const session of [{ ...valid, id: 'ses_parent' }, { data: valid }, { ...valid, location: { directory: link } }, { ...valid, location: { directory: actual + '/../actual' } }, { ...valid, time: { created: 0 } }, { ...valid, time: { created: 1.5 } }, { ...valid, revert: {} }]) {
    await assert.rejects(openCode.inspectOpenCodeCurrentContext({ sessionID: valid.id }, { get: async () => session }), code('NATIVE_CONTEXT_INVALID'));
  }
  for (const event of [{}, { sessionID: 'ses_../../parent' }, { sessionID: 'parent' }, { sessionID: 'ses_parent\n' }, null]) {
    await assert.rejects(openCode.inspectOpenCodeCurrentContext(event, { get: async () => { throw new Error('Do not query a caller-selected invalid ID'); } }), code('NATIVE_CONTEXT_INVALID'));
  }
});

test('metadata identical after a committed native rewind still cannot assert incarnation', async t => {
  const directory = await temporary(t);
  const info = { id: 'ses_currentA', location: { directory }, time: { created: 1000 }, metadata: { resetEpoch: 'MODEL-SUPPLIED-NOT-PROOF' } };
  const reader = { get: async () => info };
  const before = await openCode.inspectOpenCodeCurrentContext({ sessionID: info.id }, reader);
  // Native 2.0.12 stage+commit was observed to preserve id/created and clear
  // revert. Metadata-only equality must never reactivate a previously held grant.
  const after = await openCode.inspectOpenCodeCurrentContext({ sessionID: info.id }, reader);
  assert.deepEqual(before, after); assert.equal(after.incarnationVerified, false);
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.evidence.nativeCommittedRewindPreservesIdAndCreation, true);
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.evidence.nativeCommittedRewindClearsMarker, true);
  assert.equal(openCode.OPENCODE_EXISTING_CHAT_CAPABILITY.enabled, false);
});

test('V2 metadata failures are static and never expose native errors or filesystem paths', async () => {
  const event = { sessionID: 'ses_currentA' };
  for (const reader of [
    { get: async () => { throw new Error('RAW-CREDENTIAL RAW-PROMPT'); } },
    { get: async () => { throw new MurmurError('RAW-CREDENTIAL', 'NATIVE_CONTEXT_INVALID'); } },
    { get: async () => ({ id: event.sessionID, location: { directory: '/absent-RAW-PRIVATE-PATH' }, time: { created: 1 } }) },
  ]) await assert.rejects(openCode.inspectOpenCodeCurrentContext(event, reader), error => code('NATIVE_CONTEXT_INVALID')(error) && !error.message.includes('RAW-'));
});

test('Cursor generation and startup env do not become chat incarnation proof', () => {
  const event = { conversation_id: 'chat-A', generation_id: 'generation-1', workspace_roots: ['/workspace'], prompt: 'RAW-PROMPT', tool_output: 'RAW-OUTPUT', env: { NATIVE_ID: 'parent', CAPABILITY: 'PRIVATE' } };
  const a = cursor.inspectCursorHookMetadata(event);
  const b = cursor.inspectCursorHookMetadata({ ...event, generation_id: 'generation-2' });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { conversationId: 'chat-A', workspaceRoots: ['/workspace'], incarnationVerified: false });
  event.workspace_roots[0] = '/changed'; assert.equal(a.workspaceRoots[0], '/workspace');
  assert(Object.isFrozen(a)); assert(Object.isFrozen(a.workspaceRoots));
  assert(!JSON.stringify(a).match(/RAW-|PRIVATE|generation|parent/));
  for (const event of [null, [], {}, { conversation_id: '../parent', workspace_roots: ['/workspace'] }, { conversation_id: 'A', workspace_roots: [] }, { conversation_id: 'A', workspace_roots: Array(17).fill('/w') }, { conversation_id: 'A', workspace_roots: ['/work\nspace'] }]) assert.throws(() => cursor.inspectCursorHookMetadata(event), code('NATIVE_CONTEXT_INVALID'));
});

test('OpenCode native probe preserves proxy policy and excludes profile credentials', () => {
  const inherited = { HTTPS_PROXY: 'http://configured-proxy:80', HTTP_PROXY: '', NO_PROXY: 'localhost', https_proxy: 'http://lowercase:80', ANTHROPIC_API_KEY: 'PRIVATE', OPENAI_API_KEY: 'PRIVATE', MURMUR_EXTERNAL_CONNECTION: 'PRIVATE', HOME: '/real-home' };
  const env = openCodeProbeEnvironment('/fixture', inherited);
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy']) assert.equal(env[key], inherited[key]);
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MURMUR_EXTERNAL_CONNECTION']) assert(!Object.hasOwn(env, key));
  assert.equal(env.HOME, '/fixture/home'); assert.equal(env.XDG_DATA_HOME, '/fixture/data');
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1'); assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  const source = openCodeProbePlugin('/fixture/observations.jsonl');
  assert(source.includes("session.hook('prompt'")); assert(source.includes("session.hook('context'"));
  assert(source.includes('command.transform')); assert(source.includes('setup(ctx)'));
  assert(!source.includes('process.env')); assert(!source.includes('tool_output')); assert(!source.includes('event.prompt.text,'));
});
