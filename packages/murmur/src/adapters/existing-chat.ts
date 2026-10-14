import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assert, MurmurError } from '../protocol/index.js';
import { readPublicConnectionFile } from '../cli/external-helper.js';
import { CLAUDE_CONNECT_SYNTAX, CLAUDE_EXISTING_CHAT_CAPABILITY, claudeNativeHook, claudePrivateDirectory, claudeProjectRoot } from './claude-existing-chat.js';
import type { ClaudeNativeHookOptions } from './claude-existing-chat.js';

// Broad/all-host support remains false. The explicit version-scoped capability
// below is the only enabled native adapter; shared-chat MCP is never an authority.
export const EXISTING_CHAT_NATIVE_ENABLED = false;
export const GENERIC_EXISTING_CHAT_MCP_ENABLED = false;
export { CLAUDE_EXISTING_CHAT_CAPABILITY };
export type NativeMainOptions = ClaudeNativeHookOptions;
const help = Object.freeze({
  usage: 'murmur native hook --descriptor ABSOLUTE_CONNECTION_JSON',
  claude: CLAUDE_EXISTING_CHAT_CAPABILITY,
  syntax: CLAUDE_CONNECT_SYNTAX,
  safety: 'Only the fixed Claude UserPromptSubmit hook accepts current-action identity from bounded stdin. No ID/cwd selectors, direct native actions, force flag, model-facing MCP, human-client fallback or automatic installation.',
  setup: 'A human exports a plugin with murmur connect setup --tool claude --out NEW_DIRECTORY, then explicitly resumes the original chat using the returned command. Hot attachment is unverified.',
});

/** The returned hook result is already standard native JSON, not a result envelope. */
export async function nativeMain(argv: string[], options: NativeMainOptions = {}): Promise<unknown> {
  if (argv.length === 1 && argv[0] === '--help') return help;
  if (argv.length === 3 && argv[0] === 'hook' && argv[1] === '--descriptor') return claudeNativeHook(argv[2]!, options);
  throw new MurmurError('Use only the fixed native hook entrypoint or --help. Direct native actions and caller-selected identity are unavailable.', 'NATIVE_ADAPTER_UNVERIFIED', 403);
}

export const CLAUDE_NATIVE_SKILL = `---
name: connect
description: Request or inspect this current Claude chat's human-approved Murmur connection.
disable-model-invocation: true
---
The fixed UserPromptSubmit hook handles this command before this skill runs.
Report only the Murmur hook result supplied for this invocation. Do not run a
helper, replay the command through tools, infer identity, read private state or
native histories, or invoke human enrollment or approval commands. If no Murmur
hook result arrived, explain that the plugin did not complete the action and ask
the human to review setup. Never claim this chat is connected without its result.

Literal user syntax:
${CLAUDE_CONNECT_SYNTAX}

The join code is exactly 43 base64url characters. Start and join only request a
human review. After approval, refresh activates the connection and retrieves
bounded advisory context. Leave preserves the existing task and native chat.
Other hosts and already-open hot attachment are not verified. Native resume keeps
the current UUID; fork and clear use new UUIDs and need their own approval.
`;
export const CLAUDE_PLUGIN_MANIFEST = `${JSON.stringify({ name: 'murmur', version: '0.5.0', description: 'Human-approved current-chat Murmur commands for Claude Code 2.1.247.' }, null, 2)}\n`;
export const CLAUDE_HOOKS_TEMPLATE = `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '__MURMUR_FIXED_HOOK_COMMAND__', timeout: 30 }] }] } }, null, 2)}\n`;
export const quoteNativeShell = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
function literal(value: unknown): string {
  assert(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value), 'Setup paths must be literal absolute paths.', 'NATIVE_SETUP_PATH');
  return value;
}
export type NativeSetupBundleOptions = { tool?: string; descriptorPath: string; nodeExecutable: string; cliPath: string };
/** Pure builder: no credentials or runtime/user argument interpolation in assets. */
export function createNativeSetupBundle(options: NativeSetupBundleOptions) {
  const tool = options.tool ?? 'claude';
  assert(tool === 'claude', 'No verified native setup bundle exists for this host.', 'NATIVE_ADAPTER_UNVERIFIED', 403);
  const descriptorPath = literal(options.descriptorPath);
  assert(path.basename(descriptorPath) === 'connection.json', 'Setup requires the public connection.json descriptor.', 'NATIVE_SETUP_PATH');
  const command = `${quoteNativeShell(literal(options.nodeExecutable))} ${quoteNativeShell(literal(options.cliPath))} native hook --descriptor ${quoteNativeShell(descriptorPath)}`;
  return Object.freeze({ tool, enabled: true, capability: CLAUDE_EXISTING_CHAT_CAPABILITY, files: Object.freeze([
    Object.freeze({ path: '.claude-plugin/plugin.json', content: CLAUDE_PLUGIN_MANIFEST }),
    Object.freeze({ path: 'skills/connect/SKILL.md', content: CLAUDE_NATIVE_SKILL }),
    Object.freeze({ path: 'hooks/hooks.json', content: CLAUDE_HOOKS_TEMPLATE.replace(JSON.stringify('__MURMUR_FIXED_HOOK_COMMAND__'), JSON.stringify(command)) }),
  ]) });
}

export type ExistingChatSetupOptions = {
  tool: string; outputDirectory: string; stateDirectory: string;
  nodeExecutable?: string; cliPath?: string; claudeExecutable?: string;
  /** Human-side PATH lookup only. Never embedded in the plugin or inherited by preflight. */
  env?: NodeJS.ProcessEnv;
};
const sameDirectory = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
async function directoryInfo(directory: string, privateOnly = false): Promise<Stats> {
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory
    && (!privateOnly || (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid())), 'Setup requires canonical directories with private, owner-only helper state.', 'NATIVE_SETUP_PATH');
  return info;
}
async function actualFile(filename: string, executable: boolean): Promise<string> {
  const actual = await realpath(literal(filename)), info = await lstat(actual);
  assert(info.isFile() && !info.isSymbolicLink(), 'Setup requires actual executable and CLI files.', 'NATIVE_SETUP_PATH');
  await access(actual, executable ? constants.X_OK : constants.R_OK);
  return literal(actual);
}
async function findClaude(options: ExistingChatSetupOptions): Promise<string> {
  if (options.claudeExecutable !== undefined) return actualFile(options.claudeExecutable, true);
  for (const directory of (options.env ?? process.env).PATH?.split(path.delimiter) ?? []) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try { return await actualFile(path.join(directory, 'claude'), true); } catch { /* Try only the human caller's explicit PATH. */ }
  }
  throw new MurmurError('A supported absolute Claude executable is required for metadata-only version preflight.', 'NATIVE_SETUP_EXECUTABLE');
}
async function versionPreflight(executable: string, nodeExecutable: string): Promise<void> {
  const directory = await mkdtemp(path.join(await realpath(process.env.TMPDIR ?? tmpdir()), 'murmur-native-version-'));
  try {
    const { stdout } = await promisify(execFile)(executable, ['--version'], {
      cwd: directory, timeout: 5000, maxBuffer: 1024,
      env: { HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_STATE_HOME: directory,
        CLAUDE_CONFIG_DIR: directory, TMPDIR: directory, PATH: [path.dirname(nodeExecutable), '/usr/bin', '/bin'].join(path.delimiter),
        DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    assert(stdout.trim() === `${CLAUDE_EXISTING_CHAT_CAPABILITY.testedVersion} (Claude Code)`, 'Only the observed Claude Code 2.1.247 contract is supported. No plugin was installed or chat connected.', 'NATIVE_SETUP_VERSION');
  } catch (error) {
    if (error instanceof MurmurError) throw error;
    throw new MurmurError('Claude metadata-only version preflight failed. No plugin was installed or chat connected.', 'NATIVE_SETUP_VERSION');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Human export only, never native settings installation. Private helper state is
 * prepared here, outside the current project; the hook itself creates no dirs.
 */
export async function exportExistingChatSetup(options: ExistingChatSetupOptions): Promise<unknown> {
  assert(options.tool === 'claude', 'No verified native setup bundle exists for this host.', 'NATIVE_ADAPTER_UNVERIFIED', 403);
  const outputDirectory = literal(options.outputDirectory), parent = path.dirname(outputDirectory);
  const forbidden = ['.claude', '.codex', '.cursor', '.opencode', '.agents', '.config', 'Claude', 'Cursor', 'Codex', 'OpenCode', '.mcp.json', 'settings.json', 'settings.local.json'];
  assert(!outputDirectory.split(path.sep).some(segment => forbidden.includes(segment)), 'Select a separate export directory, never a native configuration target.', 'NATIVE_SETUP_PATH');
  const stateDirectory = literal(options.stateDirectory), descriptorPath = path.join(stateDirectory, 'connection.json');
  try {
    const parentPin = await directoryInfo(parent);
    try { await lstat(outputDirectory); throw new MurmurError('Setup refuses an existing file or directory. Select a new export directory.', 'NATIVE_SETUP_EXISTS', 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const statePin = await directoryInfo(stateDirectory, true);
    await readPublicConnectionFile(descriptorPath);
    const privateDirectory = claudePrivateDirectory(descriptorPath);
    const workspaceRoot = await claudeProjectRoot(await realpath(process.cwd()));
    const relative = path.relative(workspaceRoot, stateDirectory);
    assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Private helper state must be outside the source workspace.', 'NATIVE_SETUP_PATH');
    const nodeExecutable = await actualFile(options.nodeExecutable ?? process.execPath, true);
    const cliPath = await actualFile(options.cliPath ?? fileURLToPath(new URL('../cli/index.js', import.meta.url)), false);
    const claudeExecutable = await findClaude(options);
    await versionPreflight(claudeExecutable, nodeExecutable);
    const bundle = createNativeSetupBundle({ tool: options.tool, descriptorPath, nodeExecutable, cliPath });
    const pins = new Map<string, Stats>([[parent, parentPin], [stateDirectory, statePin]]);
    const checkPins = async () => {
      for (const [directory, pin] of pins) assert(sameDirectory(pin, await directoryInfo(directory, directory !== parent)), 'An export or private helper directory changed; no replacement was written.', 'NATIVE_SETUP_CHANGED');
    };
    for (const directory of [path.dirname(privateDirectory), privateDirectory]) {
      await checkPins();
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      pins.set(directory, await directoryInfo(directory, true));
    }
    await checkPins();
    await mkdir(outputDirectory, { mode: 0o700 }); // EEXIST is a refusal, including symlinks.
    pins.set(outputDirectory, await directoryInfo(outputDirectory, true));
    for (const child of ['.claude-plugin', 'skills', 'skills/connect', 'hooks']) {
      await checkPins(); const directory = path.join(outputDirectory, child);
      await mkdir(directory, { mode: 0o700 }); pins.set(directory, await directoryInfo(directory, true));
    }
    const files: string[] = [];
    for (const asset of bundle.files) {
      await checkPins();
      const filename = path.join(outputDirectory, asset.path);
      const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(asset.content); await file.sync(); } finally { await file.close(); }
      files.push(filename);
    }
    await checkPins();
    return { tool: 'claude', enabled: true, exported: true, installed: false, connected: false, testedVersion: CLAUDE_EXISTING_CHAT_CAPABILITY.testedVersion,
      hotAttachVerified: false, outputDirectory, files, syntax: CLAUDE_CONNECT_SYNTAX,
      resumeCommand: `${quoteNativeShell(claudeExecutable)} --plugin-dir ${quoteNativeShell(outputDirectory)} --resume`,
      nextStep: 'Human action required: pause or exit the original CLI before reopening its conversation, then run the quoted command in the original project, use the native resume picker to select the original chat, then enter /murmur:connect help. Start/join still requires human approval. This export did not install a plugin, attach to an already-open chat, or connect any chat.' };
  } catch (error) {
    if (error instanceof MurmurError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MurmurError('Setup refuses an existing file or directory. Select a new export directory.', 'NATIVE_SETUP_EXISTS', 409);
    // Retain partial owned assets for inspection; never recursively delete changed targets.
    throw new MurmurError('Setup export could not finish. Existing files were not replaced; any partial export was retained. No plugin was installed or chat connected.', 'NATIVE_SETUP_FAILED');
  }
}
