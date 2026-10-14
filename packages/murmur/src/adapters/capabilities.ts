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
    return { ...application, executables, implementation: { managedLaunch, scopedCliBridge: managedLaunch, startupBriefing: managedLaunch, mcp, advisoryHookCommand: mcp, nativeHookConfiguration: application.tool === 'claude', standaloneRequired: application.tool === 'opencode' }, status: 'unverified', configured: null, connected: null, verified: false,
      capabilities: { sessionIdentity: false, contextInjection: false, preWriteCheck: false, postWriteObservation: false, workspaceLaunch: false, mcpTools: false },
      note: managedLaunch ? 'Implementation availability is separate from native verification. Doctor does not inspect live launch-local configuration or connections. OpenCode is CLI-only/standalone; Codex automatic hook configuration is gated. Binary detection and heartbeat do not prove model use.' : 'No managed launcher for this tool yet. Binary detection is not a connection or verification.' };
  }));
}
