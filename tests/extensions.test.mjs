import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { loadDescriptor, request } from '../packages/murmur/dist/cli/client.js';
import { temporary, repository, git } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  const home = path.join(root, 'state');
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const daemon = await startDaemon(home);
  try {
    const project = await request(home, 'POST', '/v1/projects', { root: folder });
    const owner = await request(home, 'POST', '/v1/sessions', { projectId: project.id, workspaceRoot: folder, tool: 'manual', nativeId: randomUUID(), instanceId: randomUUID() });
    const task = await request(home, 'POST', '/v1/tasks', { projectId: project.id, sessionId: owner.session.id, title: 'Password reset' });
    return { root, home, folder, daemon, project, owner, task };
  } catch (error) { await daemon.close(); throw error; }
}

test('extended APIs coordinate intent, human decision acceptance, alerts and task lifecycle', async t => {
  const f = await fixture(t);
  const scoped = { token: f.owner.token };
  try {
    const declared = await request(f.home, 'POST', '/v1/intents', { taskId: f.task.id, revision: 1, produces: [{ key: 'reset-api', version: 'v1', value: '200' }] }, scoped);
    assert.equal(declared.task.revision, 2);
    const proposal = await request(f.home, 'POST', '/v1/decisions/propose', { projectId: f.project.id, key: 'reset-api', value: '202', version: 'v2', rationale: 'Asynchronous contract' }, scoped);
    await assert.rejects(request(f.home, 'POST', '/v1/decisions/accept', { decisionId: proposal.id, revision: 1, expectedAcceptedId: null }, scoped), error => error.status === 403);
    await request(f.home, 'POST', '/v1/decisions/accept', { decisionId: proposal.id, revision: 1, expectedAcceptedId: null });
    const alerts = await request(f.home, 'GET', `/v1/alerts?projectId=${f.project.id}`, undefined, scoped);
    assert(alerts.some(alert => alert.kind === 'contract_value_conflict'));
    const context = await request(f.home, 'GET', `/v1/context?projectId=${f.project.id}&taskId=${f.task.id}`, undefined, scoped);
    assert(context.briefing.includes('reset-api'));
    assert(context.briefing.length <= 6000);
    assert.equal((await request(f.home, 'GET', `/v1/workspaces?projectId=${f.project.id}`)).length, 0);
    assert.equal((await request(f.home, 'GET', `/v1/integration/jobs?projectId=${f.project.id}`)).length, 0);
    const abandoned = await request(f.home, 'POST', '/v1/tasks/update', { taskId: f.task.id, revision: 2, status: 'abandoned' }, scoped);
    await assert.rejects(request(f.home, 'POST', '/v1/reservations/acquire', { projectId: f.project.id, sessionId: f.owner.session.id, taskId: f.task.id, taskRevision: abandoned.revision, resources: [{ kind: 'path', value: 'auth' }] }, scoped), error => error.code === 'TASK_TERMINAL');
  } finally { await f.daemon.close(); }
});

test('base HTTP replay returns committed outcomes before mutable filesystem preflight', async t => {
  const f = await fixture(t);
  try {
    const body = { projectId: f.project.id, sessionId: f.owner.session.id, taskId: f.task.id, taskRevision: 1, resources: [{ kind: 'path', value: 'auth' }] };
    const key = randomUUID();
    const before = await request(f.home, 'POST', '/v1/reservations/acquire', body, { token: f.owner.token, key });
    await rename(f.folder, `${f.folder}-moved`);
    const replay = await request(f.home, 'POST', '/v1/reservations/acquire', body, { token: f.owner.token, key });
    assert.deepEqual(replay, before);
    await assert.rejects(request(f.home, 'POST', '/v1/reservations/acquire', body, { token: f.owner.token }), error => error.code === 'WORKSPACE_CHANGED');
  } finally { await f.daemon.close(); }
});

test('replacing a registered Git checkout with another repository invalidates reservations', async t => {
  const f = await fixture(t);
  try {
    await f.daemon.close();
    await rm(f.folder, { recursive: true });
    await repository(f.folder);
    const daemon = await startDaemon(f.home);
    try {
      const project = await request(f.home, 'POST', '/v1/projects', { root: f.folder });
      const owner = await request(f.home, 'POST', '/v1/sessions', { projectId: project.id, workspaceRoot: f.folder, tool: 'manual', nativeId: 'repo', instanceId: 'one' });
      const task = await request(f.home, 'POST', '/v1/tasks', { projectId: project.id, sessionId: owner.session.id, title: 'Work' });
      const worktree = path.join(f.root, 'worktree');
      git(f.folder, 'worktree', 'add', '-q', '-b', 'worker', worktree);
      const other = await request(f.home, 'POST', '/v1/sessions', { projectId: project.id, workspaceRoot: worktree, tool: 'manual', nativeId: 'other', instanceId: 'one' });
      const otherTask = await request(f.home, 'POST', '/v1/tasks', { projectId: project.id, sessionId: other.session.id, title: 'Other work' });
      await rename(worktree, `${worktree}-old`);
      await repository(worktree);
      await assert.rejects(request(f.home, 'POST', '/v1/reservations/acquire', { projectId: project.id, sessionId: other.session.id, taskId: otherTask.id, taskRevision: 1, resources: [{ kind: 'path', value: 'auth' }] }, { token: other.token }), error => error.code === 'WORKSPACE_CHANGED');
      await rename(f.folder, `${f.folder}-original`);
      await repository(f.folder);
      await assert.rejects(request(f.home, 'POST', '/v1/reservations/acquire', { projectId: project.id, sessionId: owner.session.id, taskId: task.id, taskRevision: 1, resources: [{ kind: 'path', value: 'auth' }] }, { token: owner.token }), error => error.code === 'WORKSPACE_CHANGED');
    } finally { await daemon.close(); }
  } finally { await f.daemon.close(); }
});

test('dashboard bootstrap is one-use, same-origin and separate from the service credential', async t => {
  const f = await fixture(t);
  try {
    const descriptor = await loadDescriptor(f.home);
    const origin = `http://127.0.0.1:${descriptor.port}`;
    await assert.rejects(request(f.home, 'POST', '/v1/browser/ticket', {}, { token: f.owner.token }), error => error.status === 403);
    const ticket = await request(f.home, 'POST', '/v1/browser/ticket', {});
    const code = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('bootstrap');
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    const bootstrap = await fetch(`${origin}/v1/browser/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    assert.equal(bootstrap.status, 200);
    const browser = await bootstrap.json();
    assert.notEqual(browser.token, descriptor.token);
    assert.equal((await fetch(`${origin}/v1/browser/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ code }) })).status, 401);
    assert.equal((await fetch(`${origin}/v1/status`, { headers: { Origin: origin, Authorization: `Bearer ${browser.token}` } })).status, 200);
    assert.equal((await fetch(`${origin}/v1/status`, { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${browser.token}` } })).status, 403);
    assert.equal((await fetch(`${origin}/v1/status`, { headers: { Origin: origin, Authorization: `Bearer ${descriptor.token}` } })).status, 403);
    const controller = new AbortController();
    const stream = await fetch(`${origin}/v1/stream?projectId=${f.project.id}&after=0`, { headers: { Origin: origin, Authorization: `Bearer ${browser.token}` }, signal: controller.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader();
    let output = '';
    while (!output.includes('event: update')) {
      const result = await reader.read();
      assert(!result.done);
      output += new TextDecoder().decode(result.value);
    }
    assert(output.includes('"sequence"'));
    assert(!output.includes('"payload"'));
    const created = await request(f.home, 'POST', '/v1/tasks', { projectId: f.project.id, sessionId: f.owner.session.id, title: 'Later streamed event' });
    const feed = await request(f.home, 'GET', `/v1/events?projectId=${f.project.id}`);
    const expected = feed.events.find(event => event.payload.id === created.id).sequence;
    let subsequent = '';
    let timeout;
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No subsequent SSE update')), 5000); timeout.unref(); });
    try {
      while (!subsequent.includes(`"sequence":${expected}`)) {
        const later = await Promise.race([reader.read(), deadline]);
        assert(!later.done);
        subsequent += new TextDecoder().decode(later.value);
      }
    } finally { clearTimeout(timeout); }
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally { await f.daemon.close(); }
});
