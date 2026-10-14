// Disposable synthetic UI fixture. Start only through the preview tool.
// The separate fixture-entry server issues a NORMAL one-use login at navigation
// time, avoiding tool latency; it never changes production authentication.
import http from 'node:http';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request } from '../packages/murmur/dist/cli/client.js';
import { repository } from '../tests/helpers.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
if (process.argv.length !== 3 && (process.argv.length !== 5 || process.argv[3] !== '--entry-port')) throw new Error('Pass a dedicated marked preview state directory and optional --entry-port PORT.');
const entryPort = process.argv[3] === '--entry-port' ? Number(process.argv[4]) : 0;
if (process.argv[3] && (!Number.isInteger(entryPort) || entryPort < 1024 || entryPort > 65535)) throw new Error('Invalid fixture entry port.');
const state = await realpath(process.argv[2]), root = path.dirname(state);
const marker = JSON.parse(await readFile(path.join(root, 'fixture-owner.json'), 'utf8'));
if (marker.kind !== 'murmur-linking-preview' || !path.basename(root).startsWith('murmur-link-preview-')) throw new Error('Refusing an unmarked preview directory.');
const daemon = await startDaemon(state), manifestPath = path.join(root, 'fixture.json');
let fixture, entry;
try {
  try { fixture = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const workspace = path.join(root, 'workspace');
    try { await lstat(workspace); throw new Error('Existing workspace has no fixture record; preserve it.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await repository(workspace);
    await writeFile(path.join(workspace, 'uncommitted-notes.txt'), 'Synthetic in-progress work; linking must preserve this file.\n');
    const project = await request(state, 'POST', '/v1/projects', { root: workspace });
    const owner = await request(state, 'POST', '/v1/sessions', { projectId: project.id, workspaceRoot: project.root, tool: 'manual', nativeId: 'preview-api-work', instanceId: marker.id });
    const task = await request(state, 'POST', '/v1/tasks', { projectId: project.id, sessionId: owner.session.id, title: 'Build password reset API', featureKey: 'reset-api' });
    const group = await request(state, 'POST', '/v1/groups/create', { projectId: project.id, title: 'Password reset', goal: 'Keep API and tests aligned without sharing task ownership.' });
    await request(state, 'POST', '/v1/groups/members/add', { groupId: group.id, sessionId: owner.session.id, taskId: task.id, responsibility: 'Own the reset endpoint and request schema', handoff: { summary: 'Implement the reset route; the test participant owns regression coverage.', writes: ['src/reset.ts'], produces: [{ key: 'reset.request', version: '1' }], blocker: 'Confirm the payload with the test participant' } });
    fixture = { kind: marker.kind, projectId: project.id, groupId: group.id, sourceTaskId: task.id, workspaceRoot: project.root };
    await writeFile(manifestPath, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
  }
  if (fixture.kind !== marker.kind) throw new Error('Unexpected fixture metadata.');
  const descriptor = JSON.parse(await readFile(path.join(state, 'connection.json'), 'utf8'));
  const scoped = async (endpoint, body, proof) => {
    const response = await fetch(`${descriptor.origin}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Murmur-State-Id': descriptor.stateId, 'X-Murmur-Protocol-Version': '1', ...(proof ? { Authorization: `Bearer ${proof}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Synthetic fixture request failed.');
    return response.json();
  };
  async function ensurePendingFixture() {
    if (fixture.requestId) {
      const current = await scoped('/v1/enrollment/status', { requestId: fixture.requestId }, fixture.pollSecret);
      if (current.state === 'pending' || current.state === 'approved') return;
    }
    const inviteCode = randomBytes(32).toString('base64url'), capability = randomBytes(32).toString('base64url'), pollSecret = randomBytes(32).toString('base64url');
    await request(state, 'POST', '/v1/groups/invite', { groupId: fixture.groupId, inviteHash: hash(inviteCode) });
    const receipt = await scoped('/v1/enrollment/requests', { inviteHash: hash(inviteCode), capabilityHash: hash(capability), pollSecretHash: hash(pollSecret), workspaceRoot: fixture.workspaceRoot,
      native: { tool: 'manual', nativeId: 'preview-test-participant', incarnationId: marker.id }, responsibility: 'Own regression coverage for password reset',
      handoff: { summary: 'Synthetic connector request, not a real native chat. Review the test responsibility before sharing.', changedFiles: ['tests/fixtures/reset.json'], writes: ['tests/reset.test.ts'], consumes: [{ key: 'reset.request', version: '1' }], remainingWork: ['Test expiration responses'], acceptanceCriteria: ['Cover successful reset and expired-token rejection'], blocker: 'Waiting for the API request shape' } });
    fixture = { ...fixture, requestId: receipt.requestId, capability, pollSecret };
    await writeFile(manifestPath, JSON.stringify(fixture), { mode: 0o600 });
  }
  await ensurePendingFixture();
  const entryKey = randomBytes(24).toString('base64url');
  entry = http.createServer((incoming, outgoing) => {
    void (async () => {
      // An explicitly configured fixture entry port survives preview auto-reloads:
      // redirect its loopback root through the NORMAL disposable login flow.
      // Never change the production daemon's exact Host/Origin checks.
      const rootEntry = entryPort && incoming.url === '/' && [ `localhost:${entryPort}`, `127.0.0.1:${entryPort}` ].includes(incoming.headers.host);
      if (incoming.method !== 'GET' || incoming.headers.origin || (!rootEntry && incoming.url !== `/enter/${entryKey}`)) { outgoing.writeHead(404); outgoing.end(); return; }
      await ensurePendingFixture();
      const ticket = await request(state, 'POST', '/v1/browser/ticket', {});
      const url = new URL(ticket.url); url.searchParams.set('preview', randomUUID());
      outgoing.writeHead(302, { Location: url.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); outgoing.end();
    })().catch(() => { outgoing.writeHead(500); outgoing.end('Disposable fixture entry failed.'); });
  });
  await new Promise((resolve, reject) => { entry.once('error', reject); entry.listen(entryPort, '127.0.0.1', resolve); });
  console.log(`Murmur linking preview listening on http://127.0.0.1:${daemon.port}`);
  console.log(`Disposable fixture entry: http://127.0.0.1:${entry.address().port}/enter/${entryKey}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (stopping) return; stopping = true; entry.closeAllConnections(); entry.close();
    void daemon.close().catch(() => { process.exitCode = 1; });
  });
} catch {
  entry?.closeAllConnections(); entry?.close(); await daemon.close();
  console.error('Linking preview fixture could not finish; marked disposable data was retained.'); process.exitCode = 1;
}
