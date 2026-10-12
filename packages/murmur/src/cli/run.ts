import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { request } from './client.js';
import { defaultStateDirectory } from '../daemon/config.js';
import { assert, MurmurError } from '../protocol/index.js';
import { requireHumanEnvironment, validateAgentConnection, validateSupervisorConnection } from '../protocol/agent.js';
import type { LaunchPreparation, LaunchTool } from '../protocol/agent.js';
import { createDriverInvocation, preflightDriver, redactLaunchText, inheritedMurmurSecrets } from '../adapters/drivers.js';
import type { DriverOptions } from '../adapters/drivers.js';
import { superviseLaunch } from '../adapters/supervisor.js';
import type { SupervisorDependencies } from '../adapters/supervisor.js';

export const runHelp = `Usage: murmur run <claude|codex> --project ID --title TEXT [options]\n\nStart one NEW managed task in a daemon-created workspace. Existing tasks and\nnative sessions cannot be resumed or taken over by this command.\n\n  --project ID          Registered Git project (required)\n  --title TEXT          New task objective (required)\n  --feature KEY         Optional duplicate-feature guard\n  --base REVISION       Git base revision for the new workspace\n  --allow-dirty-base    Explicitly allow a dirty source checkout; edits are not copied\n  --request-id UUID     Reuse only the exact same preparation request\n  --help               Print this help without launching anything\n\nNative options, permission bypasses, cwd overrides, and passthrough are rejected.\nThe native CLI keeps its normal authentication and permission choices. No MCP,\nhooks, global configuration, automatic commits, approvals, or merges are installed.\nThe request ID and preserved workspace are printed to stderr, never credentials.\n`;

export type RunArguments = { tool: LaunchTool; projectId: string; title: string; featureKey?: string; baseRevision?: string; allowDirtyBase?: boolean; requestId?: string };
export type RunDependencies = {
  request?: typeof request; stateDirectory?: string; uuid?: () => string;
  env?: NodeJS.ProcessEnv; stdout?: (text: string) => void; stderr?: (text: string) => void;
  executable?: string; preflight?: Omit<DriverOptions, 'env' | 'executable'>;
  nodeExecutable?: string; cliPath?: string; supervisor?: SupervisorDependencies;
};
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseRunArguments(argv: string[]): RunArguments {
  assert(argv[0] === 'claude' || argv[0] === 'codex', 'First argument must be claude or codex.', 'RUN_ARGUMENTS');
  const flags = new Map<string, string | boolean>();
  const values = new Set(['--project', '--title', '--feature', '--base', '--request-id']);
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index]!;
    assert(values.has(name) || name === '--allow-dirty-base', 'Unsupported run option or extra positional argument. See murmur run --help.', 'RUN_ARGUMENTS');
    assert(!flags.has(name), 'Duplicate run option. See murmur run --help.', 'RUN_ARGUMENTS');
    if (name === '--allow-dirty-base') flags.set(name, true);
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
  return {
    tool: argv[0], projectId, title,
    ...(flags.has('--feature') ? { featureKey: flags.get('--feature') as string } : {}),
    ...(flags.has('--base') ? { baseRevision: flags.get('--base') as string } : {}),
    ...(flags.has('--allow-dirty-base') ? { allowDirtyBase: true } : {}),
    ...(requestId ? { requestId } : {}),
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
  let requestId: string | undefined;
  try {
    requireHumanEnvironment(env);
    if (argv.includes('--help')) { stdout(runHelp); return 0; }
    const args = parseRunArguments(argv);
    requestId = args.requestId ?? (dependencies.uuid ?? randomUUID)();
    assert(uuidPattern.test(requestId), 'Request ID must be a UUID.', 'RUN_ARGUMENTS');
    // Retained before preflight or daemon side effects, including failed preparation.
    stderr(`Murmur launch request ID: ${requestId}\n`);
    phase = 'native CLI preflight';
    const driver = await preflightDriver(args.tool, { ...dependencies.preflight, env, executable: dependencies.executable });
    phase = 'launch preparation';
    const { requestId: _, ...body } = args;
    preparation = await (dependencies.request ?? request)(dependencies.stateDirectory ?? defaultStateDirectory(), 'POST', '/v1/launches/prepare', body, { key: requestId, timeoutMs: 600000 }) as LaunchPreparation;
    phase = 'preparation validation';
    preparationMatches(preparation, args);
    const invocation = createDriverInvocation(driver, preparation, { env, nodeExecutable: dependencies.nodeExecutable, cliPath: dependencies.cliPath });
    phase = 'launch claim and supervision';
    return await superviseLaunch(preparation, invocation, { ...dependencies.supervisor, stderr });
  } catch (error) {
    // Only locally generated argument diagnostics are printed verbatim. Human/API
    // errors may carry secrets or attacker-controlled details; do not serialize them.
    const message = phase === 'argument validation' && error instanceof MurmurError && error.code === 'RUN_ARGUMENTS'
      ? error.message
      : `Murmur run failed during ${phase}. No automatic takeover or destructive cleanup was attempted.`;
    stderr(`${message}\n`);
    if (requestId) stderr(`Keep request ID ${requestId}; inspect human status before retrying the exact request.\n`);
    return 1;
  } finally {
    const root = preparation?.launch?.workspaceRoot;
    if (typeof root === 'string') {
      const secrets = [preparation?.agent?.agentToken, preparation?.supervisor?.supervisorToken,
        ...inheritedMurmurSecrets(env)]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      stderr(`Preserved workspace: ${redactLaunchText(JSON.stringify(root), secrets)}\n`);
    }
  }
}
