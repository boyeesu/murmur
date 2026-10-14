#!/usr/bin/env node
/**
 * Conservative existing-chat contract gate. No production client is imported.
 * Native observations and synthetic parser/scope checks are separate evidence.
 * A failed containment/trust/auth check is terminal: there is no fallback profile.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const EXPECTED_VERSION = '2.1.247';
const MAX_OUTPUT = 128 * 1024;
const MAX_INPUT = 16 * 1024;
const CHILD_MS = 8_000;
const MAX_MOCK_INPUT = 512 * 1024;
const SKILL_MARKER = 'MURMUR_NATIVE_SKILL_FIXTURE_V1';
const ARGUMENT_A = `start A quotes ' " ; $(touch SHOULD_NOT_EXIST) \`touch SHOULD_NOT_EXIST\` > output`;
const ARGUMENT_B = 'status B';
const activeChildren = new Set();
let interrupted = false;
function stopOwnedChildren() {
  interrupted = true;
  for (const child of activeChildren) child.kill('SIGKILL');
}
const CONTRACT_KEYS = [
  'currentActionHasHostIdentity', 'currentActionHasHostWorkspace',
  'actionArgumentsDeliveredWithoutShellInterpolation', 'repeatedActionsHaveFreshIdentity',
  'concurrentSameCwdChatsHaveDistinctBindings', 'nativeResumeRetainsVerifiedBinding',
  'nativeForkRejectsCopiedParentHandle', 'nativeClearRejectsCopiedParentHandle',
  'sameIdClearHasVerifiedInvalidation', 'preloadedSkillInvocation',
  'alreadyOpenSkillHotDiscovery', 'hookOrderingVerified',
];

function parseOptions(argv) {
  const options = { native: false, lifecycle: false, claude: undefined };
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error('usage');
    seen.add(arg);
    if (arg === '--native') options.native = true;
    else if (arg === '--lifecycle') { options.native = true; options.lifecycle = true; }
    else if (arg === '--self-test') { /* explicit spelling of the default */ }
    else if (arg === '--claude' && argv[i + 1] && isAbsolute(argv[i + 1])) options.claude = argv[++i];
    else throw new Error('usage');
  }
  if (options.claude && !options.native) throw new Error('usage');
  return options;
}

// This is an input-shape fixture, NOT proof that stdin actually came from Claude.
// A production transport must establish host provenance on each action separately.
function parseEnvelope(bytes) {
  if (bytes.length > MAX_INPUT) throw new Error('input');
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!data || Array.isArray(data) || typeof data !== 'object'
      || data.hook_event_name !== 'UserPromptSubmit'
      || typeof data.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(data.session_id)
      || typeof data.cwd !== 'string' || !isAbsolute(data.cwd) || /[\x00-\x1f\x7f]/.test(data.cwd)
      || typeof data.prompt !== 'string') throw new Error('input');
  return { sessionId: data.session_id, cwd: data.cwd, action: parseAction(data.prompt) };
}

// Free-form start text stays DATA. Never place it in a hook command, argv template,
// eval, shell, $ARGUMENTS, or a !`...` skill command. Other actions have exact arity.
function parseAction(prompt) {
  if (Buffer.byteLength(prompt) > 1024 || /[\x00-\x1f\x7f]/.test(prompt)) throw new Error('action');
  const match = /^\/murmur-probe (start|join|status|refresh|leave)(?: (.+))?$/.exec(prompt);
  if (!match) throw new Error('action');
  const [, action, argument] = match;
  if (action === 'start') {
    if (!argument || !argument.trim() || Buffer.byteLength(argument) > 512) throw new Error('action');
  } else if (action === 'join') {
    if (!argument || !/^[A-Za-z0-9_-]{8,64}$/.test(argument)) throw new Error('action');
  } else if (argument !== undefined) throw new Error('action');
  return { action, ...(argument === undefined ? {} : { argument }) };
}

// A *synthetic* scope predicate, not a credential store or native adapter. Neither
// a session ID nor a copied helper handle alone is authority. Incarnation must be
// derived from a VERIFIED native event; inventing one does not satisfy this gate.
function fixtureAuthorized(binding, observation, proof, lifecycleVerified) {
  return lifecycleVerified === true
    && binding.sessionId === observation.sessionId
    && binding.cwd === observation.cwd
    && binding.incarnation === observation.incarnation
    && typeof proof === 'string' && proof.length === binding.proof.length
    && Buffer.byteLength(proof) === Buffer.byteLength(binding.proof)
    && timingSafeEqual(Buffer.from(binding.proof), Buffer.from(proof));
}

function selfTest(cwd) {
  const payload = (prompt, patch = {}) => Buffer.from(JSON.stringify({
    hook_event_name: 'UserPromptSubmit', session_id: 'fixture-chat-a', cwd, prompt, ...patch,
  }));
  const adversarial = `quotes ' " ; $(touch NOT_EXECUTED) \`touch NOT_EXECUTED\` > output`;
  assert.equal(parseEnvelope(payload(`/murmur-probe start ${adversarial}`)).action.argument, adversarial);
  for (const action of ['status', 'refresh', 'leave']) {
    assert.deepEqual(parseEnvelope(payload(`/murmur-probe ${action}`)).action, { action });
    assert.throws(() => parseEnvelope(payload(`/murmur-probe ${action} copied-handle`)));
  }
  assert.equal(parseEnvelope(payload('/murmur-probe join ABCD-1234')).action.argument, 'ABCD-1234');
  for (const prompt of ['/murmur-probe', '/murmur-probe start', '/murmur-probe join x',
    '/murmur-probe --session-id parent', '/murmur-probe status\nstart x', '/murmur-probe start\0x']) {
    assert.throws(() => parseEnvelope(payload(prompt)));
  }
  for (const patch of [{ session_id: '../parent' }, { session_id: '' }, { cwd: 'relative' },
    { hook_event_name: 'SessionStart' }, { prompt: null }]) {
    assert.throws(() => parseEnvelope(payload('/murmur-probe status', patch)));
  }
  assert.throws(() => parseEnvelope(Buffer.alloc(MAX_INPUT + 1)));
  assert.throws(() => parseEnvelope(Buffer.from([0xff])));
  assert.throws(() => parseEnvelope(Buffer.from('{')));
  assert.deepEqual(parseEnvelope(payload('/murmur-probe status', {
    transcript_path: '/DO_NOT_READ', api_key: 'DUMMY-IGNORED', clientInfo: { name: 'shared' },
  })), { sessionId: 'fixture-chat-a', cwd, action: { action: 'status' } });

  const binding = { sessionId: 'fixture-chat-a', cwd, incarnation: 'before-clear', proof: randomBytes(24).toString('hex') };
  const current = { sessionId: binding.sessionId, cwd, incarnation: binding.incarnation };
  assert(fixtureAuthorized(binding, current, binding.proof, true));
  assert(!fixtureAuthorized(binding, current, '', true));
  assert(!fixtureAuthorized(binding, current, binding.proof, false));
  assert(!fixtureAuthorized(binding, { ...current, sessionId: 'fixture-chat-b' }, binding.proof, true));
  assert(!fixtureAuthorized(binding, { ...current, cwd: `${cwd}-other` }, binding.proof, true));
  assert(!fixtureAuthorized(binding, { ...current, incarnation: 'after-clear' }, binding.proof, true));
  return {
    fixtureOnly: true,
    nativeEvidence: false,
    boundedUtf8Envelope: true,
    actionTextIsData: true,
    unknownSelectorsAndExtraArgumentsRejected: true,
    transcriptAndClientInfoIgnored: true,
    privateProofRequired: true,
    differentChatAndWorkspaceRejected: true,
    simulatedClearInvalidatesOldHandle: true,
    unverifiedLifecycleFailsClosed: true,
  };
}

async function findClaude(given) {
  if (given) return realpath(given);
  // Resolve an executable only. Do not launch a login shell or inspect config.
  for (const dir of (process.env.PATH ?? '').split(':').filter(isAbsolute)) {
    const candidate = join(dir, 'claude');
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next */ }
  }
  return undefined;
}

function isolatedEnv(root, origin) {
  return {
    HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), TMPDIR: join(root, 'tmp'),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', TERM: 'dumb',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(origin ? { ANTHROPIC_API_KEY: 'DUMMY-EXISTING-CHAT-PROBE-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: origin,
      HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1,localhost' } : {}),
  };
}

async function boundedChild(binary, args, { cwd, env, milliseconds = CHILD_MS } = {}) {
  if (interrupted) throw new Error('interrupted');
  return new Promise((done) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    activeChildren.add(child);
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0, limited = false, timedOut = false, error = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, milliseconds);
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { limited = true; child.kill('SIGKILL'); }
      else chunks[name].push(chunk);
    });
    child.on('error', () => { error = true; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      done({ code, signal, error, limited, timedOut,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
  });
}

function summary(result) {
  return { exitCode: result.code, spawnFailed: result.error, timedOut: result.timedOut, outputLimitReached: result.limited };
}

// macOS-only deny-by-default containment. Real HOME, Keychain IPC, arbitrary
// sockets, and the repository are NOT in the content-read allowlist. System
// runtime libraries and the exact native executable are; writes stay in fixture.
function containmentProfile(root, binary, port) {
  return `(version 1)
(deny default)
(allow process-exec* process-fork sysctl-read file-read-metadata)
(allow file-read-data file-map-executable
  (subpath "/usr") (subpath "/bin") (subpath "/System")
  (subpath "/opt/homebrew") (subpath "/Library/Apple")
  (subpath "/private/etc") (subpath "/dev")
  (subpath ${JSON.stringify(root)}) (literal ${JSON.stringify(binary)}))
(allow file-write* (subpath ${JSON.stringify(root)}) (subpath "/dev"))
(allow dynamic-code-generation)
(allow signal (target self))
(allow network-outbound (remote ip "localhost:${port}"))
`;
}

function skillEvidence(bytes) {
  // Inspect only our disposable fixture's message markers. Never inspect headers,
  // system instructions, auth data, real histories, or persist the request body.
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const texts = [];
    function visit(value, depth = 0) {
      if (depth > 8 || texts.length > 256) return;
      if (typeof value === 'string') texts.push(value);
      else if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
      else if (value && typeof value === 'object') {
        visit(value.content, depth + 1);
        visit(value.text, depth + 1);
      }
    }
    visit(body.messages);
    const text = texts.join('\n');
    if (!text.includes(SKILL_MARKER)) return null;
    return {
      loaded: true,
      source: /fixture-source=(project|user|plugin)/.exec(text)?.[1],
      nativeId: /native-session-id=([A-Za-z0-9._:-]+)/.exec(text)?.[1],
      literalPlaceholder: text.includes('${CLAUDE_SESSION_ID}'),
      argumentA: text.includes(ARGUMENT_A), argumentB: text.includes(ARGUMENT_B),
    };
  } catch { return null; }
}

async function rejectingMock() {
  let rejectedRequests = 0;
  const evidence = [], sockets = new Set();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 1000, headersTimeout: 1000 }, (request, response) => {
    rejectedRequests++;
    if (rejectedRequests > 32) { request.destroy(); return; }
    let receivedBytes = 0;
    const chunks = [];
    const timer = setTimeout(() => request.destroy(), 1000);
    request.on('error', () => {});
    response.on('error', () => {});
    request.on('close', () => clearTimeout(timer));
    request.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_MOCK_INPUT) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      clearTimeout(timer);
      const observation = skillEvidence(Buffer.concat(chunks));
      if (observation) evidence.push(observation);
      response.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end('{"type":"error","error":{"type":"permission_error","message":"LOCAL MOCK: model calls disabled"}}');
    });
  });
  server.maxConnections = 8;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => { rejectedRequests++; socket.destroy(); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return {
    port: server.address().port, evidence,
    rejected: () => rejectedRequests,
    close: () => new Promise((ok) => { server.close(ok); for (const socket of sockets) socket.destroy(); }),
  };
}


async function staticResponseMock() {
  let requests = 0;
  const evidence = [], sockets = new Set();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 1500, headersTimeout: 1500 }, (request, response) => {
    requests++;
    if (requests > 32) { request.destroy(); return; }
    let received = 0;
    const chunks = [];
    const timer = setTimeout(() => request.destroy(), 1500);
    request.on('error', () => {});
    response.on('error', () => {});
    request.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_MOCK_INPUT) request.destroy(); else chunks.push(chunk);
    });
    request.on('end', () => {
      clearTimeout(timer);
      const observation = skillEvidence(Buffer.concat(chunks));
      if (observation) evidence.push(observation);
      const id = `msg_${randomUUID().replaceAll('-', '')}`;
      const stream = [
        ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-6', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL STATIC FIXTURE' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
      response.end(stream.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n'));
    });
  });
  server.maxConnections = 8;
  server.on('connection', (socket) => {
    sockets.add(socket); socket.setTimeout(2000, () => socket.destroy()); socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => { requests++; socket.destroy(); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return { port: server.address().port, evidence, requests: () => requests,
    close: () => new Promise((ok) => { server.close(ok); for (const socket of sockets) socket.destroy(); }) };
}

function nativeRows(output) {
  return output.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return [{ type: row.type, subtype: row.subtype, sessionId: row.session_id }];
    } catch { return []; }
  });
}

async function fullModeLifecycleProbe(root, binary) {
  const workspace = join(root, 'workspace'), plugin = join(root, 'full-plugin');
  const hookEvents = join(root, 'full-hook-events.ndjson'), hook = join(root, 'full-hook.mjs');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(plugin, 'skills', 'murmur-probe'), { recursive: true, mode: 0o700 });
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'murmur-native-full-probe', version: '0.0.0' }), { mode: 0o600, flag: 'wx' });
  const skill = '---\nname: murmur-probe\ndescription: Disposable current-action hook probe.\ndisable-model-invocation: true\n---\n'
    + `${SKILL_MARKER}\nnative-session-id=\${CLAUDE_SESSION_ID}\narguments-begin\n$ARGUMENTS\narguments-end\nfixture-source=plugin\n`;
  await writeFile(join(plugin, 'skills', 'murmur-probe', 'SKILL.md'), skill, { mode: 0o600, flag: 'wx' });
  const hookSource = `import {appendFile} from 'node:fs/promises';\nlet source='';for await(const chunk of process.stdin)source+=chunk;let input={};try{input=JSON.parse(source)}catch{}\n`
    + `const safe={hook_event_name:input.hook_event_name,session_id:input.session_id,cwd:input.cwd,source:input.source,prompt:typeof input.prompt==='string'?input.prompt.slice(0,4096):undefined};\n`
    + `await appendFile(${JSON.stringify(hookEvents)},JSON.stringify(safe)+'\\n');process.stdout.write('{}\\n');\n`;
  await writeFile(hook, hookSource, { mode: 0o600, flag: 'wx' });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(hook)}`;
  const settings = join(root, 'full-settings.json');
  await writeFile(settings, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
  } }), { mode: 0o600, flag: 'wx' });
  const mock = await staticResponseMock();
  const env = isolatedEnv(root, `http://127.0.0.1:${mock.port}`);
  const common = ['--print', '--verbose', '--output-format', 'stream-json', '--include-hook-events', '--setting-sources', '', '--settings', settings,
    '--plugin-dir', plugin, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome'];
  const run = async (args) => {
    const result = await boundedChild(binary, [...common, ...args], { cwd: workspace, env, milliseconds: 12_000 });
    return { result, summary: summary(result), rows: nativeRows(result.stdout) };
  };
  const readEvents = async () => {
    try { return (await readFile(hookEvents, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  try {
    const original = randomUUID();
    const fresh = await run(['--session-id', original, '/murmur-native-full-probe:murmur-probe start fresh']);
    const freshEvents = await readEvents();
    const resume = await run(['--resume', original, '/murmur-native-full-probe:murmur-probe status resumed']);
    const afterResume = await readEvents();
    const fork = await run(['--resume', original, '--fork-session', '/murmur-native-full-probe:murmur-probe status forked']);
    const afterFork = await readEvents();
    const clear = await run(['--resume', original, '/clear']);
    const afterClear = await readEvents();
    const resumeEvents = afterResume.slice(freshEvents.length), forkEvents = afterFork.slice(afterResume.length), clearEvents = afterClear.slice(afterFork.length);
    const freshPrompt = freshEvents.find((row) => row.hook_event_name === 'UserPromptSubmit');
    const resumePrompt = resumeEvents.find((row) => row.hook_event_name === 'UserPromptSubmit');
    const forkStart = forkEvents.find((row) => row.hook_event_name === 'SessionStart');
    const forkPrompt = forkEvents.find((row) => row.hook_event_name === 'UserPromptSubmit');
    const clearStart = clearEvents.find((row) => row.hook_event_name === 'SessionStart' && row.source === 'clear');
    const clearReset = clear.rows.find((row) => row.type === 'conversation_reset');
    const successful = [fresh, resume, fork, clear].every((entry) => entry.result.code === 0 && !entry.result.timedOut && !entry.result.limited);
    return {
      attempted: true, successful, mockRequests: mock.requests(),
      fixtureCredentialSource: 'explicit-dummy-api-key', userProfilePathsInherited: false,
      fresh: fresh.summary, resume: resume.summary, fork: fork.summary, clear: clear.summary,
      sessionStartHookExecuted: freshEvents.some((row) => row.hook_event_name === 'SessionStart' && row.source === 'startup' && row.session_id === original),
      userPromptHookExecuted: Boolean(freshPrompt && freshPrompt.session_id === original && freshPrompt.cwd === workspace),
      rawNamespacedCommandObserved: freshPrompt?.prompt === '/murmur-native-full-probe:murmur-probe start fresh',
      resumeRetainedSessionId: Boolean(resumePrompt?.session_id === original && resumeEvents.some((row) => row.source === 'resume')),
      forkCreatedNewSessionId: Boolean(forkStart?.source === 'fork' && forkStart.session_id && forkStart.session_id !== original && forkPrompt?.session_id === forkStart.session_id),
      clearCreatedNewSessionId: Boolean(clearReset?.sessionId === original && clearStart?.session_id && clearStart.session_id !== original),
      clearSourceObserved: Boolean(clearStart),
      fullModeSkillExpandedAtMock: mock.evidence.some((row) => row.source === 'plugin' && row.nativeId),
      stderrClean: [fresh, resume, fork, clear].every((entry) => entry.result.stderr === ''),
    };
  } finally { await mock.close(); }
}

async function bareSkillProbe(root, binary, mock) {
  const content = '---\nname: murmur-probe\ndescription: Disposable explicit native metadata probe.\n'
    + 'disable-model-invocation: true\n---\n' + SKILL_MARKER
    + '\nnative-session-id=${CLAUDE_SESSION_ID}\narguments-begin\n$ARGUMENTS\narguments-end\n';
  // Both locations belong to the empty disposable fixture, never to the user.
  const projectSkill = join(root, 'workspace', '.claude', 'skills', 'murmur-probe');
  const userSkill = join(root, 'config', 'skills', 'murmur-user-probe');
  await mkdir(projectSkill, { recursive: true, mode: 0o700 });
  await mkdir(userSkill, { recursive: true, mode: 0o700 });
  await writeFile(join(projectSkill, 'SKILL.md'), content + '\nfixture-source=project\n', { mode: 0o600, flag: 'wx' });
  await writeFile(join(userSkill, 'SKILL.md'), content.replace('name: murmur-probe', 'name: murmur-user-probe') + '\nfixture-source=user\n', { mode: 0o600, flag: 'wx' });
  const plugin = join(root, 'plugin');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(plugin, 'skills', 'murmur-probe'), { recursive: true, mode: 0o700 });
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'murmur-native-probe', version: '0.0.0' }), { mode: 0o600, flag: 'wx' });
  await writeFile(join(plugin, 'skills', 'murmur-probe', 'SKILL.md'), content + '\nfixture-source=plugin\n', { mode: 0o600, flag: 'wx' });
  const env = isolatedEnv(root, `http://127.0.0.1:${mock.port}`);
  const run = async (name, argument, pluginDir) => {
    const result = await boundedChild(binary, ['--bare', '--print', '--verbose', '--output-format', 'stream-json',
      '--no-session-persistence', '--setting-sources', 'user,project,local',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
      ...(pluginDir ? ['--plugin-dir', pluginDir] : []), `/${name} ${argument}`],
    { cwd: join(root, 'workspace'), env });
    let nativeId, workspaceMatches = false;
    for (const line of result.stdout.split('\n')) {
      try {
        const row = JSON.parse(line);
        if (row.type === 'system' && row.subtype === 'init' && typeof row.session_id === 'string') {
          nativeId = row.session_id;
          workspaceMatches = row.cwd === join(root, 'workspace');
        }
      } catch { /* not a native structured init event */ }
    }
    return { nativeId, result: {
      ...summary(result), nativeInitIdPresent: Boolean(nativeId), nativeInitWorkspaceMatches: workspaceMatches,
      skillUnknown: /unknown skill|unknown command/i.test(result.stdout + result.stderr),
      authBlocked: /not logged in|authentication required|invalid api key/i.test(result.stdout + result.stderr),
      localRejectionObserved: /LOCAL MOCK/.test(result.stdout + result.stderr),
    } };
  };
  const observationsBefore = mock.evidence.length;
  const [a, b] = await Promise.all([run('murmur-probe', ARGUMENT_A), run('murmur-user-probe', ARGUMENT_B)]);
  const [pluginA, pluginB] = await Promise.all([
    run('murmur-native-probe:murmur-probe', ARGUMENT_A, plugin),
    run('murmur-native-probe:murmur-probe', ARGUMENT_B, plugin),
  ]);
  const evidence = mock.evidence.slice(observationsBefore).filter((row) => row.source === 'plugin');
  const invocationA = evidence.filter((row) => row.argumentA);
  const invocationB = evidence.filter((row) => row.argumentB);
  const sideEffects = await Promise.all(['SHOULD_NOT_EXIST', 'output'].map(async (name) => {
    try { await access(join(root, 'workspace', name)); return true; } catch { return false; }
  }));
  return {
    attempted: true, mode: 'bare-headless-skill-only', hooksEnabled: false,
    projectSkill: a.result, isolatedUserSkill: b.result,
    explicitPluginSkillA: pluginA.result, explicitPluginSkillB: pluginB.result,
    skillExpansionObserved: evidence.some((row) => row.loaded),
    sessionTemplateSubstituted: evidence.some((row) => row.nativeId && !row.literalPlaceholder),
    substitutedIdMatchesOwnInvocation: invocationA.length > 0 && invocationB.length > 0
      && invocationA.every((row) => row.nativeId === pluginA.nativeId && !row.argumentB)
      && invocationB.every((row) => row.nativeId === pluginB.nativeId && !row.argumentA),
    concurrentSameCwdStreamIdsDistinct: Boolean(a.nativeId && b.nativeId && a.nativeId !== b.nativeId),
    concurrentPluginChatIdsDistinct: Boolean(pluginA.nativeId && pluginB.nativeId && pluginA.nativeId !== pluginB.nativeId),
    adversarialArgumentsPreserved: evidence.some((row) => row.argumentA),
    secondArgumentsPreserved: evidence.some((row) => row.argumentB),
    shellSideEffectsAbsent: sideEffects.every((exists) => !exists),
    deterministicHelperActionExecuted: false,
    currentChatAuthorizationVerified: false,
    hotDiscoveryAttempted: false,
  };
}

async function nativeProbe(root, options) {
  const report = {
    requested: true, expectedVersion: EXPECTED_VERSION, observedVersion: null,
    helpConfirmed: false, exactVersionConfirmed: false, containmentPreflightPassed: false,
    fullModeRuntimeStarted: false, productionAdapterEnabled: false,
    contract: Object.fromEntries(CONTRACT_KEYS.map((key) => [key, false])),
    experiments: {
      preloadedSkill: { attempted: false, verified: false },
      alreadyOpenHotDiscovery: { attempted: false, verified: false },
      nativeResume: { attempted: false, verified: false },
      nativeFork: { attempted: false, verified: false },
      nativeClear: { attempted: false, verified: false },
    },
    blocker: null,
  };
  const binary = await findClaude(options.claude);
  if (!binary) { report.blocker = 'native-executable-unavailable'; return report; }
  const cwd = join(root, 'workspace');
  const env = isolatedEnv(root);
  const version = await boundedChild(binary, ['--version'], { cwd, env });
  const help = await boundedChild(binary, ['--help'], { cwd, env });
  report.versionProcess = summary(version);
  report.helpProcess = summary(help);
  report.observedVersion = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(version.stdout)?.[1] ?? null;
  report.exactVersionConfirmed = version.code === 0 && report.observedVersion === EXPECTED_VERSION;
  report.helpConfirmed = help.code === 0 && ['--settings', '--setting-sources', '--resume', '--fork-session', '--bare']
    .every((flag) => help.stdout.includes(flag));
  report.helpFacts = {
    bareSkipsHooksAndKeychain: /skip hooks/.test(help.stdout) && /keychain are never read/.test(help.stdout),
    bareRetainsSkillSyntax: /Skills still resolve via\s+\/skill-name/.test(help.stdout),
    noninteractiveSkipsTrustDialog: /workspace trust dialog\s+is skipped/.test(help.stdout),
    forkFlagPromisesNewSessionId: /--fork-session\s+When resuming, create a new session ID/.test(help.stdout),
  };
  if (!report.exactVersionConfirmed || !report.helpConfirmed) { report.blocker = 'version-or-help-contract-mismatch'; return report; }
  if (options.lifecycle) {
    // Explicit runtime-contract experiment in the enclosing sandbox. This mode
    // uses an empty profile and dummy local transport; it does not claim an
    // additional OS sandbox or enable a production adapter.
    report.isolation = 'enclosing-sandbox-empty-profile-dummy-local-transport';
    report.fullMode = await fullModeLifecycleProbe(root, binary);
    report.fullModeRuntimeStarted = true;
    report.experiments.preloadedSkill = { attempted: true, verified: report.fullMode.fullModeSkillExpandedAtMock, mode: 'full-headless-static-local-response' };
    report.experiments.nativeResume = { attempted: true, verified: report.fullMode.resumeRetainedSessionId, scope: 'native-id-only' };
    report.experiments.nativeFork = { attempted: true, verified: report.fullMode.forkCreatedNewSessionId, scope: 'native-id-only' };
    report.experiments.nativeClear = { attempted: true, verified: report.fullMode.clearCreatedNewSessionId, scope: 'native-id-only' };
    report.contract.currentActionHasHostIdentity = report.fullMode.userPromptHookExecuted;
    report.contract.currentActionHasHostWorkspace = report.fullMode.userPromptHookExecuted;
    report.contract.preloadedSkillInvocation = report.fullMode.fullModeSkillExpandedAtMock;
    report.blocker = report.fullMode.successful ? 'production-connector-integration-still-required' : 'native-lifecycle-contract-failed';
    return report;
  }
  if (process.platform !== 'darwin') { report.blocker = 'no-verified-private-file-and-network-containment-on-this-platform'; return report; }

  const mock = await rejectingMock();
  try {
    if (report.helpFacts.bareSkipsHooksAndKeychain && report.helpFacts.bareRetainsSkillSyntax) {
      report.bareSkill = await bareSkillProbe(root, binary, mock);
      report.experiments.preloadedSkill = { attempted: true, verified: report.bareSkill.skillExpansionObserved, mode: 'bare-headless-only' };
      report.contract.preloadedSkillInvocation = report.bareSkill.skillExpansionObserved;
    }
    const profile = join(root, 'containment.sb');
    await writeFile(profile, containmentProfile(root, binary, mock.port), { mode: 0o600, flag: 'wx' });
    const containment = await boundedChild('/usr/bin/sandbox-exec', ['-f', profile, binary, '--version'], {
      cwd, env: isolatedEnv(root, `http://127.0.0.1:${mock.port}`),
    });
    report.containmentProcess = summary(containment);
    if (containment.code !== 0) {
      report.blocker = /sandbox_(apply|init): Operation not permitted/.test(containment.stderr)
        ? 'os-denied-nested-containment-before-native-launch' : 'native-containment-preflight-failed';
      return report; // No full-mode fallback: the distinct bare skill experiment is not a hook substitute.
    }
    report.containmentPreflightPassed = true;
    // Passing --version proves startup only, not enforcement or trust. The runtime
    // action/lifecycle driver must be reviewed and added on a host that can run the
    // containment prerequisite. Do not claim unexecuted experiments are passing.
    report.blocker = 'interactive-action-and-lifecycle-driver-not-yet-verified';
    return report;
  } finally {
    report.localMockRejectedRequests = mock.rejected();
    await mock.close();
    report.localMockClosed = true;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/probe-existing-chat.mjs [--self-test] [--native | --lifecycle] [--claude /absolute/native/executable]\n'
      + 'Defaults to synthetic checks only. --native adds isolated help/version, bare headless skills, and full-mode containment preflight;\n'
      + 'it cannot enable an adapter. No real provider calls, user credentials, user histories, bypass flags, or global installation.');
    return;
  }
  if (!process.env.TMPDIR || !isAbsolute(process.env.TMPDIR)) throw new Error('TMPDIR-required');
  const root = await mkdtemp(join(await realpath(process.env.TMPDIR), 'murmur-existing-chat-probe-'));
  const deadline = setTimeout(stopOwnedChildren, options.lifecycle ? 75_000 : 45_000);
  process.on('SIGINT', stopOwnedChildren);
  process.on('SIGTERM', stopOwnedChildren);
  const report = { schemaVersion: 1, nodeVersion: process.versions.node, platform: process.platform, productionAdapterEnabled: false };
  try {
    await chmod(root, 0o700);
    for (const part of ['home', 'config', 'workspace', 'tmp', 'xdg-config', 'xdg-data', 'xdg-cache']) {
      await mkdir(join(root, part), { mode: 0o700 });
    }
    report.synthetic = selfTest(join(root, 'workspace'));
    report.native = options.native ? await nativeProbe(root, options) : { requested: false, productionAdapterEnabled: false };
    if (interrupted) throw new Error('interrupted');
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', stopOwnedChildren);
    process.off('SIGTERM', stopOwnedChildren);
    for (const child of activeChildren) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
    report.disposableStateRemoved = true;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => {
  // Never print native output, arbitrary paths, command arguments, or error stacks.
  console.error(JSON.stringify({ probeFailed: true, productionAdapterEnabled: false,
    message: 'Probe stopped. Check arguments, executable availability, TMPDIR, and local containment permissions; no fallback was attempted.' }));
  process.exitCode = 1;
});
