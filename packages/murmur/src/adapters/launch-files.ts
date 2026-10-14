import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert } from '../protocol/index.js';
import { AGENT_MODE_ENV, AGENT_CONNECTION_ENV, validateAgentConnection } from '../protocol/agent.js';
import type { LaunchPreparation } from '../protocol/agent.js';
import type { DriverInvocation } from './drivers.js';
import { DEFAULT_CLI_PATH, shellQuote } from './drivers.js';

export type BridgeMode = 'cli' | 'mcp';
export type LaunchIntegrationOptions = { bridge?: BridgeMode; contextHooks?: boolean; nodeExecutable?: string; cliPath?: string; temporaryRoot?: string };
export type CleanupResult = { removed: string[]; retained: string[] };
export type LaunchFiles = {
  directory: string; serverName: string; nativeArguments: string[]; environment: Record<string,string>;
  bridge: BridgeMode; contextHooks: boolean; cleanup(): Promise<CleanupResult>;
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const events = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse'] as const;

function literalPath(value: string): void {
  assert(path.isAbsolute(value) && !/[\0\r\n]/.test(value) && !value.includes('${'), 'Launch integration paths must be absolute and cannot contain interpolation syntax.', 'LAUNCH_CONFIG_PATH');
}
async function readOwned(filename: string, expected: {dev: number; ino: number; size: number}): Promise<Buffer> {
  const info = await lstat(filename);
  assert(info.isFile() && !info.isSymbolicLink() && info.dev === expected.dev && info.ino === expected.ino && info.size === expected.size && (info.mode & 0o077) === 0, 'Launch configuration changed; it was retained.', 'LAUNCH_CONFIG_CHANGED');
  if (process.getuid) assert(info.uid === process.getuid(), 'Launch configuration owner changed.', 'LAUNCH_CONFIG_CHANGED');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assert(opened.dev === expected.dev && opened.ino === expected.ino && opened.size === expected.size, 'Launch configuration changed while opening.', 'LAUNCH_CONFIG_CHANGED');
    const buffer = Buffer.alloc(expected.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    assert(offset === expected.size, 'Launch configuration size changed while reading.', 'LAUNCH_CONFIG_CHANGED');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Only creates a new private directory; never reads or rewrites native user settings. */
export async function createLaunchFiles(preparation: LaunchPreparation, options: LaunchIntegrationOptions = {}): Promise<LaunchFiles> {
  const connection = validateAgentConnection(preparation.agent);
  const tool = preparation.launch.tool;
  const workspace = preparation.launch.workspaceRoot;
  const bridge = options.bridge ?? 'cli';
  const contextHooks = options.contextHooks === true;
  assert(tool === 'claude' || tool === 'codex', 'Launch-local integration is not verified for this tool.', 'NATIVE_CONFIG_UNSUPPORTED');
  assert(bridge === 'cli' || bridge === 'mcp', 'Unknown bridge mode.', 'NATIVE_CONFIG_UNSUPPORTED');
  assert(preparation.launch.id === connection.launchId && typeof workspace === 'string', 'Launch configuration does not match its scoped connection.', 'LAUNCH_PREPARATION_INVALID');
  // Codex hook append semantics must be verified before automatic configuration.
  assert(!contextHooks || tool === 'claude', 'Codex hook configuration is not enabled until its installed merge/trust behavior is verified. The scoped hook command and MCP remain available.', 'NATIVE_HOOK_CONFIG_UNVERIFIED');
  const node = options.nodeExecutable ?? process.execPath;
  const cli = options.cliPath ?? DEFAULT_CLI_PATH;
  for (const value of [node, cli, workspace]) literalPath(value);
  const directory = await realpath(await mkdtemp(path.join(options.temporaryRoot ?? tmpdir(), 'murmur-launch-')));
  await chmod(directory, 0o700);
  const directoryInfo = await lstat(directory);
  const files = new Map<string, {hash: string; dev: number; ino: number; size: number}>();
  const nativeArguments: string[] = [];
  const environment: Record<string,string> = {};
  const serverName = `murmur_${digest(connection.launchId).slice(0,12)}`;
  let hookState: string | undefined;
  let cleaned = false;
  const ensureDirectory = async () => {
    const info = await lstat(directory);
    assert(info.isDirectory() && !info.isSymbolicLink() && info.dev === directoryInfo.dev && info.ino === directoryInfo.ino && (info.mode & 0o077) === 0, 'Launch directory changed; no files were removed.', 'LAUNCH_CONFIG_CHANGED');
    if (process.getuid) assert(info.uid === process.getuid(), 'Launch directory owner changed.', 'LAUNCH_CONFIG_CHANGED');
  };
  const cleanup = async (): Promise<CleanupResult> => {
    if (cleaned) return {removed:[],retained:[]};
    cleaned = true;
    const result: CleanupResult = {removed:[],retained:[]};
    try { await ensureDirectory(); } catch { return {removed:[],retained:[directory]}; }
    for (const [filename, info] of files) {
      try {
        const bytes = await readOwned(filename, info);
        assert(digest(bytes) === info.hash, 'Launch configuration content changed.', 'LAUNCH_CONFIG_CHANGED');
        await ensureDirectory();
        await unlink(filename);
        result.removed.push(filename);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.retained.push(filename); }
    }
    if (hookState) {
      try { await ensureDirectory(); await rmdir(hookState); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.retained.push(hookState); }
    }
    try { await ensureDirectory(); await rmdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !result.retained.includes(directory)) result.retained.push(directory); }
    return result;
  };
  const json = async (name: string, value: unknown) => {
    await ensureDirectory();
    const filename = path.join(directory, name);
    const contents = JSON.stringify(value, null, 2) + '\n';
    assert(Buffer.byteLength(contents) <= 256 * 1024, 'Launch configuration exceeds its size limit.', 'LAUNCH_CONFIG_SIZE');
    assert(!contents.includes(preparation.agent.agentToken) && !contents.includes(preparation.supervisor.supervisorToken), 'Credentials must not enter launch configuration files.', 'LAUNCH_CONFIG_SECRET');
    await writeFile(filename, contents, {flag:'wx',mode:0o600});
    const info = await lstat(filename);
    files.set(filename, {hash:digest(contents),dev:info.dev,ino:info.ino,size:info.size});
    return filename;
  };
  try {
    if (bridge === 'mcp') {
      if (tool === 'claude') {
        const config = await json('mcp.json', {mcpServers:{[serverName]:{type:'stdio',command:node,args:[cli,'mcp','serve'],env:{[AGENT_MODE_ENV]:`\${${AGENT_MODE_ENV}}`,[AGENT_CONNECTION_ENV]:`\${${AGENT_CONNECTION_ENV}}`}}}});
        nativeArguments.push('--mcp-config',config);
      } else {
        const values: Record<string,unknown> = {command:node,args:[cli,'mcp','serve'],cwd:workspace,env_vars:[AGENT_MODE_ENV,AGENT_CONNECTION_ENV]};
        for (const [key,value] of Object.entries(values)) nativeArguments.push('-c',`mcp_servers.${serverName}.${key}=${JSON.stringify(value)}`);
      }
    }
    if (contextHooks) {
      hookState = path.join(directory,'hook-state'); await mkdir(hookState,{mode:0o700});
      environment.MURMUR_HOOK_WORKSPACE = workspace;
      environment.MURMUR_HOOK_STATE_DIR = hookState;
      if (preparation.launch.nativeSessionId) environment.MURMUR_HOOK_NATIVE_SESSION_ID = preparation.launch.nativeSessionId;
      const hooks = Object.fromEntries(events.map(event => [event,[{hooks:[{type:'command',command:`${shellQuote(node)} ${shellQuote(cli)} hook ${tool} --event ${event}`,timeout:5}]}]]));
      const config = await json('context-hooks.json',{hooks});
      nativeArguments.push('--settings',config);
    }
    return {directory,serverName,nativeArguments,environment,bridge,contextHooks,cleanup};
  } catch (error) { await cleanup(); throw error; }
}

export function applyLaunchFiles(invocation: DriverInvocation, files: LaunchFiles): DriverInvocation {
  for (const name of Object.keys(files.environment)) assert(['MURMUR_HOOK_WORKSPACE','MURMUR_HOOK_STATE_DIR','MURMUR_HOOK_NATIVE_SESSION_ID'].includes(name), 'Unexpected launch integration environment.', 'LAUNCH_CONFIG_SECRET');
  return {...invocation,args:[...files.nativeArguments,...invocation.args],env:{...invocation.env,...files.environment}};
}
