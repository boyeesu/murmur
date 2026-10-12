import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { canonicalJson } from '../packages/murmur/dist/protocol/index.js';
import { discoverProject, normalizeResources, resourcesOverlap } from '../packages/murmur/dist/workspaces/identity.js';
import { adapterDiagnostics } from '../packages/murmur/dist/adapters/capabilities.js';
import { temporary, mutation, repository, git } from './helpers.mjs';

function setup(t) {
  let now = 100000;
  const store = new CoordinationStore(':memory:', () => now);
  t.after(() => store.close());
  const identity = { root: '/fixture', canonicalPath: '/fixture', mode: 'advisory', caseSensitive: true };
  const project = store.registerProject(identity, mutation('project', identity));
  const actors = Array.from({ length: 5 }, (_, index) => {
    const input = { projectId: project.id, tool: ['claude', 'codex', 'cursor', 'opencode', 'manual'][index], nativeId: `native-${index}`, instanceId: `instance-${index}`, workspaceRoot: '/fixture' };
    return store.registerSession(input, mutation('session', input));
  });
  const tasks = actors.map(({ session }, index) => {
    const input = { projectId: project.id, sessionId: session.id, title: `Task ${index}`, featureKey: `feature-${index}` };
    return store.createTask(input, mutation('task', input));
  });
  const leaseInput = (index, resources) => ({ projectId: project.id, sessionId: actors[index].session.id, taskId: tasks[index].id, taskRevision: 1, resources, ttlSeconds: 10 });
  return { store, project, actors, tasks, leaseInput, advance: amount => { now += amount; } };
}
const resource = value => ({ kind: 'path', value });
const code = expected => error => error.code === expected;

test('canonical request fingerprints ignore object key order, not array order', () => {
  assert.equal(canonicalJson({ b: 2, a: { z: 1, x: 2 } }), canonicalJson({ a: { x: 2, z: 1 }, b: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('directory reservations overlap descendants but not neighbouring names', () => {
  assert(resourcesOverlap(resource('src/auth'), resource('src/auth/login.ts')));
  assert(resourcesOverlap(resource('.'), resource('README.md')));
  assert(!resourcesOverlap(resource('src/auth'), resource('src/author.ts')));
  assert(!resourcesOverlap(resource('src/auth'), { kind: 'resource', value: 'src/auth' }));
});

test('idempotent mutations persist one result/event and reject changed payloads', t => {
  const { store, project } = setup(t);
  const input = { root: '/second', canonicalPath: '/second', mode: 'advisory', caseSensitive: true };
  const meta = mutation('project', input);
  const first = store.registerProject(input, meta);
  assert.deepEqual(store.registerProject(input, meta), JSON.parse(JSON.stringify(first)));
  assert.equal(store.events(first.id, 0).length, 1);
  assert.throws(() => store.registerProject(input, { ...meta, input: { changed: true } }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(store.snapshot(project.id).projects.length, 1);
});

test('explicit duplicate feature ownership is rejected with existing-task evidence', t => {
  const { store, project, actors, tasks } = setup(t);
  const input = { projectId: project.id, sessionId: actors[1].session.id, title: 'Different wording', featureKey: 'feature-0' };
  assert.throws(() => store.createTask(input, mutation('task', input)), error => error.code === 'FEATURE_ALREADY_OWNED' && error.details.id === tasks[0].id);
  assert.equal(store.snapshot().tasks.length, 5);
});

test('multi-resource acquisition is all-or-none, and retries do not grant twice', t => {
  const { store, leaseInput } = setup(t);
  const first = leaseInput(0, [resource('src/auth')]);
  const key = mutation('acquire', first);
  const acquired = store.acquire(first, key);
  assert.deepEqual(store.acquire(first, key), acquired);
  const blocked = leaseInput(1, [resource('src/free'), resource('src/auth/login.ts')]);
  assert.throws(() => store.acquire(blocked, mutation('acquire', blocked)), code('RESERVATION_CONFLICT'));
  const free = leaseInput(2, [resource('src/free')]);
  store.acquire(free, mutation('acquire', free));
  assert.equal(store.snapshot().reservations.length, 2);
});

test('expiry preserves work; old owners cannot renew or release a replacement', t => {
  const { store, leaseInput, advance } = setup(t);
  const first = leaseInput(0, [resource('src/auth')]);
  const old = store.acquire(first, mutation('acquire', first));
  advance(10001);
  const second = leaseInput(1, [resource('src/auth/login.ts')]);
  const replacement = store.acquire(second, mutation('acquire', second));
  assert(replacement.generation > old.generation);
  const stale = { id: old.id, sessionId: old.sessionId, generation: old.generation, ttlSeconds: 60 };
  assert.throws(() => store.changeLease(stale, mutation('renew', stale)), code('STALE_LEASE'));
  const stolen = { id: replacement.id, sessionId: old.sessionId, generation: replacement.generation };
  assert.throws(() => store.changeLease(stolen, mutation('release', stolen)), code('FORBIDDEN'));
  assert.equal(store.snapshot().tasks.length, 5);
  assert.equal(store.snapshot().reservations[0].id, replacement.id);
});

test('fencing and task revision checks reject stale clients', t => {
  const { store, leaseInput } = setup(t);
  const input = leaseInput(0, [resource('a')]);
  assert.throws(() => store.acquire({ ...input, taskRevision: 2 }, mutation('acquire', { stale: true })), code('STALE_REVISION'));
  const lease = store.acquire(input, mutation('acquire', input));
  const bad = { id: lease.id, sessionId: lease.sessionId, generation: lease.generation + 1 };
  assert.throws(() => store.changeLease(bad, mutation('release', bad)), code('STALE_LEASE'));
  const release = { ...bad, generation: lease.generation };
  store.changeLease(release, mutation('release', release));
  assert.equal(store.snapshot().reservations.length, 0);
});

test('snapshot and events never reveal credential hashes or session tokens', t => {
  const { store, project, actors } = setup(t);
  const output = JSON.stringify({ state: store.snapshot(), events: store.events(project.id, 0) });
  assert(!output.includes('tokenHash'));
  for (const actor of actors) assert(!output.includes(actor.token));
  assert.equal(store.authenticateSession(actors[0].token).id, actors[0].session.id);
  assert.equal(store.authenticateSession('wrong'), undefined);
});

test('plain folders are advisory; worktrees group by common directory, clones do not', async t => {
  const root = await temporary(t);
  const plain = path.join(root, 'plain');
  await mkdir(plain);
  assert.equal((await discoverProject(plain)).mode, 'advisory');
  const repo = await repository(path.join(root, 'repo'));
  const other = path.join(root, 'second-worktree');
  git(repo, 'worktree', 'add', '-q', '-b', 'task-test', other);
  const [main, worktree] = await Promise.all([discoverProject(repo), discoverProject(other)]);
  assert.equal(main.mode, 'git');
  assert.equal(main.canonicalPath, worktree.canonicalPath);
  assert.notEqual(main.root, worktree.root);
  const clone = path.join(root, 'clone');
  git(root, 'clone', '-q', repo, clone);
  assert.notEqual((await discoverProject(clone)).canonicalPath, main.canonicalPath);
  await writeFile(path.join(repo, 'uncommitted.txt'), 'preserve me');
  await discoverProject(repo);
  assert(git(repo, 'status', '--porcelain').includes('uncommitted.txt'));
});

test('resource normalization handles new paths and rejects escapes or dangling symlinks', async t => {
  const root = await temporary(t);
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  await symlink(outside, path.join(workspace, 'escape'));
  await symlink(path.join(outside, 'missing'), path.join(workspace, 'dangling'));
  assert.deepEqual(await normalizeResources([resource('src/New.ts'), resource('src/New.ts')], workspace, true), [resource('src/New.ts')]);
  assert.deepEqual(await normalizeResources([resource('SRC/New.ts')], workspace, false), [resource('src/new.ts')]);
  await assert.rejects(normalizeResources([resource('../outside')], workspace, true));
  await assert.rejects(normalizeResources([resource('escape/file')], workspace, true), code('PATH_ESCAPE'));
  await assert.rejects(normalizeResources([resource('dangling/file')], workspace, true), code('PATH_ESCAPE'));
});

test('adapter binary detection never implies connected or verified support', async () => {
  const adapters = await adapterDiagnostics();
  assert.deepEqual(adapters.map(item => item.tool), ['claude', 'codex', 'cursor', 'opencode']);
  assert(adapters.every(item => !item.verified && !item.connected && Object.values(item.capabilities).every(value => !value)));
});
