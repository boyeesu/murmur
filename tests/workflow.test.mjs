import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rename, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { discoverProject } from '../packages/murmur/dist/workspaces/identity.js';
import { GitWorkflow } from '../packages/murmur/dist/integration/workflow.js';
import { MaintenanceService, restoreBackup } from '../packages/murmur/dist/core/maintenance.js';
import { temporary, repository, git, mutation } from './helpers.mjs';

const human = { kind: 'human' };
const errorCode = code => error => error?.code === code;
async function fixture(t) {
  const directory = await temporary(t), root = await repository(path.join(directory, 'source'));
  const state = path.join(directory, 'state');
  await mkdir(state);
  const store = new CoordinationStore(path.join(state, 'coordination.sqlite'));
  t.after(() => store.close());
  const identity = await discoverProject(root), project = store.registerProject(identity, mutation('project.register', identity));
  const workflow = new GitWorkflow(store, state);
  await workflow.initialize();
  t.after(() => workflow.close());
  function actor(label = randomUUID()) {
    const input = { projectId: project.id, tool: 'manual', nativeId: label, instanceId: randomUUID(), workspaceRoot: project.root };
    const { session } = store.registerSession(input, mutation('session.register', input));
    const taskInput = { projectId: project.id, sessionId: session.id, title: label, featureKey: null };
    return { session, task: store.createTask(taskInput, mutation('task.create', taskInput)) };
  }
  const call = (method, input, principal = human, key = randomUUID()) => workflow[method](input, principal, mutation(`workflow.${method}`, input, key, principal.kind === 'human' ? 'human' : `session:${principal.sessionId}`));
  return { directory, root: project.root, state, store, workflow, project, call, actor, ...actor('first task') };
}
async function committed(root, filename, contents) {
  await writeFile(path.join(root, filename), contents);
  git(root, 'add', '--', filename);
  git(root, 'commit', '-qm', `Fixture change ${filename}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`);
  return git(root, 'rev-parse', 'HEAD');
}
async function attached(f, actor = f) {
  const workspace = await f.call('createWorkspace', { projectId: f.project.id });
  const result = await f.call('attachWorkspace', { taskId: actor.task.id, workspaceId: workspace.id, revision: actor.task.revision });
  actor.task = result.task; actor.session = result.session;
  return workspace;
}
async function submitted(f, filename = 'feature.txt', content = 'feature\n', actor = f, workspace = undefined) {
  workspace ??= await attached(f, actor);
  const sourceSha = await committed(workspace.root, filename, content);
  const changeset = await f.call('submit', { taskId: actor.task.id, revision: actor.task.revision });
  actor.task = f.store.task(actor.task.id);
  return { workspace, sourceSha, changeset };
}
async function prepared(f) {
  const submission = await submitted(f);
  return { ...submission, job: await f.call('prepare', { changesetId: submission.changeset.id }) };
}
const approval = (job, extra = {}) => ({ jobId: job.id, candidateSha: job.candidateSha, targetSha: job.targetSha, ...extra });
const nodeCheck = (source, timeoutMs = 10000) => ({ command: process.execPath, args: ['-e', source], timeoutMs });

test('managed workspace requires explicit dirty-base consent and never copies or changes source work', async t => {
  const f = await fixture(t), baseSha = git(f.root, 'rev-parse', 'HEAD');
  const original = await readFile(path.join(f.root, 'README.md'), 'utf8');
  await writeFile(path.join(f.root, 'README.md'), 'unfinished source edit\n');
  await writeFile(path.join(f.root, '.env'), 'PRIVATE_FIXTURE=do-not-copy\n');
  await assert.rejects(f.call('createWorkspace', { projectId: f.project.id }), errorCode('DIRTY_BASE'));
  const input = { projectId: f.project.id, baseRevision: baseSha, allowDirtyBase: true }, key = randomUUID();
  const workspace = await f.call('createWorkspace', input, human, key);
  assert.equal(workspace.baseSha, baseSha);
  assert.equal(workspace.kind, 'managed'); assert.equal(workspace.disposable, true); assert.equal(workspace.dirtyBaseExcluded, true);
  assert.equal(git(workspace.root, 'rev-parse', 'HEAD'), baseSha);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
  assert.equal(await readFile(path.join(f.root, 'README.md'), 'utf8'), 'unfinished source edit\n');
  assert.equal(await readFile(path.join(workspace.root, 'README.md'), 'utf8'), original);
  await assert.rejects(access(path.join(workspace.root, '.env')));
  assert.equal(git(f.root, 'rev-parse', workspace.baseRef), baseSha);
  assert.deepEqual(await f.call('createWorkspace', input, human, key), workspace);
  await assert.rejects(f.call('createWorkspace', { ...input, baseRevision: 'HEAD' }, human, key), errorCode('IDEMPOTENCY_CONFLICT'));
  const principal = { kind: 'session', projectId: f.project.id, sessionId: f.session.id };
  await assert.rejects(f.call('createWorkspace', input, principal, key), errorCode('FORBIDDEN'));
});

test('adoption verifies common-directory identity, exact root and nonnested worktrees', async t => {
  const f = await fixture(t), external = path.join(f.directory, 'existing-worktree');
  git(f.root, 'worktree', 'add', '-b', 'existing', external);
  const adopted = await f.call('adoptWorkspace', { projectId: f.project.id, root: external });
  assert.equal(adopted.kind, 'adopted'); assert.equal(adopted.disposable, false);
  await mkdir(path.join(external, 'subdirectory'));
  await assert.rejects(f.call('adoptWorkspace', { projectId: f.project.id, root: path.join(external, 'subdirectory') }), errorCode('WORKSPACE_IDENTITY_CHANGED'));
  const otherRepo = await repository(path.join(f.directory, 'other-repo'));
  await assert.rejects(f.call('adoptWorkspace', { projectId: f.project.id, root: otherRepo }), errorCode('WORKSPACE_IDENTITY_CHANGED'));
  const nested = path.join(f.root, 'nested');
  git(f.root, 'worktree', 'add', '--detach', nested);
  await assert.rejects(f.call('adoptWorkspace', { projectId: f.project.id, root: nested }), errorCode('NESTED_WORKSPACE'));
  assert.equal(f.workflow.listWorkspaces(f.project.id).length, 1);
});

test('moved/replaced worktrees fail revalidation without deleting either worktree', async t => {
  const f = await fixture(t), workspace = await f.call('createWorkspace', { projectId: f.project.id });
  const moved = path.join(f.directory, 'moved-worktree');
  git(f.root, 'worktree', 'move', workspace.root, moved);
  git(f.root, 'worktree', 'add', '--detach', workspace.root, 'HEAD');
  await assert.rejects(f.call('attachWorkspace', { taskId: f.task.id, workspaceId: workspace.id, revision: f.task.revision }), errorCode('WORKSPACE_IDENTITY_CHANGED'));
  const observation = (await f.workflow.reconcile(f.project.id)).find(row => row.workspaceId === workspace.id);
  assert.equal(observation.identityValid, false); assert.equal(observation.actor, 'unknown');
  await access(moved); await access(workspace.root);
});

test('attach is revisioned bookkeeping, rejects reservations and conflicting active tasks', async t => {
  const f = await fixture(t), workspace = await f.call('createWorkspace', { projectId: f.project.id });
  const leaseInput = { projectId: f.project.id, sessionId: f.session.id, taskId: f.task.id, taskRevision: f.task.revision, resources: [{ kind: 'path', value: 'README.md' }], ttlSeconds: 60 };
  const lease = f.store.acquire(leaseInput, mutation('lease.acquire', leaseInput));
  const input = { taskId: f.task.id, workspaceId: workspace.id, revision: f.task.revision };
  await assert.rejects(f.call('attachWorkspace', input), errorCode('LIVE_RESERVATIONS'));
  const release = { id: lease.id, sessionId: f.session.id, generation: lease.generation };
  f.store.changeLease(release, mutation('lease.release', release));
  const taskInput = { projectId: f.project.id, sessionId: f.session.id, title: 'other task', featureKey: null };
  const other = f.store.createTask(taskInput, mutation('task.create', taskInput));
  await assert.rejects(f.call('attachWorkspace', input), errorCode('SESSION_WORKSPACE_CONFLICT'));
  f.store.db.prepare("UPDATE tasks SET status = 'abandoned' WHERE id = ?").run(other.id);
  const result = await f.call('attachWorkspace', input);
  assert.equal(result.restartRequired, true); assert.match(result.message, /not relocated/);
  assert.equal(result.task.revision, f.task.revision + 1);
  assert.equal(result.session.revision, f.session.revision + 1);
  assert.equal(result.session.workspaceRoot, workspace.root);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
  await assert.rejects(f.call('attachWorkspace', input), errorCode('STALE_REVISION'));
});

test('submission rejects tracked/untracked dirt, excludes ignored files and remains pinned as source advances', async t => {
  const f = await fixture(t), workspace = await attached(f);
  await committed(workspace.root, '.gitignore', 'ignored.secret\n');
  await writeFile(path.join(workspace.root, 'ignored.secret'), 'private ignored fixture');
  await writeFile(path.join(workspace.root, 'untracked.txt'), 'untracked');
  await assert.rejects(f.call('submit', { taskId: f.task.id, revision: f.task.revision }), errorCode('DIRTY_WORKSPACE'));
  await committed(workspace.root, 'untracked.txt', 'committed feature\n');
  await writeFile(path.join(workspace.root, 'README.md'), 'tracked dirt');
  await assert.rejects(f.call('submit', { taskId: f.task.id, revision: f.task.revision }), errorCode('DIRTY_WORKSPACE'));
  await committed(workspace.root, 'README.md', 'committed README\n');
  const input = { taskId: f.task.id, revision: f.task.revision }, key = randomUUID();
  const principal = { kind: 'session', projectId: f.project.id, sessionId: f.session.id };
  const changeset = await f.call('submit', input, principal, key);
  assert.equal(Object.getPrototypeOf(changeset), Object.prototype);
  assert.equal(f.store.task(f.task.id).status, 'ready');
  assert.deepEqual(await f.call('submit', input, principal), changeset);
  const pinned = changeset.sourceSha;
  await committed(workspace.root, 'later.txt', 'not in submitted changeset\n');
  await writeFile(path.join(workspace.root, 'later-dirty.txt'), 'also not submitted');
  assert.deepEqual(await f.call('submit', input, principal, key), changeset);
  assert.equal(git(f.root, 'rev-parse', changeset.sourceRef), pinned);
  assert.notEqual(git(workspace.root, 'rev-parse', 'HEAD'), pinned);
  const job = await f.call('prepare', { changesetId: changeset.id });
  assert.equal(job.sourceSha, pinned);
  assert.throws(() => git(f.root, 'show', `${job.candidateSha}:later.txt`));
  assert.throws(() => git(f.root, 'show', `${job.candidateSha}:ignored.secret`));
  assert.equal(await readFile(path.join(workspace.root, 'later-dirty.txt'), 'utf8'), 'also not submitted');
});

test('no checks stay unverified and need exact explicit human acknowledgement', async t => {
  const f = await fixture(t), originalSha = git(f.root, 'rev-parse', 'HEAD');
  const { job, sourceSha, workspace } = await prepared(f);
  assert.equal(job.status, 'unverified'); assert.equal(job.validation.status, 'unverified');
  await assert.rejects(f.call('approve', approval(job)), errorCode('UNVERIFIED_ACK_REQUIRED'));
  await assert.rejects(f.call('approve', { ...approval(job), candidateSha: originalSha, acknowledgeNoChecks: true }), errorCode('APPROVAL_MISMATCH'));
  const result = await f.call('approve', approval(job, { acknowledgeNoChecks: true }));
  assert.equal(result.status, 'promoted');
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.candidateSha);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), originalSha);
  assert.equal(git(workspace.root, 'rev-parse', 'HEAD'), sourceSha);
  assert.equal(git(f.root, 'show', `${job.targetRef}:feature.txt`), 'feature');
  assert.equal(f.store.task(f.task.id).status, 'integrated');
});

test('textual merge conflict preserves source and inspectable candidate evidence', async t => {
  const f = await fixture(t), second = f.actor('conflicting task');
  const firstWorkspace = await attached(f), secondWorkspace = await attached(f, second);
  const first = await submitted(f, 'README.md', 'first change\n', f, firstWorkspace);
  const secondSubmission = await submitted(f, 'README.md', 'second change\n', second, secondWorkspace);
  const firstJob = await f.call('prepare', { changesetId: first.changeset.id });
  await f.call('approve', approval(firstJob, { acknowledgeNoChecks: true }));
  const conflict = await f.call('prepare', { changesetId: secondSubmission.changeset.id });
  assert.equal(conflict.status, 'conflicted'); assert.equal(conflict.candidateSha, null);
  assert.match(await readFile(path.join(conflict.candidateRoot, 'README.md'), 'utf8'), /<<<<<<< /);
  assert.equal(await readFile(path.join(secondWorkspace.root, 'README.md'), 'utf8'), 'second change\n');
  assert.equal(git(secondWorkspace.root, 'rev-parse', 'HEAD'), secondSubmission.sourceSha);
  assert.equal(git(secondWorkspace.root, 'status', '--porcelain'), '');
  assert.equal(git(f.root, 'rev-parse', conflict.targetRef), firstJob.candidateSha);
  const inspection = await f.workflow.inspectJob(conflict.id);
  assert(inspection.changedPaths.some(row => row.path === 'README.md'));
  await assert.rejects(f.call('approve', approval(conflict, { acknowledgeNoChecks: true })), errorCode('VALIDATION_REQUIRED'));
  const retried = await f.call('prepare', { changesetId: secondSubmission.changeset.id });
  assert.notEqual(retried.id, conflict.id); assert.equal(retried.status, 'conflicted');
  await access(conflict.candidateRoot);
});

test('validation runs on the combined candidate and failure cannot be bypassed', async t => {
  const f = await fixture(t), second = f.actor('second feature');
  const firstWorkspace = await attached(f), secondWorkspace = await attached(f, second);
  const first = await submitted(f, 'first.txt', 'first\n', f, firstWorkspace);
  const firstJob = await f.call('prepare', { changesetId: first.changeset.id });
  await f.call('approve', approval(firstJob, { acknowledgeNoChecks: true }));
  const secondSubmission = await submitted(f, 'second.txt', 'second\n', second, secondWorkspace);
  assert.throws(() => git(secondWorkspace.root, 'show', 'HEAD:first.txt'));
  await f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [nodeCheck("const fs=require('node:fs'); process.exit(fs.existsSync('first.txt') && fs.existsSync('second.txt') ? 23 : 0)")] });
  const job = await f.call('prepare', { changesetId: secondSubmission.changeset.id });
  const checked = await f.call('validate', { jobId: job.id });
  assert.equal(checked.status, 'validation_failed'); assert.equal(checked.validation.checks[0].exitCode, 23);
  await assert.rejects(f.call('approve', approval(checked, { acknowledgeNoChecks: true })), errorCode('VALIDATION_REQUIRED'));
  assert.equal(git(f.root, 'rev-parse', job.targetRef), firstJob.candidateSha);
  assert.equal(git(secondWorkspace.root, 'rev-parse', 'HEAD'), secondSubmission.sourceSha);
});

test('passed checks bind candidate target and configuration, and successful promotion is idempotent', async t => {
  const f = await fixture(t);
  const config = await f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [nodeCheck("const fs=require('node:fs'); if(fs.readFileSync('feature.txt','utf8') !== 'feature\\n') process.exit(1)")] });
  const { job, workspace, sourceSha } = await prepared(f);
  const validation = await f.call('validate', { jobId: job.id });
  assert.equal(validation.status, 'validated'); assert.equal(validation.validation.status, 'passed');
  assert.equal(validation.validation.configHash, config.configHash);
  const input = approval(job), key = randomUUID();
  const promoted = await f.call('approve', input, human, key), task = f.store.task(f.task.id);
  await rename(job.candidateRoot, `${job.candidateRoot}-moved-after-success`);
  assert.deepEqual(await f.call('approve', input, human, key), promoted);
  assert.equal(f.store.task(f.task.id).revision, task.revision);
  assert.equal(f.store.events(f.project.id, 0).filter(event => event.type === 'integration.promoted').length, 1);
  assert.equal(git(workspace.root, 'rev-parse', 'HEAD'), sourceSha);
});

test('configuration changes invalidate validation and stale config CAS is rejected', async t => {
  const f = await fixture(t), commands = [nodeCheck('process.exit(0)')];
  const config = await f.call('configureValidation', { projectId: f.project.id, revision: 0, commands });
  const { job } = await prepared(f);
  await f.call('validate', { jobId: job.id });
  await assert.rejects(f.call('configureValidation', { projectId: f.project.id, revision: 0, commands }), errorCode('STALE_REVISION'));
  const updated = await f.call('configureValidation', { projectId: f.project.id, revision: config.revision, commands });
  assert.notEqual(updated.configHash, config.configHash);
  assert.equal(f.workflow.getJob(job.id).status, 'invalidated');
  await assert.rejects(f.call('approve', approval(job)), errorCode('VALIDATION_REQUIRED'));
  const checked = await f.call('validate', { jobId: job.id });
  assert.equal(checked.validation.configHash, updated.configHash);
  assert.equal((await f.call('approve', approval(job))).status, 'promoted');
});

test('moved target invalidates candidate instead of forcing an update', async t => {
  const f = await fixture(t), { job, sourceSha } = await prepared(f);
  git(f.root, 'update-ref', job.targetRef, sourceSha, job.targetSha);
  await assert.rejects(f.call('approve', approval(job, { acknowledgeNoChecks: true })), errorCode('TARGET_MOVED'));
  assert.equal(git(f.root, 'rev-parse', job.targetRef), sourceSha);
  assert.equal(f.workflow.getJob(job.id).status, 'invalidated');
});

test('a checked-out integration target is never promoted or rewritten', async t => {
  const f = await fixture(t), { job } = await prepared(f);
  const checkout = path.join(f.directory, 'target-checkout');
  git(f.root, 'worktree', 'add', checkout, job.targetRef.slice('refs/heads/'.length));
  await assert.rejects(f.call('approve', approval(job, { acknowledgeNoChecks: true })), errorCode('TARGET_CHECKED_OUT'));
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), job.targetSha);
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.targetSha);
  await assert.rejects(access(path.join(checkout, 'feature.txt')));
});

test('dirty validation output invalidates candidate and leaves source untouched', async t => {
  const f = await fixture(t);
  await f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [nodeCheck("require('node:fs').writeFileSync('untracked-output.txt','do not promote')")] });
  const { job, workspace } = await prepared(f);
  await assert.rejects(f.call('validate', { jobId: job.id }), errorCode('DIRTY_WORKSPACE'));
  assert.equal(f.workflow.getJob(job.id).status, 'invalidated');
  await assert.rejects(f.call('approve', approval(job)), errorCode('VALIDATION_REQUIRED'));
  await assert.rejects(access(path.join(workspace.root, 'untracked-output.txt')));
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.targetSha);
});

test('trusted argv validation filters credentials and never exposes raw output', async t => {
  const f = await fixture(t), previous = process.env.MURMUR_ADMIN_TOKEN;
  process.env.MURMUR_ADMIN_TOKEN = 'fixture-admin-secret-not-for-validation';
  t.after(() => { if (previous === undefined) delete process.env.MURMUR_ADMIN_TOKEN; else process.env.MURMUR_ADMIN_TOKEN = previous; });
  await assert.rejects(f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [{ command: 'node -e something', args: [] }] }), errorCode('INVALID_INPUT'));
  await assert.rejects(f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [{ command: '/bin/sh', args: ['-c', 'true'] }] }), errorCode('INVALID_INPUT'));
  await f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [nodeCheck("if(process.env.MURMUR_ADMIN_TOKEN) process.exit(1); console.log('printed-private-fixture-not-for-api')")] });
  const { job } = await prepared(f), checked = await f.call('validate', { jobId: job.id });
  assert.equal(checked.status, 'validated'); assert(checked.validation.checks[0].stdoutBytes > 0);
  const inspection = await f.workflow.inspectJob(job.id);
  assert.equal(inspection.logsOmitted, true); assert.equal(inspection.contentsOmitted, true);
  assert(!JSON.stringify(inspection).includes('printed-private-fixture-not-for-api'));
  assert(!JSON.stringify(inspection).includes('fixture-admin-secret-not-for-validation'));
});

test('timeouts and explicit cancellation never produce passing validation', async t => {
  const f = await fixture(t);
  await f.call('configureValidation', { projectId: f.project.id, revision: 0, commands: [nodeCheck('setInterval(()=>{},100)', 100)] });
  const { job } = await prepared(f), timed = await f.call('validate', { jobId: job.id });
  assert.equal(timed.status, 'validation_failed'); assert.equal(timed.validation.checks[0].timedOut, true);
  await f.call('configureValidation', { projectId: f.project.id, revision: 1, commands: [nodeCheck('setInterval(()=>{},100)', 10000)] });
  const pending = f.call('validate', { jobId: job.id });
  let cancelled = false;
  for (let attempt = 0; attempt < 100 && !cancelled; attempt++) { await delay(20); cancelled = f.workflow.cancelValidation(job.id, human); }
  assert.equal(cancelled, true);
  const result = await pending;
  assert.equal(result.status, 'validation_failed'); assert.equal(result.validation.checks[0].cancelled, true);
});

test('promotion interruption reconciles the DB half once without retrying Git or duplicating events', async t => {
  const f = await fixture(t), { job } = await prepared(f);
  const originalEvent = f.store.event.bind(f.store);
  f.store.event = (projectId, type, payload) => { if (type === 'integration.promoted') throw new Error('simulated DB failure after Git CAS'); return originalEvent(projectId, type, payload); };
  const input = approval(job, { acknowledgeNoChecks: true }), key = randomUUID();
  await assert.rejects(f.call('approve', input, human, key), errorCode('WORKFLOW_FAILED'));
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.candidateSha);
  assert.equal(f.workflow.getJob(job.id).status, 'promoting');
  assert.equal(f.store.task(f.task.id).status, 'ready');
  f.store.event = originalEvent;
  const restarted = new GitWorkflow(f.store, f.state);
  await restarted.initialize();
  assert.equal(restarted.getJob(job.id).status, 'promoted');
  assert.equal(f.store.task(f.task.id).status, 'integrated');
  const replay = await restarted.approve(input, human, mutation('workflow.approve', input, key));
  assert.equal(replay.status, 'promoted');
  assert.equal(f.store.events(f.project.id, 0).filter(event => event.type === 'integration.promoted').length, 1);
});

for (const responseMissing of [false, true]) test(`restore permanently retires promoted workflow requests across initialization (cached response missing: ${responseMissing})`, async t => {
  const f = await fixture(t), { job } = await prepared(f), input = approval(job, { acknowledgeNoChecks: true }), key = randomUUID();
  await f.call('approve', input, human, key);
  const meta = mutation('workflow.approve', input, key);
  if (responseMissing) {
    // A valid crash snapshot after finishPromotion, before the final response transaction.
    f.store.db.prepare('DELETE FROM mutations WHERE caller=? AND key=?').run('human', key);
    f.store.db.prepare("UPDATE workflow_requests SET status='running',response=NULL WHERE caller=? AND key=?").run('human', key);
  }
  const directory = await realpath(f.directory), destination = path.join(directory, 'backup.sqlite'), target = path.join(directory, 'restored');
  await new MaintenanceService(f.store).backup({ destination }, human);
  await restoreBackup({ backupPath: destination, stateDirectory: target }, human);
  const store = new CoordinationStore(path.join(target, 'state.sqlite')); t.after(() => store.close());
  const restored = new GitWorkflow(store, target); t.after(() => restored.close());
  const journal = () => store.db.prepare('SELECT * FROM workflow_requests WHERE caller=? AND key=?').get('human', key);
  assert.equal(journal().status, 'retired'); assert.equal(journal().response, null);
  await assert.rejects(restored.approve(input, human, meta), errorCode('IDEMPOTENCY_RETIRED'));
  await restored.initialize();
  assert.equal(restored.getJob(job.id).status, 'promoted', 'historical promoted bookkeeping remains inspectable');
  assert.equal(restored.getJob(job.id).validation.status, 'invalidated');
  assert.equal(journal().status, 'retired'); assert.equal(journal().response, null);
  await assert.rejects(restored.approve(input, human, meta), errorCode('IDEMPOTENCY_RETIRED'));
  assert.equal(store.events(f.project.id, 0).filter(event => event.type === 'integration.promoted').length, 1);
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.candidateSha);
  if (!responseMissing) {
    assert.throws(() => store.replay(meta), errorCode('IDEMPOTENCY_RETIRED'));
    // A legacy/independently recovered journal cannot supersede permanent store retirement.
    store.db.prepare("UPDATE workflow_requests SET status='complete',response=? WHERE caller=? AND key=?").run(JSON.stringify(restored.getJob(job.id)), 'human', key);
    await assert.rejects(restored.approve(input, human, meta), errorCode('IDEMPOTENCY_RETIRED'));
    store.db.prepare("UPDATE workflow_requests SET status='interrupted' WHERE caller=? AND key=?").run('human', key);
    const reopened = new GitWorkflow(store, target); t.after(() => reopened.close()); await reopened.initialize();
    assert.equal(journal().status, 'retired'); assert.equal(journal().response, null);
    await assert.rejects(reopened.approve(input, human, meta), errorCode('IDEMPOTENCY_RETIRED'));
  }
});

test('interrupted preparation and validation retain worktrees and never become green', async t => {
  const f = await fixture(t), { job } = await prepared(f);
  f.store.db.prepare("UPDATE workflow_jobs SET status = 'preparing' WHERE id = ?").run(job.id);
  const restarted = new GitWorkflow(f.store, f.state);
  await restarted.initialize();
  assert.equal(restarted.getJob(job.id).status, 'recovery_required');
  await access(job.candidateRoot);
  assert.equal(git(f.root, 'rev-parse', job.candidateRef), job.candidateSha);
  f.store.db.prepare("UPDATE workflow_jobs SET status = 'validating' WHERE id = ?").run(job.id);
  const secondRestart = new GitWorkflow(f.store, f.state);
  await secondRestart.initialize();
  assert.equal(secondRestart.getJob(job.id).status, 'invalidated');
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.targetSha);
});

test('reconcile includes NUL-safe untracked paths and unknown-actor reservation overlap without private paths', async t => {
  const f = await fixture(t), workspace = await attached(f);
  await committed(workspace.root, '.gitignore', 'ignored.secret\n');
  const unusual = 'line\nbreak.txt';
  await writeFile(path.join(workspace.root, unusual), 'untracked data');
  await writeFile(path.join(workspace.root, 'README.md'), 'observed change');
  await writeFile(path.join(workspace.root, '.env'), 'private fixture');
  await writeFile(path.join(workspace.root, 'ignored.secret'), 'ignored fixture');
  const input = { projectId: f.project.id, sessionId: f.session.id, taskId: f.task.id, taskRevision: f.task.revision, resources: [{ kind: 'path', value: 'README.md' }], ttlSeconds: 60 };
  const lease = f.store.acquire(input, mutation('lease.acquire', input));
  const row = (await f.workflow.reconcile(f.project.id)).find(entry => entry.workspaceId === workspace.id);
  assert.equal(row.actor, 'unknown'); assert.equal(row.identityValid, true);
  assert(row.changedPaths.some(entry => entry.path === unusual));
  assert(row.overlaps.some(entry => entry.leaseId === lease.id && entry.path === 'README.md'));
  assert(!row.changedPaths.some(entry => entry.path === '.env' || entry.path === 'ignored.secret'));
  assert(!JSON.stringify(row).includes('private fixture'));
});

test('plain folders remain advisory and workflow extension leaves base schema version unchanged', async t => {
  const f = await fixture(t), root = path.join(f.directory, 'plain');
  await mkdir(root);
  const identity = await discoverProject(root), project = f.store.registerProject(identity, mutation('project.register', identity));
  await assert.rejects(f.call('createWorkspace', { projectId: project.id }), errorCode('GIT_REQUIRED'));
  assert.equal((await f.workflow.reconcile(project.id))[0].mode, 'advisory');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 4);
});

test('symbolic integration refs cannot redirect promotion onto the original branch', async t => {
  const f = await fixture(t), originalSha = git(f.root, 'rev-parse', 'HEAD'), { job } = await prepared(f);
  git(f.root, 'symbolic-ref', job.targetRef, 'refs/heads/main');
  await assert.rejects(f.call('approve', approval(job, { acknowledgeNoChecks: true })), errorCode('SYMBOLIC_REF'));
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/main'), originalSha);
  assert.equal(git(f.root, 'symbolic-ref', job.targetRef), 'refs/heads/main');
  assert.equal(f.workflow.getJob(job.id).status, 'invalidated');
});

test('index assume-unchanged flags cannot hide source or candidate edits', async t => {
  const f = await fixture(t), workspace = await attached(f);
  await committed(workspace.root, 'feature.txt', 'feature\n');
  git(workspace.root, 'update-index', '--assume-unchanged', 'feature.txt');
  await writeFile(path.join(workspace.root, 'feature.txt'), 'hidden source change');
  await assert.rejects(f.call('submit', { taskId: f.task.id, revision: f.task.revision }), errorCode('HIDDEN_INDEX_CHANGES'));
  git(workspace.root, 'update-index', '--no-assume-unchanged', 'feature.txt');
  await committed(workspace.root, 'feature.txt', 'reviewed source change\n');
  const changeset = await f.call('submit', { taskId: f.task.id, revision: f.task.revision });
  const job = await f.call('prepare', { changesetId: changeset.id });
  git(job.candidateRoot, 'update-index', '--skip-worktree', 'feature.txt');
  await writeFile(path.join(job.candidateRoot, 'feature.txt'), 'hidden candidate edit');
  await assert.rejects(f.call('approve', approval(job, { acknowledgeNoChecks: true })), errorCode('HIDDEN_INDEX_CHANGES'));
  assert.equal(git(f.root, 'rev-parse', job.targetRef), job.targetSha);
});
