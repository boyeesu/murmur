import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath, lstat, chmod, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { GroupsService } from '../packages/murmur/dist/core/groups.js';
import { ExternalGrantService } from '../packages/murmur/dist/core/external-grants.js';
import { LaunchService } from '../packages/murmur/dist/core/launches.js';
import { GitWorkflow } from '../packages/murmur/dist/integration/workflow.js';
import { WorkspaceObserver } from '../packages/murmur/dist/daemon/observer.js';
import { MaintenanceService, restoreBackup, RETENTION_CLASSES } from '../packages/murmur/dist/core/maintenance.js';
import { initializeMaintenanceSchema, validateMaintenanceDatabase } from '../packages/murmur/dist/storage/maintenance-schema.js';
import { maintenanceCommand } from '../packages/murmur/dist/cli/maintenance.js';
import { discoverProject } from '../packages/murmur/dist/workspaces/identity.js';
import { authenticatedSessionPrincipal, withAuthorization, canonicalJson } from '../packages/murmur/dist/protocol/index.js';
import { temporary, mutation } from './helpers.mjs';
const human = { kind: 'human' }, hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
async function fixture(t, persistent = false) {
  const root = await realpath(await temporary(t)), workspace = path.join(root, 'source'), state = path.join(root, 'state');
  await mkdir(workspace, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  let now = 1_000_000;
  const store = new CoordinationStore(persistent ? path.join(state, 'state.sqlite') : ':memory:', () => now); t.after(() => store.close());
  const coordination = new CoordinationService(store), groups = new GroupsService(store, coordination), workflow = new GitWorkflow(store, state);
  const runtime = { origin: 'http://127.0.0.1:7777', stateId: 'a'.repeat(64), instanceId: randomUUID() };
  const launches = new LaunchService(store, workflow, coordination, runtime), observer = new WorkspaceObserver(store, workflow);
  const grants = new ExternalGrantService(store, coordination, groups, runtime), maintenance = new MaintenanceService(store);
  const identity = await discoverProject(workspace), project = store.registerProject(identity, mutation('project', identity));
  const registration = { projectId: project.id, tool: 'manual', nativeId: 'native', instanceId: 'incarnation', workspaceRoot: workspace };
  const registered = store.registerSession(registration, mutation('register', registration));
  const task = store.createTask({ projectId: project.id, sessionId: registered.session.id, title: 'Retained owner', featureKey: 'retained' }, mutation('task', {}));
  const call = (method, input, key = randomUUID(), principal = human) => maintenance[method](input, principal, mutation(method, input, key, principal.kind === 'human' ? 'human' : `session:${principal.sessionId}`));
  const enroll = (extra = {}) => {
    const capability = secret(), pollSecret = secret(), key = randomUUID();
    const input = { capabilityHash: hash(capability), pollSecretHash: hash(pollSecret), workspaceRoot: workspace, native: { tool: 'manual', nativeId: randomUUID(), incarnationId: 'one' }, groupTitle: 'Draft title', responsibility: 'Unreviewed responsibility', handoff: { summary: 'PRIVATE-DRAFT' }, ...extra };
    return { capability, pollSecret, key, input, receipt: grants.createEnrollment(input, key) };
  };
  const approve = async (request, extra = {}) => {
    const reviewInput = { requestId: request.receipt.requestId, revision: 1 }, review = await grants.review(reviewInput, human, mutation('review', reviewInput));
    const input = { requestId: review.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Approved responsibility', ...extra };
    return grants.approve(input, human, mutation('approve', input));
  };
  const apply = (preview, key = randomUUID()) => call('applyRetention', { before: preview.before, classes: preview.classes, previewDigest: preview.previewDigest, revision: preview.revision }, key);
  return { root, workspace, state, store, coordination, groups, workflow, launches, observer, grants, maintenance, project, session: registered.session, token: registered.token, task, call, enroll, approve, apply, advance: amount => { now += amount; }, now: () => now };
}

test('manual credential CAS is distinct from heartbeat; stale hashes never regain authority', async t => {
  const f = await fixture(t), input = { sessionId: f.session.id, revision: 1 }, token2 = secret(), token3 = secret();
  assert.equal(f.maintenance.credentialStatus(f.session.id, human).revision, 1);
  f.store.heartbeat(f.session.id, 1, mutation('heartbeat', {}));
  assert.equal(f.maintenance.credentialStatus(f.session.id, human).revision, 1);
  const rotated = f.call('rotateManual', { ...input, tokenHash: hash(token2) }, 'rotation-1');
  assert.equal(rotated.revision, 2); assert.equal(f.store.session(f.session.id).revision, 2);
  assert.equal(f.store.authenticateSession(f.token), undefined); assert.equal(f.store.authenticateSession(token2).id, f.session.id);
  assert.throws(() => f.store.assertSessionCredential(f.session.id, hash(f.token)), { code: 'SESSION_UNAUTHORIZED' });
  assert.deepEqual(f.call('rotateManual', { ...input, tokenHash: hash(token2) }, 'rotation-1'), rotated);
  assert.throws(() => f.call('rotateManual', { ...input, tokenHash: hash(token3) }), { code: 'STALE_REVISION' });
  assert.throws(() => f.call('rotateManual', { sessionId: f.session.id, revision: 2, tokenHash: hash(f.token) }), { code: 'CREDENTIAL_REUSED' });
  const revoked = f.call('revokeManual', { sessionId: f.session.id, revision: 2 });
  assert.equal(revoked.revision, 3); assert.notEqual(revoked.revokedAt, null); assert.equal(f.store.authenticateSession(token2), undefined);
  f.call('rotateManual', { sessionId: f.session.id, revision: 3, tokenHash: hash(token3) });
  assert.equal(f.store.authenticateSession(token3).id, f.session.id);
  const journals = JSON.stringify(f.store.db.prepare("SELECT * FROM mutations WHERE key='rotation-1'").all());
  for (const value of [f.token,token2,token3,hash(token2)]) assert(!journals.includes(value));
  assert.equal(f.store.task(f.task.id).ownerSessionId, f.session.id);
  assert.throws(() => f.call('rotateManual', { sessionId: f.session.id, revision: 4, token: token3 }), { code: 'INVALID_INPUT' });
});

test('all maintenance requires human authority before lookup, replay, and filesystem access', async t => {
  const f = await fixture(t), principals = [{ kind: 'session', sessionId: f.session.id, projectId: f.project.id }, { kind: 'external' }];
  for (const principal of principals) {
    assert.throws(() => f.maintenance.credentialStatus('unknown', principal), { code: 'FORBIDDEN' });
    assert.throws(() => f.maintenance.previewRetention(null, principal), { code: 'FORBIDDEN' });
    assert.throws(() => f.call('revokeManual', null, 'used', principal), { code: 'FORBIDDEN' });
    assert.throws(() => f.call('rotateManual', null, 'used', principal), { code: 'FORBIDDEN' });
    assert.throws(() => f.call('applyRetention', null, 'used', principal), { code: 'FORBIDDEN' });
    await assert.rejects(f.maintenance.backup(null, principal), { code: 'FORBIDDEN' });
    await assert.rejects(restoreBackup(null, principal), { code: 'FORBIDDEN' });
  }
  for (const mode of ['managed','external']) {
    const session = f.store.createSessionRow({ projectId: f.project.id, tool: 'manual', nativeId: mode, instanceId: mode, workspaceRoot: f.workspace, tokenHash: hash(secret()), credentialMode: mode });
    assert.equal(f.maintenance.credentialStatus(session.id, human).canRotate, false);
    assert.throws(() => f.call('revokeManual', { sessionId: session.id, revision: 1 }), { code: 'CREDENTIAL_MODE' });
  }
});

test('retention is a read-only dry-run and exact CAS; pruned mutation keys are permanently tombstoned', async t => {
  const f = await fixture(t), original = mutation('fixture.once', { a: 1 }, 'exact-old-key'); let executions = 0;
  f.store.mutate(original, () => ({ executed: ++executions }));
  f.coordination.context(f.project.id, f.task.id, 0, human);
  f.advance(1000);
  const input = { before: f.now(), classes: ['events','context-records','mutation-payloads'] };
  const changes = f.store.db.prepare('SELECT total_changes() n').get().n;
  const preview = f.maintenance.previewRetention(input, human);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, changes);
  assert(preview.counts.events > 0); assert(preview.counts['context-records'] > 0);
  f.store.db.prepare("UPDATE mutations SET response='{}' WHERE key=?").run(original.key);
  assert.throws(() => f.apply(preview), { code: 'STALE_RETENTION_PREVIEW' });
  const fresh = f.maintenance.previewRetention(input, human), applied = f.apply(fresh, 'apply-once');
  assert.deepEqual(f.apply(fresh, 'apply-once'), applied);
  assert.equal(applied.newRevision, fresh.revision + 1);
  assert.throws(() => f.store.replay(original), { code: 'IDEMPOTENCY_RETIRED' });
  assert.throws(() => f.store.mutate(original, () => ++executions), { code: 'IDEMPOTENCY_RETIRED' });
  assert.throws(() => f.store.mutate({ ...original, input: { a: 2 } }, () => ++executions), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(executions, 1);
  const history = f.store.eventHistory(f.project.id, 0);
  assert.equal(history.contextRecords.before, input.before); assert(history.contextRecords.prunedCount > 0);
  assert(history.historyPruned); assert.equal(history.prunedThrough, fresh.cutoffs.events[0].throughSequence);
  assert.equal(f.store.eventHistory(f.project.id, history.prunedThrough).historyPruned, false);
  assert.equal(f.store.db.prepare('SELECT before FROM context_retention WHERE projectId=?').get(f.project.id).before, input.before);
  assert.equal(f.store.snapshot().tasks.length, 1); assert.equal(f.store.snapshot().sessions.length, 1);
  f.advance(1000); f.apply(f.maintenance.previewRetention({ ...input, before: f.now() }, human));
  assert.throws(() => f.apply(fresh, 'apply-once'), { code: 'IDEMPOTENCY_RETIRED' }, 'an old apply request cannot execute after its own response is pruned');
});

test('only expired unreviewed unlinked external drafts are redacted; approvals and immutable reconnect hashes survive', async t => {
  const f = await fixture(t), draft = f.enroll(), reviewed = f.enroll(), approved = f.enroll(), linked = f.enroll();
  const reviewInput = { requestId: reviewed.receipt.requestId, revision: 1 };
  await f.grants.review(reviewInput, human, mutation('review', reviewInput));
  const approval = await f.approve(approved);
  f.store.db.prepare('UPDATE connection_requests SET sessionId=?,taskId=? WHERE id=?').run(f.session.id, f.task.id, linked.receipt.requestId);
  const original = f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(draft.receipt.requestId);
  const preserved = [reviewed,approved,linked].map(x => f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(x.receipt.requestId));
  f.advance(700_000);
  const preview = f.maintenance.previewRetention({ before: f.now(), classes: ['unreviewed-drafts'] }, human);
  assert.equal(preview.counts['unreviewed-drafts'], 1); f.apply(preview);
  const redacted = f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(draft.receipt.requestId);
  assert.equal(redacted.requestDigest, original.requestDigest); assert.equal(redacted.capabilityHash, original.capabilityHash); assert.equal(redacted.pollSecretHash, original.pollSecretHash);
  assert(!redacted.payload.includes('PRIVATE-DRAFT')); assert.equal(redacted.state, 'expired');
  assert.equal(f.store.db.prepare('SELECT originalPayloadDigest FROM request_redactions WHERE requestId=?').get(redacted.id).originalPayloadDigest, hash(original.payload));
  assert.deepEqual([reviewed,approved,linked].map(x => f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(x.receipt.requestId)), preserved);
  assert(await f.grants.authenticateExternal(approved.capability), 'approved capability binding still validates');
  assert.equal(f.grants.grant(approval.grant.id).requestId, approved.receipt.requestId);
});

function workflowFixture(f) {
  const db = f.store.db, now = f.now(), sha = 'b'.repeat(40);
  db.prepare("INSERT INTO workflow_projects VALUES (?,'{}','refs/murmur/integration',?,'ready')").run(f.project.id, sha);
  db.prepare("INSERT INTO workflow_workspaces VALUES ('workspace',?,?,'managed','ready',?,'refs/base','murmur/task','{}',?,NULL)").run(f.project.id, f.workspace, sha, now);
  db.prepare("INSERT INTO workflow_attachments VALUES (?,'workspace')").run(f.task.id);
  db.prepare("INSERT INTO workflow_changesets VALUES ('changeset',?,?,'workspace',?,?,'refs/source',1,1,'ready',?)").run(f.project.id, f.task.id, sha, sha, now);
  const validation = JSON.stringify({ status: 'passed', candidateSha: sha, targetSha: sha, configHash: 'config', configRevision: 1, checks: [], checkedAt: now });
  db.prepare("INSERT INTO workflow_jobs VALUES ('job',?,'changeset','validated',?,?,?,?,'refs/target','refs/source','refs/pin','refs/candidate',?,'{}',?,?,?,NULL)").run(f.project.id, sha, sha, sha, sha, f.workspace, validation, now, now);
  db.prepare("INSERT INTO workflow_requests VALUES ('human','workflow-request',?,?,'prepare','complete','job','job',?,NULL,?)").run(hash('wf'), f.project.id, JSON.stringify({ token: 'OLD-CACHED-AUTHORITY' }), now);
  f.store.mutate(mutation('wf', {}, 'workflow-request'), () => ({ id: 'job' }));
  const agent = secret(), supervisor = secret();
  const session = f.store.createSessionRow({ projectId: f.project.id, tool: 'claude', nativeId: 'managed', instanceId: 'managed', workspaceRoot: f.workspace, tokenHash: hash(agent), credentialMode: 'managed' });
  db.prepare(`INSERT INTO murmur_launches(id,projectId,tool,title,state,sessionId,nativeIdentitySource,lifecycleRevision,expiresAt,createdAt,requestCaller,requestKey,requestDigest,preparationInstanceId,phase,agentHash,agentToken,supervisorHash,supervisorToken,briefing)
    VALUES ('launch',?,'claude','Managed fixture','running',?,'verified',1,?,?,'human','prepared-key',?,'fixture','ready',?,?,?,?,'Sensitive briefing')`).run(f.project.id, session.id, now + 1_000_000, now, hash('launch'), hash(agent), agent, hash(supervisor), supervisor);
  f.store.mutate(mutation('prepare', {}, 'prepared-key'), () => ({ launchId: 'launch' }));
  f.store.mutate(mutation('launch.phase', {}, 'launch:launch:phase'), () => ({ session }));
  return { agent, supervisor, session };
}

test('generic retention excludes workflow replay rows and all launch preparation journals', async t => {
  const f = await fixture(t), managed = workflowFixture(f);
  const tables = ['workflow_requests','murmur_launches','workflow_jobs','workflow_workspaces'];
  const before = tables.map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all());
  f.advance(1000); f.apply(f.maintenance.previewRetention({ before: f.now(), classes: ['mutation-payloads'] }, human));
  assert.deepEqual(tables.map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all()), before);
  for (const key of ['workflow-request','prepared-key','launch:launch:phase']) assert(f.store.db.prepare('SELECT 1 FROM mutations WHERE key=?').get(key));
  assert.equal(f.store.authenticateSession(managed.agent).id, managed.session.id);
});

test('consistent backup restores only into NEW private state, resets every authority class, and preserves source bookkeeping', async t => {
  const f = await fixture(t, true), request = f.enroll(), approval = await f.approve(request), managed = workflowFixture(f);
  const inviteCode = secret(), invitation = f.groups.invite({ groupId: approval.member.groupId, inviteHash: hash(inviteCode) }, human, mutation('invite', {}));
  const lease = f.store.acquire({ projectId: f.project.id, sessionId: f.session.id, taskId: f.task.id, taskRevision: 1, resources: [{ kind: 'resource', value: 'retained' }], ttlSeconds: 300 }, mutation('lease', {}));
  await writeFile(path.join(f.workspace, 'preserve.txt'), 'No workspace cleanup.', { mode: 0o600 });
  const tasks = f.store.snapshot().tasks, sessions = f.store.snapshot().sessions;
  const destination = path.join(f.root, 'backup.sqlite'), backup = await f.maintenance.backup({ destination }, human);
  assert(backup.pages > 0); assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  assert(!await readdir(f.root).then(names => names.includes('backup.sqlite-wal')));
  const offline = new DatabaseSync(destination, { readOnly: true }); assert.equal(offline.prepare('SELECT COUNT(*) n FROM tasks').get().n, tasks.length); offline.close();
  const target = path.join(f.root, 'restored'), result = await restoreBackup({ backupPath: destination, stateDirectory: target }, human);
  assert(result.authorityInvalidated); assert.equal((await lstat(target)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(target), ['state.sqlite']);
  const restored = new CoordinationStore(path.join(target, 'state.sqlite')); t.after(() => restored.close());
  assert.deepEqual(restored.snapshot().tasks, tasks); assert.deepEqual(restored.snapshot().sessions, sessions);
  assert.equal(restored.authenticateSession(f.token), undefined); assert.equal(restored.authenticateSession(managed.agent), undefined);
  assert.notEqual(restored.lease(lease.id).releasedAt, null);
  assert(restored.db.prepare('SELECT revokedAt FROM external_grants WHERE id=?').get(approval.grant.id).revokedAt);
  assert(restored.db.prepare('SELECT revokedAt FROM group_invitations WHERE id=?').get(invitation.id).revokedAt);
  assert.equal(restored.db.prepare('SELECT pollSecretHash FROM connection_requests WHERE id=?').get(request.receipt.requestId).pollSecretHash, null);
  const launch = restored.db.prepare('SELECT * FROM murmur_launches').get();
  assert.equal(launch.state, 'recovery_required'); for (const name of ['agentHash','agentToken','supervisorHash','supervisorToken','controllerId','pid']) assert.equal(launch[name], null);
  const job = restored.db.prepare('SELECT * FROM workflow_jobs').get(); assert.equal(job.status, 'recovery_required'); assert.equal(JSON.parse(job.validation).status, 'invalidated');
  assert.equal(restored.db.prepare('SELECT status FROM workflow_workspaces').get().status, 'recovery_required');
  const journal = restored.db.prepare('SELECT * FROM workflow_requests').get(); assert.equal(journal.status, 'retired'); assert.equal(journal.response, null);
  assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM mutations').get().n, 0); assert(restored.db.prepare('SELECT COUNT(*) n FROM mutation_tombstones').get().n > 0);
  assert.equal(await readFile(path.join(f.workspace, 'preserve.txt'), 'utf8'), 'No workspace cleanup.');
  assert(f.store.authenticateSession(f.token)); assert(f.store.authenticateSession(managed.agent)); assert.equal(f.store.lease(lease.id).releasedAt, null, 'live source is unchanged');
  await assert.rejects(restoreBackup({ backupPath: destination, stateDirectory: target }, human), { code: 'EEXIST' });
});

test('restored external authority requires fresh human approval and can reconnect its retained owner and provenance', async t => {
  const f = await fixture(t), request = f.enroll(), approved = await f.approve(request, { featureKey: 'restored-feature' });
  const originalRequest = f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(request.receipt.requestId);
  const originalGrant = f.store.db.prepare('SELECT * FROM external_grants WHERE id=?').get(approved.grant.id);
  const originalMember = f.groups.memberRow(approved.member.id), originalGroup = f.groups.groupRow(approved.group.id);
  const originalTask = f.store.task(approved.grant.taskId), counts = { sessions: f.store.snapshot().sessions.length, tasks: f.store.snapshot().tasks.length };
  const destination = path.join(f.root, 'external-backup.sqlite'), target = path.join(f.root, 'external-restored');
  await f.maintenance.backup({ destination }, human);
  await restoreBackup({ backupPath: destination, stateDirectory: target }, human);
  const store = new CoordinationStore(path.join(target, 'state.sqlite')); t.after(() => store.close());
  const coordination = new CoordinationService(store), groups = new GroupsService(store, coordination);
  const grants = new ExternalGrantService(store, coordination, groups, { origin: 'http://127.0.0.1:7777', stateId: 'a'.repeat(64), instanceId: randomUUID() });
  grants.sweep();
  assert.equal(store.authenticateSession(request.capability), undefined);
  assert.equal(await grants.authenticateExternal(request.capability), undefined);
  assert.throws(() => store.assertSessionCredential(approved.grant.sessionId, hash(request.capability)), { code: 'SESSION_UNAUTHORIZED' });
  assert.throws(() => grants.pollStatus({ requestId: request.receipt.requestId, pollSecret: request.pollSecret }), { code: 'ENROLLMENT_UNAUTHORIZED' });
  const left = groups.memberRow(approved.member.id);
  assert.equal(left.state, 'left'); assert.equal(left.revision, originalMember.revision + 1);
  assert.equal(groups.groupRow(approved.group.id).revision, originalGroup.revision + 1);
  assert.equal(store.db.prepare('SELECT tokenHash FROM sessions WHERE id=?').get(approved.grant.sessionId).tokenHash, originalGrant.capabilityHash);
  assert.equal(store.db.prepare('SELECT requestDigest FROM connection_requests WHERE id=?').get(request.receipt.requestId).requestDigest, originalRequest.requestDigest);
  assert.deepEqual(store.task(approved.grant.taskId), originalTask);
  assert.deepEqual(store.db.prepare('SELECT * FROM group_provenance ORDER BY id').all(), f.store.db.prepare('SELECT * FROM group_provenance ORDER BY id').all());
  const nextCapability = secret(), nextPoll = secret();
  const input = { ...request.input, capabilityHash: hash(nextCapability), pollSecretHash: hash(nextPoll) };
  const receipt = grants.createEnrollment(input, randomUUID());
  assert.equal(await grants.authenticateExternal(nextCapability), undefined, 'new enrollment alone is not approval');
  const reviewInput = { requestId: receipt.requestId, revision: receipt.revision };
  const review = await grants.review(reviewInput, human, mutation('review', reviewInput));
  assert(review.reconnectGrantIds.includes(approved.grant.id));
  assert.equal(await grants.authenticateExternal(nextCapability), undefined, 'human review alone is not approval');
  const approvalInput = { requestId: review.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Resume retained task', reconnectGrantId: approved.grant.id };
  const reconnected = await grants.approve(approvalInput, human, mutation('approve', approvalInput));
  assert.equal(reconnected.grant.sessionId, approved.grant.sessionId); assert.equal(reconnected.grant.taskId, approved.grant.taskId);
  assert.deepEqual(store.task(approved.grant.taskId), originalTask);
  assert.equal(store.snapshot().sessions.length, counts.sessions); assert.equal(store.snapshot().tasks.length, counts.tasks);
  assert.equal((await grants.authenticateExternal(nextCapability)).sessionId, approved.grant.sessionId);
  assert.equal(await grants.authenticateExternal(request.capability), undefined, 'copied capability never regains authority');
  assert(grants.grant(approved.grant.id).revokedAt !== null);
  assert(await f.grants.authenticateExternal(request.capability), 'source authority is unchanged');
  assert.equal(f.groups.memberRow(approved.member.id).state, 'active');
});

test('backup/restore reject overwrites, symlinks, public permissions and unknown authority schemas', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'backup.sqlite');
  await f.maintenance.backup({ destination }, human); const bytes = await readFile(destination);
  await assert.rejects(f.maintenance.backup({ destination }, human), { code: 'EEXIST' }); assert.deepEqual(await readFile(destination), bytes);
  const alias = path.join(f.root, 'alias.sqlite'); await symlink(destination, alias);
  await assert.rejects(f.maintenance.backup({ destination: alias }, human)); await assert.rejects(restoreBackup({ backupPath: alias, stateDirectory: path.join(f.root, 'no') }, human));
  const publicDir = path.join(f.root, 'public'); await mkdir(publicDir, { mode: 0o755 });
  await assert.rejects(f.maintenance.backup({ destination: path.join(publicDir, 'no.sqlite') }, human), { code: 'INSECURE_STATE' });
  const linkDir = path.join(f.root, 'link'); await symlink(f.state, linkDir);
  await assert.rejects(f.maintenance.backup({ destination: path.join(linkDir, 'no.sqlite') }, human), { code: 'INSECURE_STATE' });
  await chmod(destination, 0o644); await assert.rejects(restoreBackup({ backupPath: destination, stateDirectory: path.join(f.root, 'no') }, human), { code: 'INSECURE_STATE' }); await chmod(destination, 0o600);
  const foreign = new DatabaseSync(destination); foreign.exec('CREATE TABLE future_authority (tokenHash TEXT)'); foreign.close();
  await assert.rejects(restoreBackup({ backupPath: destination, stateDirectory: path.join(f.root, 'unknown') }, human), { code: 'UNSUPPORTED_MAINTENANCE_SCHEMA' });
  assert(!await readdir(f.root).then(names => names.includes('unknown')));
});

test('additive maintenance migration preserves v3 table layouts behind the v4 compatibility gate and rejects partial, newer or modified extensions atomically', async t => {
  const f = await fixture(t), before = f.store.db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('sessions','tasks','leases') ORDER BY name").all();
  initializeMaintenanceSchema(f.store.db); validateMaintenanceDatabase(f.store.db);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('sessions','tasks','leases') ORDER BY name").all(), before);
  f.store.db.exec('UPDATE murmur_maintenance_schema SET version=999');
  assert.throws(() => initializeMaintenanceSchema(f.store.db), { code: 'SCHEMA_TOO_NEW' });
  assert.equal(f.store.db.prepare('SELECT version FROM murmur_maintenance_schema').get().version, 999);
  f.store.db.exec('UPDATE murmur_maintenance_schema SET version=1; ALTER TABLE manual_credentials ADD COLUMN unknown TEXT');
  assert.throws(() => initializeMaintenanceSchema(f.store.db), { code: 'INVALID_SCHEMA' });
  assert.equal(f.store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('CLI rotation durably writes private secret before hash-only POST, retries exact record, and never prints secret', async t => {
  const f = await fixture(t), file = path.join(f.root, 'credential.json'), calls = [];
  const dependencies = { env: {}, request: async (directory, method, route, body, options) => {
    const record = JSON.parse(await readFile(file, 'utf8')); assert.equal(hash(record.token), body.tokenHash);
    assert.equal((await lstat(file)).mode & 0o777, 0o600); assert(!JSON.stringify(body).includes(record.token));
    calls.push({ directory, method, route, body, options }); return f.maintenance.rotateManual(body, human, mutation('rotate', body, options.key));
  } };
  const result = await maintenanceCommand(f.state, ['credentials','rotate','--session',f.session.id,'--revision','1','--out',file,'--request-id','cli-rotation'], dependencies);
  const record = JSON.parse(await readFile(file, 'utf8')); assert(!JSON.stringify(result).includes(record.token)); assert(!JSON.stringify(calls).includes(record.token));
  assert.equal(f.store.authenticateSession(record.token).id, f.session.id);
  await maintenanceCommand(f.state, ['credentials','rotate','--retry-file',file], dependencies); assert.deepEqual(calls[0], calls[1]);
  const before = calls.length;
  await assert.rejects(maintenanceCommand(f.state, ['credentials','rotate','--session',f.session.id,'--revision','2','--out',file], dependencies)); assert.equal(calls.length, before);
  await assert.rejects(maintenanceCommand(f.state, ['credentials','inspect','--session',f.session.id], { ...dependencies, env: { MURMUR_AGENT_CONNECTION_FILE: 'configured' } }));
});

test('CLI retention apply requires an explicit private preview and offline restore never calls transport', async t => {
  const f = await fixture(t), file = path.join(f.root, 'preview.json'); f.advance(1000);
  const dependencies = { env: {}, request: async (_dir, _method, route, body, options) => route.endsWith('/preview') ? f.maintenance.previewRetention(body,human) : f.maintenance.applyRetention(body,human,mutation('apply',body,options.key)) };
  const preview = await maintenanceCommand(f.state, ['retention','preview','--before',String(f.now()),'--classes','events','--out',file], dependencies);
  const applied = await maintenanceCommand(f.state, ['retention','apply','--preview',file], dependencies); assert.equal(applied.previewDigest, preview.previewDigest);
  await assert.rejects(maintenanceCommand(f.state, ['retention','apply','--before',String(f.now())], dependencies));
  const backup = path.join(f.root, 'offline.sqlite'); await f.maintenance.backup({destination:backup},human);
  await maintenanceCommand(f.state, ['restore','--backup',backup,'--state-directory',path.join(f.root,'cli-restored')], { env:{}, request: () => { throw new Error('Offline restore must not use transport'); } });
});


test('captured authenticated session guards deny work and cached replay after rotation during an await', async t => {
  const f = await fixture(t);
  const principal = authenticatedSessionPrincipal({ kind: 'session', projectId: f.project.id, sessionId: f.session.id }, () => f.store.assertSessionCredential(f.session.id, hash(f.token)));
  const original = withAuthorization(principal, mutation('guarded', {}, 'guarded-key', `session:${f.session.id}`));
  f.store.mutate(original, () => ({ safe: true }));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const delayedReplay = (async () => { await gate; return f.store.replay(original); })();
  const delayedMutation = (async () => { await gate; return f.store.mutate({ ...original, key: 'new-delayed-key' }, () => { throw new Error('must not execute'); }); })();
  f.call('rotateManual', { sessionId: f.session.id, revision: 1, tokenHash: hash(secret()) }); release();
  await assert.rejects(delayedReplay, { code: 'SESSION_UNAUTHORIZED' });
  await assert.rejects(delayedMutation, { code: 'SESSION_UNAUTHORIZED' });
  assert.throws(() => withAuthorization({ ...principal }, original), { code: 'SESSION_UNAUTHORIZED' });
  f.advance(1000); f.apply(f.maintenance.previewRetention({ before: f.now(), classes: ['mutation-payloads'] }, human));
  assert.throws(() => f.store.replay(original), { code: 'SESSION_UNAUTHORIZED' }, 'authorization comes before a tombstone response');
});

test('mutation tombstones and credential guards are rechecked under the transaction lock', async t => {
  const f = await fixture(t), input = mutation('once', {}, 'concurrent-retirement'); let executed = false;
  const originalExec = f.store.db.exec.bind(f.store.db); let injected = false;
  f.store.db.exec = sql => {
    if (sql === 'BEGIN IMMEDIATE' && !injected) {
      injected = true;
      f.store.db.prepare('INSERT INTO mutation_tombstones VALUES (?,?,?,?,?)').run(input.caller, input.key, hash(canonicalJson({ operation: input.operation, input: input.input })), f.now(), f.now());
    }
    return originalExec(sql);
  };
  try { assert.throws(() => f.store.mutate(input, () => { executed = true; return {}; }), { code: 'IDEMPOTENCY_RETIRED' }); }
  finally { f.store.db.exec = originalExec; }
  assert.equal(executed, false);
  let checks = 0;
  const principal = authenticatedSessionPrincipal({ kind: 'session', projectId: f.project.id, sessionId: f.session.id }, () => {
    if (++checks === 3) f.store.db.prepare('UPDATE manual_credentials SET revokedAt=? WHERE sessionId=?').run(f.now(), f.session.id);
    f.store.assertSessionCredential(f.session.id, hash(f.token));
  });
  const guarded = withAuthorization(principal, mutation('guarded', {}, 'inside-lock', `session:${f.session.id}`));
  assert.throws(() => f.store.mutate(guarded, () => { executed = true; return {}; }), { code: 'SESSION_UNAUTHORIZED' });
  assert.equal(executed, false); assert.equal(checks, 3); assert(f.store.authenticateSession(f.token), 'failed transaction rolled back');
});

test('retention apply rolls back every class and never clears existing tombstones on failure', async t => {
  const f = await fixture(t), draft = f.enroll(); f.advance(700_000);
  const preview = f.maintenance.previewRetention({ before: f.now(), classes: [...RETENTION_CLASSES] }, human);
  const snapshot = f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(draft.receipt.requestId);
  const eventCount = f.store.db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const oldPrepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => {
    if (sql === 'DELETE FROM events WHERE sequence=?') throw new Error('fixture write interruption');
    return oldPrepare(sql);
  };
  try { assert.throws(() => f.apply(preview), /fixture write interruption/); }
  finally { f.store.db.prepare = oldPrepare; }
  assert.deepEqual(f.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(draft.receipt.requestId), snapshot);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_tombstones').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM request_redactions').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, eventCount);
  assert.equal(f.store.db.prepare('SELECT revision FROM maintenance_state').get().revision, preview.revision);
});

test('a failed rotation POST leaves its private retry file and can only replay the original secret', async t => {
  const f = await fixture(t), out = path.join(f.root, 'uncertain.json');
  await assert.rejects(maintenanceCommand(f.state, ['credentials','rotate','--session',f.session.id,'--revision','1','--out',out,'--request-id','uncertain-key'], { env: {}, request: async () => { throw new Error('fixture connection interruption'); } }));
  const before = await readFile(out, 'utf8'), record = JSON.parse(before);
  assert.equal(f.store.authenticateSession(record.token), undefined);
  await maintenanceCommand(f.state, ['credentials','rotate','--retry-file',out], { env: {}, request: async (_directory,_method,_route,input,options) => f.maintenance.rotateManual(input,human,mutation('rotate',input,options.key)) });
  assert.equal(await readFile(out,'utf8'), before); assert(f.store.authenticateSession(record.token));
});


test('missing credential metadata never silently resurrects default authority or revision', async t => {
  const f = await fixture(t);
  f.store.db.prepare('DELETE FROM manual_credentials WHERE sessionId=?').run(f.session.id);
  assert.equal(f.store.authenticateSession(f.token), undefined);
  assert.throws(() => initializeMaintenanceSchema(f.store.db), { code: 'INVALID_SCHEMA' });
  assert.throws(() => validateMaintenanceDatabase(f.store.db), { code: 'INVALID_SCHEMA' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM manual_credentials').get().n, 0);
});


test('interrupted restoration leaves a private startup barrier, never runnable partial authority', async t => {
  const f = await fixture(t), managed = workflowFixture(f), backupPath = path.join(f.root, 'interrupted-backup.sqlite');
  await f.maintenance.backup({ destination: backupPath }, human);
  const source = new DatabaseSync(backupPath); source.prepare("UPDATE workflow_jobs SET validation='not-json'").run(); source.close();
  const stateDirectory = path.join(f.root, 'incomplete');
  await assert.rejects(restoreBackup({ backupPath, stateDirectory }, human));
  assert.match(await readFile(path.join(stateDirectory, 'state.sqlite'),'utf8'), /restore incomplete/);
  assert.equal((await lstat(path.join(stateDirectory, 'state.sqlite'))).mode & 0o777, 0o600);
  assert.throws(() => new CoordinationStore(path.join(stateDirectory, 'state.sqlite')));
  assert(f.store.authenticateSession(managed.agent));
  await assert.rejects(restoreBackup({ backupPath, stateDirectory }, human), { code: 'EEXIST' });
});


test('maintenance tables and v4 compatibility marker commit atomically without rewriting v3 session rows', async t => {
  const f = await fixture(t), db = f.store.db;
  const sessionRows = db.prepare('SELECT rowid,* FROM sessions').all(), sessionSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='sessions'").get().sql;
  for (const name of ['murmur_maintenance_schema','maintenance_state','manual_credentials','retired_session_credentials','mutation_tombstones','event_retention','context_retention','request_redactions']) db.exec(`DROP TABLE ${name}`);
  db.exec('PRAGMA user_version=3');
  const schema = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
  const originalExec = db.exec.bind(db); let markerAttempted = false;
  db.exec = sql => {
    if (sql === 'PRAGMA user_version=4') { markerAttempted = true; assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='mutation_tombstones'").get()); throw new Error('fixture upgrade interruption'); }
    return originalExec(sql);
  };
  try { assert.throws(() => initializeMaintenanceSchema(db), /fixture upgrade interruption/); }
  finally { db.exec = originalExec; }
  assert(markerAttempted); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), schema);
  initializeMaintenanceSchema(db);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(version, 4); assert(version > 3, 'the published 0.5 constructor and session migrator both refuse versions above 3');
  assert.deepEqual(db.prepare('SELECT rowid,* FROM sessions').all(), sessionRows);
  assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='sessions'").get().sql, sessionSql);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('v4 startup refuses incomplete maintenance state before any initializer can repair it', async t => {
  const f = await fixture(t, true), filename = path.join(f.state,'state.sqlite');
  f.store.db.exec('DROP TABLE mutation_tombstones');
  assert.throws(() => new CoordinationStore(filename), { code: 'INVALID_SCHEMA' });
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_schema WHERE name='mutation_tombstones'").get(), undefined);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 4);
});
