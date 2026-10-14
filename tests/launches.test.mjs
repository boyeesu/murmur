import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { LaunchService } from '../packages/murmur/dist/core/launches.js';
import { GitWorkflow } from '../packages/murmur/dist/integration/workflow.js';
import { discoverProject } from '../packages/murmur/dist/workspaces/identity.js';
import { MANAGED_TTL_MS, validateAgentConnection, validateSupervisorConnection } from '../packages/murmur/dist/protocol/agent.js';
import { temporary, repository, git, mutation } from './helpers.mjs';

const human = { kind: 'human' };
const errorCode = code => error => error?.code === code;
const digest = token => createHash('sha256').update(token).digest('hex');
const url = (route, query = '') => new URL(`http://127.0.0.1:7777${route}${query}`);
async function fixture(t) {
  const directory = await temporary(t), root = await repository(path.join(directory, 'source')), state = path.join(directory, 'state');
  await mkdir(state);
  let now = 1_000_000;
  const filename = path.join(state, 'state.sqlite');
  const f = { directory, root, state, now: () => now, advance: ms => { now += ms; }, runtime: { origin: 'http://127.0.0.1:7777', stateId: 'a'.repeat(64), instanceId: randomUUID() } };
  const open = async () => {
    f.store = new CoordinationStore(filename, () => now);
    f.workflow = new GitWorkflow(f.store, state);
    f.coordination = new CoordinationService(f.store);
    f.launches = new LaunchService(f.store, f.workflow, f.coordination, f.runtime);
    await f.workflow.initialize();
  };
  await open();
  const identity = await discoverProject(root);
  f.project = f.store.registerProject(identity, mutation('project.register', identity));
  f.prepare = (extra = {}, key = randomUUID(), principal = human) => {
    const input = { projectId: f.project.id, tool: 'claude', title: 'New managed task', ...extra };
    return f.launches.prepare(input, principal, mutation('launch.prepare', input, key, principal.kind === 'human' ? 'human' : `session:${principal.sessionId}`));
  };
  f.actor = (title = 'manual task', sessionId) => {
    if (!sessionId) {
      const input = { projectId: f.project.id, tool: 'manual', nativeId: randomUUID(), instanceId: randomUUID(), workspaceRoot: f.root };
      sessionId = f.store.registerSession(input, mutation('session.register', input)).session.id;
    }
    const input = { projectId: f.project.id, sessionId, title, featureKey: null };
    return { session: f.store.session(sessionId), task: f.store.createTask(input, mutation('task.create', input)) };
  };
  f.claim = (prepared, controllerId = randomUUID(), key = randomUUID()) => {
    const input = { launchId: prepared.launch.id, controllerId, revision: prepared.launch.lifecycleRevision };
    return { state: f.launches.control('claim', prepared.supervisor.supervisorToken, input, key), controllerId, key, input };
  };
  f.acquire = (prepared, resource = 'owned.txt', taskId = prepared.launch.taskId) => {
    const input = { projectId: f.project.id, sessionId: prepared.launch.sessionId, taskId, taskRevision: f.store.task(taskId).revision, resources: [{ kind: 'path', value: resource }], ttlSeconds: 300 };
    return f.store.acquire(input, mutation('lease.acquire', input));
  };
  f.restart = async () => {
    await f.launches.close(); f.workflow.close(); f.store.close();
    f.runtime = { ...f.runtime, instanceId: randomUUID() };
    await open();
  };
  t.after(async () => { await f.launches.close(); f.workflow.close(); f.store.close(); });
  return f;
}

function publicOnly(value, secrets) {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!encoded.includes(secret), 'public data must not contain credentials');
  for (const forbidden of ['agentToken', 'supervisorToken', 'agentHash', 'supervisorHash', 'tokenHash', 'requestDigest']) assert.ok(!encoded.includes(`"${forbidden}"`));
}

test('prepare creates a new owner at the pinned managed root, rotates the interim credential, and replays stably', async t => {
  const f = await fixture(t), key = randomUUID(), baseSha = git(f.root, 'rev-parse', 'HEAD');
  let interim;
  const original = f.store.registerSession.bind(f.store);
  f.store.registerSession = (...args) => { const result = original(...args); interim = result.token; return result; };
  const p = await f.prepare({ featureKey: ' New-Feature ', baseRevision: baseSha }, key);
  assert.deepEqual(Object.keys(p).sort(), ['agent', 'briefing', 'launch', 'supervisor']);
  assert.equal(p.launch.state, 'prepared'); assert.equal(p.launch.lifecycleRevision, 1);
  assert.equal(p.launch.featureKey, 'new-feature'); assert.equal(p.launch.baseSha, baseSha);
  assert.notEqual(p.launch.workspaceRoot, f.root);
  assert.equal(git(p.launch.workspaceRoot, 'rev-parse', 'HEAD'), baseSha);
  const session = f.store.session(p.launch.sessionId), task = f.store.task(p.launch.taskId);
  assert.equal(session.workspaceRoot, p.launch.workspaceRoot); assert.equal(session.credentialMode, 'managed');
  assert.equal(session.nativeId, p.launch.nativeSessionId); assert.equal(p.launch.nativeIdentitySource, 'requested');
  assert.match(p.launch.nativeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(task.ownerSessionId, session.id); assert.equal(task.status, 'active');
  assert.equal(f.store.db.prepare('SELECT workspaceId FROM workflow_attachments WHERE taskId = ?').get(task.id).workspaceId, p.launch.workspaceId);
  assert.match(p.agent.agentToken, /^[\w-]{43}$/); assert.match(p.supervisor.supervisorToken, /^[\w-]{43}$/);
  assert.notEqual(interim, p.agent.agentToken); assert.notEqual(p.agent.agentToken, p.supervisor.supervisorToken);
  assert.equal(f.store.authenticateSession(interim), undefined);
  assert.equal(f.store.authenticateSession(p.agent.agentToken), undefined, 'agents do not authenticate before claim');
  assert.deepEqual(validateAgentConnection(p.agent), p.agent); assert.deepEqual(validateSupervisorConnection(p.supervisor), p.supervisor);
  assert.match(p.briefing, /untrusted project data/); assert.ok(p.briefing.length < 6000);
  assert.deepEqual(await f.prepare({ featureKey: ' New-Feature ', baseRevision: baseSha }, key), p);
  await assert.rejects(f.prepare({ title: 'changed', featureKey: ' New-Feature ', baseRevision: baseSha }, key), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 1);
  const journal = f.store.db.prepare('SELECT response FROM mutations WHERE caller = ? AND key = ?').get('human', key);
  assert.deepEqual(JSON.parse(journal.response), { launchId: p.launch.id });
  publicOnly([f.launches.get(p.launch.id), f.launches.list(), f.store.snapshot(), f.store.events(f.project.id, 0), journal], [interim, p.agent.agentToken, p.supervisor.supervisorToken]);
  assert.equal(git(f.root, 'status', '--porcelain'), ''); assert.equal(git(f.root, 'rev-parse', 'HEAD'), baseSha);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 3);
});

test('dirty source needs explicit consent; committed work only is copied and Codex identity stays unverified', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.root, 'README.md'), 'utf8'), base = git(f.root, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.root, 'README.md'), 'unfinished source\n');
  await writeFile(path.join(f.root, 'private.txt'), 'not committed\n');
  await assert.rejects(f.prepare(), errorCode('DIRTY_BASE'));
  const failed = f.launches.list()[0];
  assert.equal(failed.state, 'failed'); assert.equal(failed.workspaceId, null);
  const p = await f.prepare({ tool: 'codex', baseRevision: base, allowDirtyBase: true });
  assert.equal(p.launch.nativeSessionId, null); assert.equal(p.launch.nativeIdentitySource, 'unverified');
  assert.equal(f.store.session(p.launch.sessionId).nativeId, `launch:${p.launch.id}`);
  assert.equal(await readFile(path.join(p.launch.workspaceRoot, 'README.md'), 'utf8'), original);
  await assert.rejects(access(path.join(p.launch.workspaceRoot, 'private.txt')));
  assert.equal(await readFile(path.join(f.root, 'README.md'), 'utf8'), 'unfinished source\n');
  assert.equal(await readFile(path.join(f.root, 'private.txt'), 'utf8'), 'not committed\n');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), base);
});

test('preparation is human-only, strict, Git-only and binds its mutation metadata', async t => {
  const f = await fixture(t), actor = f.actor(), session = { kind: 'session', projectId: f.project.id, sessionId: actor.session.id };
  await assert.rejects(f.prepare({}, randomUUID(), session), errorCode('FORBIDDEN'));
  for (const input of [{ title: 'x'.repeat(513) }, { title: '' }, { existingTaskId: actor.task.id }, { tool: 'cursor' }, { allowDirtyBase: 'true' }, { featureKey: null }, { baseRevision: null }]) {
    await assert.rejects(f.prepare(input), errorCode('INVALID_INPUT'));
  }
  const input = { projectId: f.project.id, tool: 'claude', title: 'bound input' };
  await assert.rejects(f.launches.prepare(input, human, mutation('launch.prepare', { ...input, title: 'other' })), errorCode('INVALID_INPUT'));
  await assert.rejects(f.launches.prepare(input, human, mutation('launch.prepare', input, randomUUID(), 'not-human')), errorCode('FORBIDDEN'));
  const plainRoot = path.join(f.directory, 'plain'); await mkdir(plainRoot);
  const identity = await discoverProject(plainRoot), plain = f.store.registerProject(identity, mutation('project.register', identity));
  await assert.rejects(f.prepare({ projectId: plain.id }), errorCode('GIT_REQUIRED'));
  assert.equal(f.launches.list().length, 0);
});

test('concurrent same-key requests join; duplicate features are rejected before making another workspace', async t => {
  const f = await fixture(t), key = randomUUID();
  const [a, b] = await Promise.all([f.prepare({ featureKey: 'same' }, key), f.prepare({ featureKey: 'same' }, key)]);
  assert.deepEqual(a, b);
  await assert.rejects(f.prepare({ featureKey: 'same' }), errorCode('FEATURE_ALREADY_OWNED'));
  const results = await Promise.allSettled([f.prepare({ featureKey: 'raced' }), f.prepare({ featureKey: 'raced' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'FEATURE_ALREADY_OWNED');
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);
});

test('feature conflict inserted during Git work is caught by atomic core uniqueness without deleting artifacts', async t => {
  const f = await fixture(t), owner = f.actor(), create = f.workflow.createWorkspace.bind(f.workflow);
  f.workflow.createWorkspace = async (...args) => {
    const workspace = await create(...args);
    const input = { projectId: f.project.id, sessionId: owner.session.id, title: 'Racing owner', featureKey: 'race' };
    f.store.createTask(input, mutation('task.create', input));
    return workspace;
  };
  const key = randomUUID();
  await assert.rejects(f.prepare({ featureKey: 'race' }, key), errorCode('FEATURE_ALREADY_OWNED'));
  const failed = f.launches.list()[0];
  assert.equal(failed.state, 'recovery_required'); assert.ok(failed.workspaceId); assert.ok(failed.sessionId); assert.equal(failed.taskId, null);
  await access(failed.workspaceRoot);
  assert.equal(f.store.session(failed.sessionId).credentialMode, 'managed');
  await assert.rejects(f.prepare({ featureKey: 'race' }, key), errorCode('RECOVERY_REQUIRED'));
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 1);
});

test('supervisor and agent credentials cannot be interchanged; one CAS claim is replayable but never replaced', async t => {
  const f = await fixture(t), prepareKey = randomUUID(), p = await f.prepare({}, prepareKey), other = await f.prepare();
  const input = { launchId: p.launch.id, controllerId: randomUUID(), revision: p.launch.lifecycleRevision };
  assert.throws(() => f.launches.control('claim', p.agent.agentToken, input, randomUUID()), errorCode('SUPERVISOR_UNAUTHORIZED'));
  assert.throws(() => f.launches.control('status', other.supervisor.supervisorToken, { launchId: p.launch.id }), errorCode('SUPERVISOR_UNAUTHORIZED'));
  assert.equal(f.store.authenticateSession(p.supervisor.supervisorToken), undefined);
  assert.throws(() => f.launches.identity(p.launch.sessionId), errorCode('AGENT_UNAUTHORIZED'));
  const claim = f.claim(p, input.controllerId);
  assert.equal(claim.state.state, 'claimed');
  assert.equal(f.store.authenticateSession(p.agent.agentToken).id, p.launch.sessionId);
  assert.deepEqual(f.launches.control('claim', p.supervisor.supervisorToken, claim.input, claim.key), claim.state);
  assert.throws(() => f.launches.control('claim', p.supervisor.supervisorToken, claim.input, randomUUID()), errorCode('LAUNCH_NOT_PREPARED'));
  assert.throws(() => f.launches.control('claim', p.supervisor.supervisorToken, { ...claim.input, controllerId: randomUUID() }, randomUUID()), errorCode('LAUNCH_NOT_PREPARED'));
  assert.throws(() => f.launches.control('claim', p.supervisor.supervisorToken, { ...claim.input, controllerId: randomUUID() }, claim.key), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.prepare({}, prepareKey), errorCode('LAUNCH_NOT_PREPARED'));
  const row = f.store.db.prepare('SELECT agentToken,supervisorToken FROM murmur_launches WHERE id = ?').get(p.launch.id);
  assert.equal(row.agentToken, null); assert.equal(row.supervisorToken, null);
  const identity = f.launches.authorizeAgent(p.launch.sessionId, 'GET', url('/v1/agent/identity'));
  assert.deepEqual(identity, { role: 'agent', protocolVersion: 1, stateId: f.runtime.stateId, instanceId: f.runtime.instanceId, launchId: p.launch.id, projectId: f.project.id, sessionId: p.launch.sessionId, taskId: p.launch.taskId, expiresAt: p.launch.expiresAt });
});

test('lifecycle revisions are independent, controller checks precede mutations, and heartbeat replay never extends twice', async t => {
  const f = await fixture(t), p = await f.prepare(), claim = f.claim(p), token = p.supervisor.supervisorToken;
  const sessionRevision = f.store.session(p.launch.sessionId).revision;
  f.store.heartbeat(p.launch.sessionId, sessionRevision, mutation('manual.test.heartbeat', {}));
  const startedInput = { launchId: p.launch.id, controllerId: claim.controllerId, revision: claim.state.lifecycleRevision, pid: 7654 };
  const started = f.launches.control('started', token, startedInput, randomUUID());
  assert.equal(started.state, 'running'); assert.equal(started.pid, 7654); assert.equal(started.expiresAt, p.launch.expiresAt);
  f.advance(30_000);
  const heartbeat = { launchId: p.launch.id, controllerId: claim.controllerId, revision: started.lifecycleRevision }, key = randomUUID();
  assert.throws(() => f.launches.control('heartbeat', token, { ...heartbeat, controllerId: randomUUID() }, randomUUID()), errorCode('CONTROLLER_MISMATCH'));
  assert.throws(() => f.launches.control('heartbeat', token, { ...heartbeat, revision: 999 }, randomUUID()), errorCode('STALE_REVISION'));
  const renewed = f.launches.control('heartbeat', token, heartbeat, key);
  assert.equal(renewed.expiresAt, f.now() + MANAGED_TTL_MS);
  f.advance(15_000);
  assert.deepEqual(f.launches.control('heartbeat', token, heartbeat, key), renewed);
  assert.equal(f.launches.get(p.launch.id).expiresAt, renewed.expiresAt);
  assert.equal(f.store.session(p.launch.sessionId).revision, sessionRevision + 1);
  assert.throws(() => f.launches.control('started', token, { ...startedInput, revision: renewed.lifecycleRevision }, randomUUID()), errorCode('INVALID_LAUNCH_STATE'));
  assert.throws(() => f.launches.control('heartbeat', token, { ...heartbeat, pid: 5 }, randomUUID()), errorCode('INVALID_INPUT'));
  assert.throws(() => f.launches.control('heartbeat', token, heartbeat), errorCode('INVALID_INPUT'));
});

test('bridge sightings do not renew supervisor expiry; expired credentials cannot revive and only bound leases are released', async t => {
  const f = await fixture(t), p = await f.prepare(), claim = f.claim(p), owned = f.acquire(p);
  const other = f.actor('another same-session task', p.launch.sessionId), otherLease = f.acquire(p, 'other.txt', other.task.id);
  const taskBefore = f.store.task(p.launch.taskId);
  f.advance(MANAGED_TTL_MS - 1);
  f.launches.authorizeAgent(p.launch.sessionId, 'GET', url('/health'));
  const seen = f.launches.get(p.launch.id);
  assert.equal(seen.bridgeLastSeenAt, f.now()); assert.equal(seen.expiresAt, p.launch.expiresAt);
  f.advance(1); f.launches.sweep(); f.launches.sweep();
  assert.equal(f.store.authenticateSession(p.agent.agentToken), undefined);
  assert.equal(f.launches.get(p.launch.id).state, 'expired');
  assert.equal(f.store.lease(owned.id).releasedAt, f.now()); assert.equal(f.store.lease(otherLease.id).releasedAt, null);
  assert.deepEqual(f.store.task(p.launch.taskId), taskBefore);
  assert.throws(() => f.launches.identity(p.launch.sessionId), errorCode('AGENT_UNAUTHORIZED'));
  assert.throws(() => f.launches.control('claim', p.supervisor.supervisorToken, claim.input, claim.key), errorCode('LAUNCH_INACTIVE'));
  assert.throws(() => f.launches.control('heartbeat', p.supervisor.supervisorToken, { ...claim.input, revision: claim.state.lifecycleRevision }, randomUUID()), errorCode('LAUNCH_INACTIVE'));
  const events = f.store.events(f.project.id, 0);
  assert.equal(events.filter(event => event.type === 'launch.expired' && event.payload.id === p.launch.id).length, 1);
  assert.equal(events.filter(event => event.type === 'launch.bridge_used').length, 1);
});

test('supervisor end revokes credentials and releases own leases but preserves task, owner, worktree and source', async t => {
  const f = await fixture(t), p = await f.prepare(), claim = f.claim(p), lease = f.acquire(p), before = f.store.task(p.launch.taskId);
  await writeFile(path.join(p.launch.workspaceRoot, 'unfinished.txt'), 'retained\n');
  const input = { launchId: p.launch.id, controllerId: claim.controllerId, revision: claim.state.lifecycleRevision, reason: 'spawn_failed', exitCode: null }, key = randomUUID();
  const ended = f.launches.control('end', p.supervisor.supervisorToken, input, key);
  assert.equal(ended.state, 'ended'); assert.equal(ended.errorCode, 'SPAWN_FAILED'); assert.equal(ended.exitCode, null);
  assert.equal(f.store.authenticateSession(p.agent.agentToken), undefined);
  assert.deepEqual(f.store.task(p.launch.taskId), before); assert.equal(f.store.lease(lease.id).releasedAt, f.now());
  assert.equal(await readFile(path.join(p.launch.workspaceRoot, 'unfinished.txt'), 'utf8'), 'retained\n');
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  f.advance(MANAGED_TTL_MS * 2);
  assert.deepEqual(f.launches.control('end', p.supervisor.supervisorToken, input, key), ended);
  assert.throws(() => f.launches.control('end', p.supervisor.supervisorToken, input, randomUUID()), errorCode('LAUNCH_INACTIVE'));
  assert.throws(() => f.launches.control('end', p.supervisor.supervisorToken, { ...input, exitCode: 1 }, key), errorCode('IDEMPOTENCY_CONFLICT'));
});

test('managed agent route allowlist binds project, task, session and lease even for another task owned by that session', async t => {
  const f = await fixture(t), p = await f.prepare(); f.claim(p);
  const id = p.launch.sessionId, taskId = p.launch.taskId, projectId = f.project.id, lease = f.acquire(p);
  const other = f.actor('other task', id), otherLease = f.acquire(p, 'other.txt', other.task.id);
  const allow = (route, body) => f.launches.authorizeAgent(id, 'POST', url(route), body);
  for (const [route, body] of [
    ['/v1/intents', { taskId, revision: 2, writes: ['src'], produces: [] }],
    ['/v1/check-plan', { projectId, taskId, title: 'candidate' }],
    ['/v1/tasks/update', { taskId, revision: 2, status: 'blocked' }],
    ['/v1/decisions/propose', { projectId, taskId, key: 'contract', value: 'yes', version: '1', rationale: 'reason' }],
    ['/v1/reservations/acquire', { projectId, sessionId: id, taskId, taskRevision: 2, resources: [], ttlSeconds: 90 }],
    ['/v1/reservations/release', { leaseId: lease.id, sessionId: id, generation: lease.generation }],
    ['/v1/submissions', { taskId, revision: 2 }],
  ]) assert.equal(allow(route, body).taskId, taskId);
  f.launches.authorizeAgent(id, 'GET', url('/v1/context', `?projectId=${projectId}`));
  f.launches.authorizeAgent(id, 'GET', url('/v1/context', `?projectId=${projectId}&taskId=${taskId}&after=0`));
  for (const route of ['/v1/snapshot', '/v1/events', '/v1/decisions', '/v1/launches']) assert.throws(() => f.launches.authorizeAgent(id, 'GET', url(route)), errorCode('AGENT_FORBIDDEN'));
  for (const route of ['/v1/tasks', '/v1/sessions/heartbeat', '/v1/decisions/accept', '/v1/reservations/renew', '/v1/workspaces/create', '/v1/launches/prepare']) assert.throws(() => allow(route, { taskId }), errorCode('AGENT_FORBIDDEN'));
  for (const [route, body] of [
    ['/v1/tasks/update', { taskId: other.task.id, revision: 1, status: 'ready' }],
    ['/v1/tasks/update', { taskId, revision: 2, status: 'abandoned' }],
    ['/v1/tasks/update', { taskId, revision: 2, status: 'active', title: 'changed' }],
    ['/v1/tasks/update', { taskId, revision: 2, status: 'active', handoffSessionId: id }],
    ['/v1/check-plan', { projectId, taskId: other.task.id }],
    ['/v1/check-plan', { projectId: randomUUID(), taskId }],
    ['/v1/decisions/propose', { projectId, taskId: null }],
    ['/v1/reservations/acquire', { projectId, sessionId: randomUUID(), taskId }],
    ['/v1/reservations/release', { leaseId: otherLease.id, sessionId: id, generation: otherLease.generation }],
    ['/v1/submissions', { taskId: other.task.id, revision: 1 }],
  ]) assert.throws(() => allow(route, body), errorCode('AGENT_FORBIDDEN'));
  for (const query of ['', `?projectId=${projectId}&taskId=${other.task.id}`, `?projectId=${randomUUID()}`, `?projectId=${projectId}&projectId=${projectId}`]) assert.throws(() => f.launches.authorizeAgent(id, 'GET', url('/v1/context', query)), errorCode('AGENT_FORBIDDEN'));
  const before = f.launches.get(p.launch.id);
  assert.equal(before.expiresAt, p.launch.expiresAt); assert.equal(before.lifecycleRevision, 2);
  assert.equal(f.store.events(projectId, 0).filter(event => event.type === 'launch.bridge_used').length, 1);
});

test('current ownership is checked before a previously successful agent mutation can replay', async t => {
  const f = await fixture(t), p = await f.prepare(); f.claim(p);
  const principal = { kind: 'session', sessionId: p.launch.sessionId, projectId: f.project.id };
  const input = { taskId: p.launch.taskId, revision: f.store.task(p.launch.taskId).revision, status: 'blocked' }, key = randomUUID();
  f.launches.authorizeAgent(principal.sessionId, 'POST', url('/v1/tasks/update'), input);
  f.coordination.updateTask(input, principal, mutation('task.update', input, key, `session:${principal.sessionId}`));
  const recipient = f.actor(), handoff = { taskId: p.launch.taskId, revision: f.store.task(p.launch.taskId).revision, handoffSessionId: recipient.session.id };
  f.coordination.updateTask(handoff, human, mutation('task.update', handoff));
  assert.throws(() => f.launches.authorizeAgent(principal.sessionId, 'POST', url('/v1/tasks/update'), input), errorCode('AGENT_UNAUTHORIZED'));
  assert.throws(() => f.launches.identity(principal.sessionId), errorCode('AGENT_UNAUTHORIZED'));
});

test('a managed session without launch metadata fails closed in Store and LaunchService', async t => {
  const f = await fixture(t), actor = f.actor(), token = 'Z'.repeat(43);
  f.store.db.prepare("UPDATE sessions SET credentialMode = 'managed', tokenHash = ? WHERE id = ?").run(digest(token), actor.session.id);
  assert.equal(f.store.authenticateSession(token), undefined);
  assert.throws(() => f.launches.identity(actor.session.id), errorCode('AGENT_UNAUTHORIZED'));
  f.store.db.exec('DROP TABLE murmur_launches');
  assert.equal(f.store.authenticateSession(token), undefined);
});

test('partial synchronous phase failure records IDs, sanitizes errors, invalidates interim token and never respawns', async t => {
  const f = await fixture(t), original = f.store.registerSession.bind(f.store), key = randomUUID();
  let interim;
  f.store.registerSession = (...args) => { const result = original(...args); interim = result.token; throw new Error(`private failure ${result.token}`); };
  await assert.rejects(f.prepare({}, key), error => error.code === 'LAUNCH_PREPARATION_FAILED' && !JSON.stringify(error).includes(interim));
  const row = f.launches.list()[0];
  assert.equal(row.state, 'recovery_required'); assert.ok(row.workspaceId); assert.ok(row.sessionId); assert.equal(row.taskId, null);
  assert.equal(f.store.authenticateSession(interim), undefined); await access(row.workspaceRoot);
  await f.restart();
  await assert.rejects(f.prepare({}, key), errorCode('RECOVERY_REQUIRED'));
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 1);
  publicOnly(f.store.events(f.project.id, 0), [interim]);
});

test('restart retains unclaimed prepared response but marks partial preparation and ambiguous claim for recovery', async t => {
  const f = await fixture(t), key = randomUUID(), prepared = await f.prepare({}, key);
  await f.restart();
  assert.deepEqual(await f.prepare({}, key), prepared);
  const claim = f.claim(prepared);
  await f.restart();
  assert.equal(f.launches.get(prepared.launch.id).state, 'recovery_required');
  assert.equal(f.store.authenticateSession(prepared.agent.agentToken), undefined);
  assert.throws(() => f.launches.control('claim', prepared.supervisor.supervisorToken, claim.input, claim.key), errorCode('LAUNCH_INACTIVE'));
  await assert.rejects(f.prepare({}, key), errorCode('RECOVERY_REQUIRED'));
  const interrupted = await f.prepare(), taskBefore = f.store.task(interrupted.launch.taskId);
  // A crash can lose our phase checkpoint while core/workflow commits have already reached disk.
  f.store.db.prepare("UPDATE murmur_launches SET state = 'preparing', phase = 'attachment', workspaceId = NULL, workspaceRoot = NULL, baseSha = NULL, sessionId = NULL, taskId = NULL WHERE id = ?").run(interrupted.launch.id);
  await f.restart();
  const recovered = f.launches.get(interrupted.launch.id);
  assert.equal(recovered.state, 'recovery_required');
  for (const field of ['workspaceId', 'workspaceRoot', 'baseSha', 'sessionId', 'taskId']) assert.equal(recovered[field], interrupted.launch[field]);
  assert.deepEqual(f.store.task(interrupted.launch.taskId), taskBefore);
  assert.equal(f.store.authenticateSession(interrupted.agent.agentToken), undefined);
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 2);
});

test('running supervisor can continue across daemon restart, while missed deadlines remain expired', async t => {
  const f = await fixture(t), p = await f.prepare(), claim = f.claim(p);
  const running = f.launches.control('started', p.supervisor.supervisorToken, { launchId: p.launch.id, controllerId: claim.controllerId, revision: claim.state.lifecycleRevision, pid: 12 }, randomUUID());
  await f.restart();
  assert.equal(f.launches.identity(p.launch.sessionId).instanceId, f.runtime.instanceId);
  f.advance(30_000);
  const heartbeat = f.launches.control('heartbeat', p.supervisor.supervisorToken, { launchId: p.launch.id, controllerId: claim.controllerId, revision: running.lifecycleRevision }, randomUUID());
  assert.equal(heartbeat.state, 'running');
  f.advance(MANAGED_TTL_MS);
  await f.restart();
  assert.equal(f.launches.get(p.launch.id).state, 'expired');
  assert.equal(f.store.authenticateSession(p.agent.agentToken), undefined);
});

test('close waits for in-flight preparation, blocks new work, and never controls external processes', async t => {
  const f = await fixture(t), create = f.workflow.createWorkspace.bind(f.workflow);
  let release, entered;
  const paused = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.workflow.createWorkspace = async (...args) => { entered(); await paused; return create(...args); };
  f.launches.start(); f.launches.start();
  const preparation = f.prepare(); await started;
  let closed = false;
  const closing = f.launches.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(f.prepare(), errorCode('SERVICE_CLOSING'));
  release(); const p = await preparation; await closing;
  assert.equal(closed, true); assert.equal(p.launch.state, 'prepared'); await access(p.launch.workspaceRoot);
});

test('in-flight request identity rejects changed input and snapshots caller-owned objects before asynchronous phases', async t => {
  const f = await fixture(t), create = f.workflow.createWorkspace.bind(f.workflow), key = randomUUID();
  let release, entered;
  const paused = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.workflow.createWorkspace = async (...args) => { entered(); await paused; return create(...args); };
  const input = { projectId: f.project.id, tool: 'claude', title: 'Original title' }, meta = mutation('launch.prepare', input, key);
  const pending = f.launches.prepare(input, human, meta); await started;
  await assert.rejects(f.prepare({ title: 'Changed title' }, key), errorCode('IDEMPOTENCY_CONFLICT'));
  input.title = 'Mutated caller object'; meta.operation = 'changed.operation';
  release(); const p = await pending;
  assert.equal(p.launch.title, 'Original title');
  assert.deepEqual(await f.prepare({ title: 'Original title' }, key), p);
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 1);
});

test('unclaimed preparations and cached heartbeats expire without a maintenance timer and cannot be replayed runnable', async t => {
  const f = await fixture(t), preparationKey = randomUUID(), p = await f.prepare({}, preparationKey), running = await f.prepare(), claim = f.claim(running);
  const heartbeatInput = { launchId: running.launch.id, controllerId: claim.controllerId, revision: claim.state.lifecycleRevision }, key = randomUUID();
  const renewed = f.launches.control('heartbeat', running.supervisor.supervisorToken, heartbeatInput, key);
  f.advance(MANAGED_TTL_MS);
  await assert.rejects(f.prepare({}, preparationKey), errorCode('LAUNCH_NOT_PREPARED'));
  assert.equal(f.launches.get(p.launch.id).state, 'expired');
  assert.throws(() => f.launches.control('heartbeat', running.supervisor.supervisorToken, heartbeatInput, key), errorCode('LAUNCH_INACTIVE'));
  assert.equal(f.launches.control('status', running.supervisor.supervisorToken, { launchId: running.launch.id }).state, 'expired');
  assert.equal(f.store.authenticateSession(running.agent.agentToken), undefined);
  assert.equal(renewed.expiresAt, f.now());
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 2);
  assert.equal(f.store.task(p.launch.taskId).status, 'active');
});
