import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeSetupBundle } from '../adapters/existing-chat.js';
import { readPublicConnectionFile } from '../cli/external-helper.js';
import { assert } from '../protocol/index.js';
import { literalPath } from './filesystem.js';
import type { InstallationProjectHook, InstallationStrategy } from './types.js';

export type CodexInstallationStrategyOptions = { nodeExecutable?: string; cliPath?: string };
export function createCodexInstallationStrategy(options: CodexInstallationStrategyOptions = {}): InstallationStrategy {
  return {
    provider: 'codex', version: 'codex-project-user-prompt-v1', enabled: true,
    description: 'Additive project .codex/hooks.json registration for the observed Codex 0.154.0 UserPromptSubmit contract. Native /hooks trust and same-chat resume remain explicit.',
    limitation: 'Hook file installation is not proof of native loading, trust approval, hot attachment or a connected chat. Use only the tested Codex version.',
    async build(context) {
      const descriptorPath = path.join(context.stateDirectory, 'connection.json'); await readPublicConnectionFile(descriptorPath);
      const nodeExecutable = literalPath(await realpath(options.nodeExecutable ?? process.execPath));
      const cliPath = literalPath(await realpath(options.cliPath ?? fileURLToPath(new URL('../cli/index.js', import.meta.url))));
      for (const filename of [nodeExecutable, cliPath]) { const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o022) === 0, 'Murmur runtime files must be canonical and not writable by another user.', 'INSTALLATION_PATH'); }
      await access(nodeExecutable, constants.X_OK); await access(cliPath, constants.R_OK);
      const bundle = createNativeSetupBundle({ tool: 'codex', descriptorPath, nodeExecutable, cliPath });
      const exported = JSON.parse(bundle.files.find(file => file.path === 'hooks.json')!.content) as { hooks: { UserPromptSubmit: InstallationProjectHook['entry'][] } };
      return {
        files: bundle.files,
        projectHook: { path: '.codex/hooks.json', keys: ['hooks', 'UserPromptSubmit'], entry: exported.hooks.UserPromptSubmit[0]! },
        activation: { kind: 'manual', cwd: context.projectRoot, testedVersion: bundle.capability.testedVersion, nativeLoaded: 'unverified',
          instructions: "Use the tested Codex CLI version. Pause/exit the original process yourself, then run codex -c 'features.hooks=true' resume from the original project and select the same conversation. The hooks feature flag enables the hook surface, not trust or permission bypass. Review the exact project hook in native /hooks and grant only the normal native trust you choose. Do not enable allow-untrusted-hooks or bypass sandbox/permission settings. Then enter murmur-connect help as an ordinary message. Start/join still requires a separate Murmur human approval. This installer never launches or stops Codex." },
        runtimeDirectories: ['existing-chats', 'existing-chats/codex'], observedFiles: [descriptorPath, nodeExecutable, cliPath],
        requestedBehavior: ['Install the versioned Codex hook/export bundle privately outside source.', 'Append exactly one Murmur-owned matcher group to project .codex/hooks.json hooks.UserPromptSubmit while preserving other native hooks, comments, settings and permission rules.', 'Native /hooks approval and same-conversation resume remain explicit; never alter native trust or claim the hook has loaded.'],
      };
    },
  };
}
