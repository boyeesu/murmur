import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { mutation, temporary } from './helpers.mjs';

const human = { kind: 'human' };
const caller = principal => principal.kind === 'human' ? 'human' : `session:${principal.sessionId}`;
function fixture(t, caseSensitive = true) {
  const store = new CoordinationStore(':memory:', () => 10_000);
  t.after(() => store.close());
  const service = new CoordinationService(store);
  const call = (method, input, principal = human, key = randomUUID()) => service[method](input, principal, mutation(method, input, key, caller(principal)));
  const project = (label = randomUUID()) => store.registerProject({ root: `/virtual/${label}`, canonicalPath: `/virtual/${label}`, mode: 'advisory', caseSensitive }, mutation('project.register', { label }));
  const session = projectId => store.registerSession({ projectId, tool: 'manual', nativeId: randomUUID(), instanceId: randomUUID(), workspaceRoot: '/virtual/work' }, mutation('session.register', { projectId }));
  const p = project(), a = session(p.id), b = session(p.id), c = session(p.id);
  const principal = registration => ({ kind: 'session', projectId: registration.session.projectId, sessionId: registration.session.id });
  const task = (title, owner = a, featureKey = null) => store.createTask({ projectId: owner.session.projectId, sessionId: owner.session.id, title, featureKey }, mutation('task.create', { title, featureKey }));
  const declare = (item, declaration = {}, owner = a) => call('declareIntent', { taskId: item.id, revision: store.task(item.id).revision, acceptanceCriteria: ['Observable behavior is verified.'], reads: [], writes: [], produces: [], consumes: [], dependencies: [], ...declaration }, principal(owner));
  const propose = (key, version, value, extra = {}) => call('proposeDecision', { projectId: p.id, key, version, value, rationale: 'Explicit project agreement.', ...extra });
  const accept = (decision, expectedAcceptedId = null) => call('acceptDecision', { decisionId: decision.id, revision: decision.revision, expectedAcceptedId });
  return { store, service, call, project, session, principal, p, a, b, c, task, declare, propose, accept };
}
const contract = (key, version = '1', value) => ({ key, version, ...(value === undefined ? {} : { value }) });

test('coordination schema persists independently of base schema and rejects unknown versions', async t => {
  const root = await temporary(t), filename = path.join(root, 'coordination.sqlite');
  const first = new CoordinationStore(filename);
  new CoordinationService(first);
  assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, 4);
  first.close();
  const reopened = new CoordinationStore(filename);
  t.after(() => reopened.close());
  new CoordinationService(reopened);
  reopened.db.exec('UPDATE murmur_coordination_schema SET version = 2');
  assert.throws(() => new CoordinationService(reopened), { code: 'SCHEMA_TOO_NEW' });
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 4);
  reopened.db.exec('UPDATE murmur_coordination_schema SET version = 1');
  new CoordinationService(reopened);
});

test('different objectives and disjoint files still identify duplicate contract producers', t => {
  const f = fixture(t), left = f.task('Implement request middleware'), right = f.task('Ship credentials gateway', f.b);
  f.declare(left, { writes: ['server/middleware.ts'], produces: [contract('auth.session')] });
  f.declare(right, { writes: ['gateway/login.ts'], produces: [contract('auth.session')] }, f.b);
  const alerts = f.service.getAlerts(f.p.id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'duplicate_contract_producers');
  assert.deepEqual(new Set(alerts[0].taskIds), new Set([left.id, right.id]));
  assert.equal(alerts[0].evidence.contractKey, 'auth.session');
  assert.ok(alerts[0].evidence.subjects.every(item => item.intentRevision === 1 && item.taskRevision === 2));
  const before = f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const result = f.service.checkPlan(f.p.id, { title: 'Authenticate browser calls', writes: ['ui/auth.ts'], produces: [contract('auth.session')] });
  assert.equal(result.advisory, true);
  assert.equal(result.alerts.filter(alert => alert.kind === 'duplicate_contract_producers').length, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, before, 'checkPlan is read-only');
  assert.deepEqual(f.service.checkPlan(f.p.id, { taskId: left.id }).alerts, alerts);
});

test('independent work is not called duplicate; overlap and title similarity remain advisory', t => {
  const f = fixture(t), left = f.task('Implement account response'), right = f.task('Implement billing response', f.b);
  f.declare(left, { writes: ['accounts'], produces: [contract('account.read')] });
  f.declare(right, { writes: ['billing'], produces: [contract('billing.read')] }, f.b);
  assert.deepEqual(f.service.getAlerts(f.p.id), []);
  assert.deepEqual(f.service.checkPlan(f.p.id, { title: 'Implement account response', writes: ['unrelated'] }).alerts, []);
  const overlap = f.service.checkPlan(f.p.id, { title: 'Add telemetry', writes: ['accounts/metrics.ts'] }).alerts;
  assert.deepEqual(overlap.map(alert => alert.kind), ['overlapping_writes']);
  assert.match(overlap[0].message, /not evidence of duplicate/);
  const similar = f.service.checkPlan(f.p.id, { title: 'Build account response', writes: ['accounts/result.ts'] }).alerts;
  assert.ok(similar.some(alert => alert.kind === 'similar_title_scope' && alert.evidence.confidence === 'low'));
  assert.ok(!similar.some(alert => alert.kind === 'duplicate_contract_producers'));
  assert.deepEqual(f.service.checkPlan(f.p.id, { title: 'Add telemetry', writes: ['accounts-old'] }).alerts, [], 'prefixes must end at a path boundary');
});

test('intent paths normalize lexically, reject escapes and do not inspect the filesystem', t => {
  const f = fixture(t, false), item = f.task('Normalize logical scope');
  const result = f.declare(item, { reads: ['./API//Read.ts', 'api/read.ts'], writes: ['src/new/../File.ts'] });
  assert.deepEqual(result.intent.reads, ['api/read.ts']);
  assert.deepEqual(result.intent.writes, ['src/file.ts']);
  assert.equal(result.intent.objective, item.title);
  assert.equal(result.task.revision, 2);
  for (const unsafe of ['../secret', 'a/../../secret', '/absolute', 'C:/outside', 'a\\b', 'src/**']) {
    assert.throws(() => f.declare(item, { writes: [unsafe] }), { code: 'PATH_ESCAPE' });
  }
  assert.equal(f.store.task(item.id).revision, 2);
});

test('proposals are not authority; accepted decisions reveal stale versions and contradictions', t => {
  const f = fixture(t), item = f.task('Consume login policy');
  f.declare(item, { consumes: [contract('auth.policy', 'v1', 'cookies')] });
  const proposed = f.propose('auth.policy', 'v2', 'bearer');
  assert.equal(proposed.status, 'proposed');
  assert.deepEqual(f.service.getAlerts(f.p.id), []);
  assert.deepEqual(f.service.context(f.p.id, item.id).decisions, []);
  const accepted = f.accept(proposed);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.revision, 2);
  const alerts = f.service.getAlerts(f.p.id);
  assert.deepEqual(new Set(alerts.map(alert => alert.kind)), new Set(['contract_value_conflict', 'stale_consumed_version']));
  for (const alert of alerts) assert.equal(alert.evidence.decision.decisionRevision, 2);
  const secondProposal = f.propose('auth.policy', 'v3', 'cookies');
  assert.deepEqual(f.service.getAlerts(f.p.id), alerts, 'unaccepted alternatives never change authority');
  f.accept(secondProposal, accepted.id);
  assert.notDeepEqual(f.service.getAlerts(f.p.id).map(alert => alert.id), alerts.map(alert => alert.id));
});

test('explicit contradictory values are detected across producer and consumer declarations', t => {
  const f = fixture(t), producer = f.task('Provide account policy'), consumer = f.task('Render account state', f.b);
  f.declare(producer, { produces: [contract('account.state', '2', 'enabled')] });
  f.declare(consumer, { consumes: [contract('account.state', '2', 'disabled')] }, f.b);
  const alerts = f.service.getAlerts(f.p.id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'contract_value_conflict');
  assert.deepEqual(new Set(alerts[0].evidence.declarations.map(item => item.role)), new Set(['produces', 'consumes']));
});

test('accepted-decision compare-and-swap is human-only and leaves one accepted value', t => {
  const f = fixture(t), first = f.propose('api.shape', '1', 'flat'), second = f.propose('api.shape', '2', 'nested');
  const acceptInput = { decisionId: first.id, revision: 1, expectedAcceptedId: null };
  assert.throws(() => f.call('acceptDecision', acceptInput, f.principal(f.a)), { code: 'FORBIDDEN' });
  const key = randomUUID(), accepted = f.call('acceptDecision', acceptInput, human, key);
  assert.deepEqual(f.call('acceptDecision', acceptInput, human, key), accepted, 'successful acceptance replays without stale CAS preflight');
  assert.throws(() => f.accept(second), { code: 'ACCEPTED_DECISION_CONFLICT' });
  assert.equal(f.service.listDecisions(f.p.id).find(item => item.id === second.id).revision, 1);
  const replacement = f.accept(second, first.id);
  const records = f.service.listDecisions(f.p.id);
  assert.equal(records.filter(item => item.status === 'accepted').length, 1);
  assert.equal(replacement.id, second.id);
  assert.equal(records.find(item => item.id === first.id).status, 'superseded');
  assert.equal(records.find(item => item.id === first.id).revision, 3);
  assert.equal(records.find(item => item.id === first.id).supersededBy, second.id);
  assert.throws(() => f.call('acceptDecision', { decisionId: second.id, revision: 1, expectedAcceptedId: first.id }), { code: 'STALE_REVISION' });
});

test('task lifecycle enforces ownership, revision fencing, terminality and feature release', t => {
  const f = fixture(t), item = f.task('Own account migration', f.a, 'account.migration');
  const p = f.principal(f.a);
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 1, status: 'ready' }, f.principal(f.b)), { code: 'FORBIDDEN' });
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 1, status: 'integrated' }, p), { code: 'INVALID_INPUT' });
  const blocked = f.call('updateTask', { taskId: item.id, revision: 1, status: 'blocked' }, p);
  assert.equal(blocked.revision, 2);
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 1, title: 'Stale rename' }, p), { code: 'STALE_REVISION' });
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 2, status: 'ready' }, p), { code: 'INVALID_TASK_STATE' });
  const lease = f.store.acquire({ projectId: f.p.id, sessionId: f.a.session.id, taskId: item.id, taskRevision: 2, resources: [{ kind: 'path', value: 'accounts' }], ttlSeconds: 60 }, mutation('reservation.acquire', {}));
  f.call('updateTask', { taskId: item.id, revision: 2, status: 'abandoned' }, p);
  assert.equal(f.store.lease(lease.id).releasedAt, 10_000);
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 3, status: 'active' }, p), { code: 'INVALID_TASK_STATE' });
  assert.throws(() => f.declare(item, {}), { code: 'INVALID_TASK_STATE' });
  const replacement = f.task('Continue account migration', f.b, 'account.migration');
  assert.notEqual(replacement.id, item.id);
  assert.equal(f.store.acquire({ projectId: f.p.id, sessionId: f.b.session.id, taskId: replacement.id, taskRevision: 1, resources: [{ kind: 'path', value: 'accounts' }], ttlSeconds: 60 }, mutation('reservation.acquire', {})).releasedAt, null);
});

test('handoff releases leases, resets readiness and revokes former-owner replay access', t => {
  const f = fixture(t), item = f.task('Produce account endpoint');
  const update = { taskId: item.id, revision: 1, title: 'Produce account endpoint v2' }, key = randomUUID();
  f.call('updateTask', update, f.principal(f.a), key);
  const lease = f.store.acquire({ projectId: f.p.id, sessionId: f.a.session.id, taskId: item.id, taskRevision: 2, resources: [{ kind: 'path', value: 'api/accounts' }], ttlSeconds: 60 }, mutation('reservation.acquire', {}));
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 2, handoffSessionId: f.b.session.id }, f.principal(f.a)), { code: 'FORBIDDEN' });
  const ready = f.call('updateTask', { taskId: item.id, revision: 2, status: 'ready' });
  const handed = f.call('updateTask', { taskId: item.id, revision: ready.revision, handoffSessionId: f.b.session.id });
  assert.equal(handed.ownerSessionId, f.b.session.id);
  assert.equal(handed.status, 'planned');
  assert.equal(f.store.lease(lease.id).releasedAt, 10_000);
  assert.throws(() => f.call('updateTask', update, f.principal(f.a), key), { code: 'FORBIDDEN' });
  assert.throws(() => f.declare(item, {}), { code: 'FORBIDDEN' });
  const activated = f.call('updateTask', { taskId: item.id, revision: handed.revision, status: 'active' }, f.principal(f.b));
  assert.equal(activated.status, 'active');
});

test('dependency graph rejects transitive cycles atomically', t => {
  const f = fixture(t), one = f.task('One'), two = f.task('Two'), three = f.task('Three');
  f.declare(one, { dependencies: [two.id] });
  f.declare(two, { dependencies: [three.id] });
  assert.throws(() => f.declare(three, { dependencies: [one.id] }), { code: 'DEPENDENCY_CYCLE' });
  assert.equal(f.store.task(three.id).revision, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordination_intents WHERE taskId = ?').get(three.id).n, 0);
  assert.throws(() => f.declare(three, { dependencies: [three.id] }), { code: 'DEPENDENCY_CYCLE' });
  f.declare(one, { dependencies: [] });
  assert.equal(f.declare(three, { dependencies: [one.id] }).task.revision, 2);
});

test('cross-project references, callers and cached-response probes are rejected', t => {
  const f = fixture(t), otherProject = f.project(), outsider = f.session(otherProject.id), outsideTask = f.task('Outside', outsider), item = f.task('Inside');
  assert.throws(() => f.declare(item, { dependencies: [outsideTask.id] }), { code: 'FORBIDDEN' });
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 1, handoffSessionId: outsider.session.id }), { code: 'FORBIDDEN' });
  assert.throws(() => f.call('proposeDecision', { projectId: f.p.id, key: 'account', version: '1', value: 'yes', rationale: 'test', taskId: outsideTask.id }), { code: 'FORBIDDEN' });
  assert.throws(() => f.service.checkPlan(f.p.id, { taskId: outsideTask.id }), { code: 'FORBIDDEN' });
  assert.throws(() => f.service.context(f.p.id, outsideTask.id), { code: 'FORBIDDEN' });
  const input = { taskId: item.id, revision: 1, title: 'Safe title' }, key = randomUUID();
  f.call('updateTask', input, f.principal(f.a), key);
  assert.throws(() => f.service.updateTask(input, f.principal(outsider), mutation('anything', input, key, caller(f.principal(f.a)))), { code: 'FORBIDDEN' });
  assert.throws(() => f.service.updateTask({ ...input, revision: 2 }, f.principal(f.a), mutation('anything', input, key, 'human')), { code: 'FORBIDDEN' });
  const forgedPrincipal = { kind: 'session', sessionId: outsider.session.id, projectId: f.p.id };
  assert.throws(() => f.call('proposeDecision', { projectId: f.p.id, key: 'account', version: '1', value: 'yes', rationale: 'test' }, forgedPrincipal), { code: 'FORBIDDEN' });
});

test('dismissals are exact revision-scoped, authorized and stable across unchanged reads', t => {
  const f = fixture(t), left = f.task('One producer'), right = f.task('Another producer', f.b);
  f.declare(left, { produces: [contract('account.result')] });
  f.declare(right, { produces: [contract('account.result')] }, f.b);
  const original = f.service.getAlerts(f.p.id)[0];
  assert.deepEqual(f.service.getAlerts(f.p.id), [original]);
  const input = { projectId: f.p.id, alertId: original.id }, key = randomUUID();
  assert.throws(() => f.call('dismissAlert', input, f.principal(f.c)), { code: 'FORBIDDEN' });
  const dismissed = f.call('dismissAlert', input, f.principal(f.a), key);
  assert.equal(dismissed.dismissed, true);
  assert.deepEqual(f.service.getAlerts(f.p.id), []);
  assert.deepEqual(f.call('dismissAlert', input, f.principal(f.a), key), dismissed);
  f.declare(right, { produces: [contract('account.result', '2')] }, f.b);
  const next = f.service.getAlerts(f.p.id)[0];
  assert.notEqual(next.id, original.id);
  assert.throws(() => f.call('dismissAlert', input), { code: 'STALE_ALERT' });
  assert.deepEqual(f.call('dismissAlert', input, f.principal(f.a), key), dismissed, 'historical replay is not a new dismissal');
  f.call('updateTask', { taskId: left.id, revision: 2, handoffSessionId: f.c.session.id });
  assert.throws(() => f.call('dismissAlert', input, f.principal(f.a), key), { code: 'FORBIDDEN' });
});

test('a new accepted decision revision reopens previously dismissed stale-consumer alerts', t => {
  const f = fixture(t), item = f.task('Read contract');
  f.declare(item, { consumes: [contract('contract.read', '1')] });
  const first = f.accept(f.propose('contract.read', '2', 'stable'));
  const alert = f.service.getAlerts(f.p.id)[0];
  f.call('dismissAlert', { projectId: f.p.id, alertId: alert.id });
  assert.deepEqual(f.service.getAlerts(f.p.id), []);
  f.accept(f.propose('contract.read', '3', 'stable'), first.id);
  assert.notEqual(f.service.getAlerts(f.p.id)[0].id, alert.id);
});

test('payload limits and unknown fields fail before mutating or replaying', t => {
  const f = fixture(t), item = f.task('Bounded input');
  assert.throws(() => f.declare(item, { writes: Array(65).fill('src') }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.declare(item, { acceptanceCriteria: ['x'.repeat(513)] }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.declare(item, { produces: [contract('same'), contract('same', '2')] }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.declare(item, { produces: [contract('invalid key')] }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.call('updateTask', { taskId: item.id, revision: 1, status: 'ready', unexpected: true }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.propose('valid', '1', 'x'.repeat(2049)), { code: 'INVALID_INPUT' });
  assert.throws(() => f.declare(item, { produces: Array.from({ length: 32 }, (_, i) => contract(`p.${i}`, '1', '漢'.repeat(2048))) }), { code: 'INVALID_INPUT' });
  assert.equal(f.store.task(item.id).revision, 1);
  assert.throws(() => f.service.context(f.p.id, undefined, -1), { code: 'INVALID_INPUT' });
});

test('service binds idempotency to validated method input, not caller-provided metadata', t => {
  const f = fixture(t), item = f.task('Original title'), key = randomUUID();
  const input = { taskId: item.id, revision: 1, title: 'First title' };
  const meta = mutation('misleading-operation', { unrelated: true }, key, caller(f.principal(f.a)));
  const result = f.service.updateTask(input, f.principal(f.a), meta);
  assert.deepEqual(f.service.updateTask(input, f.principal(f.a), meta), result);
  assert.throws(() => f.service.updateTask({ ...input, title: 'Second title' }, f.principal(f.a), meta), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.store.task(item.id).title, 'First title');
});

test('context is bounded, safe, scoped and advances only through returned event metadata', t => {
  const f = fixture(t);
  let focus;
  for (let i = 0; i < 55; i++) {
    const item = f.task(`Task ${i} ${'objective '.repeat(40)}`);
    f.declare(item, { writes: [`area-${i}`], acceptanceCriteria: Array.from({ length: 10 }, (_, n) => `Criterion ${n}`) });
    if (i === 54) focus = item;
  }
  for (let i = 0; i < 35; i++) f.accept(f.propose(`policy.${i}`, '1', `choice-${i}`));
  const first = f.service.context(f.p.id, focus.id, 0);
  assert.equal(first.task.id, focus.id);
  assert.equal(first.tasks[0].id, focus.id);
  assert.equal(first.tasks.length, 24);
  assert.equal(first.decisions.length, 32);
  assert.equal(first.events.length, 100);
  assert.ok(first.briefing.length <= 6000);
  assert.match(first.briefing, /Accepted decisions/);
  assert.match(first.briefing, /Accepted "policy\./);
  assert.match(first.briefing, /Alerts/);
  for (const field of ['tasks', 'taskDetails', 'decisions', 'events', 'briefing']) assert.equal(first.truncated[field], true);
  assert.equal(first.nextCursor, first.events.at(-1).sequence);
  assert.equal(first.delivery.meaning, 'generated_context_event_metadata_only');
  assert.equal(first.delivery.eventCount, 100);
  const stored = f.store.db.prepare('SELECT * FROM coordination_context_deliveries WHERE id = ?').get(first.delivery.id);
  assert.equal(stored.nextCursor, first.nextCursor);
  assert.equal(stored.eventCount, first.events.length);
  assert.deepEqual(JSON.parse(stored.taskRevisions).map(item => item.id), first.tasks.map(item => item.id));
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes(f.a.token));
  assert.ok(!serialized.includes('tokenHash'));
  assert.ok(!serialized.includes('workspaceRoot'));
  assert.ok(first.events.every(event => !('payload' in event)), 'arbitrary event payloads and transcript content are excluded');
  const second = f.service.context(f.p.id, focus.id, first.nextCursor);
  assert.ok(second.events.every(event => event.sequence > first.nextCursor));
  assert.equal(new Set([...first.events, ...second.events].map(event => event.sequence)).size, first.events.length + second.events.length);
  const third = f.service.context(f.p.id, focus.id, second.nextCursor);
  assert.equal(third.nextCursor, second.nextCursor);
  assert.equal(third.events.length, 0);
  const empty = f.project();
  assert.equal(f.service.context(empty.id).tasks.length, 0);
});

test('failed task events roll back handoff, released leases and idempotency together', t => {
  const f = fixture(t), item = f.task('Atomic handoff');
  const lease = f.store.acquire({ projectId: f.p.id, sessionId: f.a.session.id, taskId: item.id, taskRevision: 1, resources: [{ kind: 'path', value: 'atomic' }], ttlSeconds: 60 }, mutation('reservation.acquire', {}));
  const input = { taskId: item.id, revision: 1, handoffSessionId: f.b.session.id }, key = randomUUID();
  const event = f.store.event;
  f.store.event = function (projectId, type, payload) {
    if (type === 'task.handed_off') throw new Error('Injected event failure');
    return event.call(this, projectId, type, payload);
  };
  assert.throws(() => f.call('updateTask', input, human, key), /Injected event failure/);
  f.store.event = event;
  assert.equal(f.store.task(item.id).ownerSessionId, f.a.session.id);
  assert.equal(f.store.task(item.id).revision, 1);
  assert.equal(f.store.lease(lease.id).releasedAt, null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM mutations WHERE caller = ? AND key = ?').get('human', key).n, 0);
  assert.equal(f.call('updateTask', input, human, key).ownerSessionId, f.b.session.id);
});

test('incomplete or unversioned extension tables fail closed without changing the base version', t => {
  const incomplete = new CoordinationStore(':memory:');
  const unversioned = new CoordinationStore(':memory:');
  t.after(() => { incomplete.close(); unversioned.close(); });
  new CoordinationService(incomplete);
  incomplete.db.exec('DROP TABLE coordination_context_deliveries');
  assert.throws(() => new CoordinationService(incomplete), { code: 'INVALID_SCHEMA' });
  unversioned.db.exec('CREATE TABLE coordination_intents (placeholder TEXT)');
  assert.throws(() => new CoordinationService(unversioned), { code: 'INVALID_SCHEMA' });
  assert.equal(unversioned.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(unversioned.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'murmur_coordination_schema'").get().n, 0);
});

test('contradictory produced and consumed values on one task are still explicit evidence', t => {
  const f = fixture(t), item = f.task('Transform account state');
  f.declare(item, { produces: [contract('account.state', '1', 'enabled')], consumes: [contract('account.state', '1', 'disabled')] });
  const alert = f.service.getAlerts(f.p.id)[0];
  assert.equal(alert.kind, 'contract_value_conflict');
  assert.deepEqual(alert.taskIds, [item.id]);
  f.declare(item, { produces: [contract('account.state', '2', 'enabled')], consumes: [contract('account.state', '1', 'disabled')] });
  assert.deepEqual(f.service.getAlerts(f.p.id), [], 'distinct versions may describe an intentional transformation');
});

test('context bounds alerts without silently changing the complete alert feed', t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) f.declare(f.task(`Producer ${i}`), { produces: [contract('shared.contract')] });
  assert.equal(f.service.getAlerts(f.p.id).length, 36);
  const context = f.service.context(f.p.id);
  assert.equal(context.alerts.length, 24);
  assert.equal(context.truncated.alerts, true);
  assert.ok(context.briefing.length <= 6000);
  assert.match(context.briefing, /duplicate_contract_producers/);
  assert.equal(f.service.getAlerts(f.p.id).length, 36);
});
