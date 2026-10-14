import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { formatNativeRequest, nativeRequestTools } from '../adapters/native-publication.js';

/** No credentials, environment reads, files, network or actor selection. */
export function createNativeRequestsServer(): McpServer {
  class SafeServer extends McpServer {
    override connect(transport: Transport): Promise<void> {
      const guarded: Transport = {
        start: () => transport.start(), close: () => transport.close(),
        send: (message, options) => transport.send('error' in message ? { ...message, error: { code: message.error.code, message: 'Invalid actorless request.' } } : message, options),
        get onmessage() { return transport.onmessage; }, set onmessage(value) { transport.onmessage = value; },
        get onclose() { return transport.onclose; }, set onclose(value) { transport.onclose = value; },
        get onerror() { return transport.onerror; }, set onerror(value) { transport.onerror = value; },
        get sessionId() { return transport.sessionId; }, setProtocolVersion: transport.setProtocolVersion?.bind(transport),
      };
      return super.connect(guarded);
    }
  }
  const server = new SafeServer({ name: 'murmur-native-requests', version: '0.6.0-alpha.1' }, {
    instructions: 'These tools only format actorless coordination requests. They cannot connect a chat, read context or publish anything. Only a trusted native PostToolUse bridge can publish for an already-approved current chat. An awaiting_native_bridge receipt is NOT publication success. Respect the native bridge result; do not retry automatically.',
  });
  for (const tool of nativeRequestTools) server.registerTool(tool.name, {
    title: tool.title,
    description: `${tool.title}. Requires an already-approved native chat and trusted post-tool bridge. Returns an awaiting_native_bridge receipt, never publication success. No session, task, workspace, credential or actor parameters are accepted.`,
    inputSchema: tool.inputSchema,
    // The formatter itself is pure, but the intended native bridge can mutate.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (input: unknown) => formatNativeRequest(tool.name, input));
  server.server.setRequestHandler(CallToolRequestSchema, request => {
    try { return formatNativeRequest(request.params.name, request.params.arguments ?? {}); }
    catch { return { isError: true, content: [{ type: 'text' as const, text: '{"status":"not_published","error":"NATIVE_REQUEST_INPUT"}' }] }; }
  });
  return server;
}
