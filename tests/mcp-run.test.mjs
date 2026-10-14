import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { loadDescriptor, request } from '../packages/murmur/dist/cli/client.js';
import { temporary, repository, git } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const dependencyManifest = fileURLToPath(new URL('../package.json', import.meta.url));
const resultPrefix = 'MURMUR_FAKE_MCP_RESULT ';

// Serialized into temporary fake native binaries. Only these test hosts resolve
// the source project's private SDK dependencies; all Murmur operations go through
// the generated configuration and production public CLI, never imported helpers.
async function fakeNative(configuration) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createHash, randomUUID } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { execFileSync } = require('node:child_process');
  const tool = configuration.tool;
  if (process.argv.includes('--version')) {
    console.log(tool === 'claude' ? '2.1.247 (Claude Code)' : 'codex-cli 0.154.0');
    return;
  }
  if (process.argv.includes('--help')) {
    console.log(tool === 'claude'
      ? 'Usage: claude [PROMPT] --session-id --append-system-prompt --mcp-config --settings'
      : 'Usage: codex [PROMPT] --cd --config -c');
    return;
  }

  let stage = 'managed environment';
  let client;
  try {
    const argv = process.argv.slice(2);
    const connection = JSON.parse(process.env.MURMUR_AGENT_CONNECTION);
    const scopedNames = ['MURMUR_AGENT_MODE', 'MURMUR_AGENT_CONNECTION'];
    const hookNames = ['MURMUR_HOOK_WORKSPACE', 'MURMUR_HOOK_STATE_DIR', 'MURMUR_HOOK_NATIVE_SESSION_ID'];
    const murmurNames = Object.keys(process.env).filter(name => name.toUpperCase().startsWith('MURMUR_'));
    assert.deepEqual(murmurNames.sort(), [...scopedNames, ...(tool === 'claude' ? hookNames : [])].sort());
    assert.equal(process.env.MURMUR_AGENT_MODE, '1');
    assert.match(connection.agentToken, /^[A-Za-z0-9_-]{43}$/);
    assert(!JSON.stringify(argv).includes(connection.agentToken));
    assert.equal(process.env.TMPDIR, configuration.temporaryRoot);
    assert.equal(process.env.HOME, configuration.nativeHome);
    const workspace = fs.realpathSync(process.cwd());
    assert.notEqual(workspace, configuration.source);
    const relative = (root, candidate) => {
      const value = path.relative(root, candidate);
      return value === '' || (!path.isAbsolute(value) && value !== '..' && !value.startsWith('..' + path.sep));
    };
    const argument = flag => {
      assert.equal(argv.filter(value => value === flag).length, 1);
      const value = argv[argv.indexOf(flag) + 1];
      assert.equal(typeof value, 'string');
      return value;
    };
    const privateFile = filename => {
      assert(path.isAbsolute(filename));
      assert(relative(configuration.temporaryRoot, fs.realpathSync(filename)));
      assert(!relative(workspace, filename));
      const info = fs.lstatSync(filename);
      assert(info.isFile() && !info.isSymbolicLink());
      assert.equal(info.mode & 0o077, 0);
      assert.equal(fs.statSync(path.dirname(filename)).mode & 0o077, 0);
      const text = fs.readFileSync(filename, 'utf8');
      assert(!text.includes(connection.agentToken));
      return JSON.parse(text);
    };
    const expectedServer = 'murmur_' + createHash('sha256').update(connection.launchId).digest('hex').slice(0, 12);
    const configPaths = [];
    let server, settings;
    const forwarded = {};

    stage = 'generated native configuration';
    if (tool === 'claude') {
      const filename = argument('--mcp-config');
      configPaths.push(filename);
      const config = privateFile(filename);
      assert.deepEqual(Object.keys(config), ['mcpServers']);
      assert.deepEqual(Object.keys(config.mcpServers), [expectedServer]);
      server = config.mcpServers[expectedServer];
      assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'env', 'type']);
      assert.equal(server.type, 'stdio');
      assert.deepEqual(Object.keys(server.env).sort(), scopedNames.slice().sort());
      for (const name of scopedNames) {
        assert.equal(server.env[name], '${' + name + '}');
        // Model the host's documented interpolation, not literal placeholder forwarding.
        forwarded[name] = process.env[name];
      }
      const settingsPath = argument('--settings');
      configPaths.push(settingsPath);
      settings = privateFile(settingsPath);
      assert.deepEqual(Object.keys(settings), ['hooks']);
      assert.deepEqual(Object.keys(settings.hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
      assert.equal(argument('--session-id'), process.env.MURMUR_HOOK_NATIVE_SESSION_ID);
      assert.equal(process.env.MURMUR_HOOK_WORKSPACE, workspace);
      assert.match(argument('--append-system-prompt'), /Prefer murmur_get_context, murmur_declare_intent and murmur_check_plan/);
    } else {
      const values = {};
      for (let index = 0; index < argv.length; index++) {
        if (argv[index] !== '-c') continue;
        const directive = argv[++index];
        const match = /^mcp_servers\.([A-Za-z0-9_]+)\.(command|args|cwd|env_vars)=(.+)$/.exec(directive);
        assert(match);
        assert.equal(match[1], expectedServer);
        assert(!Object.hasOwn(values, match[2]));
        values[match[2]] = JSON.parse(match[3]);
      }
      assert.deepEqual(Object.keys(values).sort(), ['args', 'command', 'cwd', 'env_vars']);
      server = values;
      assert.deepEqual(server.env_vars, scopedNames);
      for (const name of server.env_vars) forwarded[name] = process.env[name];
      assert.equal(server.cwd, workspace);
      assert.equal(argument('--cd'), workspace);
      assert.match(argv.at(-1), /Prefer murmur_get_context, murmur_declare_intent and murmur_check_plan/);
      assert(!argv.includes('--settings') && !argv.includes('--mcp-config'));
    }
    assert.equal(server.command, configuration.node);
    assert.deepEqual(server.args, [configuration.cli, 'mcp', 'serve']);
    assert.deepEqual(Object.keys(forwarded).sort(), scopedNames.slice().sort());
    for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--yolo', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']) {
      assert(!argv.includes(flag));
    }

    stage = 'official SDK initialization';
    const projectRequire = createRequire(configuration.dependencyManifest);
    const { Client } = projectRequire('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = projectRequire('@modelcontextprotocol/sdk/client/stdio.js');
    const { CallToolResultSchema } = projectRequire('@modelcontextprotocol/sdk/types.js');
    // Never spread the native environment into its MCP child. In particular the
    // host-only hook cache variables and any human capability are not forwarded.
    const childEnv = { PATH: process.env.PATH, HOME: configuration.nativeHome,
      TMPDIR: configuration.temporaryRoot, ...forwarded };
    const transport = new StdioClientTransport({ command: server.command, args: server.args,
      cwd: server.cwd ?? workspace, env: childEnv, stderr: 'pipe' });
    const wire = [], protocolErrors = [];
    let stderr = '';
    transport.onmessage = message => wire.push(message);
    transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
    client = new Client({ name: 'fake-' + tool + '-native-host', version: '1.0.0' });
    client.onerror = error => protocolErrors.push(error.message);
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'murmur', version: '0.3.0' });
    const listed = (await client.listTools()).tools;
    for (const name of ['murmur_get_context', 'murmur_declare_intent', 'murmur_check_plan']) {
      assert(listed.some(tool => tool.name === name && tool.inputSchema.additionalProperties === false));
    }
    for (const name of ['murmur_accept_decision', 'murmur_register', 'murmur_heartbeat', 'murmur_read_file']) {
      assert(!listed.some(tool => tool.name === name));
    }
    const invoke = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 10000 });
      assert.notEqual(result.isError, true);
      assert(result.content.length > 0 && result.content[0].type === 'text');
      const value = JSON.parse(result.content[0].text);
      assert.deepEqual(value, result.structuredContent);
      assert(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024);
      assert(!JSON.stringify(result).includes(connection.agentToken));
      return value;
    };

    stage = 'scoped MCP context and declaration';
    const initial = await invoke('murmur_get_context');
    assert.equal(initial.task.id, connection.taskId);
    assert.equal(initial.task.ownerSessionId, connection.sessionId);
    const declaredPaths = ['src/' + tool + '.ts'];
    const declaration = { revision: initial.task.revision, writes: declaredPaths,
      produces: [{ key: 'fake-native-mcp-contract', version: 'v1', value: '202' }], requestId: randomUUID() };
    const intent = await invoke('murmur_declare_intent', declaration);
    assert.equal(intent.task.id, connection.taskId);
    assert(intent.task.revision > initial.task.revision);
    assert.deepEqual(await invoke('murmur_declare_intent', declaration), intent);
    fs.writeFileSync(path.join(configuration.signals, tool), connection.taskId, { flag: 'wx' });
    const peer = tool === 'claude' ? 'codex' : 'claude';
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(configuration.signals, peer))) {
      if (Date.now() >= deadline) throw new Error('Fixture peer did not arrive.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    stage = 'shared coordination and plan check';
    const updated = await invoke('murmur_get_context');
    assert(updated.alerts.some(alert => alert.kind === 'duplicate_contract_producers'));
    await invoke('murmur_check_plan', { title: 'Advisory ' + tool + ' candidate', writes: declaredPaths,
      produces: [{ key: 'fake-native-mcp-contract', version: 'v1', value: '202' }], requestId: randomUUID() });

    let hookEvent = null, hookStateDirectory = null;
    if (tool === 'claude') {
      stage = 'generated trusted context hook';
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      for (const event of Object.keys(settings.hooks)) {
        const entries = settings.hooks[event];
        assert.equal(entries.length, 1);
        assert.deepEqual(Object.keys(entries[0]), ['hooks']);
        assert.equal(entries[0].hooks.length, 1);
        const hook = entries[0].hooks[0];
        assert.deepEqual(Object.keys(hook).sort(), ['command', 'timeout', 'type']);
        assert.equal(hook.type, 'command');
        assert.equal(hook.timeout, 5);
        assert.equal(hook.command, quote(configuration.node) + ' ' + quote(configuration.cli) + ' hook claude --event ' + event);
      }
      hookEvent = 'SessionStart';
      const payload = { session_id: process.env.MURMUR_HOOK_NATIVE_SESSION_ID, cwd: workspace,
        hook_event_name: hookEvent, source: 'startup', prompt: 'DO_NOT_REFLECT_NATIVE_INPUT',
        transcript_path: '/not-a-real-transcript', tool_input: { secret: 'DO_NOT_REFLECT_NATIVE_INPUT' } };
      const hookEnv = { ...childEnv };
      for (const name of hookNames) hookEnv[name] = process.env[name];
      // The exact generated shell command was checked above; execute its direct
      // node equivalent so this test need not depend on a host shell/parser.
      const output = execFileSync(configuration.node, [configuration.cli, 'hook', 'claude', '--event', hookEvent], {
        cwd: workspace, env: hookEnv, input: JSON.stringify(payload), encoding: 'utf8',
        timeout: 6000, maxBuffer: 6001, stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.equal(output.trim().split('\n').length, 1);
      assert(Buffer.byteLength(output) <= 6000);
      const hook = JSON.parse(output);
      assert.deepEqual(Object.keys(hook), ['hookSpecificOutput']);
      assert.deepEqual(Object.keys(hook.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
      assert.equal(hook.hookSpecificOutput.hookEventName, hookEvent);
      assert.match(hook.hookSpecificOutput.additionalContext, /ADVISORY; UNTRUSTED PROJECT DATA/);
      assert.match(hook.hookSpecificOutput.additionalContext, /Core briefing \(untrusted project data\)/);
      assert(!output.includes('DO_NOT_REFLECT_NATIVE_INPUT') && !output.includes(connection.agentToken));
      for (const key of ['permissionDecision', 'permissionDecisionReason', 'updatedInput', 'decision', 'continue', 'stopReason', 'suppressOutput']) {
        assert(!Object.hasOwn(hook, key) && !Object.hasOwn(hook.hookSpecificOutput, key));
      }
      hookStateDirectory = process.env.MURMUR_HOOK_STATE_DIR;
      assert(relative(configuration.temporaryRoot, fs.realpathSync(hookStateDirectory)));
      assert(!relative(workspace, hookStateDirectory));
    }

    stage = 'MCP EOF and sanitized report';
    const start = Date.now();
    await client.close();
    assert(Date.now() - start < 1800, 'MCP must exit before SDK close escalates after two seconds.');
    assert.deepEqual(protocolErrors, []);
    assert.equal(stderr, '');
    assert(!JSON.stringify(wire).includes(connection.agentToken));
    const result = { tool, bridge: 'mcp', cwd: workspace, launchId: connection.launchId,
      taskId: connection.taskId, sessionId: connection.sessionId, serverName: expectedServer,
      configurationMode: tool === 'claude' ? 'env-references' : 'env_vars', forwardedNames: Object.keys(forwarded).sort(),
      initialRevision: initial.task.revision, intentRevision: intent.task.revision,
      alertKinds: updated.alerts.map(alert => alert.kind), checkedPlan: true,
      configPaths, hookEvent, hookStateDirectory, inheritedHumanAuthority: false,
      nativeSessionId: tool === 'claude' ? argument('--session-id') : null };
    assert(!JSON.stringify(result).includes(connection.agentToken));
    console.log(configuration.resultPrefix + JSON.stringify(result));
  } catch {
    // Assertion diffs/SDK errors could contain credentials. Emit only a fixed
    // stage label; the outer test never receives native environment or raw errors.
    console.error('MURMUR_FAKE_MCP_FAILURE ' + stage);
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

test('production run --bridge mcp connects fake Claude/Codex hosts and Claude advisory hooks', { timeout: 60000 }, async t => {
  const root = await realpath(await temporary(t));
  const state = path.join(root, 'state'), bin = path.join(root, 'bin'), signals = path.join(root, 'signals');
  const temporaryRoot = path.join(root, 'launch-temporary'), nativeHome = path.join(root, 'native-home');
  for (const directory of [bin, signals, temporaryRoot, nativeHome]) await mkdir(directory);
  const source = await realpath(await repository(path.join(root, 'source')));
  const original = git(source, 'rev-parse', 'HEAD');
  // Fixture-only native settings prove launch-local integration does not rewrite
  // user settings. No real home, provider account, native executable, or model is used.
  const nativeSettings = new Map([
    [path.join(nativeHome, '.claude', 'settings.json'), '{"fixture":"leave native permissions alone"}\n'],
    [path.join(nativeHome, '.codex', 'config.toml'), '# fixture native settings: leave untouched\n'],
  ]);
  for (const [filename, contents] of nativeSettings) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  for (const tool of ['claude', 'codex']) {
    const configuration = { tool, node: process.execPath, cli, dependencyManifest,
      source, signals, temporaryRoot, nativeHome, resultPrefix };
    const filename = path.join(bin, tool);
    await writeFile(filename, `#!${process.execPath}\nvoid (${fakeNative.toString()})(${JSON.stringify(configuration)});\n`);
    await chmod(filename, 0o755);
  }
  const daemon = await startDaemon(state);
  let runs = [];
  try {
    const project = await request(state, 'POST', '/v1/projects', { root: source });
    const descriptor = await loadDescriptor(state);
    const supervisorSentinel = 'outer-supervisor-fixture-do-not-inherit';
    const lowerCaseSentinel = 'outer-lowercase-fixture-do-not-inherit';
    const childEnvironment = {
      PATH: bin + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin'), HOME: nativeHome,
      TMPDIR: temporaryRoot, MURMUR_HOME: state, MURMUR_ADMIN_TOKEN: descriptor.token,
      MURMUR_SUPERVISOR_TOKEN: supervisorSentinel, murmur_private_token: lowerCaseSentinel,
    };
    const requestIds = ['claude', 'codex'].map(() => randomUUID());
    runs = ['claude', 'codex'].map((tool, index) => execute(process.execPath, [cli, 'run', tool,
      '--project', project.id, '--title', 'Fake MCP ' + tool + ' work', '--request-id', requestIds[index],
      '--bridge', 'mcp', ...(tool === 'claude' ? ['--context-hooks'] : [])], {
      cwd: source, env: childEnvironment, timeout: 45000, maxBuffer: 1024 * 1024,
    }));
    const completed = await Promise.all(runs);
    const results = completed.map((output, index) => {
      const lines = output.stdout.split('\n').filter(line => line.startsWith(resultPrefix));
      assert.equal(lines.length, 1, 'each fake host must report one completed SDK journey');
      assert.match(output.stderr, new RegExp(requestIds[index]));
      for (const secret of [descriptor.token, supervisorSentinel, lowerCaseSentinel]) {
        assert(!output.stdout.includes(secret) && !output.stderr.includes(secret));
      }
      return JSON.parse(lines[0].slice(resultPrefix.length));
    });
    assert.notEqual(results[0].cwd, results[1].cwd);
    assert.notEqual(results[0].serverName, results[1].serverName);
    for (const result of results) {
      assert.equal(result.bridge, 'mcp');
      assert.notEqual(result.cwd, source);
      assert.equal(result.inheritedHumanAuthority, false);
      assert.deepEqual(result.forwardedNames, ['MURMUR_AGENT_CONNECTION', 'MURMUR_AGENT_MODE']);
      assert(result.intentRevision > result.initialRevision);
      assert(result.alertKinds.includes('duplicate_contract_producers'));
      assert.equal(result.checkedPlan, true);
      assert.equal(git(result.cwd, 'rev-parse', 'HEAD'), original);
      assert.equal(git(result.cwd, 'status', '--porcelain'), '', 'MCP/hook setup must not edit the managed workspace');
      for (const filename of result.configPaths) await assert.rejects(lstat(filename), { code: 'ENOENT' });
    }
    const claude = results.find(result => result.tool === 'claude');
    const codex = results.find(result => result.tool === 'codex');
    assert.equal(claude.configurationMode, 'env-references');
    assert.equal(codex.configurationMode, 'env_vars');
    assert.equal(claude.hookEvent, 'SessionStart');
    assert.equal(codex.hookEvent, null);
    assert.equal(codex.hookStateDirectory, null);
    const cacheFiles = await readdir(claude.hookStateDirectory);
    assert.equal(cacheFiles.length, 1, 'only generated hook metadata should be retained');
    assert.match(cacheFiles[0], /^[a-f0-9]{64}\.json$/);
    const cache = JSON.parse(await readFile(path.join(claude.hookStateDirectory, cacheFiles[0]), 'utf8'));
    assert.deepEqual(Object.keys(cache).sort(), ['cursor', 'fingerprint', 'generatedAt', 'version']);
    assert.equal(cache.version, 1);
    assert.equal((await lstat(claude.hookStateDirectory)).mode & 0o077, 0);
    assert.equal((await lstat(path.join(claude.hookStateDirectory, cacheFiles[0]))).mode & 0o077, 0);
    const status = await request(state, 'GET', `/v1/status?projectId=${project.id}`);
    assert.equal(status.launches.length, 2);
    assert(status.launches.every(launch => launch.state === 'ended'));
    assert(status.sessions.every(session => session.credentialMode === 'managed'));
    assert(status.tasks.every(task => task.status === 'active'));
    for (const result of results) {
      const launch = status.launches.find(launch => launch.id === result.launchId);
      assert.equal(launch.taskId, result.taskId);
      assert.equal(launch.sessionId, result.sessionId);
      assert.equal(launch.workspaceRoot, result.cwd);
      assert.equal(launch.nativeSessionId, result.nativeSessionId);
    }
    assert.equal(git(source, 'rev-parse', 'HEAD'), original);
    assert.equal(git(source, 'status', '--porcelain'), '');
    for (const [filename, contents] of nativeSettings) assert.equal(await readFile(filename, 'utf8'), contents);
  } finally {
    await Promise.allSettled(runs);
    await daemon.close();
  }
});
