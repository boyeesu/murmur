import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNativeRequestsServer } from '../mcp/native-requests.js';
import { MurmurError } from '../protocol/index.js';

export const NATIVE_REQUEST_STDIN_BYTES = 32 * 1024;
export type NativeRequestsMainOptions = { input?: Readable; output?: Writable };
/** Dispatch before human discovery. Stdout is exclusively MCP; no return envelope. */
export async function nativeRequestsMain(argv: string[] = [], options: NativeRequestsMainOptions = {}): Promise<void> {
  if (argv.length !== 0) throw new MurmurError('Use only murmur native-requests, without identity or configuration arguments.', 'NATIVE_REQUEST_ARGUMENTS');
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const server = createNativeRequestsServer();
  const invalid = () => new MurmurError('Actorless request transport stopped safely.', 'NATIVE_REQUEST_TRANSPORT');
  // The SDK's line decoder replaces malformed UTF-8. Validate the original
  // bytes first, retaining decoder state for characters split across chunks.
  // No repaired text or undecoded tail may become an actorless request.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const validatedInput = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        if (!Buffer.isBuffer(chunk) || chunk.length > NATIVE_REQUEST_STDIN_BYTES) throw invalid();
        decoder.decode(chunk, { stream: true });
        callback(null, chunk);
      } catch { callback(invalid()); }
    },
    flush(callback) { try { decoder.decode(); callback(); } catch { callback(invalid()); } },
  });
  const transport = new StdioServerTransport(validatedInput, output, { maxBufferSize: NATIVE_REQUEST_STDIN_BYTES });
  await new Promise<void>((resolve, reject) => {
    let closing = false, finished = false, failed = false;
    const finish = () => {
      if (finished) return; finished = true;
      input.off('error', fail); input.off('close', closed); output.off('error', fail);
      validatedInput.off('end', stop); validatedInput.off('error', fail);
      input.unpipe(validatedInput); validatedInput.destroy();
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      input.destroy();
      if (failed) reject(invalid());
      else resolve();
    };
    const stop = () => {
      if (closing) return; closing = true;
      void server.close().then(finish, () => { failed = true; finish(); });
    };
    const fail = () => { failed = true; stop(); };
    const closed = () => { if (!input.readableEnded) fail(); };
    server.server.onclose = finish; server.server.onerror = fail;
    input.once('error', fail); input.once('close', closed); output.once('error', fail);
    validatedInput.once('end', stop); validatedInput.once('error', fail);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    void server.connect(transport).then(() => {
      if (input.readableEnded || input.destroyed) stop();
      else input.pipe(validatedInput);
    }, fail);
  });
}
