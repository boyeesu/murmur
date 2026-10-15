#!/usr/bin/env node
/** Opt-in native Codex fixture. Only fixture-owned history/configuration and a
 * static loopback Responses responder are used; no model, real credential, or
 * user transcript is involved. Normal project and hook trust must be satisfied
 * by the native tool; this probe never preapproves them or bypasses permissions.
 * Historical bypass-assisted results do not establish normal activation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request } from '../packages/murmur/dist/cli/client.js';
import { exportExistingChatSetup } from '../packages/murmur/dist/adapters/existing-chat.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--codex' || !path.isAbsolute(args[1])) {
  throw new Error('Use --codex /absolute/executable.');
}
const binary = await realpath(args[1]);
const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const root = await mkdtemp(path.join(await realpath(process.env.TMPDIR), 'murmur-codex-proof-'));
const children = new Set(), sockets = new Set(), providerRequests = [];
let daemon, mock, interrupted = false, activeTurn = null, lastNative = null, httpRequests = 0;
const report = {
  kind: 'native-codex-connector-fixture', nativeVersion: null,
  realModelCalls: false, realUserHistoryAccess: false, globalInstallation: false,
  fixtureHookTrustBypass: false, fixtureProjectPretrusted: false, interactiveHookTrustVerified: false,
  nativeSandboxBypassed: false, hotAttachVerified: false,
  phase: 'setup', checks: {},
};
function kill(child) {
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}
const stop = () => { interrupted = true; for (const child of children) kill(child); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const total = setTimeout(stop, 150000);
try {
  for (const name of ['workspace', 'home', 'codex', 'tmp', 'xdg-config', 'xdg-data', 'xdg-cache']) {
    await mkdir(path.join(root, name), { mode: 0o700 });
  }
  const workspace = path.join(root, 'workspace'), state = path.join(root, 'state');
  await mkdir(path.join(workspace, '.codex'), { mode: 0o700 });
  daemon = await startDaemon(state);
  const project = await request(state, 'POST', '/v1/projects', { root: workspace });
  mock = createServer({ maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 }, (req, res) => {
    httpRequests++;
    if (httpRequests > 64) { req.destroy(); return; }
    let size = 0; const chunks = [];
    req.on('error', () => {}); res.on('error', () => {});
    req.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fixture endpoint only"}'); return;
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400); res.end('invalid fixture request'); return; }
      providerRequests.push({ turn: activeTurn, body });
      const message = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LOCAL STATIC FIXTURE: NO MODEL USED', annotations: [] }] };
      const response = { id: `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'murmur-static-fixture', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return; }
      const events = [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } }],
        ['response.content_part.added', { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text }],
        ['response.output_text.done', { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: message.content[0].text }],
        ['response.content_part.done', { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: message }],
        ['response.completed', { type: 'response.completed', response }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
      res.end(events.map(([event, data], sequence_number) => `event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number })}\n\n`).join(''));
    });
  });
  mock.maxConnections = 8;
  mock.on('connection', socket => { sockets.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); });
  mock.on('clientError', (_error, socket) => socket.destroy());
  mock.on('connect', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${mock.address().port}`;
  const env = {
    HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', TERM: 'dumb',
    MURMUR_FIXTURE_API_KEY: 'DUMMY-LOCAL-STATIC-FIXTURE',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1,localhost',
    http_proxy: origin, https_proxy: origin, all_proxy: origin, no_proxy: '127.0.0.1,localhost',
  };
  // These files and the temporary hook installation belong to this fixture only.
  await writeFile(path.join(env.CODEX_HOME, 'config.toml'), [
    'model = "murmur-static-fixture"', 'model_provider = "murmur_fixture"',
    'check_for_update_on_startup = false', 'web_search = "disabled"',
    '[analytics]', 'enabled = false', '[feedback]', 'enabled = false',
    '[features]', 'hooks = true', 'apps = false', 'plugins = false', 'enable_request_compression = false',
    '[model_providers.murmur_fixture]', 'name = "Owned static loopback fixture"',
    `base_url = ${JSON.stringify(`${origin}/v1`)}`, 'wire_api = "responses"',
    'env_key = "MURMUR_FIXTURE_API_KEY"', 'requires_openai_auth = false',
    'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 5000', '',
  ].join('\n'), { mode: 0o600 });
  const exported = await exportExistingChatSetup({ tool: 'codex', outputDirectory: path.join(root, 'export'), stateDirectory: state, nodeExecutable: process.execPath, cliPath: cli, codexExecutable: binary, env });
  assert.equal(exported.exported, true); assert.equal(exported.installed, false); assert.equal(exported.connected, false);
  assert.equal(exported.testedVersion, '0.154.0'); report.nativeVersion = exported.testedVersion;
  const hookJson = await readFile(path.join(root, 'export', 'hooks.json'), 'utf8');
  await writeFile(path.join(workspace, '.codex', 'hooks.json'), hookJson, { mode: 0o600 });
  const run = async (label, turnArgs) => {
    assert(!interrupted, 'fixture interrupted or timed out'); activeTurn = label;
    const result = await new Promise(resolve => {
      const child = spawn(binary, ['exec', '--json', '--skip-git-repo-check', ...turnArgs], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      children.add(child); let out = '', err = '', size = 0, limited = false, timedOut = false, spawnError;
      const timer = setTimeout(() => { timedOut = true; kill(child); }, 20000);
      for (const [stream, name] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) { limited = true; kill(child); }
        else if (name === 'out') out += chunk; else err += chunk;
      });
      child.once('error', error => { spawnError = error.code ?? 'spawn-failed'; });
      child.once('close', (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ code, signal, out, err, limited, timedOut, spawnError }); });
    });
    lastNative = result;
    assert.equal(result.code, 0, `native ${label} failed (exit ${result.code}, signal ${result.signal}, timeout ${result.timedOut})`);
    assert(!result.limited, 'native output exceeded fixture bound');
    const rows = result.out.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const thread = rows.find(row => row.type === 'thread.started');
    assert(thread && typeof thread.thread_id === 'string', 'native JSONL did not disclose its thread ID');
    assert(rows.some(row => row.type === 'turn.completed'), 'native turn did not complete against the static responder');
    const sent = providerRequests.filter(row => row.turn === label).map(row => row.body);
    assert(sent.length > 0, 'native turn did not reach the owned static responder');
    return { rows, id: thread.thread_id, sent };
  };
  report.phase = 'native-start';
  const first = await run('start', ['murmur-connect start Native proof | Own API']);
  const pending = await request(state, 'GET', '/v1/connections/requests');
  const receipt = pending.find(row => row.native.nativeId === first.id);
  assert(receipt && receipt.state === 'pending', 'native UserPromptSubmit did not create a pending request for the native thread ID');
  assert.equal(receipt.native.tool, 'codex');
  assert.equal(receipt.native.incarnationId, first.id);
  assert.equal(receipt.workspaceRoot, workspace);
  assert.equal(pending.length, 1);
  report.checks.nativeStartRequestedHumanApproval = true;
  report.checks.nativeThreadIdentityMatched = true;
  report.checks.productionExportLoaded = true;
  // Inspect only requests to our responder, never native transcript files. A
  // developer-role message proves hook context reached native model input; the
  // same words in the user's prompt or old assistant response are not evidence.
  const developerText = turn => turn.sent.flatMap(body => Array.isArray(body.input) ? body.input : [])
    .filter(item => item.role === 'developer')
    .map(item => typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join('\n')).join('\n');
  const approve = async pendingReceipt => {
    const review = await request(state, 'POST', '/v1/connections/review', { requestId: pendingReceipt.requestId, revision: pendingReceipt.revision });
    return request(state, 'POST', '/v1/connections/approve', { requestId: pendingReceipt.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: pendingReceipt.responsibility });
  };
  assert(developerText(first).includes('Murmur connection: pending.'), 'pending hook output did not reach developer context');

  report.phase = 'approve-and-resume';
  const approvedA = await approve(receipt);
  const resumedA = await run('resume-A', ['resume', first.id, 'murmur-connect refresh']);
  assert.equal(resumedA.id, first.id, 'resume changed native thread identity');
  assert(developerText(resumedA).includes('Murmur connection: connected.'), 'approved connection was not activated');
  assert(developerText(resumedA).includes('Own API'), 'scoped task briefing did not reach developer context');
  report.checks.resumeRetainsApprovedScope = true;
  report.checks.scopedBriefingInDeveloperInput = true;

  report.phase = 'automatic-fresh-context';
  const freshValue = `fresh-fixture-${randomUUID()}`;
  assert(!developerText(resumedA).includes(freshValue));
  const proposal = await request(state, 'POST', '/v1/decisions/propose', { projectId: project.id, key: 'native-proof-contract', value: freshValue, version: 'fixture-v2', rationale: 'Fresh coordination update after the previous native turn' });
  await request(state, 'POST', '/v1/decisions/accept', { decisionId: proposal.id, revision: proposal.revision, expectedAcceptedId: null });
  const automatic = await run('ordinary-A', ['resume', first.id, 'Continue the owned static fixture.']);
  assert.equal(automatic.id, first.id);
  assert(developerText(automatic).includes('Murmur current-chat context refreshed automatically.'), 'ordinary prompt did not invoke automatic context refresh');
  assert(developerText(automatic).includes(freshValue), 'newly accepted decision was absent from the next ordinary prompt');
  report.checks.ordinaryPromptAutomaticallyRefreshes = true;
  report.checks.newDecisionArrivesWithoutManualRefresh = true;

  report.phase = 'independent-same-workspace-chat';
  const invitation = randomBytes(32).toString('base64url');
  await request(state, 'POST', '/v1/groups/invite', { groupId: approvedA.group.id, inviteHash: createHash('sha256').update(invitation).digest('hex') });
  const second = await run('join-B', [`murmur-connect join ${invitation} | Own tests`]);
  assert.notEqual(second.id, first.id);
  const requests = await request(state, 'GET', '/v1/connections/requests');
  const receiptB = requests.find(row => row.native.nativeId === second.id);
  assert(receiptB && receiptB.state === 'pending', 'second native chat did not create its own pending request');
  assert.notEqual(receiptB.requestId, receipt.requestId);
  assert.equal(receiptB.workspaceRoot, workspace);
  const approvedB = await approve(receiptB);
  assert.notEqual(approvedB.grant.id, approvedA.grant.id);
  assert.notEqual(approvedB.member.sessionId, approvedA.member.sessionId);
  assert.notEqual(approvedB.member.taskId, approvedA.member.taskId);
  const resumedB = await run('resume-B', ['resume', second.id, 'murmur-connect refresh']);
  assert.equal(resumedB.id, second.id);
  assert(developerText(resumedB).includes('Own API') && developerText(resumedB).includes('Own tests'));
  report.checks.twoSameWorkspaceChatsHaveSeparateOwners = true;
  report.checks.secondChatResumesSameIdentity = true;

  report.phase = 'fork-and-new-thread-isolation';
  const fork = await run('fork-A', ['fork', first.id, 'murmur-connect status']);
  assert.notEqual(fork.id, first.id);
  // Forks intentionally copy parent history. Check the new disconnected hook
  // result and absence of enrollment, not absence of historical parent text.
  assert(developerText(fork).includes('Murmur connection: disconnected.'), 'fork inherited an active parent connection');
  const freshThread = await run('new-unconnected', ['An unrelated owned fixture conversation.']);
  assert.notEqual(freshThread.id, first.id); assert.notEqual(freshThread.id, second.id);
  assert(!developerText(freshThread).includes('Murmur current-chat context refreshed automatically.'), 'fresh unconnected thread received linked context');
  const afterIsolation = await request(state, 'GET', '/v1/connections/requests');
  assert.equal(afterIsolation.length, requests.length, 'fork or new thread silently enrolled');
  report.checks.forkDoesNotInheritParentGrant = true;
  report.checks.newThreadDoesNotInheritGrantOrEnroll = true;

  report.phase = 'leave-preserves-independent-work';
  const left = await run('leave-A', ['resume', first.id, 'murmur-connect leave']);
  assert.equal(left.id, first.id);
  assert(developerText(left).includes('Murmur connection left. The existing task and native chat were preserved.'));
  const grants = await request(state, 'GET', `/v1/connections/grants?projectId=${project.id}`);
  const grantA = grants.find(grant => grant.id === approvedA.grant.id);
  const grantB = grants.find(grant => grant.id === approvedB.grant.id);
  assert(grantA && typeof grantA.revokedAt === 'number', 'leave did not revoke the original grant');
  assert(grantB && grantB.revokedAt === null, 'leave changed the independent chat grant');
  const current = await request(state, 'GET', `/v1/status?projectId=${project.id}`);
  assert(current.tasks.some(task => task.id === approvedA.member.taskId && task.ownerSessionId === approvedA.member.sessionId));
  assert(current.tasks.some(task => task.id === approvedB.member.taskId && task.ownerSessionId === approvedB.member.sessionId));
  const remaining = await run('ordinary-B-after-leave', ['resume', second.id, 'Continue the independent test work.']);
  assert.equal(remaining.id, second.id);
  assert(developerText(remaining).includes('Murmur current-chat context refreshed automatically.'));
  report.checks.leavePreservesTasksAndOtherGrant = true;
  report.checks.otherChatStillRefreshesAfterLeave = true;
  report.phase = 'complete';
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure = error instanceof Error ? error.message : 'fixture-failed';
  if (error && typeof error === 'object' && typeof error.code === 'string') report.errorCode = error.code;
  if (lastNative) report.nativeDiagnostic = { exit: lastNative.code, signal: lastNative.signal, timedOut: lastNative.timedOut, stderr: lastNative.err.slice(-5000), stdout: lastNative.out.slice(-3000) };
  process.exitCode = 1;
} finally {
  clearTimeout(total); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  for (const child of children) kill(child);
  const cleanupErrors = [];
  try { await daemon?.close(); } catch { cleanupErrors.push('fixture daemon close failed'); }
  try {
    if (mock) await new Promise(resolve => { mock.close(resolve); for (const socket of sockets) socket.destroy(); });
  } catch { cleanupErrors.push('static responder close failed'); }
  try { await rm(root, { recursive: true, force: true }); report.disposableStateRemoved = true; }
  catch { report.disposableStateRemoved = false; cleanupErrors.push('disposable state removal failed'); }
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.success = false; process.exitCode = 1; }
  report.mockRequests = providerRequests.length;
  report.rejectedHttpRequests = httpRequests - providerRequests.length;
}
console.log(JSON.stringify(report, null, 2));
