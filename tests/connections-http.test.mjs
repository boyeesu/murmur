import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request } from '../packages/murmur/dist/cli/client.js';
import { temporary, repository, git } from './helpers.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
async function fixture(t) {
  const root = await temporary(t), workspace = await repository(path.join(root, 'project')), home = path.join(root, 'state');
  const daemon = await startDaemon(home); t.after(() => daemon.close());
  const descriptor = JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8'));
  const project = await request(home, 'POST', '/v1/projects', { root: workspace });
  const headers = { 'Content-Type': 'application/json', 'X-Murmur-State-Id': descriptor.stateId, 'X-Murmur-Protocol-Version': '1' };
  const http = async (endpoint, { method = 'GET', body, token, key = randomUUID(), extra = {}, rawBody } = {}) => {
    const response = await fetch(`${descriptor.origin}${endpoint}`, { method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'Idempotency-Key': key } : {}), ...extra },
      ...(body === undefined && rawBody === undefined ? {} : { body: rawBody ?? JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const enroll = async (target = { groupTitle: 'Password reset' }, extra = {}) => {
    const capability = secret(), pollSecret = secret(), key = randomUUID();
    const input = { capabilityHash: hash(capability), pollSecretHash: hash(pollSecret), workspaceRoot: project.root,
      native: { tool: 'manual', nativeId: randomUUID(), incarnationId: 'http-fixture' }, responsibility: 'Implement one part', ...target, ...extra };
    const result = await http('/v1/enrollment/requests', { method: 'POST', body: input, key });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { input, capability, pollSecret, receipt: result.data, key };
  };
  const approve = async (entry, extra = {}) => {
    const review = await request(home, 'POST', '/v1/connections/review', { requestId: entry.receipt.requestId, revision: entry.receipt.revision });
    const body = { requestId: entry.receipt.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Reviewed responsibility', ...extra };
    return { review, approval: await request(home, 'POST', '/v1/connections/approve', body), body };
  };
  return { root, home, project, descriptor, headers, http, enroll, approve };
}
function noSecrets(value, ...secrets) { const json = JSON.stringify(value); for (const secret of secrets) assert(!json.includes(secret), 'private proof escaped in a response'); }

test('HTTP enrollment has a receipt-only, state-bound, non-browser preapproval surface', async t => {
  const f = await fixture(t), privateDraft = 'This draft is not approved for project sharing';
  const entry = await f.enroll({ groupTitle: 'Review required' }, { handoff: { summary: privateDraft } });
  noSecrets(entry.receipt, entry.capability, entry.pollSecret, privateDraft);
  assert.equal((await f.http('/v1/external/identity', { token: entry.capability })).status, 401);
  const poll = await f.http('/v1/enrollment/status', { method: 'POST', token: entry.pollSecret, body: { requestId: entry.receipt.requestId } });
  assert.deepEqual(poll.data, entry.receipt);
  assert.equal((await f.http('/v1/enrollment/status', { method: 'POST', token: entry.capability, body: { requestId: entry.receipt.requestId } })).status, 401);
  assert.equal((await f.http('/v1/enrollment/status', { method: 'POST', token: entry.pollSecret, body: { requestId: entry.receipt.requestId, pollSecret: entry.pollSecret } })).status, 400);
  assert.equal((await f.http('/v1/enrollment/requests', { method: 'POST', body: entry.input, extra: { Origin: f.descriptor.origin } })).status, 403);
  assert.equal((await f.http('/v1/enrollment/requests', { method: 'POST', body: entry.input, extra: { 'X-Murmur-State-Id': 'b'.repeat(64) } })).status, 409);
  assert.equal((await f.http('/v1/enrollment/requests?after=1', { method: 'POST', body: entry.input })).status, 400);
  assert.equal((await f.http('/v1/enrollment/requests', { method: 'POST', body: entry.input, token: entry.capability })).status, 403);
  const oversized = await f.http('/v1/enrollment/requests', { method: 'POST', body: { ...entry.input, responsibility: 'x'.repeat(17000) } });
  assert.equal(oversized.status, 413);
  const extra = await f.http('/v1/enrollment/requests', { method: 'POST', body: { ...entry.input, capability: entry.capability } });
  assert.equal(extra.status, 400); noSecrets(extra.data, entry.capability);
  const replay = await f.http('/v1/enrollment/requests', { method: 'POST', body: entry.input, key: entry.key });
  assert.deepEqual(replay.data, entry.receipt);
  assert.equal((await f.http('/v1/enrollment/requests', { method: 'POST', body: { ...entry.input, responsibility: 'changed' }, key: entry.key })).status, 409);
  const shared = await request(f.home, 'GET', `/v1/events?projectId=${f.project.id}`);
  noSecrets(shared, privateDraft, entry.capability, entry.pollSecret);
  const human = await request(f.home, 'GET', '/v1/connections/requests');
  assert.equal(human.find(item => item.requestId === entry.receipt.requestId).handoff.summary, privateDraft);
});

test('two approved HTTP participants share work context but never task authority or files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project.root, 'uncommitted.txt'), 'Keep my current work.\n');
  const before = { head: git(f.project.root, 'rev-parse', 'HEAD'), refs: git(f.project.root, 'for-each-ref'), status: git(f.project.root, 'status', '--porcelain=v1') };
  const a = await f.enroll({ groupTitle: 'Password reset' }, { handoff: { summary: 'PRIVATE-A-DRAFT' } });
  const first = await f.approve(a, { title: 'Build reset API', featureKey: 'reset-api', handoff: { summary: 'Reviewed API work', writes: ['src/api.ts'], produces: [{ key: 'reset.route', version: '1' }], decisions: [{ key: 'reset.route', version: '1', value: 'POST /reset', rationale: 'Proposed, not accepted' }] } });
  const code = secret();
  const invitation = await request(f.home, 'POST', '/v1/groups/invite', { groupId: first.approval.group.id, inviteHash: hash(code) });
  noSecrets(invitation, code, hash(code));
  const b = await f.enroll({ inviteHash: hash(code) });
  const second = await f.approve(b, { title: 'Test reset API', featureKey: 'reset-tests', handoff: { summary: 'Reviewed test work', writes: ['tests/reset.test.ts'], consumes: [{ key: 'reset.route', version: '1' }] } });
  assert.equal(second.review.inspection.sharedCheckout, true);
  assert.equal(second.approval.group.id, first.approval.group.id);
  assert.notEqual(first.approval.member.sessionId, second.approval.member.sessionId);
  const identity = await f.http('/v1/external/identity', { token: a.capability });
  assert.equal(identity.status, 200); assert.equal(identity.data.role, 'external');
  assert.equal(identity.data.taskId, first.approval.member.taskId);
  const contextA = await f.http('/v1/external/context', { token: a.capability });
  assert.equal(contextA.status, 200);
  assert(contextA.data.tasks.some(task => task.id === second.approval.member.taskId));
  assert.equal(contextA.data.decisions.length, 0, 'imported proposal must not become accepted authority');
  const blocked = await f.http('/v1/external/task-status', { method: 'POST', token: a.capability, body: { revision: contextA.data.task.revision, status: 'blocked', blocker: 'Waiting for interface review' } });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.data));
  const latestA = (await f.http('/v1/external/context', { token: a.capability })).data;
  assert(latestA.briefing.includes('Waiting for interface review'));
  const leaseA = await f.http('/v1/external/reserve', { method: 'POST', token: a.capability, body: { revision: latestA.task.revision, resources: [{ kind: 'path', value: 'src/api.ts' }], ttlSeconds: 30 } });
  assert.equal(leaseA.status, 200, JSON.stringify(leaseA.data));
  assert(leaseA.data.expiresAt <= identity.data.expiresAt);
  const latestB = (await f.http('/v1/external/context', { token: b.capability })).data;
  const leaseB = await f.http('/v1/external/reserve', { method: 'POST', token: b.capability, body: { revision: latestB.task.revision, resources: [{ kind: 'path', value: 'tests/reset.test.ts' }], ttlSeconds: 30 } });
  assert.equal(leaseB.status, 200);
  assert.equal((await f.http('/v1/external/task-status', { method: 'POST', token: b.capability, body: { taskId: latestA.task.id, revision: latestA.task.revision, status: 'ready' } })).status, 400);
  assert.equal((await f.http('/v1/external/release', { method: 'POST', token: b.capability, body: { leaseId: leaseA.data.id, generation: leaseA.data.generation } })).status, 403);
  for (const endpoint of ['/v1/status', `/v1/groups?projectId=${f.project.id}`, '/v1/connections/requests', `/v1/events?projectId=${f.project.id}`]) assert.equal((await f.http(endpoint, { token: a.capability })).status, 403);
  assert.equal((await f.http('/v1/external/context?after=0&after=1', { token: a.capability })).status, 400);
  assert.equal((await f.http('/v1/external/context?projectId=other', { token: a.capability })).status, 400);
  assert.equal((await f.http('/v1/external/context', { token: a.capability, extra: { Origin: f.descriptor.origin } })).status, 403);
  const leaveKey = randomUUID(), leave = await f.http('/v1/external/leave', { method: 'POST', token: a.capability, body: {}, key: leaveKey });
  assert.equal(leave.status, 200, JSON.stringify(leave.data));
  assert.equal((await f.http('/v1/external/leave', { method: 'POST', token: a.capability, body: {}, key: leaveKey })).status, 401);
  assert.equal((await f.http('/v1/external/context', { token: a.capability })).status, 401);
  const final = await request(f.home, 'GET', `/v1/status?projectId=${f.project.id}`);
  assert.equal(final.tasks.find(task => task.id === latestA.task.id).status, 'blocked');
  assert.equal(final.tasks.find(task => task.id === latestA.task.id).ownerSessionId, first.approval.member.sessionId);
  assert(!final.reservations.some(lease => lease.id === leaseA.data.id));
  assert(final.reservations.some(lease => lease.id === leaseB.data.id));
  const details = await request(f.home, 'GET', `/v1/groups/detail?groupId=${first.approval.group.id}`);
  assert(details.invitations.some(item => item.id === invitation.id && item.consumedAt !== null));
  noSecrets({ details, contextA: contextA.data, final }, a.capability, a.pollSecret, b.capability, b.pollSecret, 'PRIVATE-A-DRAFT');
  assert.deepEqual({ head: git(f.project.root, 'rev-parse', 'HEAD'), refs: git(f.project.root, 'for-each-ref'), status: git(f.project.root, 'status', '--porcelain=v1') }, before);
  assert.equal(await readFile(path.join(f.project.root, 'uncommitted.txt'), 'utf8'), 'Keep my current work.\n');
});

test('expired external HTTP credentials cannot replay a successful mutation', async t => {
  const f = await fixture(t), entry = await f.enroll();
  await f.approve(entry, { expiresInSeconds: 1 });
  const context = await f.http('/v1/external/context', { token: entry.capability });
  const body = { revision: context.data.task.revision, status: 'blocked' }, key = randomUUID();
  assert.equal((await f.http('/v1/external/task-status', { method: 'POST', token: entry.capability, body, key })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await f.http('/v1/external/task-status', { method: 'POST', token: entry.capability, body, key })).status, 401);
  assert.equal((await f.http('/v1/sessions/heartbeat', { method: 'POST', token: entry.capability, body: {} })).status, 401);
});

test('an inert request reference never logs in a browser or approves anything', async t => {
  const f = await fixture(t), entry = await f.enroll();
  const shell = await fetch(`${f.descriptor.origin}/ui/#request=${entry.receipt.requestId}`);
  assert.equal(shell.status, 200); assert(!(await shell.text()).includes(entry.receipt.requestId));
  assert.equal((await f.http('/v1/connections/requests')).status, 401);
  const bootstrap = await f.http('/v1/browser/bootstrap', { method: 'POST', body: { code: entry.receipt.requestId }, extra: { Origin: f.descriptor.origin } });
  assert.equal(bootstrap.status, 401);
  assert.equal((await f.http('/v1/enrollment/status', { method: 'POST', token: entry.pollSecret, body: { requestId: entry.receipt.requestId } })).data.state, 'pending');
});
