#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { defaultStateDirectory } from '../daemon/config.js';
import { startDaemon } from '../daemon/server.js';
import { request } from './client.js';
import { adapterDiagnostics } from '../adapters/capabilities.js';
import { executeExtended, extensionHelp, extensionFlags, extensionBooleans } from './commands.js';
import { requireHumanEnvironment } from '../protocol/agent.js';
import { agentMain } from './agent.js';
import { runMain } from './run.js';
import { assert, MurmurError } from '../protocol/index.js';

const help = `Murmur 0.5.0 — shared work groups and scoped connections (Claude explicit resume supported)

Usage: murmur <command> [options]

  run <claude|codex|opencode> --project ID --title TEXT
                                       Create an isolated managed task and launch the tool
  agent <command>                      Scoped commands for managed agent sessions
  group <action>                       Human-managed shared work groups
  connect <action>                     Human review, approval, reconnect and revocation
  external <command>                   Explicitly configured external scoped client
  native --help                        Report supported native connection entrypoints
  mcp serve                            Official SDK stdio server for managed sessions
  hook <claude|codex> --event EVENT     Advisory scoped native-hook entrypoint
  daemon start                         Run foreground until Ctrl-C
  daemon stop                          Stop the local service
  init [--root PATH]                   Register a Git project or advisory folder
  status [--project ID] [--json]        Show tasks, sessions, and active reservations
  doctor [--json]                      Inspect daemon and unverified adapter availability
  session register --project ID --tool NAME --root PATH [--native-id ID]
  task create --project ID --session ID --title TEXT [--feature KEY]
  reserve --project ID --session ID --task ID --revision N --path PATH [--ttl N]
  release --lease ID --session ID --generation N
  events --project ID [--after N]

${extensionHelp}
All command output except status is JSON. Session registration prints a private
session token: do not paste it into public logs. No hooks or settings are installed.
Set MURMUR_HOME to a dedicated private directory to override local state storage.
`;
const booleanFlags = new Set(['json', 'help', ...extensionBooleans]);
const knownFlags = new Set(['json', 'help', 'root', 'project', 'tool', 'native-id', 'instance', 'session', 'title', 'feature', 'task', 'revision', 'path', 'ttl', 'lease', 'generation', 'after', ...extensionFlags]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'external') { const { externalMain } = await import('./external.js'); console.log(JSON.stringify(await externalMain(argv.slice(1)), null, 2)); return; }
  if (argv[0] === 'native') {
    const { nativeMain } = await import('../adapters/existing-chat.js');
    // nativeMain already returns the host hook schema. Do not wrap it in a result
    // envelope or pretty-print it past the native adapter's UTF-8 output budget.
    process.stdout.write(`${JSON.stringify(await nativeMain(argv.slice(1)))}\n`);
    return;
  }
  if (argv[0] === 'mcp') { const { mcpMain } = await import('./mcp.js'); await mcpMain(argv.slice(1)); return; }
  if (argv[0] === 'hook') { const { hookMain } = await import('./hook.js'); await hookMain(argv.slice(1)); return; }
  if (argv[0] === 'agent') {
    const result = await agentMain(argv.slice(1));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  requireHumanEnvironment();
  if (argv[0] === 'group' || argv[0] === 'connect') {
    const module = argv[0] === 'group' ? await import('./group.js') : await import('./connect.js');
    const run = 'groupMain' in module ? module.groupMain : module.connectMain;
    const output = await run(argv.length === 1 ? ['--help'] : argv.slice(1));
    console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
    return;
  }
  if (argv[0] === 'run') { process.exitCode = await runMain(argv.slice(1)); return; }
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') { console.log(help); return; }
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    assert(knownFlags.has(name), `Unknown option: --${name}`);
    assert(!flags.has(name), `Duplicate option: --${name}`);
    if (booleanFlags.has(name)) flags.set(name, 'true');
    else {
      const value = argv[++index];
      assert(value !== undefined && !value.startsWith('--'), `Missing value for --${name}`);
      flags.set(name, value);
    }
  }
  const required = (name: string): string => { const value = flags.get(name); assert(value, `Missing --${name}`); return value; };
  const directory = defaultStateDirectory();
  const command = positional.join(' ');
  const post = (endpoint: string, body: unknown) => request(directory, 'POST', endpoint, body, { key: flags.get('request-id') });
  let output: unknown;
  if (command === 'daemon start') {
    const daemon = await startDaemon(directory);
    console.log(JSON.stringify({ running: true, port: daemon.port, stateDirectory: daemon.directory }));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void daemon.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  } else if (command === 'daemon stop') {
    output = await post('/v1/daemon/stop', {});
  } else if (command === 'init') {
    output = await post('/v1/projects', { root: flags.get('root') ?? process.cwd() });
  } else if (command === 'status') {
    const project = flags.get('project');
    const status = await request(directory, 'GET', `/v1/status${project ? `?projectId=${encodeURIComponent(project)}` : ''}`);
    if (!flags.has('json')) {
      console.log(`Murmur — ${status.projects.length} project(s), ${status.sessions.length} session(s), ${status.tasks.length} task(s)`);
      for (const project of status.projects) console.log(`\n${project.id}  ${project.mode === 'git' ? 'Git' : 'ADVISORY ONLY'}  ${project.root}`);
      for (const session of status.sessions) {
        const launch = status.launches?.find((item: { sessionId: string }) => item.sessionId === session.id);
        const activity = launch ? `managed ${launch.state}; ${launch.bridgeLastSeenAt ? 'scoped bridge used' : 'no bridge use observed'}` : session.credentialMode === 'external' ? 'external scoped participation; inspect connect grants for approval/expiry (not native process liveness)' : status.now - session.lastSeenAt > 120000 ? 'stale (no heartbeat)' : 'manual registration';
        console.log(`  session ${session.id}  ${session.tool}  ${activity}`);
      }
      for (const task of status.tasks) console.log(`  task ${task.id}  ${task.status}  ${task.title}`);
      console.log(`\n${status.reservations.length} active reservation(s). Reservations do not prevent filesystem writes.`);
      return;
    }
    output = status;
  } else if (command === 'doctor') {
    let daemon: unknown;
    try { daemon = { status: 'connected', ...await request(directory, 'GET', '/health') }; }
    catch (error) { daemon = { status: 'unavailable', reason: (error as Error).message }; }
    output = { runtime: process.version, stateDirectory: directory, daemon, adapters: await adapterDiagnostics(), releaseGate: 'Groups, scoped MCP and external protocol are implemented. Claude 2.1.247 explicit plugin/resume connection is supported. Hot attachment, other native adapters and four-tool live verification remain incomplete.' };
  } else if (command === 'session register') {
    output = await post('/v1/sessions', { projectId: required('project'), tool: required('tool'), workspaceRoot: flags.get('root') ?? process.cwd(), nativeId: flags.get('native-id') ?? randomUUID(), instanceId: flags.get('instance') ?? randomUUID() });
  } else if (command === 'task create') {
    output = await post('/v1/tasks', { projectId: required('project'), sessionId: required('session'), title: required('title'), ...(flags.has('feature') ? { featureKey: flags.get('feature') } : {}) });
  } else if (command === 'reserve') {
    output = await post('/v1/reservations/acquire', { projectId: required('project'), sessionId: required('session'), taskId: required('task'), taskRevision: Number(required('revision')), resources: [{ kind: 'path', value: required('path') }], ttlSeconds: Number(flags.get('ttl') ?? 90) });
  } else if (command === 'release') {
    output = await post('/v1/reservations/release', { leaseId: required('lease'), sessionId: required('session'), generation: Number(required('generation')) });
  } else if (command === 'events') {
    output = await request(directory, 'GET', `/v1/events?projectId=${encodeURIComponent(required('project'))}&after=${encodeURIComponent(flags.get('after') ?? '0')}`);
  } else {
    const extended = await executeExtended(command, flags, directory);
    if (!extended.handled) throw new MurmurError(`Unknown command: ${command}. Use --help.`, 'INVALID_COMMAND');
    output = extended.result;
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  const failure = error instanceof MurmurError ? { code: error.code, message: error.message, details: error.details } : { code: 'INTERNAL_ERROR', message: 'Unexpected local failure. No automatic recovery was attempted.' };
  console.error(JSON.stringify({ error: failure }));
  process.exitCode = 1;
});
