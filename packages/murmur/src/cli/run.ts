import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { request } from './client.js';
import { defaultStateDirectory } from '../daemon/config.js';
import { assert, MurmurError } from '../protocol/index.js';
import { requireHumanEnvironment, validateAgentConnection, validateSupervisorConnection } from '../protocol/agent.js';
import type { LaunchPreparation, LaunchTool } from '../protocol/agent.js';
import { createDriverInvocation, preflightDriver, assertDriverMode, redactLaunchText, inheritedMurmurSecrets } from '../adapters/drivers.js';
import type { DriverOptions } from '../adapters/drivers.js';
import { applyLaunchFiles, createLaunchFiles } from '../adapters/launch-files.js';
import type { BridgeMode, LaunchFiles } from '../adapters/launch-files.js';
import { superviseLaunch } from '../adapters/supervisor.js';
import type { SupervisorDependencies } from '../adapters/supervisor.js';

export const runHelp = `Usage: murmur run <claude|codex|opencode> --project ID --title TEXT [options]\n\nStart one NEW managed task in a daemon-created workspace. Existing tasks and\nnative sessions cannot be resumed or taken over by this command.\n\n  --project ID          Registered Git project (required)\n  --title TEXT          New task objective (required)\n  --feature KEY         Optional duplicate-feature guard\n  --base REVISION       Git base revision for the new workspace\n  --allow-dirty-base    Explicitly allow a dirty source checkout; edits are not copied\n  --request-id UUID     Reuse only the exact same preparation request
  --bridge cli|mcp      Select the scoped bridge (default: cli)
  --context-hooks       Request advisory launch-local context hooks (Claude only)\n  --help               Print this help without launching anything\n\nNative options, permission bypasses, cwd overrides, and passthrough are rejected.\nThe native CLI keeps its normal authentication and permission choices. MCP and\ncontext hooks are opt-in and launch-local. OpenCode V2 supports CLI only, using\n--standalone; --bridge mcp and --context-hooks are rejected before preparation.\nNo global configuration, automatic\ncommits, approvals, or merges are installed.\nThe request ID and preserved workspace are printed to stderr, never credentials.\n`;

export type RunArguments = { tool: LaunchTool; projectId: string; title: string; featureKey?: string; baseRevision?: string; allowDirtyBase?: boolean; requestId?: string; bridge?: BridgeMode; contextHooks?: boolean };
export type RunDependencies = {
  request?: typeof request; stateDirectory?: string; uuid?: () => string;
  env?: NodeJS.ProcessEnv; stdout?: (text: string) => void; stderr?: (text: string) => void;
  executable?: string; preflight?: Omit<DriverOptions, 'env' | 'executable'>;
  nodeExecutable?: string; cliPath?: string; supervisor?: SupervisorDependencies;
};
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseRunArguments(argv: string[]): RunArguments {
  assert(argv[0] === 'claude' || argv[0] === 'codex' || argv[0] === 'opencode', 'First argument must be claude, codex, or opencode.', 'RUN_ARGUMENTS');
  const flags = new Map<string, string | boolean>();
  const values = new Set(['--project', '--title', '--feature', '--base', '--request-id', '--bridge']);
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index]!;
    assert(values.has(name) || name === '--allow-dirty-base' || name === '--context-hooks', 'Unsupported run option or extra positional argument. See murmur run --help.', 'RUN_ARGUMENTS');
    assert(!flags.has(name), 'Duplicate run option. See murmur run --help.', 'RUN_ARGUMENTS');
    if (name === '--allow-dirty-base' || name === '--context-hooks') flags.set(name, true);
    else {
      const value = argv[++index];
      assert(typeof value === 'string' && value.trim().length > 0 && !value.startsWith('--') && !value.includes('\0'), 'Missing or invalid run option value. See murmur run --help.', 'RUN_ARGUMENTS');
      flags.set(name, value);
    }
  }
  assert(flags.has('--project') && flags.has('--title'), 'Both --project and --title are required.', 'RUN_ARGUMENTS');
  const projectId = flags.get('--project') as string;
  const title = flags.get('--title') as string;
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(projectId) && title.length <= 512, 'Invalid project ID or task title length.', 'RUN_ARGUMENTS');
  for (const name of ['--feature', '--base']) assert(!flags.has(name) || String(flags.get(name)).length <= 512, 'Run option is too long.', 'RUN_ARGUMENTS');
  const requestId = flags.get('--request-id') as string | undefined;
  assert(requestId === undefined || uuidPattern.test(requestId), 'Request ID must be a UUID.', 'RUN_ARGUMENTS');
  assert(!flags.has('--bridge') || flags.get('--bridge') === 'cli' || flags.get('--bridge') === 'mcp', 'Bridge must be cli or mcp.', 'RUN_ARGUMENTS');
  return {
    tool: argv[0], projectId, title,
    ...(flags.has('--feature') ? { featureKey: flags.get('--feature') as string } : {}),
    ...(flags.has('--base') ? { baseRevision: flags.get('--base') as string } : {}),
    ...(flags.has('--allow-dirty-base') ? { allowDirtyBase: true } : {}),
    ...(requestId ? { requestId } : {}),
    ...(flags.has('--bridge') ? { bridge: flags.get('--bridge') as BridgeMode } : {}),
    ...(flags.has('--context-hooks') ? { contextHooks: true } : {}),
  };
}

function preparationMatches(preparation: LaunchPreparation, args: RunArguments): void {
  const agent = validateAgentConnection(preparation.agent);
  const supervisor = validateSupervisorConnection(preparation.supervisor);
  const launch = preparation.launch;
  assert(launch && launch.id === agent.launchId && launch.id === supervisor.launchId &&
    launch.projectId === args.projectId && launch.tool === args.tool && launch.title === args.title && launch.featureKey === (args.featureKey ?? null) &&
    launch.projectId === agent.projectId && launch.sessionId === agent.sessionId && launch.taskId === agent.taskId &&
    agent.origin === supervisor.origin && agent.stateId === supervisor.stateId &&
    typeof launch.workspaceRoot === 'string' && path.isAbsolute(launch.workspaceRoot) &&
    Number.isSafeInteger(launch.lifecycleRevision) && launch.lifecycleRevision >= 0 &&
    typeof preparation.briefing === 'string', 'Preparation does not match the requested managed launch.', 'LAUNCH_PREPARATION_INVALID');
}

/** Called after the main CLI's human-environment guard; returns rather than exiting. */
export async function runMain(argv: string[], dependencies: RunDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => { process.stdout.write(text); });
  const stderr = dependencies.stderr ?? (text => { process.stderr.write(text); });
  const env = dependencies.env ?? process.env;
  let phase = 'argument validation';
  let preparation: LaunchPreparation | undefined;
  let launchFiles: LaunchFiles | undefined;
  let requestId: string | undefined;
  try {
    requireHumanEnvironment(env);
    if (argv.includes('--help')) { stdout(runHelp); return 0; }
    const args = parseRunArguments(argv);
    assertDriverMode(args.tool, args);
    requestId = args.requestId ?? (dependencies.uuid ?? randomUUID)();
    assert(uuidPattern.test(requestId), 'Request ID must be a UUID.', 'RUN_ARGUMENTS');
    // Retained before preflight or daemon side effects, including failed preparation.
    stderr(`Murmur launch request ID: ${requestId}\n`);
    phase = 'native CLI preflight';
    const driver = await preflightDriver(args.tool, { ...dependencies.preflight, env, executable: dependencies.executable, bridge: args.bridge, contextHooks: args.contextHooks });
    if (args.contextHooks && args.tool !== 'claude') throw new MurmurError('Codex native hook configuration is gated until installed merge/trust behavior is verified.', 'NATIVE_HOOK_CONFIG_UNVERIFIED');
    if (args.bridge === 'mcp') {
      phase = 'MCP runtime preflight';
      try { await import('../mcp/server.js'); }
      catch { throw new MurmurError('The official MCP runtime is unavailable. Install the pinned package dependencies; no CLI fallback was selected automatically.', 'MCP_RUNTIME_UNAVAILABLE'); }
    }
    phase = 'launch preparation';
    const { requestId: _, bridge: _bridge, contextHooks: _hooks, ...body } = args;
    preparation = await (dependencies.request ?? request)(dependencies.stateDirectory ?? defaultStateDirectory(), 'POST', '/v1/launches/prepare', body, { key: requestId, timeoutMs: 600000 }) as LaunchPreparation;
    phase = 'preparation validation';
    preparationMatches(preparation, args);
    let invocation = createDriverInvocation(driver, preparation, { env, nodeExecutable: dependencies.nodeExecutable, cliPath: dependencies.cliPath, bridge: args.bridge });
    if (args.bridge === 'mcp' || args.contextHooks) {
      phase = 'launch-local integration configuration';
      launchFiles = await createLaunchFiles(preparation, { bridge: args.bridge, contextHooks: args.contextHooks, nodeExecutable: dependencies.nodeExecutable, cliPath: dependencies.cliPath });
      invocation = applyLaunchFiles(invocation, launchFiles);
      stderr(`Murmur integration requested: ${args.bridge ?? 'cli'}${args.contextHooks ? ' with advisory context hooks' : ''}. Native policy/trust still applies.\n`);
    }
    phase = 'launch claim and supervision';
    return await superviseLaunch(preparation, invocation, { ...dependencies.supervisor, stderr });
  } catch (error) {
    // Only locally generated argument diagnostics are printed verbatim. Human/API
    // errors may carry secrets or attacker-controlled details; do not serialize them.
    const message = error instanceof MurmurError && (phase === 'argument validation' && error.code === 'RUN_ARGUMENTS' || ['NATIVE_HOOK_CONFIG_UNVERIFIED','MCP_RUNTIME_UNAVAILABLE','OPENCODE_MODE_UNSUPPORTED'].includes(error.code))
      ? error.message
      : `Murmur run failed during ${phase}. No automatic takeover or destructive cleanup was attempted.`;
    stderr(`${message}\n`);
    if (requestId) stderr(`Keep request ID ${requestId}; inspect human status before retrying the exact request.\n`);
    return 1;
  } finally {
    if (launchFiles) {
      const cleanup = await launchFiles.cleanup();
      if (cleanup.retained.length) stderr('Murmur retained private launch cache or changed configuration files for inspection; no uncertain data was removed.\n');
    }
    const root = preparation?.launch?.workspaceRoot;
    if (typeof root === 'string') {
      const secrets = [preparation?.agent?.agentToken, preparation?.supervisor?.supervisorToken,
        ...inheritedMurmurSecrets(env)]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      stderr(`Preserved workspace: ${redactLaunchText(JSON.stringify(root), secrets)}\n`);
    }
  }
}
