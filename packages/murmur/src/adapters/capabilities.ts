import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { CLAUDE_EXISTING_CHAT_CAPABILITY } from './claude-existing-chat.js';
import { CODEX_EXISTING_CHAT_CAPABILITY } from './codex-existing-chat.js';

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
    const nativeChat = application.tool === 'claude' || application.tool === 'codex';
    const nativeCapability = application.tool === 'claude' ? CLAUDE_EXISTING_CHAT_CAPABILITY : application.tool === 'codex' ? CODEX_EXISTING_CHAT_CAPABILITY : null;
    const nativeNote = application.tool === 'claude'
      ? 'Claude Code 2.1.247: explicit plugin export and native resume; human-approved chat connection with automatic prompt/tool advisory context after explicit activation. Structured publication remains disabled pending verified native post-tool delivery.'
      : 'Codex CLI 0.154.0: explicit hook export, reviewed additive installation and native resume; human-approved chat connection with automatic context refresh after explicit activation. Parent-conversation scope includes Codex subagents.';
    return { ...application, executables, implementation: { managedLaunch, scopedCliBridge: managedLaunch, startupBriefing: managedLaunch, mcp, advisoryHookCommand: mcp, nativeHookConfiguration: application.tool === 'claude', standaloneRequired: application.tool === 'opencode', sharedGroups: true, externalScopedProtocol: true, existingChatNativeActions: nativeChat }, existingChat: { enabled: nativeChat, configured: null, connected: null, code: nativeChat ? `${application.tool.toUpperCase()}_EXPLICIT_RESUME` : 'NATIVE_ADAPTER_UNVERIFIED', testedVersion: nativeCapability?.testedVersion ?? null, hotAttachVerified: false, automaticContextRefresh: nativeChat, note: nativeChat ? `${nativeNote} Setup checks the installed version. No live connection, model use or hot attachment is inferred.` : 'No verified existing-chat adapter for this host.' }, status: 'unverified', configured: null, connected: null, verified: false,
      capabilities: { sessionIdentity: false, contextInjection: false, preWriteCheck: false, postWriteObservation: false, workspaceLaunch: false, mcpTools: false },
      note: nativeChat ? `${nativeNote} Implementation availability is not proof of native installation, connection, real model use or hot attachment.` : managedLaunch ? 'Implementation availability is separate from native verification. Doctor does not inspect live launch-local configuration or connections. OpenCode is CLI-only/standalone; Codex automatic hook configuration is gated. Binary detection and heartbeat do not prove model use.' : 'No managed launcher for this tool yet. Binary detection is not a connection or verification.' };
  }));
}
