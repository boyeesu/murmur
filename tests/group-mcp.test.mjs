import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request } from '../packages/murmur/dist/cli/client.js';
import { AgentClient } from '../packages/murmur/dist/cli/agent-client.js';
import { createMurmurMcpServer } from '../packages/murmur/dist/mcp/server.js';
import { temporary, repository } from './helpers.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, CallToolResultSchema);
function value(result) { return JSON.parse(result.content[0].text); }
function successful(result) { assert.notEqual(result.isError, true, JSON.stringify(result)); return value(result); }
async function control(prepared, action, body) {
  const c = prepared.supervisor;
  const response = await fetch(`${c.origin}/v1/launch-control/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.supervisorToken}`, 'X-Murmur-State-Id': c.stateId, 'X-Murmur-Protocol-Version': '1', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ launchId: prepared.launch.id, ...body }) });
  assert.equal(response.status, 200); return response.json();
}
async function mcp(t, connection) {
  const requests = [];
  const server = createMurmurMcpServer(connection, { fetch: (url, init) => { requests.push({ url: String(url), body: init.body && JSON.parse(init.body) }); return fetch(url, init); } });
  const client = new Client({ name: 'group-linking-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, requests };
}

test('managed MCP group requests require human approval and leave without altering supervision or leases', async t => {
  const root = await temporary(t), source = await repository(path.join(root, 'source')), home = path.join(root, 'state');
  const daemon = await startDaemon(home); t.after(() => daemon.close());
  const project = await request(home, 'POST', '/v1/projects', { root: source });
  const prepare = async title => {
    const prepared = await request(home, 'POST', '/v1/launches/prepare', { projectId: project.id, tool: 'claude', title }, { timeoutMs: 60000 });
    // Simulate lifecycle assertions only. No native CLI/model is launched.
    const controllerId = randomUUID();
    const claimed = await control(prepared, 'claim', { controllerId, revision: prepared.launch.lifecycleRevision });
    const running = await control(prepared, 'started', { controllerId, revision: claimed.lifecycleRevision, pid: process.pid });
    return { prepared, controllerId, running };
  };
  const a = await prepare('API responsibility'), b = await prepare('Test responsibility');
  const ma = await mcp(t, a.prepared.agent), mb = await mcp(t, b.prepared.agent);
  const pendingA = successful(await call(ma.client, 'murmur_request_group_link', { groupTitle: 'Reset work', responsibility: 'Own API changes', handoff: { summary: 'Reviewed API plan', changedFiles: ['src/old-route.ts'], remainingWork: ['Add expiration response'], writes: ['src/reset.ts'] }, requestId: 'group-request-a' }));
  assert.equal(pendingA.state, 'pending');
  assert.equal((await request(home, 'GET', `/v1/groups?projectId=${project.id}`)).length, 0);
  const approve = async pending => {
    const review = await request(home, 'POST', '/v1/connections/review', { requestId: pending.requestId, revision: pending.revision });
    return request(home, 'POST', '/v1/connections/approve', { requestId: pending.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Explicitly approved responsibility' });
  };
  const approvedA = await approve(pendingA); assert.equal(approvedA.grant, null);
  assert.equal(approvedA.member.sessionId, a.prepared.agent.sessionId); assert.equal(approvedA.member.taskId, a.prepared.agent.taskId);
  const code = randomBytes(32).toString('base64url');
  await request(home, 'POST', '/v1/groups/invite', { groupId: approvedA.group.id, inviteHash: hash(code) });
  const pendingB = successful(await call(mb.client, 'murmur_request_group_link', { inviteCode: code, responsibility: 'Own tests', requestId: 'group-request-b' }));
  const sent = mb.requests.find(item => item.url.endsWith('/v1/groups/requests')).body;
  assert.equal(sent.inviteHash, hash(code)); assert.equal(sent.inviteCode, undefined);
  for (const key of ['sessionId', 'taskId', 'projectId']) assert.equal(sent[key], undefined);
  const approvedB = await approve(pendingB); assert.equal(approvedB.group.id, approvedA.group.id);
  const context = successful(await call(ma.client, 'murmur_get_context'));
  assert(context.tasks.some(task => task.id === b.prepared.agent.taskId));
  assert.match(context.membershipRevision, /^[a-f0-9]{64}$/);
  const blocked = successful(await call(ma.client, 'murmur_update_task', { revision: context.task.revision, status: 'blocked', blocker: 'Awaiting API review' }));
  const current = successful(await call(ma.client, 'murmur_get_context'));
  assert.equal(current.task.status, 'blocked'); assert(current.briefing.includes('Awaiting API review'));
  const lease = successful(await call(ma.client, 'murmur_reserve_resources', { taskRevision: current.task.revision, resources: [{ kind: 'path', value: 'src/reset.ts' }], ttlSeconds: 60 }));
  const forbidden = await call(ma.client, 'murmur_leave_group', { memberId: approvedB.member.id, revision: approvedB.member.revision });
  assert.equal(forbidden.isError, true);
  const left = successful(await call(ma.client, 'murmur_leave_group', { memberId: approvedA.member.id, revision: approvedA.member.revision, requestId: 'leave-own-group' }));
  assert.equal(left.state, 'left');
  assert.equal((await new AgentClient(a.prepared.agent).identity()).role, 'agent');
  const launches = await request(home, 'GET', `/v1/launches?projectId=${project.id}`);
  assert.equal(launches.find(item => item.id === a.prepared.launch.id).state, 'running');
  const status = await request(home, 'GET', `/v1/status?projectId=${project.id}`);
  assert(status.reservations.some(item => item.id === lease.id));
  assert.equal(status.tasks.find(item => item.id === a.prepared.agent.taskId).ownerSessionId, a.prepared.agent.sessionId);
  const tools = await ma.client.listTools();
  assert(!tools.tools.some(tool => /approve|accept_decision|register_session/.test(tool.name)));
});
