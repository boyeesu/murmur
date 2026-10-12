import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, MurmurError, PROTOCOL_VERSION } from '../protocol/index.js';
import { requireHumanEnvironment } from '../protocol/agent.js';
import { stateIdentity, statePort } from '../daemon/config.js';

export async function loadDescriptor(directory: string) {
  requireHumanEnvironment();
  try {
    const canonical = await realpath(directory);
    const filename = path.join(canonical, 'daemon.json');
    const info = await lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'Unsafe daemon credential file.', 'INSECURE_STATE');
    const descriptor = JSON.parse(await readFile(filename, 'utf8'));
    assert(descriptor.protocolVersion === PROTOCOL_VERSION && descriptor.stateId === stateIdentity(canonical) && descriptor.port === statePort(canonical), 'Incompatible or mismatched daemon descriptor.', 'DAEMON_MISMATCH');
    assert(typeof descriptor.token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(descriptor.token), 'Invalid daemon credential.', 'DAEMON_MISMATCH');
    return descriptor as { port: number; token: string; instanceId: string; stateId: string; protocolVersion: number };
  } catch (error) {
    if (error instanceof MurmurError) throw error;
    throw new MurmurError('Murmur is not running or its descriptor cannot be read. Start `murmur daemon start` in another terminal.', 'DAEMON_UNAVAILABLE', 503);
  }
}
export async function request(directory: string, method: string, endpoint: string, body?: unknown, options: { token?: string; key?: string; timeoutMs?: number } = {}): Promise<any> {
  const descriptor = await loadDescriptor(directory);
  assert(endpoint.startsWith('/') && !endpoint.startsWith('//'), 'Endpoint must be a local absolute path.');
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${descriptor.port}${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      headers: { Authorization: `Bearer ${options.token ?? descriptor.token}`, 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'Idempotency-Key': options.key ?? randomUUID() } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new MurmurError('Cannot reach the local Murmur daemon. It may have stopped; no automatic replay was attempted.', 'DAEMON_UNAVAILABLE', 503); }
  const data = await response.json() as any;
  if (!response.ok) throw new MurmurError(data.error?.message || 'Daemon request failed.', data.error?.code || 'REQUEST_FAILED', response.status, data.error?.details);
  return data;
}
