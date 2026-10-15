import { execFile } from 'node:child_process';
import { access, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createNativeSetupBundle, CLAUDE_EXISTING_CHAT_CAPABILITY } from '../adapters/existing-chat.js';
import { readPublicConnectionFile } from '../cli/external-helper.js';
import { assert, MurmurError } from '../protocol/index.js';
import { literalPath } from './filesystem.js';
import type { InstallationStrategy } from './types.js';

export type ClaudeInstallationStrategyOptions = { env?: NodeJS.ProcessEnv; nativeExecutable?: string; nodeExecutable?: string; cliPath?: string };
async function actualFile(filename: string, executable = false): Promise<string> {
  const actual = literalPath(await realpath(literalPath(filename))), info = await lstat(actual);
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o022) === 0, 'A canonical, non-writable native executable or Murmur CLI file is required.', 'INSTALLATION_NATIVE_UNAVAILABLE');
  await access(actual, executable ? constants.X_OK : constants.R_OK); return actual;
}
async function findExecutable(options: ClaudeInstallationStrategyOptions): Promise<string> {
  if (options.nativeExecutable) return actualFile(options.nativeExecutable, true);
  for (const directory of (options.env ?? process.env).PATH?.split(path.delimiter) ?? []) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try { return await actualFile(path.join(directory, 'claude'), true); } catch { /* Only the human-supplied PATH is searched. */ }
  }
  throw new MurmurError('Claude executable is unavailable; no native integration was installed.', 'INSTALLATION_NATIVE_UNAVAILABLE');
}
/** A metadata-only probe with isolated native homes. Never calls a model, installs
 * a plugin, or changes native trust/permissions. Proxy restrictions are retained.
 */
async function preflight(executable: string, nodeExecutable: string, env: NodeJS.ProcessEnv): Promise<void> {
  const directory = await mkdtemp(path.join(await realpath(process.env.TMPDIR ?? tmpdir()), 'murmur-install-version-'));
  try {
    const proxy = Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:https?|all|no)_proxy$/i.test(key)));
    const { stdout } = await promisify(execFile)(executable, ['--version'], {
      cwd: directory, timeout: 5000, maxBuffer: 1024,
      env: { ...proxy, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_STATE_HOME: directory, CLAUDE_CONFIG_DIR: directory, TMPDIR: directory,
        PATH: [path.dirname(nodeExecutable), '/usr/bin', '/bin'].join(path.delimiter), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    assert(stdout.trim() === `${CLAUDE_EXISTING_CHAT_CAPABILITY.testedVersion} (Claude Code)`, 'Installed Claude version is outside the verified explicit-resume contract.', 'INSTALLATION_NATIVE_VERSION');
  } catch (error) {
    if (error instanceof MurmurError) throw error;
    throw new MurmurError('Native metadata-only version preflight failed; no native integration was installed.', 'INSTALLATION_NATIVE_VERSION');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createClaudeInstallationStrategy(options: ClaudeInstallationStrategyOptions = {}): InstallationStrategy {
  return {
    provider: 'claude', version: 'claude-explicit-resume-v1', enabled: true,
    limitation: 'Managed bundle only. The real 2.1.247 local marketplace installer also mutates opaque native-profile migration/identity/cache files and rewrites settings formatting; direct project declarations alone do not register an installed plugin. Automatic native installation is therefore not enabled. Explicit --plugin-dir/--resume remains supported; native loading is unverified.',
    description: 'Managed private plugin bundle; explicit project-local Claude 2.1.247 --plugin-dir/--resume activation only. No settings mutation or hot attachment.',
    async build(context) {
      const descriptorPath = path.join(context.stateDirectory, 'connection.json');
      await readPublicConnectionFile(descriptorPath);
      const nodeExecutable = await actualFile(options.nodeExecutable ?? process.execPath, true);
      const cliPath = await actualFile(options.cliPath ?? fileURLToPath(new URL('../cli/index.js', import.meta.url)));
      const executable = await findExecutable(options); await preflight(executable, nodeExecutable, options.env ?? process.env);
      const bundle = createNativeSetupBundle({ tool: 'claude', descriptorPath, nodeExecutable, cliPath });
      return {
        files: bundle.files,
        activation: { kind: 'explicit-command', executable, args: ['--plugin-dir', context.bundleDirectory, '--resume'], cwd: context.projectRoot,
          instructions: 'Human action required: pause or exit the original CLI yourself, then run this exact command in the original project and select the original chat in the native resume picker. Run /murmur:connect help. Start/join still requires separate human approval. Do not use on unverified Claude versions. Existing processes are not changed or stopped.',
          testedVersion: CLAUDE_EXISTING_CHAT_CAPABILITY.testedVersion, nativeLoaded: 'unverified' },
        requestedBehavior: ['Install a private, versioned Murmur plugin bundle for this project only.', 'Expose human-invoked /murmur:connect commands through the verified UserPromptSubmit hook after explicit native activation.', 'Do not modify native settings, permissions, trust, source, workspaces, grants, tasks, or running native processes.'],
        runtimeDirectories: ['existing-chats', 'existing-chats/claude'], observedFiles: [descriptorPath, executable, nodeExecutable, cliPath],
      };
    },
  };
}
