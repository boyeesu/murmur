import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { GroupsService } from '../packages/murmur/dist/core/groups.js';
import { ExternalGrantService } from '../packages/murmur/dist/core/external-grants.js';
import { callerId, withAuthorization } from '../packages/murmur/dist/protocol/index.js';
import { discoverProject } from '../packages/murmur/dist/workspaces/identity.js';
import { mutation, temporary, repository, git } from './helpers.mjs';
const human = { kind: 'human' }, hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
async function fixture(t, gitRepo = false) {
  const root = await temporary(t), workspace = path.join(root, 'source');
  if (gitRepo) await repository(workspace); else await mkdir(workspace);
  let now = 100_000;
  const store = new CoordinationStore(':memory:', () => now); t.after(() => store.close());
  const coordination = new CoordinationService(store), groups = new GroupsService(store, coordination);
  const grants = new ExternalGrantService(store, coordination, groups, { origin: 'http://127.0.0.1:12345', stateId: 'a'.repeat(64), instanceId: randomUUID() });
  const identity = await discoverProject(workspace), project = store.registerProject(identity, mutation('register', identity));
  const call = (service, method, input, key = randomUUID(), principal = human) => service[method](input, principal, mutation(method, input, key, callerId(principal)));
  const enrollment = (extra = {}, key = randomUUID()) => {
    const capability = secret(), pollSecret = secret();
    const input = { capabilityHash: hash(capability), pollSecretHash: hash(pollSecret), workspaceRoot: workspace, native: { tool: 'manual', nativeId: randomUUID(), incarnationId: 'incarnation-1' }, groupTitle: 'Password reset', responsibility: 'Implement API', ...extra };
    return { capability, pollSecret, input, receipt: grants.createEnrollment(input, key), key };
  };
  const approve = async (request, extra = {}) => {
    const review = await call(grants, 'review', { requestId: request.receipt.requestId, revision: request.receipt.revision });
    const input = { requestId: request.receipt.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Reviewed API responsibility', ...extra };
    const key = randomUUID(), result = await call(grants, 'approve', input, key);
    const principal = await grants.authenticateExternal(request.capability);
    return { ...result, principal, approvalInput: input, approvalKey: key };
  };
  return { root, workspace, store, coordination, groups, grants, project, call, enrollment, approve, advance: amount => { now += amount; } };
}

test('preauth enrollment is hashes-only, private, bounded, replay-safe and does no discovery', async t => {
  const f = await fixture(t);
  const request = f.enrollment({ workspaceRoot: '/nonexistent/no-filesystem-access', handoff: { summary: 'PRIVATE-DRAFT' }, inviteHash: hash(secret()), groupTitle: undefined });
  assert.equal(request.receipt.state, 'pending');
  assert.deepEqual(f.grants.createEnrollment(request.input, request.key), request.receipt);
  assert.throws(() => f.grants.createEnrollment({ ...request.input, responsibility: 'different' }, request.key), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.grants.pollStatus({ requestId: request.receipt.requestId, pollSecret: secret() }), { code: 'ENROLLMENT_UNAUTHORIZED' });
  assert.deepEqual(f.grants.pollStatus({ requestId: request.receipt.requestId, pollSecret: request.pollSecret }), request.receipt);
  assert.equal(await f.grants.authenticateExternal(request.capability), undefined);
  assert.throws(() => f.grants.createEnrollment({ ...request.input, capability: request.capability }, randomUUID()), /Unexpected/);
  assert.throws(() => f.grants.createEnrollment({ ...request.input, responsibility: 'x'.repeat(17000) }, randomUUID()), { code: 'BODY_TOO_LARGE' });
  const publicData = JSON.stringify({ snapshot: f.store.snapshot(), events: f.store.events(f.project.id, 0), receipt: request.receipt });
  assert(!publicData.includes('PRIVATE-DRAFT'));
  for (const row of f.store.db.prepare('SELECT response FROM mutations').all()) for (const value of [request.capability, request.pollSecret, 'PRIVATE-DRAFT']) assert(!row.response.includes(value));
  assert.equal(f.grants.listRequests(human)[0].handoff.summary, 'PRIVATE-DRAFT');
  for (let i = 0; i < 9; i++) f.enrollment();
  assert.throws(() => f.enrollment(), { code: 'ENROLLMENT_LIMIT' });
  f.advance(60_001); f.enrollment();
  f.advance(600_001);
  assert.equal(f.grants.pollStatus({ requestId: request.receipt.requestId, pollSecret: request.pollSecret }).state, 'expired');
  await assert.rejects(f.call(f.grants, 'review', { requestId: request.receipt.requestId, revision: 1 }), { code: 'ENROLLMENT_INACTIVE' });
});

test('human approval creates isolated external ownership and publishes only reviewed handoff proposals', async t => {
  const f = await fixture(t), request = f.enrollment({ handoff: { summary: 'PRIVATE-UNREVIEWED' } });
  const approved = await f.approve(request, { featureKey: 'api-owner', handoff: { summary: 'APPROVED-SUMMARY', reads: ['src/shared'], writes: ['src/api'], acceptanceCriteria: ['tested'], produces: [{ key: 'api.reset', version: '1' }], blocker: 'Awaiting schema', decisions: [{ key: 'api.reset', version: '1', value: 'POST /reset', rationale: 'reviewed' }] } });
  assert(approved.principal); assert.equal(f.store.session(approved.member.sessionId).credentialMode, 'external');
  assert.equal(f.store.authenticateSession(request.capability), undefined, 'external never authenticates through legacy session auth');
  assert.equal(approved.grant.expiresAt - approved.grant.createdAt, 8 * 3600_000);
  assert.equal(f.grants.pollStatus({ requestId: request.receipt.requestId, pollSecret: request.pollSecret }).state, 'approved');
  const identity = await f.grants.dispatch('identity', {}, approved.principal);
  assert.equal(identity.role, 'external'); assert.equal(identity.taskId, approved.member.taskId);
  assert.equal(f.coordination.listDecisions(f.project.id)[0].status, 'proposed');
  const context = await f.grants.dispatch('context', {}, approved.principal);
  assert.deepEqual(context.task.intent.writes, ['src/api']);
  assert.equal(context.task.blocker.blocker, 'Awaiting schema');
  assert.equal(context.task.blocker.taskRevision, context.task.revision);
  assert.equal(context.decisions.length, 0);
  const output = JSON.stringify({ context, events: f.store.events(f.project.id, 0), approval: approved.grant, groups: f.groups.list(f.project.id, human), journals: f.store.db.prepare('SELECT * FROM mutations').all() });
  for (const forbidden of [request.capability, request.pollSecret, 'PRIVATE-UNREVIEWED']) assert(!output.includes(forbidden));
  assert(output.includes('APPROVED-SUMMARY'));
  assert(f.store.db.prepare("SELECT 1 FROM group_provenance WHERE entityType='decision' AND grantId=?").get(approved.grant.id));
  const briefing = f.groups.briefing({ memberId: approved.member.id }, human);
  assert.equal(briefing.kind, 'reviewed_replacement_handoff'); assert.match(briefing.warning, /NEW managed task/);
  assert.deepEqual(briefing.handoff.writes, ['src/api']);
});

test('external authority denies selectors, escalation, foreign tasks, missing guards and expired replays', async t => {
  const f = await fixture(t), request = f.enrollment(), a = await f.approve(request, { expiresInSeconds: 60 });
  for (const [operation, input] of [['context', { taskId: a.member.taskId }], ['intent', { revision: 1, sessionId: a.member.sessionId }], ['task-status', { revision: 1, status: 'abandoned' }], ['task-status', { revision: 1, status: 'planned' }], ['propose-decision', { key: 'x', value: 'y', version: '1', rationale: 'r', status: 'accepted' }], ['status', {}], ['events', {}], ['handoff', {}], ['renew', {}]]) {
    await assert.rejects(f.grants.dispatch(operation, input, a.principal, randomUUID()));
  }
  assert.throws(() => f.grants.identity({ ...a.principal }), { code: 'EXTERNAL_UNAUTHORIZED' });
  const other = f.store.createTask({ projectId: f.project.id, sessionId: a.member.sessionId, title: 'Second task same session', featureKey: null }, mutation('task', {}));
  assert.throws(() => f.coordination.updateTask({ taskId: other.id, revision: 1, status: 'blocked' }, a.principal, mutation('update', {}, randomUUID(), callerId(a.principal))), { code: 'EXTERNAL_FORBIDDEN' });
  const data = { revision: 1, writes: ['api'] }, key = randomUUID();
  const first = await f.grants.dispatch('intent', data, a.principal, key);
  assert.deepEqual(await f.grants.dispatch('intent', data, a.principal, key), first);
  const journal = f.store.db.prepare('SELECT * FROM mutations WHERE caller=? AND key=?').get(callerId(a.principal), key);
  assert(journal); assert(!JSON.stringify(journal).includes('authorization'));
  const forged = mutation('intent', data, key, callerId(a.principal));
  assert.throws(() => f.store.replay(forged), { code: 'EXTERNAL_UNAUTHORIZED' });
  assert.throws(() => f.store.mutate(forged, () => ({})), { code: 'EXTERNAL_UNAUTHORIZED' });
  f.advance(60_000);
  await assert.rejects(f.grants.dispatch('intent', data, a.principal, key), { code: 'EXTERNAL_UNAUTHORIZED' });
  assert.equal(await f.grants.authenticateExternal(request.capability), undefined);
  assert.equal(f.store.task(a.member.taskId).ownerSessionId, a.member.sessionId);
});

test('single-use invitations are consumed atomically and feature ownership is never reused', async t => {
  const f = await fixture(t), group = f.call(f.groups, 'create', { projectId: f.project.id, title: 'Shared goal' });
  const code = secret(), invitation = f.call(f.groups, 'invite', { groupId: group.id, inviteHash: hash(code) });
  assert.equal(invitation.expiresAt - invitation.createdAt, 15 * 60_000);
  const left = f.enrollment({ groupTitle: undefined, inviteHash: hash(code) }), right = f.enrollment({ groupTitle: undefined, inviteHash: hash(code) });
  const reviews = await Promise.all([left, right].map(item => f.call(f.grants, 'review', { requestId: item.receipt.requestId, revision: 1 })));
  const results = await Promise.allSettled(reviews.map(review => f.call(f.grants, 'approve', { requestId: review.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Distinct owner' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'INVITATION_INACTIVE').length, 1);
  assert.equal(f.store.snapshot().tasks.length, 1); assert.equal(f.groups.get(group.id, human).members.length, 1);
  assert(!JSON.stringify(f.store.db.prepare('SELECT * FROM mutations').all()).includes(code));
  const owned = await f.approve(f.enrollment(), { featureKey: 'exclusive-feature' });
  const duplicate = f.enrollment(), review = await f.call(f.grants, 'review', { requestId: duplicate.receipt.requestId, revision: 1 });
  const before = f.store.snapshot().sessions.length;
  await assert.rejects(f.call(f.grants, 'approve', { requestId: review.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Duplicate', featureKey: 'exclusive-feature' }), { code: 'FEATURE_ALREADY_OWNED' });
  assert.equal(f.store.snapshot().sessions.length, before, 'failed compound approval rolls back session and group');
  assert.equal(f.store.task(owned.member.taskId).featureKey, 'exclusive-feature');
});

test('fixed expiry and leave release only grant-owned lease generations and preserve feature claims', async t => {
  const f = await fixture(t), request = f.enrollment(), a = await f.approve(request, { expiresInSeconds: 30, featureKey: 'retained' });
  const lease = await f.grants.dispatch('reserve', { revision: 1, resources: [{ kind: 'path', value: 'src' }], ttlSeconds: 3600 }, a.principal, randomUUID());
  assert.equal(lease.expiresAt, a.grant.expiresAt);
  const manual = f.store.registerSession({ projectId: f.project.id, workspaceRoot: f.workspace, tool: 'manual', nativeId: 'manual', instanceId: 'i' }, mutation('session', {}));
  const task = f.store.createTask({ projectId: f.project.id, sessionId: manual.session.id, title: 'Other owner', featureKey: null }, mutation('task', {}));
  const other = f.store.acquire({ projectId: f.project.id, sessionId: manual.session.id, taskId: task.id, taskRevision: 1, resources: [{ kind: 'resource', value: 'other' }], ttlSeconds: 120 }, mutation('lease', {}));
  f.advance(10_000); await f.grants.dispatch('context', {}, a.principal);
  assert.equal(f.grants.grant(a.grant.id).expiresAt, a.grant.expiresAt, 'refresh is not renewal');
  await assert.rejects(f.grants.dispatch('release', { leaseId: other.id, generation: other.generation }, a.principal, randomUUID()), { code: 'EXTERNAL_FORBIDDEN' });
  f.advance(20_001);
  const replacement = f.store.acquire({ projectId: f.project.id, sessionId: manual.session.id, taskId: task.id, taskRevision: 1, resources: [{ kind: 'path', value: 'src' }], ttlSeconds: 120 }, mutation('lease', {}));
  f.grants.sweep();
  assert.notEqual(f.store.lease(lease.id).releasedAt, null);
  assert.equal(f.store.lease(replacement.id).releasedAt, null);
  assert.equal(f.store.lease(other.id).releasedAt, null);
  assert.equal(f.store.task(a.member.taskId).status, 'active'); assert.equal(f.store.task(a.member.taskId).featureKey, 'retained');
  const bRequest = f.enrollment(), b = await f.approve(bRequest);
  const bLease = await f.grants.dispatch('reserve', { revision: 1, resources: [{ kind: 'resource', value: 'own' }] }, b.principal, randomUUID());
  const left = await f.grants.dispatch('leave', {}, b.principal, randomUUID()); assert.equal(left.state, 'left');
  assert.equal(await f.grants.authenticateExternal(bRequest.capability), undefined);
  assert.notEqual(f.store.lease(bLease.id).releasedAt, null);
  assert.equal(f.store.task(b.member.taskId).status, 'active');
});

test('review pins workspace and request; replacement, stale review, and revoked async work fail closed', async t => {
  const f = await fixture(t), request = f.enrollment(), review = await f.call(f.grants, 'review', { requestId: request.receipt.requestId, revision: 1 });
  await assert.rejects(f.call(f.grants, 'approve', { requestId: review.requestId, revision: review.revision, reviewDigest: 'a'.repeat(64), responsibility: 'Changed review' }), { code: 'STALE_REVIEW' });
  await rename(f.workspace, `${f.workspace}-old`); await mkdir(f.workspace);
  await assert.rejects(f.call(f.grants, 'approve', { requestId: review.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Reviewed' }));
  assert.equal(f.store.snapshot().sessions.length, 0);
  await rename(f.workspace, `${f.workspace}-replacement`); await rename(`${f.workspace}-old`, f.workspace);
  const a = await f.approve(f.enrollment());
  const original = f.grants.inspectWorkspace.bind(f.grants);
  let unblock, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.grants.inspectWorkspace = async workspace => { const result = await original(workspace); entered(); await new Promise(resolve => { unblock = resolve; }); return result; };
  const operation = f.grants.dispatch('intent', { revision: 1, writes: ['new'] }, a.principal, randomUUID());
  await waiting;
  f.call(f.grants, 'revoke', { grantId: a.grant.id }); unblock();
  await assert.rejects(operation);
  assert.equal(f.store.task(a.member.taskId).revision, 1);
});

test('manual group workflow is human-only and cannot promote external or manual credentials', async t => {
  const f = await fixture(t), manual = f.store.registerSession({ projectId: f.project.id, workspaceRoot: f.workspace, tool: 'manual', nativeId: 'm', instanceId: 'i' }, mutation('manual', {}));
  const task = f.store.createTask({ projectId: f.project.id, sessionId: manual.session.id, title: 'Manual responsibility', featureKey: null }, mutation('task', {}));
  const group = f.call(f.groups, 'create', { projectId: f.project.id, title: 'Manual coordination' });
  const member = f.call(f.groups, 'addExisting', { groupId: group.id, sessionId: manual.session.id, taskId: task.id, responsibility: 'Own manual work', handoff: { summary: 'Reviewed manual briefing', writes: ['manual'] } });
  assert.equal(member.kind, 'manual'); assert.equal(f.store.authenticateSession(manual.token).id, manual.session.id);
  const principal = { kind: 'session', sessionId: manual.session.id, projectId: f.project.id };
  assert.throws(() => f.call(f.groups, 'requestManaged', { groupTitle: 'new', responsibility: 'unapproved' }, randomUUID(), principal), { code: 'FORBIDDEN' });
  assert.throws(() => f.call(f.groups, 'addExisting', { groupId: group.id, sessionId: manual.session.id, taskId: task.id, responsibility: 'unapproved' }, randomUUID(), principal), { code: 'FORBIDDEN' });
  const a = await f.approve(f.enrollment());
  assert.throws(() => f.call(f.groups, 'addExisting', { groupId: group.id, sessionId: a.member.sessionId, taskId: a.member.taskId, responsibility: 'unauthorized promotion' }), { code: 'FORBIDDEN' });
  f.call(f.groups, 'close', { groupId: group.id, revision: f.groups.groupRow(group.id).revision });
  assert.equal(f.store.authenticateSession(manual.token).id, manual.session.id);
  assert.equal(f.store.task(task.id).ownerSessionId, manual.session.id);
});

test('context ranks linked members without hiding cross-group conflicts or accepted decisions', async t => {
  const f = await fixture(t), a = await f.approve(f.enrollment());
  for (let i = 0; i < 28; i++) {
    const session = f.store.registerSession({ projectId: f.project.id, workspaceRoot: f.workspace, tool: 'manual', nativeId: `m${i}`, instanceId: 'i' }, mutation('session', {}));
    f.store.createTask({ projectId: f.project.id, sessionId: session.session.id, title: `Other ${i}`, featureKey: null }, mutation('task', {}));
  }
  const code = secret(); f.call(f.groups, 'invite', { groupId: a.group.id, inviteHash: hash(code) });
  const b = await f.approve(f.enrollment({ groupTitle: undefined, inviteHash: hash(code) }));
  const c = await f.approve(f.enrollment());
  for (const item of [a, c]) f.call(f.coordination, 'declareIntent', { taskId: item.member.taskId, revision: 1, writes: ['shared'], produces: [{ key: 'shared.api', version: '1' }] });
  const decision = f.call(f.coordination, 'proposeDecision', { projectId: f.project.id, key: 'global.authority', value: 'must remain visible', version: '1', rationale: 'human' });
  f.call(f.coordination, 'acceptDecision', { decisionId: decision.id, revision: 1, expectedAcceptedId: null });
  const before = await f.grants.dispatch('context', {}, a.principal);
  assert.deepEqual(before.tasks.slice(0, 3).map(task => task.id), [a.member.taskId, c.member.taskId, b.member.taskId]);
  assert(before.alerts.some(alert => alert.taskIds.includes(c.member.taskId)));
  assert(before.decisions.some(item => item.id === decision.id));
  assert(before.briefing.includes('must remain visible'));
  assert.equal(before.truncated.tasks, true); assert(before.briefing.length <= 6000);
  f.call(f.groups, 'leave', { memberId: b.member.id, revision: b.member.revision });
  const after = await f.grants.dispatch('context', { after: before.nextCursor }, a.principal);
  assert.notEqual(after.membershipRevision, before.membershipRevision); assert(after.nextCursor >= before.nextCursor);
});

test('enrollment approval refresh and leave preserve dirty source files and Git refs', async t => {
  const f = await fixture(t, true);
  await writeFile(path.join(f.workspace, 'README.md'), 'Dirty user work retained.\n');
  await writeFile(path.join(f.workspace, 'untracked.txt'), 'Do not adopt, move, or delete.\n');
  const snapshot = async () => ({ status: git(f.workspace, 'status', '--porcelain=v1'), refs: git(f.workspace, 'show-ref'), files: await Promise.all((await readdir(f.workspace)).filter(name => name !== '.git').sort().map(async name => [name, await readFile(path.join(f.workspace, name), 'utf8')])) });
  const before = await snapshot(), request = f.enrollment(), a = await f.approve(request);
  await f.grants.dispatch('context', {}, a.principal);
  await f.grants.dispatch('leave', {}, a.principal, randomUUID());
  assert.deepEqual(await snapshot(), before);
});

test('managed group requests reuse the existing task and leave preserves launch authority and leases', async t => {
  const { LaunchService } = await import('../packages/murmur/dist/core/launches.js');
  const { GitWorkflow } = await import('../packages/murmur/dist/integration/workflow.js');
  const f = await fixture(t, true), state = path.join(f.root, 'managed-state'); await mkdir(state);
  const workflow = new GitWorkflow(f.store, state); await workflow.initialize();
  const launches = new LaunchService(f.store, workflow, f.coordination, f.grants.runtime);
  t.after(async () => { await launches.close(); workflow.close(); });
  const input = { projectId: f.project.id, tool: 'claude', title: 'Existing managed work', featureKey: 'managed-exclusive' };
  const prepared = await launches.prepare(input, human, mutation('launch.prepare', input));
  launches.control('claim', prepared.supervisor.supervisorToken, { launchId: prepared.launch.id, controllerId: 'controller', revision: prepared.launch.lifecycleRevision }, randomUUID());
  const principal = { kind: 'session', projectId: f.project.id, sessionId: prepared.agent.sessionId };
  const requestInput = { groupTitle: 'Mixed managed and external', responsibility: 'Retain current managed task', handoff: { summary: 'Reviewed existing managed task' } };
  launches.authorizeAgent(principal.sessionId, 'POST', new URL(`${f.grants.runtime.origin}/v1/groups/requests`), requestInput);
  const request = f.call(f.groups, 'requestManaged', requestInput, randomUUID(), principal);
  const review = await f.call(f.grants, 'review', { requestId: request.requestId, revision: request.revision });
  const approved = await f.call(f.grants, 'approve', { requestId: request.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Managed task retained' });
  assert.equal(approved.grant, null); assert.equal(approved.member.kind, 'managed'); assert.equal(approved.member.taskId, prepared.agent.taskId);
  assert.equal(f.store.snapshot().tasks.length, 1); assert.equal(f.store.snapshot().sessions.length, 1);
  const lease = f.store.acquire({ projectId: f.project.id, sessionId: principal.sessionId, taskId: approved.member.taskId, taskRevision: f.store.task(approved.member.taskId).revision, resources: [{ kind: 'path', value: 'managed' }], ttlSeconds: 60 }, mutation('lease', {}));
  const before = launches.get(prepared.launch.id);
  const leave = { memberId: approved.member.id, revision: approved.member.revision };
  launches.authorizeAgent(principal.sessionId, 'POST', new URL(`${f.grants.runtime.origin}/v1/groups/members/leave`), leave);
  f.call(f.groups, 'leave', leave, randomUUID(), principal);
  const after = launches.get(prepared.launch.id);
  assert.equal(after.state, before.state); assert.equal(after.expiresAt, before.expiresAt); assert.equal(after.lifecycleRevision, before.lifecycleRevision);
  assert.equal(f.store.lease(lease.id).releasedAt, null); assert.equal(f.store.authenticateSession(prepared.agent.agentToken).id, principal.sessionId);
  assert.equal(f.store.task(approved.member.taskId).featureKey, 'managed-exclusive');
  assert.throws(() => launches.authorizeAgent(principal.sessionId, 'POST', new URL(`${f.grants.runtime.origin}/v1/groups/members/add`), {}), { code: 'AGENT_FORBIDDEN' });
  assert.throws(() => launches.authorizeAgent(principal.sessionId, 'POST', new URL(`${f.grants.runtime.origin}/v1/groups/requests`), { ...requestInput, taskId: prepared.agent.taskId }), { code: 'AGENT_FORBIDDEN' });
});

test('guard is rechecked inside mutations and before cached replays after ownership or workspace changes', async t => {
  const f = await fixture(t), request = f.enrollment(), a = await f.approve(request), data = { revision: 1, writes: ['first'] }, key = randomUUID();
  await f.grants.dispatch('intent', data, a.principal, key);
  const meta = withAuthorization(a.principal, mutation('coordination.intent.declare', { taskId: a.member.taskId, revision: 1, writes: ['first'] }, key, callerId(a.principal)));
  const other = f.store.registerSession({ projectId: f.project.id, workspaceRoot: f.workspace, tool: 'manual', nativeId: 'handoff-target', instanceId: 'i' }, mutation('session', {}));
  f.store.db.prepare('UPDATE tasks SET ownerSessionId=? WHERE id=?').run(other.session.id, a.member.taskId);
  assert.throws(() => f.store.replay(meta), { code: 'EXTERNAL_UNAUTHORIZED' });
  assert.throws(() => f.store.mutate(meta, () => ({ unsafe: true })), { code: 'EXTERNAL_UNAUTHORIZED' });
  assert.equal(await f.grants.authenticateExternal(request.capability), undefined);
  const b = await f.approve(f.enrollment());
  const guarded = withAuthorization(b.principal, mutation('test.inner-check', {}, randomUUID(), callerId(b.principal)));
  const original = f.store.db.exec.bind(f.store.db);
  let injected = false;
  f.store.db.exec = sql => {
    const result = original(sql);
    if (sql === 'BEGIN IMMEDIATE' && !injected) { injected = true; f.store.db.prepare('UPDATE external_grants SET revokedAt=? WHERE id=?').run(123, b.grant.id); }
    return result;
  };
  let ran = false;
  assert.throws(() => f.store.mutate(guarded, () => { ran = true; return {}; }), { code: 'EXTERNAL_UNAUTHORIZED' });
  assert.equal(ran, false); f.store.db.exec = original;
  assert.equal(f.grants.grant(b.grant.id).revokedAt, null, 'failed mutation rolled back the injected change as well');
});

test('review retries are pinned, approval retries are sanitized, rejection and deadlines are final', async t => {
  const f = await fixture(t), request = f.enrollment(), key = randomUUID(), input = { requestId: request.receipt.requestId, revision: 1 };
  const review = await f.call(f.grants, 'review', input, key);
  assert.deepEqual(await f.call(f.grants, 'review', input, key), review);
  const approvalKey = randomUUID(), approvalInput = { requestId: review.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Reviewed', expiresInSeconds: 86400 };
  const approved = await f.call(f.grants, 'approve', approvalInput, approvalKey);
  assert.equal(approved.grant.expiresAt - approved.grant.createdAt, 86400_000);
  await assert.rejects(f.call(f.grants, 'approve', { ...approvalInput, responsibility: 'changed' }, approvalKey), { code: 'IDEMPOTENCY_CONFLICT' });
  f.call(f.grants, 'revoke', { grantId: approved.grant.id });
  const replay = await f.call(f.grants, 'approve', approvalInput, approvalKey);
  assert.notEqual(replay.grant.revokedAt, null); assert.equal(replay.member.state, 'left');
  assert.equal(await f.grants.authenticateExternal(request.capability), undefined);
  const rejected = f.enrollment(); f.call(f.grants, 'reject', { requestId: rejected.receipt.requestId, revision: 1 });
  assert.equal(f.grants.pollStatus({ requestId: rejected.receipt.requestId, pollSecret: rejected.pollSecret }).state, 'rejected');
  await assert.rejects(f.call(f.grants, 'review', { requestId: rejected.receipt.requestId, revision: 1 }), { code: 'ENROLLMENT_INACTIVE' });
  const tooLong = f.enrollment();
  await assert.rejects(f.approve(tooLong, { expiresInSeconds: 86401 }));
});

test('same native chat cannot acquire concurrent memberships and group closure revokes only external participation', async t => {
  const f = await fixture(t), native = { tool: 'claude', nativeId: 'same-chat', incarnationId: 'same-incarnation' };
  const a = await f.approve(f.enrollment({ native }));
  const duplicate = f.enrollment({ native });
  await assert.rejects(f.approve(duplicate), { code: 'MEMBERSHIP_EXISTS' });
  assert.equal(f.store.snapshot().sessions.length, 1);
  const lease = await f.grants.dispatch('reserve', { revision: 1, resources: [{ kind: 'resource', value: 'own' }] }, a.principal, randomUUID());
  f.call(f.groups, 'close', { groupId: a.group.id, revision: f.groups.groupRow(a.group.id).revision });
  assert.notEqual(f.grants.grant(a.grant.id).revokedAt, null); assert.notEqual(f.store.lease(lease.id).releasedAt, null);
  assert.equal(f.store.task(a.member.taskId).status, 'active');
});

test('pending admission cap is persistent across instances and cleared only by expiry or a human decision', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++) { if (i && i % 8 === 0) f.advance(60_001); f.enrollment(); }
  assert.throws(() => f.enrollment(), { code: 'ENROLLMENT_LIMIT' });
  const another = new ExternalGrantService(f.store, f.coordination, f.groups, f.grants.runtime);
  const cap = secret(), poll = secret();
  assert.throws(() => another.createEnrollment({ capabilityHash: hash(cap), pollSecretHash: hash(poll), workspaceRoot: f.workspace, native: { tool: 'manual', nativeId: 'new', incarnationId: 'i' }, responsibility: 'own', groupTitle: 'new' }, randomUUID()), { code: 'ENROLLMENT_LIMIT' });
  const pending = f.grants.listRequests(human)[0]; f.call(f.grants, 'reject', { requestId: pending.requestId, revision: pending.revision });
  assert.equal(f.enrollment().receipt.state, 'pending');
  f.advance(600_001); assert.equal(f.enrollment().receipt.state, 'pending');
});

test('Git worktree marker replacement is detected after approval without touching source', async t => {
  const f = await fixture(t, true), worktree = path.join(f.root, 'linked-worktree');
  git(f.workspace, 'worktree', 'add', '-q', '-b', 'existing-chat', worktree);
  const request = f.enrollment({ workspaceRoot: worktree }), a = await f.approve(request);
  const marker = path.join(worktree, '.git'), original = await readFile(marker, 'utf8');
  await writeFile(marker, original + '\n');
  assert.throws(() => f.grants.identity(a.principal), /Git workspace mapping changed/);
  assert.equal(await f.grants.authenticateExternal(request.capability), undefined);
  await writeFile(marker, original);
});

test('explicit human reconnect reuses the task and exclusive feature with fresh capability and lease generation', async t => {
  const f = await fixture(t), native = { tool: 'claude', nativeId: 'reconnect-chat', incarnationId: 'same-incarnation' };
  const firstRequest = f.enrollment({ native }), first = await f.approve(firstRequest, { featureKey: 'exclusive-reconnect', expiresInSeconds: 10 });
  const oldLease = await f.grants.dispatch('reserve', { revision: 1, resources: [{ kind: 'path', value: 'same-scope' }] }, first.principal, randomUUID());
  f.advance(10_001);
  const secondRequest = f.enrollment({ native }), second = await f.approve(secondRequest, { reconnectGrantId: first.grant.id });
  assert.equal(second.member.sessionId, first.member.sessionId); assert.equal(second.member.taskId, first.member.taskId);
  assert.notEqual(second.member.id, first.member.id); assert.notEqual(second.grant.id, first.grant.id);
  assert.equal(f.store.snapshot().sessions.length, 1); assert.equal(f.store.snapshot().tasks.length, 1);
  assert.equal(f.store.task(second.member.taskId).featureKey, 'exclusive-reconnect');
  assert.equal(await f.grants.authenticateExternal(firstRequest.capability), undefined);
  assert(second.principal); assert.equal(f.store.authenticateSession(secondRequest.capability), undefined);
  assert.notEqual(f.grants.grant(first.grant.id).revokedAt, null);
  assert.equal(f.groups.memberRow(first.member.id).state, 'left');
  const replacement = await f.grants.dispatch('reserve', { revision: 1, resources: [{ kind: 'path', value: 'same-scope' }] }, second.principal, randomUUID());
  assert(replacement.generation > oldLease.generation);
  await assert.rejects(f.grants.dispatch('release', { leaseId: oldLease.id, generation: oldLease.generation }, second.principal, randomUUID()), { code: 'EXTERNAL_FORBIDDEN' });
  f.groups.revokeGrantRow(first.grant.id, 'delayed-cleanup');
  assert.equal(f.store.lease(replacement.id).releasedAt, null);
  assert(f.store.db.prepare("SELECT 1 FROM group_provenance WHERE entityType='reconnect' AND entityId=? AND grantId=?").get(first.grant.id, second.grant.id));
});

test('reconnect refuses active takeover, changed identity/owner, wrong feature, and stale reconnect generation', async t => {
  const f = await fixture(t), native = { tool: 'claude', nativeId: 'reconnect-guards', incarnationId: 'original' };
  const original = await f.approve(f.enrollment({ native }), { featureKey: 'preserve-feature' });
  await assert.rejects(f.approve(f.enrollment({ native }), { reconnectGrantId: original.grant.id }), { code: 'RECONNECT_FORBIDDEN' });
  f.call(f.grants, 'revoke', { grantId: original.grant.id });
  await assert.rejects(f.approve(f.enrollment({ native: { ...native, incarnationId: 'forked' } }), { reconnectGrantId: original.grant.id }), { code: 'RECONNECT_CHANGED' });
  await assert.rejects(f.approve(f.enrollment({ native }), { reconnectGrantId: original.grant.id, featureKey: 'different' }), { code: 'RECONNECT_CHANGED' });
  const second = await f.approve(f.enrollment({ native }), { reconnectGrantId: original.grant.id });
  f.call(f.grants, 'revoke', { grantId: second.grant.id });
  await assert.rejects(f.approve(f.enrollment({ native }), { reconnectGrantId: original.grant.id }), { code: 'RECONNECT_CHANGED' });
  const other = f.store.registerSession({ projectId: f.project.id, workspaceRoot: f.workspace, tool: 'manual', nativeId: 'other', instanceId: 'i' }, mutation('session', {}));
  f.store.db.prepare('UPDATE tasks SET ownerSessionId=? WHERE id=?').run(other.session.id, second.member.taskId);
  await assert.rejects(f.approve(f.enrollment({ native }), { reconnectGrantId: second.grant.id }), { code: 'RECONNECT_CHANGED' });
  assert.equal(f.store.task(second.member.taskId).featureKey, 'preserve-feature');
});

test('concurrent identical reviews return the same pinned receipt and eligible reconnects are human-reviewed', async t => {
  const f = await fixture(t), native = { tool: 'claude', nativeId: 'review-race', incarnationId: 'i' }, original = await f.approve(f.enrollment({ native }));
  f.call(f.grants, 'revoke', { grantId: original.grant.id });
  const request = f.enrollment({ native }), input = { requestId: request.receipt.requestId, revision: 1 }, key = randomUUID();
  const [left, right] = await Promise.all([f.call(f.grants, 'review', input, key), f.call(f.grants, 'review', input, key)]);
  assert.deepEqual(left, right); assert.deepEqual(left.reconnectGrantIds, [original.grant.id]);
  assert.equal(f.groups.requestRow(request.receipt.requestId).revision, 2);
  const foreign = f.enrollment({ native: { ...native, nativeId: 'different-chat' } });
  const foreignReview = await f.call(f.grants, 'review', { requestId: foreign.receipt.requestId, revision: 1 });
  assert.deepEqual(foreignReview.reconnectGrantIds, []);
  assert.deepEqual(Object.keys(f.grants.pollStatus({ requestId: request.receipt.requestId, pollSecret: request.pollSecret })).sort(), ['decidedAt','expiresAt','requestId','revision','state']);
});

test('human group detail exposes bounded revocable invitation metadata but never hashes or codes', async t => {
  const f = await fixture(t), group = f.call(f.groups, 'create', { projectId: f.project.id, title: 'Invitations' }), codes = [];
  for (let i = 0; i < 102; i++) { const code = secret(); codes.push(code); f.call(f.groups, 'invite', { groupId: group.id, inviteHash: hash(code) }); }
  const reopened = new GroupsService(f.store, f.coordination), detail = reopened.get(group.id, human);
  assert.equal(detail.invitations.length, 100); assert.equal(detail.invitationsTruncated, true);
  const encoded = JSON.stringify(detail);
  assert(!encoded.includes('inviteHash')); for (const code of codes) { assert(!encoded.includes(code)); assert(!encoded.includes(hash(code))); }
  const invitation = detail.invitations[0]; f.call(f.groups, 'revokeInvite', { inviteId: invitation.id });
  assert.notEqual(f.groups.invitationRow(invitation.id).revokedAt, null);
});

test('reported changed files and remaining work survive review without becoming planned writes or reservations',async t=>{
 const f=await fixture(t),request=f.enrollment({handoff:{summary:'PRIVATE draft',changedFiles:['private-draft.ts'],remainingWork:['PRIVATE remaining']}});
 const a=await f.approve(request,{handoff:{summary:'Reviewed report',changedFiles:['src/already-edited.ts','src/../tests/already-edited.test.ts'],remainingWork:['Add integration coverage','Review API error handling']}});
 const member=f.groups.memberRow(a.member.id);assert.deepEqual(member.handoff.changedFiles,['src/already-edited.ts','tests/already-edited.test.ts']);assert.equal(member.handoff.remainingWork.length,2);
 const context=await f.grants.dispatch('context',{},a.principal);assert.equal(context.task.intent,null);assert.equal(f.store.snapshot().reservations.length,0);
 const linked=context.memberships.find(item=>item.id===member.id);assert.deepEqual(linked.reportedChangedFiles,member.handoff.changedFiles);assert.deepEqual(linked.remainingWork,member.handoff.remainingWork);
 assert(context.briefing.includes('not filesystem attribution'));assert(!JSON.stringify(context).includes('PRIVATE'));
 const exported=f.groups.briefing({memberId:member.id},human);assert.deepEqual(exported.handoff.changedFiles,member.handoff.changedFiles);assert.deepEqual(exported.handoff.remainingWork,member.handoff.remainingWork);
 for(const type of ['reported_changed_files','remaining_work'])assert(f.store.db.prepare('SELECT 1 FROM group_provenance WHERE memberId=? AND entityType=? AND grantId=?').get(member.id,type,a.grant.id));
 for(const handoff of [{summary:'x',changedFiles:['../escape']},{summary:'x',changedFiles:Array.from({length:65},(_,i)=>`path-${i}`)},{summary:'x',remainingWork:Array.from({length:17},()=> 'todo')},{summary:'x',remainingWork:['x'.repeat(513)]}])assert.throws(()=>f.enrollment({handoff}));
});
