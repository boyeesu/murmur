import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { LaunchService } from '../packages/murmur/dist/core/launches.js';
import { preflightDriver, createDriverInvocation, STARTUP_CONTEXT_BYTES } from '../packages/murmur/dist/adapters/drivers.js';
import { parseRunArguments, runMain, runHelp } from '../packages/murmur/dist/cli/run.js';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request, loadDescriptor } from '../packages/murmur/dist/cli/client.js';
import { temporary, repository, git, mutation } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const agentToken = 'a'.repeat(43), supervisorToken = 'b'.repeat(43), adminToken = 'c'.repeat(43);
const rootHelp = `Usage: opencode <subcommand> [flags] [<directory>]
Arguments:
  [<directory>]  Optional workspace directory
Flags:
  --standalone  Run with a private server instead of the background service
  --prompt string  Initial prompt
`;
const args = ['opencode', '--project', 'project-1', '--title', 'New OpenCode task'];
const runtime = { origin: 'http://127.0.0.1:7777', stateId: 'd'.repeat(64), instanceId: 'migration-runtime' };
const digest = value => createHash('sha256').update(value).digest('hex');

async function fakeOpenCode(t) {
  const root = await temporary(t), bin = path.join(root, 'bin'), workspace = path.join(root, "managed 'quotes' and $dollars");
  await mkdir(bin); await mkdir(workspace);
  const executable = path.join(bin, 'opencode'), trace = path.join(root, 'trace.jsonl');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({args, cwd:process.cwd(), env:process.env})+'\\n');
if(args[0]==='--version') console.log(process.env.FAKE_VERSION || 'v2.0.12');
else if(args[0]==='--help') console.log(process.env.FAKE_HELP || ${JSON.stringify(rootHelp)});
else console.log('FAKE_OPENCODE_COMPLETED');
`, { mode: 0o700 });
  return { executable, trace, workspace, env: { PATH: bin, TRACE: trace, OPENCODE_TEST_AUTH: 'ordinary-native-auth', MURMUR_HOME: path.join(root, 'human-state'), MURMUR_ADMIN_TOKEN: adminToken, MURMUR_SUPERVISOR_TOKEN: supervisorToken, murmur_private: 'not-child-authority' } };
}
function preparation(workspace) {
  const base = { protocolVersion: 1, origin: runtime.origin, stateId: runtime.stateId, launchId: 'launch-1' };
  return {
    launch: { id: 'launch-1', tool: 'opencode', projectId: 'project-1', title: args.at(-1), featureKey: null,
      state: 'prepared', sessionId: 'session-1', taskId: 'task-1', workspaceId: 'workspace-1', workspaceRoot: workspace,
      baseSha: 'e'.repeat(40), nativeSessionId: null, nativeIdentitySource: 'unverified', lifecycleRevision: 1,
      expiresAt: Date.now() + 120000, controllerId: null, pid: null, createdAt: Date.now(), startedAt: null,
      endedAt: null, exitCode: null, errorCode: null, bridgeLastSeenAt: null },
    agent: { ...base, projectId: 'project-1', sessionId: 'session-1', taskId: 'task-1', agentToken },
    supervisor: { ...base, supervisorToken }, briefing: 'Untrusted task notes.',
  };
}

test('OpenCode parser exposes only the new-task CLI contract and preserves optional request IDs', () => {
  assert.deepEqual(parseRunArguments(args), { tool: 'opencode', projectId: 'project-1', title: args.at(-1) });
  const requestId = randomUUID();
  assert.equal(parseRunArguments([...args, '--request-id', requestId, '--bridge', 'cli']).requestId, requestId);
  assert.match(runHelp, /claude\|codex\|opencode/);
  assert.match(runHelp, /OpenCode V2 supports CLI only/);
  for (const extra of [['--auto'], ['--server', 'http://127.0.0.1:9000'], ['--resume'], ['--session-id', randomUUID()], ['--prompt', 'override'], ['--standalone'], ['--cwd', '/other'], ['--', '--auto'], ['--config', 'native.json'], ['--request-id', 'bad']]) {
    assert.throws(() => parseRunArguments([...args, ...extra]), { code: 'RUN_ARGUMENTS' });
  }
  assert.throws(() => parseRunArguments(['cursor', ...args.slice(1)]), { code: 'RUN_ARGUMENTS' });
});

test('OpenCode V2 preflight and root invocation use a scoped env, bounded data, and explicit workspace', async t => {
  const f = await fakeOpenCode(t), prepared = preparation(f.workspace);
  prepared.briefing = `${agentToken} ${supervisorToken} ${adminToken} ` + 'untrusted multibyte é text\n'.repeat(5000);
  const driver = await preflightDriver('opencode', { env: f.env });
  assert.equal(driver.executable, await realpath(f.executable));
  const invocation = createDriverInvocation(driver, prepared, { env: f.env });
  assert.deepEqual(invocation.args.slice(0, 2), ['--standalone', '--prompt']);
  assert.equal(invocation.args.length, 4);
  assert.equal(invocation.args[3], f.workspace);
  assert.equal(invocation.cwd, f.workspace);
  const prompt = invocation.args[2];
  assert(prompt.startsWith('Murmur managed launch integration (trusted launcher instructions)'));
  assert.match(prompt, /UNTRUSTED STARTUP DATA/);
  assert.match(prompt, /TRUNCATED: refresh with agent context/);
  assert.match(prompt, /Keep the user's normal approval and permission choices/);
  assert(Buffer.byteLength(prompt.slice(prompt.indexOf('UNTRUSTED STARTUP DATA'))) <= STARTUP_CONTEXT_BYTES);
  for (const secret of [agentToken, supervisorToken, adminToken]) assert(!prompt.includes(secret));
  assert.deepEqual(Object.keys(invocation.env).filter(key => /^MURMUR_/i.test(key)).sort(), ['MURMUR_AGENT_CONNECTION', 'MURMUR_AGENT_MODE']);
  assert.deepEqual(JSON.parse(invocation.env.MURMUR_AGENT_CONNECTION), prepared.agent);
  assert.equal(invocation.env.OPENCODE_TEST_AUTH, 'ordinary-native-auth');
  const result = await execute(invocation.executable, invocation.args, { env: invocation.env, cwd: invocation.cwd });
  assert.match(result.stdout, /FAKE_OPENCODE_COMPLETED/);
  const trace = (await readFile(f.trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(trace.slice(0, 2).map(item => item.args), [['--version'], ['--help']]);
  assert(trace.slice(0, 2).every(item => Object.keys(item.env).every(key => !/^MURMUR_/i.test(key))));
  assert.deepEqual(trace[2].args, invocation.args);
  assert.equal(trace[2].cwd, await realpath(f.workspace));
  assert.equal(prepared.launch.nativeSessionId, null);
  assert.equal(prepared.launch.nativeIdentitySource, 'unverified');
});

test('OpenCode preflight rejects V1, unknown major versions, and missing V2 root help contracts', async t => {
  const f = await fakeOpenCode(t);
  for (const version of ['1.2.3', 'opencode v1.2.3', 'v3.0.0', 'not-a-version', '2.0']) {
    await assert.rejects(preflightDriver('opencode', { env: { ...f.env, FAKE_VERSION: version } }), { code: 'NATIVE_CONTRACT_UNSUPPORTED' });
  }
  for (const help of [rootHelp.replace('--standalone', '--standalone-ish'), rootHelp.replace('--prompt', '--prompt-file'), rootHelp.replaceAll('[<directory>]', '[prompt]'), 'Usage: opencode run [prompt] --standalone --prompt']) {
    await assert.rejects(preflightDriver('opencode', { env: { ...f.env, FAKE_HELP: help } }), { code: 'NATIVE_CONTRACT_UNSUPPORTED' });
  }
  for (const version of ['2.0.12', 'opencode v2.0.12']) {
    assert.equal((await preflightDriver('opencode', { env: { ...f.env, FAKE_VERSION: version } })).tool, 'opencode');
  }
});

test('OpenCode refuses MCP and context hooks before preflight or any HTTP preparation', async () => {
  for (const flags of [['--bridge', 'mcp'], ['--context-hooks'], ['--bridge', 'cli', '--context-hooks'], ['--bridge', 'mcp', '--context-hooks']]) {
    let requests = 0, ids = 0;
    const stderr = [];
    const code = await runMain([...args, ...flags], { env: {}, executable: '/not-an-installed-cli',
      uuid: () => { ids++; return randomUUID(); }, request: async () => { requests++; throw new Error('must not prepare'); }, stderr: text => stderr.push(text) });
    assert.equal(code, 1); assert.equal(requests, 0); assert.equal(ids, 0);
    assert.match(stderr.join(''), /OpenCode V2 supports only --bridge cli without --context-hooks/);
    assert.match(stderr.join(''), /no preparation or configuration changes were made/);
    assert(!stderr.join('').includes('request ID'));
  }
  for (const options of [{ bridge: 'mcp' }, { contextHooks: true }]) {
    await assert.rejects(preflightDriver('opencode', { ...options, executable: '/not-an-installed-cli', env: {} }), { code: 'OPENCODE_MODE_UNSUPPORTED' });
    assert.throws(() => createDriverInvocation({ tool: 'opencode', executable: '/unused' }, preparation('/managed'), options), { code: 'OPENCODE_MODE_UNSUPPORTED' });
  }
});

// Frozen v1 fixture: do not generate old DDL by invoking the current LaunchService.
const v1Schema = `
CREATE TABLE murmur_launch_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
INSERT INTO murmur_launch_schema VALUES ('launches', 1);
CREATE TABLE murmur_launches (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), tool TEXT NOT NULL CHECK(tool IN ('claude','codex')),
  title TEXT NOT NULL, featureKey TEXT, state TEXT NOT NULL CHECK(state IN ('preparing','prepared','claimed','running','ended','failed','expired','recovery_required')),
  sessionId TEXT UNIQUE REFERENCES sessions(id), taskId TEXT UNIQUE REFERENCES tasks(id), workspaceId TEXT,
  workspaceRoot TEXT, baseSha TEXT, nativeSessionId TEXT, nativeIdentitySource TEXT NOT NULL,
  lifecycleRevision INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER, controllerId TEXT, pid INTEGER,
  createdAt INTEGER NOT NULL, startedAt INTEGER, endedAt INTEGER, exitCode INTEGER, errorCode TEXT, bridgeLastSeenAt INTEGER,
  requestCaller TEXT NOT NULL, requestKey TEXT NOT NULL, requestDigest TEXT NOT NULL, preparationInstanceId TEXT NOT NULL,
  phase TEXT NOT NULL, agentHash TEXT, agentToken TEXT, supervisorHash TEXT, supervisorToken TEXT,
  briefing TEXT, bridgeFirstSeenAt INTEGER, endReason TEXT, UNIQUE(requestCaller, requestKey)
);
CREATE INDEX murmur_launch_deadlines ON murmur_launches(state, expiresAt);
CREATE INDEX murmur_launch_project ON murmur_launches(projectId, createdAt);
CREATE UNIQUE INDEX fixture_launch_workspace ON murmur_launches(workspaceId) WHERE workspaceId IS NOT NULL;
`;
function migrate(store, instanceId = runtime.instanceId) { return new LaunchService(store, {}, {}, { ...runtime, instanceId }); }
function databaseSnapshot(store) {
  const tables = ['murmur_launches', 'sessions', 'tasks', 'mutations', 'events'];
  return Object.fromEntries(tables.map(name => [name, store.db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]));
}
function schemaSnapshot(store) { return store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(); }
function oldLaunches(t, filename = ':memory:') {
  const store = new CoordinationStore(filename, () => 1000);
  t.after(() => store.close());
  store.db.exec(v1Schema);
  const data = { root: '/migration', canonicalPath: '/migration', mode: 'advisory', caseSensitive: true };
  const project = store.registerProject(data, mutation('project', data));
  const tokens = {};
  for (const [index, state] of ['prepared', 'running', 'ended', 'claimed'].entries()) {
    const tool = index % 2 ? 'codex' : 'claude';
    const sessionInput = { projectId: project.id, tool, nativeId: `fixture-native-${index}`, instanceId: `fixture-${index}`, workspaceRoot: `/migration/${state}` };
    const { session, token } = store.registerSession(sessionInput, mutation('session', sessionInput));
    const taskInput = { projectId: project.id, sessionId: session.id, title: `Fixture ${state}`, featureKey: null };
    const task = store.createTask(taskInput, mutation('task', taskInput));
    tokens[state] = token;
    const supervisor = String(index + 1).repeat(43);
    store.db.prepare("UPDATE sessions SET credentialMode='managed',tokenHash=? WHERE id=?").run(state === 'ended' ? digest('revoked') : digest(token), session.id);
    const row = { id: `fixture-${state}`, projectId: project.id, tool, title: task.title, featureKey: `feature-${index}`, state,
      sessionId: session.id, taskId: task.id, workspaceId: `workspace-${index}`, workspaceRoot: session.workspaceRoot, baseSha: 'f'.repeat(40),
      nativeSessionId: tool === 'claude' ? randomUUID() : null, nativeIdentitySource: tool === 'claude' ? 'requested' : 'unverified',
      lifecycleRevision: index + 7, expiresAt: state === 'ended' ? 900 : 999999, controllerId: state === 'prepared' ? null : `controller-${index}`,
      pid: state === 'running' || state === 'ended' ? 23456 + index : null, createdAt: 100, startedAt: state === 'running' || state === 'ended' ? 200 : null,
      endedAt: state === 'ended' ? 900 : null, exitCode: state === 'ended' ? 17 : null, errorCode: null,
      bridgeLastSeenAt: state === 'running' ? 950 : null, requestCaller: 'human', requestKey: `prepare-${index}`, requestDigest: digest(`request-${index}`),
      preparationInstanceId: runtime.instanceId, phase: 'complete', agentHash: digest(token), agentToken: state === 'prepared' ? token : null,
      supervisorHash: digest(supervisor), supervisorToken: state === 'prepared' ? supervisor : null, briefing: `Private cache ${index}\nline 2`,
      bridgeFirstSeenAt: state === 'running' ? 900 : null, endReason: state === 'ended' ? 'exited' : null };
    store.db.prepare(`INSERT INTO murmur_launches (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    store.db.prepare('INSERT INTO mutations (caller,key,digest,response,createdAt) VALUES (?,?,?,?,?)').run(`supervisor:${row.id}`, `control-${index}`, digest(`control-${index}`), JSON.stringify({ state, lifecycleRevision: row.lifecycleRevision }), 800);
  }
  return { store, tokens };
}

test('launch schema v1 migration preserves populated rows, all credentials, journals, deadlines and indexes', async t => {
  const { store, tokens } = oldLaunches(t);
  const before = databaseSnapshot(store), indexes = schemaSnapshot(store).filter(row => row.type === 'index');
  const columns = store.db.prepare('PRAGMA table_info(murmur_launches)').all();
  const foreignKeys = store.db.prepare('PRAGMA foreign_key_list(murmur_launches)').all();
  const launches = migrate(store); t.after(() => launches.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(store.db.prepare("SELECT version FROM murmur_launch_schema WHERE name='launches'").get().version, 2);
  assert.deepEqual(databaseSnapshot(store), before);
  assert.deepEqual(schemaSnapshot(store).filter(row => row.type === 'index'), indexes);
  assert.deepEqual(store.db.prepare('PRAGMA table_info(murmur_launches)').all(), columns);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_list(murmur_launches)').all(), foreignKeys);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert(store.authenticateSession(tokens.running));
  assert(store.authenticateSession(tokens.claimed));
  assert.equal(store.authenticateSession(tokens.prepared), undefined);
  assert.equal(store.authenticateSession(tokens.ended), undefined);
  const again = migrate(store); t.after(() => again.close());
  assert.deepEqual(databaseSnapshot(store), before);
  // Only the tool CHECK widens: uniqueness remains enforced, Cursor remains unsupported.
  store.db.prepare("UPDATE murmur_launches SET tool='opencode' WHERE id='fixture-prepared'").run();
  assert.throws(() => store.db.prepare("UPDATE murmur_launches SET tool='cursor' WHERE id='fixture-prepared'").run(), /CHECK constraint/);
  assert.throws(() => store.db.prepare("UPDATE murmur_launches SET workspaceId='workspace-0' WHERE id='fixture-running'").run(), /UNIQUE constraint/);
  assert.throws(() => store.db.prepare("UPDATE murmur_launches SET requestKey='prepare-0' WHERE id='fixture-running'").run(), /UNIQUE constraint/);
  assert.throws(() => store.db.prepare("UPDATE murmur_launches SET sessionId=(SELECT sessionId FROM murmur_launches WHERE id='fixture-prepared') WHERE id='fixture-running'").run(), /UNIQUE constraint/);
  assert.throws(() => store.db.prepare("UPDATE murmur_launches SET taskId=(SELECT taskId FROM murmur_launches WHERE id='fixture-prepared') WHERE id='fixture-running'").run(), /UNIQUE constraint/);
});

test('launch schema migration failure after rebuild rolls back schema, rows and private state', t => {
  const { store } = oldLaunches(t);
  store.db.exec(`CREATE TRIGGER fixture_fail_version BEFORE UPDATE OF version ON murmur_launch_schema
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  const before = databaseSnapshot(store), schema = schemaSnapshot(store);
  assert.throws(() => migrate(store), /injected migration failure/);
  assert.equal(store.db.prepare("SELECT version FROM murmur_launch_schema WHERE name='launches'").get().version, 1);
  assert.deepEqual(databaseSnapshot(store), before);
  assert.deepEqual(schemaSnapshot(store), schema);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  store.db.exec('DROP TRIGGER fixture_fail_version');
  const launches = migrate(store); t.after(() => launches.close());
  assert.deepEqual(databaseSnapshot(store), before);
});

test('launch schema refuses unknown fields, altered constraints, missing indexes, triggers and inbound references without data loss', t => {
  for (const alter of [
    "ALTER TABLE murmur_launches ADD COLUMN unknownPrivateCache TEXT DEFAULT 'must survive'",
    'DROP INDEX murmur_launch_deadlines',
    'CREATE TRIGGER unknown_launch_trigger AFTER DELETE ON murmur_launches BEGIN DELETE FROM mutations; END',
    'CREATE TABLE unknown_launch_child (launchId TEXT REFERENCES murmur_launches(id) ON DELETE CASCADE)',
    'ALTER TABLE murmur_launches RENAME COLUMN supervisorHash TO unknownHash',
  ]) {
    const { store } = oldLaunches(t);
    store.db.exec(alter);
    const before = databaseSnapshot(store), schema = schemaSnapshot(store);
    assert.throws(() => migrate(store), { code: 'LAUNCH_SCHEMA_INVALID' });
    assert.deepEqual(databaseSnapshot(store), before);
    assert.deepEqual(schemaSnapshot(store), schema);
  }
});

test('launch schema v2 fresh databases reopen and reject newer versions before recovery', async t => {
  const root = await temporary(t), filename = path.join(root, 'launch-schema.sqlite');
  const first = new CoordinationStore(filename, () => 1000), launches = migrate(first);
  assert.equal(first.db.prepare("SELECT version FROM murmur_launch_schema WHERE name='launches'").get().version, 2);
  const schema = schemaSnapshot(first);
  await launches.close(); first.close();
  const reopened = new CoordinationStore(filename, () => 1000); t.after(() => reopened.close());
  const again = migrate(reopened); t.after(() => again.close());
  assert.deepEqual(schemaSnapshot(reopened), schema);
  reopened.db.exec("UPDATE murmur_launch_schema SET version=3 WHERE name='launches'");
  const before = schemaSnapshot(reopened);
  assert.throws(() => migrate(reopened), { code: 'SCHEMA_TOO_NEW' });
  assert.deepEqual(schemaSnapshot(reopened), before);
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 4);
});

test('newer launch schema rejects populated state before restart recovery or credential changes', t => {
  const { store } = oldLaunches(t);
  store.db.exec("UPDATE murmur_launch_schema SET version=3 WHERE name='launches'");
  const before = databaseSnapshot(store), schema = schemaSnapshot(store);
  assert.throws(() => migrate(store, 'different-runtime'), { code: 'SCHEMA_TOO_NEW' });
  assert.deepEqual(databaseSnapshot(store), before);
  assert.deepEqual(schemaSnapshot(store), schema);
  assert.equal(store.db.prepare("SELECT version FROM murmur_launch_schema WHERE name='launches'").get().version, 3);
});

test('OpenCode fixture daemon plus fake CLI exercises scoped bridge and preserves source/task on exit', async t => {
  const root = await temporary(t), home = path.join(root, 'state'), bin = path.join(root, 'bin');
  await mkdir(bin);
  const source = await repository(path.join(root, 'source')), original = git(source, 'rev-parse', 'HEAD');
  const daemon = await startDaemon(home);
  try {
    const project = await request(home, 'POST', '/v1/projects', { root: source });
    const descriptor = await loadDescriptor(home);
    const native = path.join(bin, 'opencode');
    await writeFile(native, `#!${process.execPath}
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
if(args[0]==='--version') { console.log('v2.0.12'); process.exit(0); }
if(args[0]==='--help') { console.log(${JSON.stringify(rootHelp)}); process.exit(0); }
const connection = JSON.parse(process.env.MURMUR_AGENT_CONNECTION);
const invoke = (...args) => JSON.parse(execFileSync(process.execPath, [${JSON.stringify(cli)}, 'agent', ...args], {env:process.env,encoding:'utf8'}));
const context = invoke('context');
invoke('intent', '--revision', String(context.task.revision), '--data', JSON.stringify({writes:['src/opencode.ts']}));
const updated = invoke('context');
let humanBlocked = false;
try { execFileSync(process.execPath,[${JSON.stringify(cli)},'status'],{env:process.env,stdio:['ignore','pipe','pipe']}); }
catch(error) { humanBlocked = String(error.stderr).includes('HUMAN_COMMAND_FORBIDDEN'); }
console.log('OPENCODE_FIXTURE '+JSON.stringify({args,cwd:process.cwd(),taskId:connection.taskId,sessionId:connection.sessionId,revision:updated.task.revision,humanBlocked,murmurKeys:Object.keys(process.env).filter(key=>/^MURMUR_/i.test(key)),hasAgentCredential:Boolean(connection.agentToken)}));
`);
    await chmod(native, 0o700);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MURMUR_/i.test(key))), PATH: bin + path.delimiter + process.env.PATH,
      MURMUR_HOME: home, MURMUR_ADMIN_TOKEN: descriptor.token, MURMUR_SUPERVISOR_TOKEN: supervisorToken };
    const output = await execute(process.execPath, [cli, 'run', 'opencode', '--project', project.id, '--title', 'Fake OpenCode V2 work', '--bridge', 'cli'], { env, timeout: 45000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(output.stdout.split('\n').find(line => line.startsWith('OPENCODE_FIXTURE ')).slice('OPENCODE_FIXTURE '.length));
    assert.deepEqual(result.args.slice(0, 2), ['--standalone', '--prompt']);
    assert.equal(result.args.length, 4); assert.equal(result.args[3], result.cwd);
    assert.notEqual(result.cwd, await realpath(source));
    assert.deepEqual(result.murmurKeys.sort(), ['MURMUR_AGENT_CONNECTION', 'MURMUR_AGENT_MODE']);
    assert(result.humanBlocked); assert(result.hasAgentCredential); assert(result.revision > 1);
    const status = await request(home, 'GET', `/v1/status?projectId=${project.id}`);
    assert.equal(status.launches.length, 1);
    const launch = status.launches[0], task = status.tasks.find(item => item.id === result.taskId), session = status.sessions.find(item => item.id === result.sessionId);
    assert.equal(launch.tool, 'opencode'); assert.equal(launch.state, 'ended'); assert.equal(launch.exitCode, 0);
    assert.equal(launch.nativeSessionId, null); assert.equal(launch.nativeIdentitySource, 'unverified');
    assert.equal(session.nativeId, `launch:${launch.id}`); assert.equal(session.credentialMode, 'managed');
    assert.equal(task.status, 'active'); assert.equal(task.ownerSessionId, session.id);
    assert.equal(await readFile(path.join(result.cwd, 'README.md'), 'utf8'), await readFile(path.join(source, 'README.md'), 'utf8'));
    assert.match(output.stderr, /Preserved workspace:/);
    for (const secret of [descriptor.token, supervisorToken]) assert(!(output.stdout + output.stderr).includes(secret));
    assert.equal(git(source, 'rev-parse', 'HEAD'), original);
    assert.equal(git(source, 'status', '--porcelain'), '');
  } finally { await daemon.close(); }
});
