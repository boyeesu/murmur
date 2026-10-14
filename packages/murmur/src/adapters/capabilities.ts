import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const applications = [
  { tool: 'claude', commands: ['claude'], reference: 'https://code.claude.com/docs/en/hooks' },
  { tool: 'codex', commands: ['codex'], reference: 'https://developers.openai.com/codex/hooks' },
  { tool: 'cursor', commands: ['cursor-agent', 'agent', 'cursor'], reference: 'https://cursor.com/docs/agent/hooks' },
  { tool: 'opencode', commands: ['opencode'], reference: 'https://opencode.ai/docs/plugins/' },
];
export async function adapterDiagnostics() {
  return Promise.all(applications.map(async application => {
    const executables: string[] = [];
    for (const command of application.commands) {
      for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const filename = path.join(directory, command);
        try { await access(filename, constants.X_OK); executables.push(filename); break; } catch { /* Not on this PATH. */ }
      }
    }
    const managedLaunch = ['claude','codex','opencode'].includes(application.tool);
    const mcp = application.tool === 'claude' || application.tool === 'codex';
    const nativeChat = application.tool === 'claude';
    return { ...application, executables, implementation: { managedLaunch, scopedCliBridge: managedLaunch, startupBriefing: managedLaunch, mcp, advisoryHookCommand: mcp, nativeHookConfiguration: application.tool === 'claude', standaloneRequired: application.tool === 'opencode', sharedGroups: true, externalScopedProtocol: true, existingChatNativeActions: nativeChat }, existingChat: { enabled: nativeChat, configured: null, connected: null, code: nativeChat ? 'CLAUDE_EXPLICIT_RESUME' : 'NATIVE_ADAPTER_UNVERIFIED', testedVersion: nativeChat ? '2.1.247' : null, hotAttachVerified: false, note: nativeChat ? 'Claude Code 2.1.247: explicit plugin export and native resume, human-approved command-driven coordination. Installed version is checked during setup; no live connection is inferred here. Hot attachment remains unverified.' : 'No verified existing-chat adapter for this host.' }, status: 'unverified', configured: null, connected: null, verified: false,
      capabilities: { sessionIdentity: false, contextInjection: false, preWriteCheck: false, postWriteObservation: false, workspaceLaunch: false, mcpTools: false },
      note: nativeChat ? 'Claude Code 2.1.247 explicit plugin/resume connector is available and native-fixture tested. Setup checks the installed version; configured/connected state and real model use are not inferred. Hot attachment is unverified.' : managedLaunch ? 'Implementation availability is separate from native verification. Doctor does not inspect live launch-local configuration or connections. OpenCode is CLI-only/standalone; Codex automatic hook configuration is gated. Binary detection and heartbeat do not prove model use.' : 'No managed launcher for this tool yet. Binary detection is not a connection or verification.' };
  }));
}
