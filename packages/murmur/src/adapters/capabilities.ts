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
    const managedLaunch = application.tool === 'claude' || application.tool === 'codex';
    return { ...application, executables, implementation: { managedLaunch, scopedCliBridge: managedLaunch, startupBriefing: managedLaunch, mcp: false, nativeHooks: false }, status: 'unverified', configured: false, connected: false, verified: false,
      capabilities: { sessionIdentity: false, contextInjection: false, preWriteCheck: false, postWriteObservation: false, workspaceLaunch: false, mcpTools: false },
      note: managedLaunch ? 'Managed CLI launch and scoped command implementations are available. Native MCP/hooks and real model-driven use are not verified by binary detection or heartbeat.' : 'No managed launcher for this tool yet. Binary detection is not a connection or verification.' };
  }));
}
