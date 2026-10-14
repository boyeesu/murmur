import { readAgentConnection } from '../protocol/agent.js';
import { AgentClient } from './agent-client.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MurmurError } from '../protocol/index.js';

export const MAX_MCP_STDIN_BYTES = 128 * 1024;
const help = `Usage: murmur mcp serve
       murmur mcp --help

Serve the managed task-scoped Murmur tools over MCP stdio.
Requires MURMUR_AGENT_MODE=1 and the complete MURMUR_AGENT_CONNECTION
provided by a managed launch. No state, credential, or project discovery.
Stdout is reserved for MCP while serving. EOF and signals close this adapter,
not the managed task/session; credentials are never renewed here.
`;

/** The top-level CLI must dispatch this before its human guard and must not print its return value. */
export async function mcpMain(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if ((argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) ||
      (argv.length === 2 && argv[0] === 'serve' && argv[1] === '--help')) {
    process.stdout.write(help);
    return;
  }
  try {
    if (argv.length !== 1 || argv[0] !== 'serve') throw new MurmurError('Use murmur mcp serve or murmur mcp --help.', 'INVALID_COMMAND');
    // Fail before importing the SDK. Never read the human descriptor or start a daemon.
    const connection = readAgentConnection(env);
    const [{ createMurmurMcpServer }, { StdioServerTransport }] = await Promise.all([
      import('../mcp/server.js'), import('@modelcontextprotocol/sdk/server/stdio.js'),
    ]);
    const server = createMurmurMcpServer(connection);
    const lifetime = new AbortController();
    const identityClient = new AgentClient(connection, { fetch: (url, init) => globalThis.fetch(url, {
      ...init, signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
    }) });
    // Let the official transport consume stdin during preflight so EOF/close is
    // observable even when the peer already wrote an initialize request. Do not
    // deliver that request (or any other message) until the scoped identity passes.
    class VerifiedStdioTransport extends StdioServerTransport {
      override async start(): Promise<void> {
        const deliver = this.onmessage;
        const pending: JSONRPCMessage[] = [];
        let bytes = 0;
        this.onmessage = message => {
          if (lifetime.signal.aborted) return;
          bytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
          if (bytes > MAX_MCP_STDIN_BYTES) {
            this.onerror?.(new Error('MCP preflight input limit.'));
            return;
          }
          pending.push(message);
        };
        await super.start();
        try {
          await identityClient.identity();
          if (lifetime.signal.aborted) return;
          this.onmessage = deliver;
          for (const message of pending) {
            if (lifetime.signal.aborted) break;
            deliver?.(message);
          }
        } finally { pending.length = 0; }
      }
    }
    const transport = new VerifiedStdioTransport(process.stdin, process.stdout, { maxBufferSize: MAX_MCP_STDIN_BYTES });
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      let failed: MurmurError | undefined;
      let finished = false;
      const cleanup = (): void => {
        process.stdin.off('end', stop);
        process.stdin.off('close', stop);
        process.stdout.off('error', fail);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      };
      const finish = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        lifetime.abort();
        // SDK pause alone leaves an open pipe referenced when a peer keeps writing.
        // This CLI owns stdin; close it so rejected input and signals also exit promptly.
        process.stdin.destroy();
        if (failed) reject(failed);
        else resolve();
      };
      const stop = (): void => {
        if (closing) return;
        closing = true;
        lifetime.abort();
        // SDK close aborts all in-flight handler signals and removes transport listeners.
        void server.close().then(finish, () => { failed = new MurmurError('The MCP stdio connection failed.', 'MCP_TRANSPORT'); finish(); });
      };
      const fail = (error?: unknown): void => {
        if (finished) return;
        failed = error instanceof MurmurError ? error : new MurmurError('The MCP stdio connection failed.', 'MCP_TRANSPORT');
        stop();
      };
      server.server.onclose = () => { closing = true; finish(); };
      // SDK errors can include raw JSON or validation keys. Never print their messages.
      server.server.onerror = fail;
      process.stdin.once('end', stop);
      process.stdin.once('close', stop);
      process.stdout.once('error', fail);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      // connect owns start(); do not start the transport a second time.
      void server.connect(transport).then(() => {
        if (process.stdin.readableEnded || process.stdin.destroyed) stop();
      }, fail);
    });
  } catch (error) {
    // Fixed messages also protect malformed managed connection JSON and SDK diagnostics.
    const code = error instanceof MurmurError && ['AGENT_CONFIGURATION', 'AGENT_CREDENTIAL_EXPIRED', 'AGENT_IDENTITY_MISMATCH', 'AGENT_STATE_MISMATCH', 'AGENT_PROTOCOL_MISMATCH', 'AGENT_TIMEOUT', 'AGENT_UNAVAILABLE', 'INVALID_COMMAND', 'MCP_TRANSPORT'].includes(error.code)
      ? error.code : 'MCP_START_FAILED';
    const message = code === 'AGENT_CONFIGURATION' ? 'A valid managed agent connection is required.'
      : code === 'INVALID_COMMAND' ? 'Use murmur mcp serve or murmur mcp --help.' : 'The MCP stdio adapter could not continue.';
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
