import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

// The client under test is current source; the normal project test command builds
// the actual daemon. Test-only human credentials belong to this disposable daemon,
// never a user profile. Neither client imports or discovers human credentials.
const source = new URL('../packages/murmur/src/', import.meta.url);
const modules = new Set(['cli/external-client.ts', 'protocol/index.ts', 'protocol/agent.ts', 'protocol/external.ts'].map(file => new URL(file, source).href));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(source.href) && specifier.startsWith('.')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
      assert(modules.has(url), 'Client imported an unscoped module'); return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!modules.has(url)) return next(url, context);
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  },
});
const { ExternalClient, EnrollmentClient } = await import(new URL('cli/external-client.ts', source));
hooks.deregister();
const digest = value => createHash('sha256').update(value).digest('hex');

test('real HTTP enrollment, approval, scoped operations and leave remain isolated', { timeout: 20_000 }, async () => {
  assert(process.env.TMPDIR);
  const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR, 'murmur-external-http-test-')));
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(workspace); await mkdir(home, { mode: 0o700 });
  const overrides = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let daemon;
  try {
    const { startDaemon } = await import('../packages/murmur/dist/daemon/server.js');
    daemon = await startDaemon(path.join(root, 'service'));
    const descriptor = JSON.parse(await readFile(path.join(daemon.directory, 'connection.json'), 'utf8'));
    const testHuman = JSON.parse(await readFile(path.join(daemon.directory, 'daemon.json'), 'utf8'));
    const humanPost = async (endpoint, input) => {
      const response = await fetch(`${descriptor.origin}${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${testHuman.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(input),
      });
      const result = await response.json();
      assert(response.ok, `Disposable human fixture request failed (${response.status}, ${result.error?.code ?? 'unknown'})`);
      return result;
    };
    await humanPost('/v1/projects', { root: workspace });
    const capability = randomBytes(32).toString('base64url'), pollSecret = randomBytes(32).toString('base64url');
    const input = { capabilityHash: digest(capability), pollSecretHash: digest(pollSecret), workspaceRoot: workspace,
      native: { tool: 'manual', nativeId: randomUUID(), incarnationId: 'test-only-incarnation' }, groupTitle: 'HTTP fixture', responsibility: 'Verify scoped API' };
    const enrollment = new EnrollmentClient(descriptor, { timeoutMs: 3000, redactSecrets: [capability, pollSecret] });
    const requested = await enrollment.request(input, 'request-once');
    assert.equal(requested.state, 'pending'); assert.deepEqual(await enrollment.request(input, 'request-once'), requested);
    await assert.rejects(enrollment.activate(capability, workspace), { code: 'EXTERNAL_UNAUTHORIZED' });
    assert.equal((await enrollment.status(requested.requestId, pollSecret)).state, 'pending');
    const review = await humanPost('/v1/connections/review', { requestId: requested.requestId, revision: requested.revision });
    const approval = await humanPost('/v1/connections/approve', { requestId: requested.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: 'Reviewed fixture responsibility', expiresInSeconds: 120 });
    assert.equal((await enrollment.status(requested.requestId, pollSecret)).state, 'approved');
    const connection = await enrollment.activate(capability, workspace);
    assert(Object.isFrozen(connection)); assert.equal(connection.taskId, approval.member.taskId);
    const client = new ExternalClient(connection, { timeoutMs: 3000, redactSecrets: [pollSecret] });
    assert.equal((await client.identity()).grantId, approval.grant.id);
    let context = await client.context(); assert.equal(context.task.id, connection.taskId);
    await client.intent({ revision: context.task.revision, writes: ['src/api'], acceptanceCriteria: ['test coverage'] }, 'intent-once');
    context = await client.context();
    await client.taskStatus({ revision: context.task.revision, status: 'blocked', blocker: 'Waiting on schema review' }, 'status-once');
    await client.checkPlan({ title: 'Candidate', writes: ['src/api'] }, 'check-once');
    await client.proposeDecision({ key: 'api.fixture', value: 'v1', version: '1', rationale: 'Fixture-only proposal' }, 'proposal-once');
    context = await client.context();
    const lease = await client.reserve({ revision: context.task.revision, resources: [{ kind: 'path', value: 'src/api' }], ttlSeconds: 60 }, 'reserve-once');
    assert(lease.expiresAt <= connection.expiresAt);
    const released = await client.release({ leaseId: lease.id, generation: lease.generation }, 'release-once'); assert(released.releasedAt !== null);
    const member = await client.memberStatus(); assert.equal(member.member.id, connection.memberId);
    const outputs = JSON.stringify({ context, member, requested });
    assert(!outputs.includes(capability)); assert(!outputs.includes(pollSecret)); assert(!outputs.includes(testHuman.token));
    await client.leave('leave-once');
    await assert.rejects(client.context(), { code: 'EXTERNAL_UNAUTHORIZED' });
    await assert.rejects(enrollment.activate(capability, workspace), { code: 'EXTERNAL_UNAUTHORIZED' });
  } finally {
    try { await daemon?.close(); } finally {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(root, { recursive: true, force: true });
    }
  }
});
