import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { loadDescriptor, request } from '../packages/murmur/dist/cli/client.js';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const code = expected => error => error.code === expected;

async function project(home, root) {
  await mkdir(root, { recursive: true });
  return request(home, 'POST', '/v1/projects', { root });
}
async function actor(home, project, tool = 'manual') {
  return request(home, 'POST', '/v1/sessions', { projectId: project.id, workspaceRoot: project.root, tool, nativeId: randomUUID(), instanceId: randomUUID() });
}
async function launch(home) {
  const child = spawn(process.execPath, [cli, 'daemon', 'start'], { env: { ...process.env, MURMUR_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error(`Daemon startup timeout: ${errors}`)), 10000);
      child.stderr.on('data', chunk => { errors += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('"running":true')) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Daemon exited (${code}): ${errors}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    return child;
  } catch (error) { await kill(child); throw error; }
}
async function kill(child, signal = 'SIGKILL') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(signal); });
}

test('five scoped clients coordinate atomically over authenticated HTTP', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'state');
  let daemon = await startDaemon(home);
  try {
    const repo = await project(home, path.join(root, 'project'));
    const actors = await Promise.all(['claude', 'codex', 'cursor', 'opencode', 'manual'].map(tool => actor(home, repo, tool)));
    const tasks = await Promise.all(actors.map((owner, index) => request(home, 'POST', '/v1/tasks', { projectId: repo.id, sessionId: owner.session.id, title: `Task ${index}`, featureKey: `feature-${index}` }, { token: owner.token })));
    const results = await Promise.allSettled(actors.map((owner, index) => request(home, 'POST', '/v1/reservations/acquire', { projectId: repo.id, sessionId: owner.session.id, taskId: tasks[index].id, taskRevision: 1, resources: [{ kind: 'path', value: 'src/auth' }], ttlSeconds: 60 }, { token: owner.token })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'RESERVATION_CONFLICT').length, 4);
    const state = await request(home, 'GET', '/v1/status');
    assert.equal(state.sessions.length, 5);
    assert.equal(state.tasks.length, 5);
    assert.equal(state.reservations.length, 1);

    await assert.rejects(request(home, 'POST', '/v1/tasks', { projectId: repo.id, sessionId: actors[1].session.id, title: 'Impersonation' }, { token: actors[0].token }), code('FORBIDDEN'));
    await assert.rejects(request(home, 'POST', '/v1/projects', { root: repo.root }, { token: actors[0].token }), code('FORBIDDEN'));
    const other = await project(home, path.join(root, 'unrelated'));
    await assert.rejects(request(home, 'GET', `/v1/status?projectId=${other.id}`, undefined, { token: actors[0].token }), code('FORBIDDEN'));
    const limited = await request(home, 'GET', '/v1/status', undefined, { token: actors[0].token });
    assert.equal(limited.projects.length, 1);
    assert.equal(limited.projects[0].id, repo.id);
    await assert.rejects(request(home, 'POST', '/v1/sessions', { projectId: repo.id, workspaceRoot: other.root, tool: 'manual', nativeId: 'bad-root', instanceId: 'bad-instance' }), code('PROJECT_MISMATCH'));

    const key = randomUUID();
    const heartbeat = { sessionId: actors[0].session.id, revision: 1 };
    const first = await request(home, 'POST', '/v1/sessions/heartbeat', heartbeat, { token: actors[0].token, key });
    const repeat = await request(home, 'POST', '/v1/sessions/heartbeat', heartbeat, { token: actors[0].token, key });
    assert.deepEqual(first, repeat);
    await assert.rejects(request(home, 'POST', '/v1/sessions/heartbeat', heartbeat, { token: actors[0].token }), code('STALE_REVISION'));
    await assert.rejects(request(home, 'POST', '/v1/sessions/heartbeat', { ...heartbeat, revision: 2 }, { token: actors[0].token, key }), code('IDEMPOTENCY_CONFLICT'));
    const events = await request(home, 'GET', `/v1/events?projectId=${repo.id}`);
    assert.equal(new Set(events.events.map(event => event.sequence)).size, events.events.length);
    assert.equal((await request(home, 'GET', `/v1/events?projectId=${repo.id}&after=${events.nextCursor}`)).events.length, 0);

    // A different process cannot bind the same state to another coordinator.
    await assert.rejects(execute(process.execPath, [cli, 'daemon', 'start'], { env: { ...process.env, MURMUR_HOME: home }, timeout: 10000 }), error => error.stderr.includes('DAEMON_BIND_FAILED'));
    const oldDescriptor = await loadDescriptor(home);
    await daemon.close();
    daemon = await startDaemon(home);
    const newDescriptor = await loadDescriptor(home);
    assert.notEqual(newDescriptor.token, oldDescriptor.token);
    assert.equal(newDescriptor.port, oldDescriptor.port);
    const persisted = await request(home, 'GET', '/v1/status', undefined, { token: actors[0].token });
    assert.equal(persisted.tasks.length, 5);
    assert.equal(persisted.reservations.length, 1);
    assert.deepEqual(await request(home, 'POST', '/v1/sessions/heartbeat', heartbeat, { token: actors[0].token, key }), repeat);
  } finally { await daemon.close(); }
});

test('HTTP rejects missing credentials, browser origins, wrong hosts and malformed inputs', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'state');
  const daemon = await startDaemon(home);
  try {
    const descriptor = await loadDescriptor(home);
    const url = `http://127.0.0.1:${descriptor.port}`;
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${descriptor.token}`, Origin: 'https://untrusted.example' } })).status, 403);
    const headers = { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
    const malformed = await fetch(`${url}/v1/projects`, { method: 'POST', headers, body: '{bad' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
    const missingKey = await fetch(`${url}/v1/projects`, { method: 'POST', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missingKey.status, 400);
    const unsupported = await fetch(`${url}/v1/projects`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(unsupported.status, 415);
    const { request: rawRequest } = await import('node:http');
    const wrongHost = await new Promise((resolve, reject) => {
      const request = rawRequest(`${url}/health`, { headers: { Host: 'evil.example', Authorization: headers.Authorization } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await stat(home)).mode & 0o077, 0);
    assert.equal((await stat(path.join(home, 'daemon.json'))).mode & 0o077, 0);
    assert.equal((await stat(path.join(home, 'state.sqlite'))).mode & 0o077, 0);
  } finally { await daemon.close(); }
});

test('unsafe shared state directories are refused rather than silently changed', async t => {
  const root = await temporary(t);
  const state = path.join(root, 'public-state');
  await mkdir(state, { mode: 0o755 }); await chmod(state, 0o755);
  await assert.rejects(startDaemon(state), code('INSECURE_STATE'));
  assert.equal((await stat(state)).mode & 0o777, 0o755);
});

test('real CLI crash/restart preserves state and releases the process-owned lock', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  let child;
  try {
    child = await launch(home);
    const env = { ...process.env, MURMUR_HOME: home };
    const init = await execute(process.execPath, [cli, 'init', '--root', workspace], { env, timeout: 10000 });
    const registered = JSON.parse(init.stdout);
    assert.equal(registered.mode, 'advisory');
    const originalDescriptor = JSON.parse(await readFile(path.join(home, 'daemon.json'), 'utf8'));
    await kill(child);
    child = await launch(home);
    const status = await execute(process.execPath, [cli, 'status', '--json'], { env, timeout: 10000 });
    assert.equal(JSON.parse(status.stdout).projects[0].id, registered.id);
    const current = JSON.parse(await readFile(path.join(home, 'daemon.json'), 'utf8'));
    assert.notEqual(current.instanceId, originalDescriptor.instanceId);
    const doctor = await execute(process.execPath, [cli, 'doctor', '--json'], { env, timeout: 10000 });
    const diagnosis = JSON.parse(doctor.stdout);
    assert.equal(diagnosis.daemon.status, 'connected');
    assert(diagnosis.adapters.every(adapter => !adapter.verified && !adapter.connected));
    await execute(process.execPath, [cli, 'daemon', 'stop'], { env, timeout: 10000 });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Daemon did not stop')), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await assert.rejects(loadDescriptor(home), code('DAEMON_UNAVAILABLE'));
  } finally { await kill(child); }
});
