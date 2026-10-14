import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { temporary, mutation } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));

test('the user guide JSON examples parse and its intent example is accepted', async t => {
  const guide = await readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  assert(examples.length >= 3);
  const intent = examples.find(example => !Array.isArray(example) && example.acceptanceCriteria);
  assert(intent);
  const store = new CoordinationStore(':memory:');
  t.after(() => store.close());
  const coordination = new CoordinationService(store);
  const identity = { root:'/guide', canonicalPath:'/guide', mode:'advisory', caseSensitive:true };
  const project = store.registerProject(identity, mutation('project', identity));
  const registration = { projectId:project.id, tool:'manual', nativeId:'guide', instanceId:'example', workspaceRoot:'/guide' };
  const {session} = store.registerSession(registration, mutation('session', registration));
  const input = { projectId:project.id, sessionId:session.id, title:'Password reset endpoint', featureKey:null };
  const task = store.createTask(input, mutation('task', input));
  const declaration = { taskId:task.id, revision:task.revision, ...intent };
  const result = coordination.declareIntent(declaration, {kind:'human'}, mutation('intent', declaration));
  assert.equal(result.intent.produces[0].key, 'reset-api');
  assert.equal(result.intent.produces[0].value, '202 Accepted');
});

test('documented request IDs make base CLI registration and task retries deterministic', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'state');
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const daemon = await startDaemon(home);
  const env = { ...process.env, MURMUR_HOME: home };
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args], {env, timeout:10000})).stdout);
  try {
    const project = await run('init', '--root', folder, '--request-id', 'guide-init');
    const args = ['session', 'register', '--project', project.id, '--tool', 'manual', '--root', folder, '--native-id', 'guide-agent', '--instance', 'guide-instance', '--request-id', 'guide-owner'];
    const owner = await run(...args);
    const repeatedOwner = await run(...args);
    assert.equal(repeatedOwner.session.id, owner.session.id);
    assert(repeatedOwner.token === owner.token);
    const taskArgs = ['task', 'create', '--project', project.id, '--session', owner.session.id, '--title', 'Guide task', '--request-id', 'guide-task'];
    const task = await run(...taskArgs);
    const repeatedTask = await run(...taskArgs);
    assert.equal(repeatedTask.id, task.id);
    const changed = [...taskArgs]; changed[changed.indexOf('Guide task')] = 'A different task';
    await assert.rejects(run(...changed), error => error.stderr.includes('IDEMPOTENCY_CONFLICT'));
    const status = await run('status', '--project', project.id, '--json');
    assert.equal(status.sessions.length, 1);
    assert.equal(status.tasks.length, 1);
    const help = await execute(process.execPath, [cli, '--help'], {env, timeout:10000});
    assert(help.stdout.includes('scoped MCP and managed launches'));
    assert(help.stdout.includes('task abandonment require explicit --confirm'));
  } finally { await daemon.close(); }
});
