#!/usr/bin/env node
/** Native V2 contract probe with disposable metadata and static shell history.
 * Never enables an adapter, installs a global plugin, reads user history, or
 * submits a prompt for provider inference.
 * All runtime operations target newly-created disposable sessions. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '2.0.12';
const LIMIT = 128 * 1024;
const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
export function openCodeProbeEnvironment(root, inherited = process.env) {
  const env = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: join(root, 'home'), OPENCODE_TEST_HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OTEL_SDK_DISABLED: 'true',
  };
  // Preserve the user's network policy exactly; never substitute or clear proxies.
  for (const key of proxies) if (inherited[key] !== undefined) env[key] = inherited[key];
  return env;
}

export function openCodeProbePlugin(observations) {
  // This is the V2 {id, setup} definition shape accepted by Plugin.define, NOT
  // the V1 callback-returning-hooks API. It requires no downloaded SDK package.
  return `import {appendFile} from 'node:fs/promises';
const log = async value => appendFile(${JSON.stringify(observations)}, JSON.stringify(value) + '\\n', {mode:0o600});
const metadata = async (ctx, id) => {
  const session = await ctx.session.get({sessionID:id});
  return {id:session.id, created:session.time?.created, directory:session.location?.directory, parentID:session.parentID, hasRevert:session.revert !== undefined};
};
export default {id:'murmur-v2-contract-probe', async setup(ctx) {
  await log({event:'setup',version:ctx.app?.version,directory:ctx.location?.directory});
  await ctx.session.hook('prompt', async event => {
    await log({event:'prompt',keys:Object.keys(event).sort(),sessionID:event.sessionID,messageID:event.messageID,promptKeys:Object.keys(event.prompt ?? {}).sort(),session:await metadata(ctx,event.sessionID)});
  });
  await ctx.session.hook('context', async event => {
    await log({event:'context',keys:Object.keys(event).sort(),sessionID:event.sessionID,session:await metadata(ctx,event.sessionID)});
  });
  await ctx.command.transform(editor => editor.add({name:'murmur-probe',description:'Disposable metadata-only Murmur native probe',async execute(event) {
    await log({event:'command',keys:Object.keys(event).sort(),sessionID:event.sessionID,promptKeys:Object.keys(event.prompt ?? {}).sort(),literalArguments:event.prompt?.text === 'status',session:await metadata(ctx,event.sessionID)});
  }}));
}};
`;
}

export async function probeOpenCode(executable) {
  assert(isAbsolute(executable) && isAbsolute(process.env.TMPDIR ?? ''));
  const root = await realpath(await mkdtemp(join(process.env.TMPDIR, 'murmur-opencode-contract-')));
  const children = new Set();
  const stop = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
  const interrupt = () => { for (const child of children) stop(child); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const report = {
    schemaVersion: 1, tool: 'opencode', expectedVersion: VERSION, productionAdapterEnabled: false,
    fixtureOnly: true, userProfileInherited: false, providerInferenceRequested: false,
    native: { version: false, isolatedPaths: false, v2PluginLoaded: false, explicitCommand: false,
      promptCallback: false, concurrentSameCwdChatsDistinct: false, resumePreservesBinding: false,
      forkHasFreshBinding: false, resetInvalidation: false, automaticContext: false, structuredIntent: false },
    processes: [], blocker: null,
  };
  try {
    for (const directory of ['home', 'config', 'data', 'state', 'cache', 'tmp', 'workspace', 'plugin']) await mkdir(join(root, directory), { mode: 0o700 });
    const workspace = join(root, 'workspace'), plugin = join(root, 'plugin'), observations = join(root, 'observations.jsonl');
    await writeFile(join(plugin, 'server.js'), openCodeProbePlugin(observations), { mode: 0o600, flag: 'wx' });
    await writeFile(join(plugin, 'index.js'), "export {default} from './server.js';\n", { mode: 0o600, flag: 'wx' });
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'murmur-v2-contract-probe', type: 'module', main: './server.js', exports: { '.': './server.js', './server': './server.js' } }), { mode: 0o600, flag: 'wx' });
    // V2 requires a DIRECTORY here. A module-file target is silently unavailable
    // to commands and produces 'configured plugin path must be a directory'.
    await writeFile(join(root, 'config', 'opencode.json'), JSON.stringify({ plugins: [plugin] }), { mode: 0o600, flag: 'wx' });
    const env = openCodeProbeEnvironment(root);
    const run = async (label, args) => {
      const result = await new Promise(resolve => {
        const child = spawn(executable, args, { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        children.add(child);
        let length = 0, output = '', failed = false, timedOut = false, limited = false;
        const timer = setTimeout(() => { timedOut = true; stop(child); }, 12_000);
        child.stdout.on('data', chunk => { length += chunk.length; if (length > LIMIT) { limited = true; stop(child); } else output += chunk; });
        child.stderr.on('data', chunk => { length += chunk.length; if (length > LIMIT) { limited = true; stop(child); } });
        child.on('error', () => { failed = true; });
        child.on('close', code => { clearTimeout(timer); stop(child); children.delete(child); resolve({ code, output, failed, timedOut, limited }); });
      });
      const summary = { operation: label, code: result.code, timedOut: result.timedOut, outputLimited: result.limited, spawnFailed: result.failed };
      if (result.code !== 0) {
        // Native error class only; never echo arbitrary messages, arguments,
        // paths, response bodies, prompts or private runtime configuration.
        try {
          const tag = JSON.parse(result.output.trim())._tag;
          if (typeof tag === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(tag)) summary.nativeErrorTag = tag;
        } catch { /* No structured native error. */ }
      }
      report.processes.push(summary);
      if (result.code !== 0 || result.timedOut || result.failed || result.limited) { report.blocker = `native-operation-failed:${label}`; throw new Error('native-operation-failed'); }
      return result.output;
    };
    const api = async (operation, body, id) => {
      const value = await run(operation, ['api', '--standalone', operation,
        ...(['plugin.list', 'command.list'].includes(operation) ? ['--param', `location[directory]=${workspace}`] : []),
        ...(id ? ['--param', `sessionID=${id}`] : []), ...(body === undefined ? [] : ['--data', JSON.stringify(body)])]);
      return value.trim() ? JSON.parse(value) : undefined;
    };
    const version = await run('version', ['--version']);
    report.native.version = version.trim() === `opencode v${VERSION}`;
    if (!report.native.version) { report.blocker = 'unsupported-native-version'; return report; }
    const paths = await run('isolated-paths', ['debug', 'paths']);
    report.native.isolatedPaths = paths.trim().split('\n').every(line => line.trim().split(/\s+/).slice(1).join(' ').startsWith(root + '/'));
    if (!report.native.isolatedPaths) { report.blocker = 'native-path-isolation-unverified'; return report; }
    const create = async () => (await api('session.create', { location: { directory: workspace }, title: 'Disposable Murmur native contract fixture' })).data;
    const a = await create(), b = await create();
    // Admission with resume:false cannot schedule provider inference. It also
    // distinguishes lazy native session initialization from mere config parsing.
    await api('session.prompt', { text: 'Disposable metadata-only fixture. Do not execute.', resume: false }, a.id);
    const listed = await api('plugin.list');
    report.native.v2PluginLoaded = listed?.data?.some(entry => entry.id === 'murmur-v2-contract-probe' && entry.state?.status === 'active') ?? false;
    if (!report.native.v2PluginLoaded) {
      report.pluginState = listed?.data?.map(entry => ({ fixture: entry.id === 'murmur-v2-contract-probe', status: entry.state?.status })) ?? [];
      const diagnostics = new Set();
      for (const entry of await readdir(join(root, 'data', 'opencode', 'log')).catch(() => [])) {
        const log = await readFile(join(root, 'data', 'opencode', 'log', entry), 'utf8');
        for (const marker of ['configured plugin path must be a directory', 'Plugin entrypoint not found', 'Cannot find module', 'loading plugin', 'failed to load', 'FSEvents']) if (log.includes(marker)) diagnostics.add(marker);
      }
      report.nativeDiagnostics = [...diagnostics];
      // plugin.list runs in another short-lived standalone server. An empty
      // list does not disprove lazy setup; only native callback evidence counts.
    }
    const command = sessionID => api('session.command', { name: 'murmur-probe', text: 'status' }, sessionID);
    const readObservations = async () => {
      const bytes = await readFile(observations); assert(bytes.length < LIMIT);
      const rows = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      report.native.v2PluginLoaded = rows.some(row => row.event === 'setup' && row.version === VERSION);
      report.observedCallbackKeys = Object.fromEntries(['command', 'prompt', 'context'].map(event => [event, rows.find(row => row.event === event)?.keys ?? []]));
      return rows;
    };
    await Promise.all([command(a.id), command(b.id)]);
    await command(a.id); // Native command reentry; NOT an inferred TUI resume guarantee.
    const rows = await readObservations(), commands = rows.filter(row => row.event === 'command');
    const matches = (row, session) => row.sessionID === session.id && row.session?.id === session.id && row.session?.created === session.time.created && row.session?.directory === workspace;
    report.native.explicitCommand = commands.length >= 3 && commands.every(row => row.literalArguments);
    report.native.concurrentSameCwdChatsDistinct = a.id !== b.id && commands.some(row => matches(row, a)) && commands.some(row => matches(row, b));
    report.native.commandReentryPreservesMetadata = commands.filter(row => matches(row, a)).length === 2;
    report.native.promptCallback = rows.some(row => row.event === 'prompt' && matches(row, a));
    // OpenCode refuses an empty session fork. Create native-authored fixture
    // history using only a constant printf: no source edits, model/provider call,
    // user history, permission override, or synthetic claimed lifecycle event.
    await api('session.shell', { command: "printf 'MURMUR NATIVE FIXTURE\\n'" }, b.id);
    report.fixtureShellHistory = true;
    const fork = (await api('session.fork', {}, b.id)).data;
    await command(fork.id);
    const afterFork = await readObservations();
    report.native.forkHasFreshBinding = fork.id !== b.id && afterFork.some(row => row.event === 'command' && matches(row, fork));
    // Read only native-authored disposable fixture history, retaining just its
    // message ID. No real conversation or tool output is imported or persisted.
    const messageId = (await api('session.message.list', undefined, b.id))?.data?.find(message => message.type === 'shell')?.id;
    assert(typeof messageId === 'string');
    await api('session.revert.stage', { messageID: messageId, files: false }, b.id);
    const staged = (await api('session.get', undefined, b.id)).data;
    report.nativeRewindMarkerObserved = staged.revert !== undefined;
    await api('session.revert.commit', undefined, b.id);
    const committed = (await api('session.get', undefined, b.id)).data;
    report.nativeCommittedRewindPreservesIdAndCreation = committed.id === b.id && committed.time.created === b.time.created;
    report.nativeCommittedRewindClearsMarker = committed.revert === undefined;
    await command(b.id);
    // This is counterevidence to treating ID+creation time as an incarnation,
    // not a successful invalidation design or authority-recovery mechanism.
    report.blocker = 'cli-resume-reset-invalidation-and-provider-context-intent-not-verified';
    return report;
  } catch {
    report.blocker ??= 'bounded-native-metadata-probe-failed'; return report;
  } finally {
    interrupt(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    await rm(root, { recursive: true, force: true }); report.disposableStateRemoved = true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: node scripts/probe-opencode-existing-chat.mjs --native --opencode /absolute/opencode\nDisposable V2 probe with static printf shell history. No inference, installation, user history, policy changes or capability enablement.');
  else if (args.length === 3 && args[0] === '--native' && args[1] === '--opencode' && isAbsolute(args[2])) {
    probeOpenCode(args[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('Murmur native probe failed safely.'); process.exitCode = 1; });
  } else { console.error('Use --help or explicit --native --opencode ABSOLUTE_EXECUTABLE.'); process.exitCode = 1; }
}
