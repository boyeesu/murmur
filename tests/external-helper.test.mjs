import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const root = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['cli/external-client.ts', 'cli/external-helper.ts', 'adapters/existing-chat.ts', 'adapters/claude-existing-chat.ts', 'adapters/native-chat.ts', 'adapters/codex-existing-chat.ts', 'protocol/index.ts', 'protocol/agent.ts', 'protocol/external.ts'].map(file => new URL(file, root).href));
const loaded = new Set();
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), `Forbidden helper dependency: ${url}`); return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!modules.has(url)) return next(url, context);
    loaded.add(url); return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const { acknowledgeApprovedContext, ExistingChatHelper, readPublicConnectionFile } = await import(new URL('cli/external-helper.ts', root));
const { nativeMain, createNativeSetupBundle, exportExistingChatSetup, GENERIC_EXISTING_CHAT_MCP_ENABLED, EXISTING_CHAT_NATIVE_ENABLED, CLAUDE_EXISTING_CHAT_CAPABILITY, CLAUDE_NATIVE_SKILL, CLAUDE_PLUGIN_MANIFEST, CLAUDE_HOOKS_TEMPLATE, quoteNativeShell } = await import(new URL('adapters/existing-chat.ts', root));
const { MurmurError, canonicalJson } = await import(new URL('protocol/index.ts', root));
hooks.deregister();
const hash = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error instanceof MurmurError && error.code === expected;
async function temporary(t) {
  assert(process.env.TMPDIR);
  const directory = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-external-helper-test-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function fixture(t) {
  const directory = await temporary(t), workspace = path.join(directory, 'workspace'), state = path.join(directory, 'private-state'), service = path.join(directory, 'service');
  await mkdir(workspace); await mkdir(state, { mode: 0o700 }); await mkdir(service, { mode: 0o700 });
  const descriptor = { protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: 'a'.repeat(64), instanceId: randomUUID() };
  const descriptorPath = path.join(service, 'connection.json'); await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  let current = { native: { tool: 'claude', nativeId: 'native-a', incarnationId: 'incarnation-1' }, workspaceRoot: workspace, incarnationVerified: true };
  const calls = [], requests = new Map(); let lostReply = false, providerCalls = 0, beforeFetch;
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Murmur-State-Id': descriptor.stateId, 'X-Murmur-Protocol-Version': '1' } });
  const saved = async () => Promise.all((await readdir(state)).filter(file => file.endsWith('.json')).map(async file => ({ filename: path.join(state, file), state: JSON.parse(await readFile(path.join(state, file), 'utf8')) })));
  const fetch = async (url, init) => {
    const call = { url: String(url), ...init, headers: new Headers(init.headers) }; calls.push(call);
    if (beforeFetch) await beforeFetch(call);
    const endpoint = new URL(call.url).pathname;
    if (endpoint === '/v1/enrollment/requests') {
      const input = JSON.parse(call.body), key = call.headers.get('Idempotency-Key');
      const records = await saved(); const owned = records.find(record => record.state.requestKey === key)?.state;
      assert(owned, 'private proofs must be persisted before the network request');
      assert.equal(owned.input.capabilityHash, hash(owned.candidateCapability)); assert.equal(owned.input.pollSecretHash, hash(owned.pollSecret));
      assert.notEqual(owned.candidateCapability, owned.pollSecret); assert.equal(call.headers.has('Authorization'), false);
      assert(!call.body.includes(owned.candidateCapability)); assert(!call.body.includes(owned.pollSecret));
      if (!requests.has(key)) requests.set(key, { input, receipt: { requestId: `request-${requests.size + 1}`, state: 'pending', revision: 1, expiresAt: Date.now() + 60_000, decidedAt: null }, capability: owned.candidateCapability, pollSecret: owned.pollSecret, expiresAt: Date.now() + 120_000, revoked: false });
      else assert.deepEqual(input, requests.get(key).input);
      if (lostReply) { lostReply = false; throw new Error(`Lost reply ${owned.candidateCapability} ${owned.pollSecret}`); }
      return response(requests.get(key).receipt);
    }
    if (endpoint === '/v1/enrollment/status') {
      assert.equal(call.method, 'POST'); const body = JSON.parse(call.body); assert.deepEqual(Object.keys(body), ['requestId']);
      const request = [...requests.values()].find(row => row.receipt.requestId === body.requestId);
      assert(request); assert.equal(call.headers.get('Authorization'), `Bearer ${request.pollSecret}`);
      return response(request.receipt);
    }
    const request = [...requests.values()].find(row => call.headers.get('Authorization') === `Bearer ${row.capability}`);
    assert(request); if (request.receipt.state !== 'approved' || request.revoked) return response({ error: { code: 'EXTERNAL_UNAUTHORIZED', message: `${request.capability} ${request.pollSecret}` } }, 401);
    const suffix = request.receipt.requestId;
    if (endpoint === '/v1/external/identity') return response({ role: 'external', protocolVersion: 1, stateId: descriptor.stateId, instanceId: descriptor.instanceId,
      grantId: `grant-${suffix}`, projectId: 'project-one', sessionId: `session-${suffix}`, taskId: `task-${suffix}`, memberId: `member-${suffix}`, groupId: 'group-one', workspaceRoot: workspace, expiresAt: request.expiresAt, membershipRevision: 1 });
    if (endpoint === '/v1/external/leave') { request.revoked = true; return response({ left: true, taskPreserved: true }); }
    return response({ ok: true, endpoint, message: `Private values ${request.capability} ${request.pollSecret}`, capability: request.capability, pollSecret: request.pollSecret });
  };
  const options = { privateDirectory: state, descriptorPath, nativeContext: () => { providerCalls++; return current; }, transport: { fetch } };
  const helper = new ExistingChatHelper(options);
  return { directory, workspace, state, service, descriptor, descriptorPath, calls, requests, helper, options, saved, get current() { return current; },
    setCurrent: value => { current = value; }, approve: () => {
      for (const request of requests.values()) if (request.receipt.state === 'pending') {
        request.receipt = { ...request.receipt, state: 'approved', revision: 2, decidedAt: Date.now() };
      }
    }, loseReply: () => { lostReply = true; }, beforeFetch: fn => { beforeFetch = fn; }, providerCalls: () => providerCalls };
}
const startInput = { groupTitle: 'Password reset', responsibility: 'Implement API', handoff: { summary: 'Reviewed draft candidate', writes: ['src/api'] } };
async function delivered(helper, after, policy) { const result = await helper.refreshApproved(after, policy); await acknowledgeApprovedContext(result); return result; }
async function connected(f) { await f.helper.start(startInput); f.approve(); assert.equal((await f.helper.status()).state, 'connected'); }
function noSecrets(value, states) {
  const output = JSON.stringify(value);
  for (const state of states) for (const key of ['candidateCapability', 'pollSecret']) assert(!output.includes(state[key]));
}

test('helper graph excludes human discovery; only version-scoped host hook entrypoints are enabled', async () => {
  assert.deepEqual(loaded, modules); assert.equal(GENERIC_EXISTING_CHAT_MCP_ENABLED, false); assert.equal(EXISTING_CHAT_NATIVE_ENABLED, false);
  for (const args of [[], ['start', 'feature'], ['status'], ['refresh'], ['leave'], ['--force'], ['start', '--force'], ['--help', '--force'], ['hook', '--descriptor', '/x/connection.json', '--session', 'parent']]) {
    await assert.rejects(nativeMain(args), code('NATIVE_ADAPTER_UNVERIFIED'));
  }
  const help = await nativeMain(['--help']); assert.deepEqual(help.claude, CLAUDE_EXISTING_CHAT_CAPABILITY);
  assert.equal(help.claude.testedVersion, '2.1.247'); assert.equal(help.claude.hotAttachVerified, false);
});

test('separate private proofs exist before hash-only enrollment; status never returns credentials', async t => {
  const f = await fixture(t);
  const result = await f.helper.start(startInput), records = await f.saved();
  assert.equal(result.state, 'pending'); assert.equal(result.reviewLinkIsInert, true); assert.equal(result.reviewUrl, `${f.descriptor.origin}/ui/`);
  assert.equal(records.length, 1); assert.equal((await lstat(records[0].filename)).mode & 0o077, 0);
  noSecrets(result, records.map(record => record.state));
  const pending = await f.helper.status(); assert.equal(pending.state, 'pending');
  assert.equal(f.calls.filter(call => call.url.endsWith('/identity')).length, 0);
  f.approve(); const activated = await f.helper.status(); assert.equal(activated.state, 'connected');
  const state = (await f.saved())[0].state; assert.equal(state.phase, 'active'); assert.equal(state.connection.capability, state.candidateCapability);
  noSecrets(activated, [state]); noSecrets(await f.helper.status(), [state]); noSecrets(await f.helper.refresh(), [state]);
  assert(f.providerCalls() > f.calls.length, 'fresh host context is checked on every transport boundary');
});

test('explicit retry after lost enrollment reply reuses persisted key/input/proofs and never auto-retries', async t => {
  const f = await fixture(t); f.loseReply();
  await assert.rejects(f.helper.start(startInput), error => error instanceof MurmurError && !error.message.includes('Lost reply'));
  assert.equal(f.calls.length, 1); const before = (await f.saved())[0].state;
  assert.equal(before.receipt, null);
  const result = await f.helper.start(startInput); assert.equal(result.state, 'pending');
  const after = (await f.saved())[0].state;
  assert.equal(before.requestKey, after.requestKey); assert.equal(before.candidateCapability, after.candidateCapability); assert.equal(before.pollSecret, after.pollSecret);
  assert.equal(f.calls[0].body, f.calls[1].body); assert.equal(f.requests.size, 1);
});

test('concurrent same-cwd chats and clear/fork identities cannot authorize copied parent handles', async t => {
  const f = await fixture(t); await connected(f); const original = (await f.saved())[0]; const initialCalls = f.calls.length;
  const parent = f.current;
  f.setCurrent({ ...parent, native: { ...parent.native, nativeId: 'native-fork' } });
  assert.deepEqual(await f.helper.status(), { state: 'disconnected' }); await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED'));
  assert.equal(f.calls.length, initialCalls);
  // Copying a private record to a guessed child's filename still fails its immutable observation check.
  const rootInfo = await lstat(f.workspace);
  const observation = { native: f.current.native, workspaceRoot: f.workspace, workspaceIdentity: `${rootInfo.dev}:${rootInfo.ino}:${rootInfo.birthtimeMs}` };
  const copied = path.join(f.state, `${hash(canonicalJson(observation))}.json`);
  await writeFile(copied, await readFile(original.filename), { mode: 0o600 });
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_NATIVE_CHANGED')); await rm(copied);
  f.setCurrent({ ...parent, native: { ...parent.native, incarnationId: 'after-clear' } });
  assert.deepEqual(await f.helper.status(), { state: 'disconnected' }); await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED'));
  f.setCurrent({ ...parent, incarnationVerified: false }); await assert.rejects(f.helper.status(), code('NATIVE_ADAPTER_UNVERIFIED'));
  f.setCurrent(parent); await f.helper.refresh();
  assert.throws(() => f.helper.run('context', { nativeId: 'native-fork' }), code('EXTERNAL_INPUT'));
  assert.throws(() => f.helper.start({ ...startInput, native: parent.native }), code('EXTERNAL_INPUT'));
});

test('fresh native checks stop mutations if chat changes after async identity', async t => {
  const f = await fixture(t); await connected(f); const before = f.calls.length;
  f.beforeFetch(call => { if (call.url.endsWith('/identity')) f.setCurrent({ ...f.current, native: { ...f.current.native, incarnationId: 'after-clear' } }); });
  await assert.rejects(f.helper.run('intent', { revision: 1, writes: ['src'] }, 'intent-key'), code('EXTERNAL_NATIVE_CHANGED'));
  assert.equal(f.calls.length, before + 1); assert(f.calls.at(-1).url.endsWith('/identity'));
});

async function mutexPaths(f) {
  const info = await lstat(f.workspace);
  const observation = { native: f.current.native, workspaceRoot: f.workspace, workspaceIdentity: `${info.dev}:${info.ino}:${info.birthtimeMs}` };
  const directory = path.join(f.state, `${hash(canonicalJson(observation))}.json.lock`);
  return { directory, filename: path.join(directory, 'mutex.sqlite') };
}

// Real independent Node processes exercise the OS mutex, not a mocked SQLite or
// a native CLI. All state/proofs are disposable fixtures; no real HTTP is used.
async function mutexWorker(t, f, hold = false) {
  const script = `
    import { readFileSync } from 'node:fs';
    import { registerHooks, stripTypeScriptTypes } from 'node:module';
    const root = new URL(${JSON.stringify(root.href)});
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.'))
          return { url: new URL(specifier.replace(/\\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (!url.startsWith(root.href)) return next(url, context);
        return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
      }
    });
    const { ExistingChatHelper } = await import(new URL('cli/external-helper.ts', root));
    hooks.deregister();
    const input = JSON.parse(process.argv[1]);
    const helper = new ExistingChatHelper({ privateDirectory: input.directory, descriptorPath: input.descriptorPath,
      nativeContext: () => input.current, timeoutMs: 30000, transport: { fetch: async () => {
        process.send({ kind: 'entered' });
        if (input.hold) await new Promise(resolve => process.once('message', resolve));
        throw new Error('Fixture transport stopped');
      } } });
    try { await helper.status(); process.send({ kind: 'finished' }); }
    catch (error) { process.send({ kind: 'error', code: error.code }); }
    finally { process.disconnect(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ directory: f.state, descriptorPath: f.descriptorPath, current: f.current, hold })], {
    cwd: f.directory, env: { TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { if (errors.length < 8192) errors += chunk; });
  const exited = once(child, 'exit');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return exited; };
  t.after(stop);
  const message = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(5000) }).then(([value]) => value),
    exited.then(() => { throw new Error(`Mutex child exited before reporting: ${errors}`); }),
  ]);
  return { child, exited, stop, message };
}

test('SIGKILL releases the real SQLite mutex without removing state or renewing authority', { timeout: 15000 }, async t => {
  const f = await fixture(t); await connected(f);
  const before = (await f.saved())[0], mutex = await mutexPaths(f), pin = await lstat(mutex.filename);
  const holder = await mutexWorker(t, f, true);
  try {
    assert.deepEqual(holder.message, { kind: 'entered' });
    await assert.rejects(f.helper.status(), code('EXTERNAL_HELPER_BUSY'));
    const contender = await mutexWorker(t, f);
    assert.deepEqual(contender.message, { kind: 'error', code: 'EXTERNAL_HELPER_BUSY' });
    await contender.exited;
    assert.deepEqual(await holder.stop(), [null, 'SIGKILL']);
    const calls = f.calls.length;
    assert.equal((await f.helper.status()).state, 'connected');
    assert.deepEqual((await f.saved())[0], before);
    assert.equal(f.requests.size, 1); assert.equal([...f.requests.values()][0].revoked, false);
    assert(f.calls.slice(calls).every(call => call.url.endsWith('/v1/external/identity')));
    const after = await lstat(mutex.filename);
    assert.equal(after.ino, pin.ino); assert.equal(after.dev, pin.dev); assert.equal(after.mode & 0o077, 0);
    assert.deepEqual(await readdir(mutex.directory), ['mutex.sqlite']);
    assert.equal((await readFile(mutex.filename)).length, 0, 'the mutex stores neither data nor credentials');
  } finally { await holder.stop(); }
});

test('same-process contention cannot release the holder OS lock through another descriptor', { timeout: 15000 }, async t => {
  const f = await fixture(t); await connected(f);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.beforeFetch(async call => { if (call.url.endsWith('/identity')) { entered(); await pending; } });
  const held = f.helper.status(); await started;
  try {
    await assert.rejects(new ExistingChatHelper(f.options).status(), code('EXTERNAL_HELPER_BUSY'));
    const contender = await mutexWorker(t, f);
    assert.deepEqual(contender.message, { kind: 'error', code: 'EXTERNAL_HELPER_BUSY' });
    await contender.exited;
  } finally { release(); await held; }
  assert.equal((await new ExistingChatHelper(f.options).status()).state, 'connected');
});

test('legacy file locks are never removed and new mutex directories exclude old O_EXCL writers', async t => {
  const f = await fixture(t), mutex = await mutexPaths(f);
  const legacy = await open(mutex.directory, 'wx', 0o600), pin = await legacy.stat();
  try {
    await assert.rejects(f.helper.start(startInput), code('EXTERNAL_HELPER_BUSY'));
    assert.equal((await lstat(mutex.directory)).ino, pin.ino);
    assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.state), [path.basename(mutex.directory)]);
  } finally { await legacy.close(); }
  await rm(mutex.directory); // Simulate the old owner's normal finally cleanup, not recovery by the new helper.
  assert.deepEqual(await f.helper.status(), { state: 'disconnected' });
  assert((await lstat(mutex.directory)).isDirectory());
  await assert.rejects(open(mutex.directory, 'wx', 0o600), { code: 'EEXIST' });
});

test('interrupted new-format initialization can finish without deleting a marker', async t => {
  for (const emptyFile of [false, true]) {
    const f = await fixture(t), mutex = await mutexPaths(f);
    await mkdir(mutex.directory, { mode: 0o700 });
    if (emptyFile) await writeFile(mutex.filename, '', { mode: 0o600, flag: 'wx' });
    const pin = await lstat(mutex.directory);
    assert.deepEqual(await f.helper.status(), { state: 'disconnected' });
    assert.equal((await lstat(mutex.directory)).ino, pin.ino); assert.equal(f.calls.length, 0);
  }
});

test('mutex symlinks, hardlinks and nonprivate paths are refused before proof or transport access', async t => {
  const f = await fixture(t); await f.helper.status(); const mutex = await mutexPaths(f);
  await chmod(mutex.directory, 0o755); await assert.rejects(f.helper.status(), code('EXTERNAL_PRIVATE_STATE')); await chmod(mutex.directory, 0o700);
  await chmod(mutex.filename, 0o644); await assert.rejects(f.helper.status(), code('EXTERNAL_PRIVATE_STATE')); await chmod(mutex.filename, 0o600);
  await rename(mutex.filename, `${mutex.filename}-old`); await symlink(`${mutex.filename}-old`, mutex.filename);
  await assert.rejects(f.helper.status(), code('EXTERNAL_PRIVATE_STATE'));
  await rm(mutex.filename); await rename(`${mutex.filename}-old`, mutex.filename);
  await link(mutex.filename, `${mutex.filename}-alias`); await assert.rejects(f.helper.status(), code('EXTERNAL_PRIVATE_STATE')); await rm(`${mutex.filename}-alias`);
  await rename(mutex.directory, `${mutex.directory}-old`); await symlink(`${mutex.directory}-old`, mutex.directory);
  await assert.rejects(f.helper.status(), code('EXTERNAL_PRIVATE_STATE'));
  await rm(mutex.directory); await rename(`${mutex.directory}-old`, mutex.directory);
  assert.deepEqual(await f.helper.status(), { state: 'disconnected' }); assert.equal(f.calls.length, 0);
});

test('mutex inode and directory substitutions stop mutations without deleting replacements', async t => {
  for (const replaceDirectory of [false, true]) {
    const f = await fixture(t); await connected(f); const mutex = await mutexPaths(f), before = (await f.saved())[0];
    let replacement;
    f.beforeFetch(async call => {
      if (!call.url.endsWith('/identity')) return;
      if (replaceDirectory) { await rename(mutex.directory, `${mutex.directory}-old`); await mkdir(mutex.directory, { mode: 0o700 }); }
      else await rename(mutex.filename, `${mutex.filename}-old`);
      await writeFile(mutex.filename, '', { mode: 0o600, flag: 'wx' }); replacement = await lstat(mutex.filename);
    });
    const count = f.calls.length;
    await assert.rejects(f.helper.run('intent', { revision: 1, writes: ['src'] }), code('EXTERNAL_PRIVATE_STATE'));
    assert.equal(f.calls.length, count + 1); assert(f.calls.at(-1).url.endsWith('/identity'));
    assert.deepEqual((await f.saved())[0], before); assert.equal((await lstat(mutex.filename)).ino, replacement.ino);
  }
});

test('private file and directory substitutions, public metadata poisoning, and locks fail closed', async t => {
  const f = await fixture(t); await connected(f); const record = (await f.saved())[0]; let before = f.calls.length;
  await chmod(record.filename, 0o644); await assert.rejects(f.helper.refresh(), code('EXTERNAL_PRIVATE_STATE')); assert.equal(f.calls.length, before); await chmod(record.filename, 0o600);
  assert((await lstat(`${record.filename}.lock`)).isDirectory());
  await writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, token: 'DO-NOT-READ-HUMAN-AUTHORITY' })); await assert.rejects(f.helper.status(), error => error instanceof MurmurError); assert.equal(f.calls.length, before);
  await writeFile(f.descriptorPath, JSON.stringify(f.descriptor));
  await rename(f.state, `${f.state}-old`); await mkdir(f.state, { mode: 0o700 });
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_PRIVATE_STATE')); assert.equal(f.calls.length, before);
});

test('descriptor reader accepts only private no-follow connection.json and never opens human discovery', async t => {
  const f = await fixture(t); assert.deepEqual(await readPublicConnectionFile(f.descriptorPath), f.descriptor);
  await assert.rejects(readPublicConnectionFile(path.join(f.service, 'daemon.json')), code('EXTERNAL_CONFIGURATION'));
  const saved = path.join(f.service, 'saved.json'); await rename(f.descriptorPath, saved); await symlink(saved, f.descriptorPath);
  await assert.rejects(readPublicConnectionFile(f.descriptorPath), code('EXTERNAL_PRIVATE_STATE'));
  const inside = path.join(f.workspace, 'private'); await mkdir(inside, { mode: 0o700 });
  const helper = new ExistingChatHelper({ ...f.options, privateDirectory: inside });
  await assert.rejects(helper.status(), code('EXTERNAL_CONFIGURATION'));
});

test('losing local proof does not recover by native ID, and leave permits only newly approved enrollment', async t => {
  const f = await fixture(t); await connected(f); const old = (await f.saved())[0].state;
  const left = await f.helper.leave('leave-key'); assert.equal(left.taskPreserved, true);
  assert.equal((await f.helper.status()).state, 'left'); await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED'));
  await f.helper.start(startInput); const next = (await f.saved())[0].state;
  assert.notEqual(next.candidateCapability, old.candidateCapability); assert.notEqual(next.requestKey, old.requestKey);
  await rm((await f.saved())[0].filename); const before = f.calls.length;
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED')); assert.equal(f.calls.length, before);
});

test('helper timeout stops a stalled provider without HTTP or private writes', async t => {
  const f = await fixture(t);
  const helper = new ExistingChatHelper({ ...f.options, timeoutMs: 20, nativeContext: () => new Promise(() => {}) });
  await assert.rejects(helper.status(), code('EXTERNAL_TIMEOUT')); assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.state), []);
});

test('human setup exports a fixed private Claude plugin without installation, secrets or overwrite', async t => {
  const f = await fixture(t), target = path.join(f.directory, "plugin's export"), cliPath = path.join(f.directory, "cli's entry.js"), claudeExecutable = path.join(f.directory, "claude's fixture");
  await writeFile(cliPath, '// fixture only\n');
  await writeFile(claudeExecutable, '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$MURMUR_HOME" ] || exit 9\nprintf "2.1.247 (Claude Code)\\n"\n', { mode: 0o700 });
  const options = { tool: 'claude', outputDirectory: target, stateDirectory: f.service, nodeExecutable: process.execPath, cliPath, claudeExecutable, env: { ANTHROPIC_API_KEY: 'DO-NOT-INHERIT', MURMUR_HOME: 'DO-NOT-INHERIT' } };
  const result = await exportExistingChatSetup(options);
  assert.equal(result.exported, true); assert.equal(result.installed, false); assert.equal(result.connected, false); assert.equal(result.files.length, 3);
  assert.equal(result.resumeCommand, `${quoteNativeShell(claudeExecutable)} --plugin-dir ${quoteNativeShell(target)} --resume`);
  const bundle = createNativeSetupBundle({ tool: 'claude', descriptorPath: f.descriptorPath, nodeExecutable: await realpath(process.execPath), cliPath }); assert(Object.isFrozen(bundle));
  for (const asset of bundle.files) { assert.equal(await readFile(path.join(target, asset.path), 'utf8'), asset.content); assert.equal((await lstat(path.join(target, asset.path))).mode & 0o077, 0); }
  for (const [relative, content] of [['.claude-plugin/plugin.json', CLAUDE_PLUGIN_MANIFEST], ['skills/connect/SKILL.md', CLAUDE_NATIVE_SKILL], ['hooks/hooks.json', CLAUDE_HOOKS_TEMPLATE]]) assert.equal(await readFile(new URL(`../packages/murmur/assets/native/claude/${relative}`, import.meta.url), 'utf8'), content);
  for (const relative of ['', '.claude-plugin', 'skills', 'skills/connect', 'hooks']) assert.equal((await lstat(path.join(target, relative))).mode & 0o077, 0);
  for (const relative of ['existing-chats', 'existing-chats/claude']) assert.equal((await lstat(path.join(f.service, relative))).mode & 0o077, 0);
  const hook = JSON.parse(await readFile(path.join(target, 'hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.command, `${quoteNativeShell(await realpath(process.execPath))} ${quoteNativeShell(cliPath)} native hook --descriptor ${quoteNativeShell(f.descriptorPath)}`);
  assert(!JSON.stringify(result).includes('DO-NOT-INHERIT')); assert(!bundle.files.some(asset => /CLAUDE_SESSION_ID|ARGUMENTS|!`|DO-NOT-INHERIT/.test(asset.content)));
  await assert.rejects(exportExistingChatSetup(options), code('NATIVE_SETUP_EXISTS'));
  assert.equal(await readFile(path.join(target, bundle.files[0].path), 'utf8'), bundle.files[0].content);
  for (const segment of ['.claude', '.codex', '.cursor', '.opencode', '.agents', '.config', '.mcp.json']) {
    await assert.rejects(exportExistingChatSetup({ ...options, outputDirectory: path.join(f.directory, segment) }), code('NATIVE_SETUP_PATH'));
    await assert.rejects(exportExistingChatSetup({ ...options, outputDirectory: path.join(f.directory, segment, 'export') }), code('NATIVE_SETUP_PATH'));
  }
  await assert.rejects(exportExistingChatSetup({ ...options, tool: 'cursor', outputDirectory: path.join(f.directory, 'unsupported-export') }), code('NATIVE_ADAPTER_UNVERIFIED'));
});

test('two injected same-cwd chats enroll concurrently with independent private grants', async t => {
  const f = await fixture(t);
  const nativeB = { ...f.current, native: { ...f.current.native, nativeId: 'native-b' } };
  const second = new ExistingChatHelper({ ...f.options, nativeContext: () => nativeB });
  const [a, b] = await Promise.all([f.helper.start(startInput), second.start({ ...startInput, responsibility: 'Implement UI' })]);
  assert.notEqual(a.requestId, b.requestId);
  const records = (await f.saved()).map(row => row.state);
  assert.equal(records.length, 2); assert.notEqual(records[0].candidateCapability, records[1].candidateCapability);
  assert.notEqual(records[0].pollSecret, records[1].pollSecret);
  f.approve(); await Promise.all([f.helper.status(), second.status()]);
  const [ai, bi] = await Promise.all([f.helper.run('identity'), second.run('identity')]);
  assert.notEqual(ai.grantId, bi.grantId); assert.notEqual(ai.taskId, bi.taskId); assert.notEqual(ai.sessionId, bi.sessionId);
});

test('terminal receipt and revoked active grant never bootstrap from historical approval', async t => {
  const f = await fixture(t); await f.helper.start(startInput);
  const request = [...f.requests.values()][0];
  request.receipt = { ...request.receipt, state: 'rejected', revision: 2, decidedAt: Date.now() };
  assert.equal((await f.helper.status()).state, 'rejected'); const before = f.calls.length;
  f.approve(); assert.equal((await f.helper.status()).state, 'rejected'); assert.equal(f.calls.length, before);
  await f.helper.start(startInput); f.approve(); await f.helper.status();
  const latest = [...f.requests.values()].at(-1); latest.revoked = true;
  const count = f.calls.length;
  await assert.rejects(f.helper.status(), code('EXTERNAL_UNAUTHORIZED'));
  assert.equal((await f.helper.status()).state, 'retired');
  assert.equal(f.calls.length, count + 1);
  assert(f.calls.slice(count).every(call => call.url.endsWith('/v1/external/identity')));
});

test('a substituted source directory cannot reuse its old private binding', async t => {
  const f = await fixture(t); await connected(f); const before = f.calls.length;
  await rename(f.workspace, `${f.workspace}-old`); await mkdir(f.workspace);
  assert.deepEqual(await f.helper.status(), { state: 'disconnected' });
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED')); assert.equal(f.calls.length, before);
});

test('helper preserves reported handoff fields as metadata without reading or copying source', async t => {
  const f = await fixture(t);
  const handoff = { summary: 'Reported changes only', changedFiles: ['not-present.ts'], remainingWork: ['Run reviewed checks'] };
  await f.helper.start({ groupTitle: 'Checklist fixture', responsibility: 'Review remaining work', handoff });
  const state = (await f.saved())[0].state;
  assert.deepEqual(state.input.handoff, handoff);
  assert.deepEqual(state.input.native, f.current.native);
  assert.equal(state.input.workspaceRoot, f.workspace);
  assert.equal(Object.hasOwn(state.input.handoff, 'writes'), false);
  assert.deepEqual(await readdir(f.workspace), []);
});

test('approval before request deadline can activate when first polled after that deadline', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); await f.helper.start(startInput);
  const before = (await f.saved())[0].state;
  const request = [...f.requests.values()][0]; request.expiresAt = now + 8 * 60 * 60_000;
  f.approve(); const approvedAt = request.receipt.decidedAt;
  now += 11 * 60_000;
  assert(before.receipt.expiresAt < now); assert(request.expiresAt > now); assert(approvedAt < before.receipt.expiresAt);
  const result = await f.helper.status(); assert.equal(result.state, 'connected');
  const after = (await f.saved())[0].state;
  assert.equal(after.candidateCapability, before.candidateCapability); assert.equal(after.pollSecret, before.pollSecret);
  assert.equal(after.connection.expiresAt, request.expiresAt); assert.equal(f.requests.size, 1);
  assert(f.calls.some(call => call.url.endsWith('/v1/enrollment/status')));
});

test('explicit start and join never discard a potentially approved late pending proof', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const operation of ['start', 'join']) {
    const f = await fixture(t); await f.helper.start(startInput);
    const before = (await f.saved())[0].state;
    const request = [...f.requests.values()][0]; request.expiresAt = now + 8 * 60 * 60_000;
    f.approve(); now += 11 * 60_000;
    const count = f.calls.length;
    const action = operation === 'start' ? () => f.helper.start({ ...startInput, groupTitle: 'Different group' })
      : () => f.helper.join('new-invitation-123456', { responsibility: 'New responsibility' });
    await assert.rejects(action(), code('EXTERNAL_ALREADY_BOUND'));
    const after = (await f.saved())[0].state;
    assert.equal(after.phase, 'active'); assert.equal(after.candidateCapability, before.candidateCapability); assert.equal(after.pollSecret, before.pollSecret);
    assert.equal(f.requests.size, 1); assert(f.calls.slice(count).some(call => call.url.endsWith('/v1/enrollment/status')));
    assert(!f.calls.slice(count).some(call => call.url.endsWith('/v1/enrollment/requests')));
  }
});

test('early revoke allows explicit fresh start or join but still needs a NEW human approval', async t => {
  for (const operation of ['start', 'join']) {
    const f = await fixture(t); await connected(f);
    const before = (await f.saved())[0].state;
    const old = [...f.requests.values()][0]; old.revoked = true;
    assert(before.connection.expiresAt > Date.now());
    const count = f.calls.length;
    const result = operation === 'start' ? await f.helper.start({ ...startInput, groupTitle: 'Fresh request' })
      : await f.helper.join('fresh-invitation-123456', { responsibility: 'Fresh responsibility' });
    assert.equal(result.state, 'pending'); assert.equal(f.requests.size, 2);
    const after = (await f.saved())[0].state;
    assert.notEqual(after.candidateCapability, before.candidateCapability); assert.notEqual(after.pollSecret, before.pollSecret); assert.notEqual(after.requestKey, before.requestKey);
    assert.equal(after.connection, null); assert.deepEqual(after.observation, before.observation);
    assert.equal(f.calls[count].url, `${f.descriptor.origin}/v1/external/identity`);
    assert.equal((await f.helper.status()).state, 'pending');
    await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED'));
    f.approve(); assert.equal((await f.helper.status()).state, 'connected');
    assert.notEqual((await f.saved())[0].state.connection.grantId, before.connection.grantId);
    noSecrets(result, [before, after]);
  }
});

test('ordinary scoped rejection retires locally without ever reusing old approved receipt', async t => {
  const f = await fixture(t); await connected(f);
  [...f.requests.values()][0].revoked = true;
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_UNAUTHORIZED'));
  const retired = (await f.saved())[0].state; assert.equal(retired.phase, 'retired'); assert.equal(retired.connection, null);
  const count = f.calls.length; assert.equal((await f.helper.status()).state, 'retired');
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED')); assert.equal(f.calls.length, count);
  assert.equal(f.requests.size, 1, 'retirement alone must not request enrollment');
});

test('timeouts, HTTP 503, wrong service and changed identity do NOT retire or replace proofs', async t => {
  const cases = [
    ['EXTERNAL_TIMEOUT', 504], ['EXTERNAL_UNAVAILABLE', 503], ['EXTERNAL_UNAUTHORIZED', 503],
    ['EXTERNAL_STATE_MISMATCH', 409], ['EXTERNAL_PROTOCOL_MISMATCH', 409], ['EXTERNAL_IDENTITY_MISMATCH', 409],
  ];
  for (const [errorCode, status] of cases) {
    const f = await fixture(t); await connected(f);
    const before = (await f.saved())[0].state;
    f.beforeFetch(call => { if (call.url.endsWith('/identity')) throw new MurmurError('Injected nondefinitive failure.', errorCode, status); });
    await assert.rejects(f.helper.start({ ...startInput, groupTitle: 'Fresh' }), code(errorCode));
    await assert.rejects(f.helper.status(), code(errorCode));
    assert.deepEqual((await f.saved())[0].state, before); assert.equal(f.requests.size, 1);
  }
});

test('definitive rejection cannot retire a binding after its fresh native pins change', async t => {
  const f = await fixture(t); await connected(f); const before = (await f.saved())[0].state;
  f.beforeFetch(call => {
    if (call.url.endsWith('/identity')) {
      f.setCurrent({ ...f.current, native: { ...f.current.native, incarnationId: 'after-clear' } });
      throw new MurmurError('Rejected old authority.', 'EXTERNAL_UNAUTHORIZED', 401);
    }
  });
  await assert.rejects(f.helper.start({ ...startInput, groupTitle: 'Fresh' }), code('EXTERNAL_NATIVE_CHANGED'));
  assert.deepEqual((await f.saved())[0].state, before); assert.equal(f.requests.size, 1);
});

test('late pending request is replaced only after authenticated server expiry, not the local clock', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); await f.helper.start(startInput);
  const old = (await f.saved())[0].state, request = [...f.requests.values()][0];
  now += 11 * 60_000;
  // A still-pending server response wins over the elapsed local request deadline.
  const count = f.calls.length;
  assert.equal((await f.helper.start(startInput)).state, 'pending');
  assert.equal(f.requests.size, 1); assert.equal((await f.saved())[0].state.candidateCapability, old.candidateCapability);
  assert.equal(f.calls[count].url, `${f.descriptor.origin}/v1/enrollment/status`);
  request.receipt = { ...request.receipt, state: 'expired' };
  const expiredCount = f.calls.length;
  assert.equal((await f.helper.start({ ...startInput, groupTitle: 'After expiry' })).state, 'pending');
  assert.equal(f.calls[expiredCount].url, `${f.descriptor.origin}/v1/enrollment/status`);
  assert.equal(f.calls[expiredCount + 1].url, `${f.descriptor.origin}/v1/enrollment/requests`);
  assert.equal(f.requests.size, 2); assert.notEqual((await f.saved())[0].state.candidateCapability, old.candidateCapability);
});

test('late pending proof survives an unavailable polling service without fresh enrollment', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); await f.helper.start(startInput); const before = (await f.saved())[0].state;
  now += 11 * 60_000;
  f.beforeFetch(call => { if (call.url.endsWith('/v1/enrollment/status')) throw new MurmurError('Polling unavailable.', 'EXTERNAL_UNAVAILABLE', 503); });
  await assert.rejects(f.helper.start({ ...startInput, groupTitle: 'Must not replace' }), code('EXTERNAL_UNAVAILABLE'));
  await assert.rejects(f.helper.status(), code('EXTERNAL_UNAVAILABLE'));
  assert.deepEqual((await f.saved())[0].state, before); assert.equal(f.requests.size, 1);
});

test('actual immutable grant deadline retires independently from the old request deadline', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); await connected(f); const old = (await f.saved())[0].state;
  now = old.connection.expiresAt + 1;
  const count = f.calls.length;
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_EXPIRED'));
  assert.equal(f.calls.length, count, 'known fixed grant expiry needs no provider request');
  assert.equal((await f.saved())[0].state.phase, 'retired');
  assert.equal((await f.helper.start(startInput)).state, 'pending');
  assert.notEqual((await f.saved())[0].state.candidateCapability, old.candidateCapability);
  await assert.rejects(f.helper.refresh(), code('EXTERNAL_NOT_CONNECTED'));
});

test('definitive rejection cannot retire or replace after workspace directory substitution', async t => {
  const f = await fixture(t); await connected(f); const before = (await f.saved())[0].state;
  f.beforeFetch(async call => {
    if (call.url.endsWith('/identity')) {
      await rename(f.workspace, `${f.workspace}-old`); await mkdir(f.workspace);
      throw new MurmurError('Rejected old authority.', 'EXTERNAL_UNAUTHORIZED', 401);
    }
  });
  await assert.rejects(f.helper.start({ ...startInput, groupTitle: 'Must not replace' }), code('EXTERNAL_NATIVE_CHANGED'));
  assert.deepEqual((await f.saved())[0].state, before); assert.equal(f.requests.size, 1);
});

test('approved-only calls leave unlinked chats without files, mutexes or network', async t => {
  const f = await fixture(t);
  assert.equal(await f.helper.peekApproved(), false);
  assert.equal(await f.helper.refreshApproved(), null);
  for (const operation of ['identity', 'member-status', 'intent', 'task-status', 'check-plan', 'propose-decision', 'reserve', 'release', 'leave']) {
    assert.equal(await f.helper.runApproved(operation), null);
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.state), []);
  assert.throws(() => f.helper.runApproved('approve'), code('EXTERNAL_INPUT'));
  assert.throws(() => f.helper.runApproved('context', { nativeId: 'other' }), code('EXTERNAL_INPUT'));
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.state), []);
});

test('approved-only calls never poll or activate pending requests, even after human approval', async t => {
  const f = await fixture(t); await f.helper.start(startInput);
  const before = (await f.saved())[0], bytes = await readFile(before.filename), mutex = await mutexPaths(f);
  await rm(mutex.directory, { recursive: true }); // The fixture owns this idle marker.
  const files = await readdir(f.state), count = f.calls.length;
  for (const approve of [false, true]) {
    if (approve) f.approve();
    assert.equal(await f.helper.peekApproved(), false);
    assert.equal(await f.helper.refreshApproved(), null);
    assert.equal(await f.helper.runApproved('intent', { revision: 1, writes: ['src'] }, 'auto-intent'), null);
    assert.deepEqual(await readdir(f.state), files);
    assert.deepEqual(await readFile(before.filename), bytes); assert.equal(f.calls.length, count);
  }
  assert.equal((await f.saved())[0].state.phase, 'pending');
  assert.equal((await f.helper.status()).state, 'connected', 'explicit status retains its existing activation behavior');
  assert.equal(await f.helper.peekApproved(), true);
});

test('approved-only calls do not recreate locks or reuse terminal and expired authority', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const terminal of ['left', 'retired', 'expired']) {
    const f = await fixture(t); await connected(f);
    if (terminal === 'left') await f.helper.leave();
    if (terminal === 'retired') {
      [...f.requests.values()][0].revoked = true;
      await assert.rejects(f.helper.refreshApproved(), code('EXTERNAL_UNAUTHORIZED'));
    }
    if (terminal === 'expired') now = (await f.saved())[0].state.connection.expiresAt;
    const before = (await f.saved())[0], bytes = await readFile(before.filename), count = f.calls.length;
    await rm((await mutexPaths(f)).directory, { recursive: true });
    const files = await readdir(f.state);
    assert.equal(await f.helper.peekApproved(), false);
    assert.equal(await f.helper.refreshApproved(), null);
    assert.equal(await f.helper.runApproved('leave'), null);
    assert.equal(f.calls.length, count); assert.equal(f.requests.size, 1);
    assert.deepEqual(await readFile(before.filename), bytes); assert.deepEqual(await readdir(f.state), files);
  }
});

test('approved-only operations reuse the fixed grant, validated inputs and secret redaction', async t => {
  const f = await fixture(t); await connected(f);
  const before = (await f.saved())[0], bytes = await readFile(before.filename), count = f.calls.length;
  assert.equal(await f.helper.peekApproved(), true); assert.equal(f.calls.length, count);
  const result = await f.helper.refreshApproved(7);
  assert(f.calls[count].url.endsWith('/v1/external/identity'));
  assert(f.calls[count + 1].url.endsWith('/v1/external/context?after=7'));
  const intent = await f.helper.runApproved('intent', { revision: 3, writes: ['src'] }, 'approved-intent');
  assert.equal(f.calls.at(-1).headers.get('Idempotency-Key'), 'approved-intent');
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { revision: 3, writes: ['src'] });
  noSecrets([result, intent], [before.state]);
  assert.deepEqual(await readFile(before.filename), bytes); assert.equal(f.requests.size, 1);
  assert(!f.calls.slice(count).some(call => call.url.includes('/enrollment/')));
  const current = f.calls.length;
  await assert.rejects(f.helper.runApproved('intent', { revision: 3, sessionId: 'other' }), code('EXTERNAL_INPUT'));
  await assert.rejects(f.helper.runApproved('task-status', { revision: 3, status: 'completed' }), code('EXTERNAL_INPUT'));
  assert.equal(f.calls.length, current);
});

test('a local peek is not authority: later native/workspace changes stay unlinked without new files', async t => {
  for (const changed of ['nativeId', 'incarnationId', 'workspace']) {
    const f = await fixture(t); await connected(f);
    assert.equal(await f.helper.peekApproved(), true);
    const files = await readdir(f.state), count = f.calls.length;
    if (changed === 'workspace') { await rename(f.workspace, `${f.workspace}-old`); await mkdir(f.workspace); }
    else f.setCurrent({ ...f.current, native: { ...f.current.native, [changed]: 'new-native-identity' } });
    assert.equal(await f.helper.peekApproved(), false); assert.equal(await f.helper.refreshApproved(), null);
    assert.equal(f.calls.length, count); assert.deepEqual(await readdir(f.state), files);
  }
});

test('approved-only mutations recheck fresh identity after asynchronous handshake', async t => {
  const f = await fixture(t); await connected(f); const before = (await f.saved())[0], count = f.calls.length;
  f.beforeFetch(call => { if (call.url.endsWith('/identity')) f.setCurrent({ ...f.current, native: { ...f.current.native, incarnationId: 'after-clear' } }); });
  await assert.rejects(f.helper.runApproved('intent', { revision: 1, writes: ['src'] }, 'before-clear'), code('EXTERNAL_NATIVE_CHANGED'));
  assert.equal(f.calls.length, count + 1); assert(f.calls.at(-1).url.endsWith('/identity'));
  assert.deepEqual((await f.saved())[0], before); assert.equal(f.requests.size, 1);
});

test('read-only peeks cannot release the active operation SQLite mutex', { timeout: 15000 }, async t => {
  const f = await fixture(t); await connected(f);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  f.beforeFetch(async call => { if (call.url.endsWith('/identity')) { entered(); await pending; } });
  const held = f.helper.refreshApproved(); await started;
  try {
    assert.equal(await new ExistingChatHelper(f.options).peekApproved(), true);
    await assert.rejects(new ExistingChatHelper(f.options).refreshApproved(), code('EXTERNAL_HELPER_BUSY'));
    const contender = await mutexWorker(t, f);
    assert.deepEqual(contender.message, { kind: 'error', code: 'EXTERNAL_HELPER_BUSY' }); await contender.exited;
  } finally { release(); await held; }
});

test('approved-only service outages preserve proof and never poll, renew or re-enroll', async t => {
  const f = await fixture(t); await connected(f); const before = (await f.saved())[0];
  for (const [failure, status] of [['EXTERNAL_UNAVAILABLE', 503], ['EXTERNAL_TIMEOUT', 504], ['EXTERNAL_STATE_MISMATCH', 409]]) {
    f.beforeFetch(() => { throw new MurmurError('Raw fixture credential MUST-NOT-LEAK', failure, status); });
    const count = f.calls.length;
    await assert.rejects(f.helper.refreshApproved(), code(failure));
    assert.equal(f.calls.length, count + 1); assert(f.calls.at(-1).url.endsWith('/identity'));
    assert.deepEqual((await f.saved())[0], before); assert.equal(f.requests.size, 1);
  }
});

test('approved-only peeks and operations reject unsafe private proofs without replacing them', async t => {
  const f = await fixture(t); await connected(f); const before = (await f.saved())[0], count = f.calls.length;
  await chmod(before.filename, 0o644);
  await assert.rejects(f.helper.peekApproved(), code('EXTERNAL_PRIVATE_STATE'));
  await assert.rejects(f.helper.refreshApproved(), code('EXTERNAL_PRIVATE_STATE'));
  assert.equal(f.calls.length, count); assert.equal((await lstat(before.filename)).mode & 0o077, 0o044);
});

test('optional context policy keeps inactive chats read-only without new locks or polling', async t => {
  const f = await fixture(t), policy = { minimumIntervalMs: 1000, deduplicate: true };
  assert.equal(await f.helper.refreshApproved(0, policy), null);
  assert.deepEqual(await readdir(f.state), []); assert.equal(f.calls.length, 0);
  await f.helper.start(startInput); f.approve();
  const before = (await f.saved())[0], count = f.calls.length;
  await rm((await mutexPaths(f)).directory, { recursive: true });
  const files = await readdir(f.state);
  assert.equal(await f.helper.refreshApproved(0, policy), null);
  assert.deepEqual((await f.saved())[0], before); assert.equal(f.calls.length, count); assert.deepEqual(await readdir(f.state), files);
});

test('context policy stores only epoch-bound hashes/times, suppresses duplicates and refreshes changed context', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); await connected(f);
  let briefing = 'Fixture context must never be retained as raw private cache data';
  const fetch = async (url, init) => {
    const response = await f.options.transport.fetch(url, init);
    return String(url).includes('/v1/external/context') ? new Response(JSON.stringify({ briefing }), { headers: response.headers }) : response;
  };
  const helper = new ExistingChatHelper({ ...f.options, transport: { fetch } }), policy = { minimumIntervalMs: 1000, deduplicate: true };
  const original = (await f.saved())[0].state;
  assert.deepEqual(await delivered(helper, 0, policy), { briefing });
  const count = f.calls.length, first = (await f.saved())[0].state;
  assert.equal(first.connection.expiresAt, original.connection.expiresAt); assert.equal(first.candidateCapability, original.candidateCapability);
  assert.deepEqual(Object.keys(first.contextDelivery).sort(), ['attemptedAt', 'fingerprint', 'generatedAt']);
  assert.equal(first.contextDelivery.fingerprint, hash(briefing)); assert(!JSON.stringify(first).includes(briefing));
  assert.equal(await delivered(helper, 0, policy), null); assert.equal(f.calls.length, count);
  now += 1000; assert.equal(await delivered(helper, 0, policy), null); assert.equal(f.calls.length, count + 2);
  now += 1000; briefing = 'A newly accepted decision or conflict alert';
  assert.deepEqual(await delivered(helper, 0, policy), { briefing });
  now += 1000; assert.deepEqual(await delivered(helper, 0, { ...policy, deduplicate: false }), { briefing });
  now += 60_000; assert.deepEqual(await delivered(helper, 0, policy), { briefing });
  now += 1000; briefing = 'Event history was pruned through sequence 100; missing events cannot be replayed. Read current state.\n' + briefing;
  assert.deepEqual(await delivered(helper, 0, policy), { briefing }, 'A newly added retention-gap notice must invalidate native context dedupe');
  const last = (await f.saved())[0].state; assert.equal(last.connection.expiresAt, original.connection.expiresAt); assert(!JSON.stringify(last).includes(briefing));
  [...f.requests.values()][0].revoked = true;
  await f.helper.start({ ...startInput, groupTitle: 'Explicit new approval epoch' });
  const replacement = (await f.saved())[0].state;
  assert.notEqual(replacement.candidateCapability, original.candidateCapability); assert.equal(replacement.contextDelivery, undefined);
});

test('context policy bounds outage retries without discarding or renewing authority', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); await connected(f); const original = (await f.saved())[0].state;
  f.beforeFetch(() => { throw new MurmurError('Untrusted raw network error', 'EXTERNAL_UNAVAILABLE', 503); });
  const policy = { minimumIntervalMs: 1000, deduplicate: true }, count = f.calls.length;
  await assert.rejects(f.helper.refreshApproved(0, policy), code('EXTERNAL_UNAVAILABLE'));
  assert.equal(await f.helper.refreshApproved(0, policy), null); assert.equal(f.calls.length, count + 1);
  now += 1000; await assert.rejects(f.helper.refreshApproved(0, policy), code('EXTERNAL_UNAVAILABLE'));
  assert.equal(f.calls.length, count + 2); const after = (await f.saved())[0].state;
  assert.deepEqual(after.connection, original.connection); assert.equal(after.candidateCapability, original.candidateCapability); assert.equal(f.requests.size, 1);
});

async function contextFixture(t) {
  const f = await fixture(t); await connected(f);
  const briefing = 'Accepted critical-contract@v2: Stop old writes';
  const transport = { fetch: async (url, init) => {
    const response = await f.options.transport.fetch(url, init);
    return String(url).includes('/v1/external/context') ? new Response(JSON.stringify({ briefing }), { headers: response.headers }) : response;
  } };
  const options = { ...f.options, transport };
  return { ...f, briefing, options, helper: new ExistingChatHelper(options), policy: { minimumIntervalMs: 0, deduplicate: true } };
}

test('dedupe requires the exact successful result to be acknowledged; copies and lost results stay retryable', async t => {
  const f = await contextFixture(t);
  const first = await f.helper.refreshApproved(0, f.policy), before = (await f.saved())[0];
  assert.equal(before.state.contextDelivery.fingerprint, null);
  await acknowledgeApprovedContext(JSON.parse(JSON.stringify(first)));
  assert.deepEqual((await f.saved())[0], before);
  const second = await f.helper.refreshApproved(0, f.policy), newer = (await f.saved())[0];
  assert.deepEqual(second, first);
  await acknowledgeApprovedContext(first);
  assert.deepEqual((await f.saved())[0], newer, 'A stale result cannot overwrite a later attempt');
  await acknowledgeApprovedContext(second);
  assert.equal((await f.saved())[0].state.contextDelivery.fingerprint, hash(f.briefing));
  assert.equal(await f.helper.refreshApproved(0, f.policy), null);
});

test('timeout after context generation cannot deduplicate an unreturned briefing', async t => {
  const f = await contextFixture(t);
  let generated = false, enter, release;
  const started = new Promise(resolve => { enter = resolve; }), hold = new Promise(resolve => { release = resolve; });
  t.after(release);
  const helper = new ExistingChatHelper({ ...f.options, timeoutMs: 100,
    nativeContext: async () => { if (generated) { enter(); await hold; } return f.current; },
    transport: { fetch: async (url, init) => {
      const response = await f.options.transport.fetch(url, init);
      if (String(url).includes('/v1/external/context')) generated = true;
      return response;
    } },
  });
  const failed = assert.rejects(helper.refreshApproved(0, f.policy), code('EXTERNAL_TIMEOUT'));
  await started; await failed;
  assert.equal((await f.saved())[0].state.contextDelivery.fingerprint, null);
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await delivered(f.helper, 0, f.policy), { briefing: f.briefing });
  assert.equal((await f.saved())[0].state.contextDelivery.fingerprint, hash(f.briefing));
});

test('final freshness failure leaves generated context retryable without any cleanup write', async t => {
  const f = await contextFixture(t); let generated = false;
  const helper = new ExistingChatHelper({ ...f.options,
    nativeContext: () => { if (generated) throw new Error('PRIVATE-FRESHNESS-FAILURE'); return f.current; },
    transport: { fetch: async (url, init) => { const response = await f.options.transport.fetch(url, init); if (String(url).includes('/v1/external/context')) generated = true; return response; } },
  });
  await assert.rejects(helper.refreshApproved(0, f.policy), code('EXTERNAL_PRIVATE_STATE'));
  assert.equal((await f.saved())[0].state.contextDelivery.fingerprint, null);
  assert.deepEqual(await delivered(f.helper, 0, f.policy), { briefing: f.briefing });
});

test('stale acknowledgements cannot touch a replacement epoch or a different native chat', async t => {
  for (const change of ['epoch', 'native']) {
    const f = await contextFixture(t), context = await f.helper.refreshApproved(0, f.policy);
    if (change === 'epoch') {
      await f.helper.leave(); await f.helper.start({ ...startInput, groupTitle: 'Replacement epoch' });
      f.approve(); await f.helper.status();
    } else f.setCurrent({ ...f.current, native: { ...f.current.native, incarnationId: 'different-native-chat' } });
    const before = await f.saved(), files = await readdir(f.state), count = f.calls.length;
    await acknowledgeApprovedContext(context);
    assert.deepEqual(await f.saved(), before); assert.deepEqual(await readdir(f.state), files); assert.equal(f.calls.length, count);
  }
});

test('timed-out acknowledgements retain the mutex and cannot later overwrite changed proof state', async t => {
  const f = await contextFixture(t); let acknowledging = false, checks = 0, enter, release;
  const started = new Promise(resolve => { enter = resolve; }), hold = new Promise(resolve => { release = resolve; });
  t.after(release);
  const helper = new ExistingChatHelper({ ...f.options, nativeContext: async () => {
    if (acknowledging && ++checks === 7) { enter(); await hold; }
    return f.current;
  } });
  const context = await helper.refreshApproved(0, f.policy);
  acknowledging = true;
  const completion = acknowledgeApprovedContext(context);
  await started; await completion;
  await assert.rejects(f.helper.status(), code('EXTERNAL_HELPER_BUSY'));
  const before = (await f.saved())[0];
  const changed = { ...before.state, phase: 'left', connection: null };
  await writeFile(before.filename, JSON.stringify(changed), { mode: 0o600 });
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual((await f.saved())[0].state, changed);
  await acknowledgeApprovedContext(context);
  assert.deepEqual((await f.saved())[0].state, changed);
  assert.equal((await f.helper.status()).state, 'left');
});
