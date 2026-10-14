import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert, MurmurError, object, PROTOCOL_VERSION } from '../protocol/index.js';

/** Public service location only. Never add authentication material to this file. */
export type PublicConnection = { protocolVersion: number; origin: string; stateId: string; instanceId: string };
export const PUBLIC_CONNECTION_FILE = 'connection.json';
const MAX_BYTES = 2048;
function unsafe(): never { throw new MurmurError('The public connection descriptor is unsafe or belongs to another service.', 'INSECURE_CONNECTION'); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const sameFile = (a: Stats, b: Stats) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function privateOwner(info: Stats): boolean {
  return (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid());
}
export function validatePublicConnection(value: unknown): PublicConnection {
  const data = object(value);
  const fields = ['protocolVersion', 'origin', 'stateId', 'instanceId'];
  assert(Object.keys(data).length === fields.length && fields.every(key => Object.hasOwn(data, key)), 'Unexpected public connection fields.', 'INSECURE_CONNECTION');
  assert(data.protocolVersion === PROTOCOL_VERSION && typeof data.origin === 'string' && data.origin.length <= 128 &&
    typeof data.stateId === 'string' && /^[a-f0-9]{64}$/.test(data.stateId) &&
    typeof data.instanceId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.instanceId),
  'Invalid public connection metadata.', 'INSECURE_CONNECTION');
  let origin: URL;
  try { origin = new URL(data.origin); } catch { unsafe(); }
  assert(origin!.protocol === 'http:' && origin!.hostname === '127.0.0.1' && origin!.port !== '' &&
    !origin!.username && !origin!.password && !origin!.search && !origin!.hash && origin!.pathname === '/' &&
    origin!.origin === data.origin, 'Public service location must be a canonical loopback origin.', 'INSECURE_CONNECTION');
  return { protocolVersion: PROTOCOL_VERSION, origin: data.origin, stateId: data.stateId, instanceId: data.instanceId };
}
async function inspect(filename: string): Promise<{ info: Stats; bytes: Buffer; descriptor: PublicConnection } | null> {
  let before: Stats;
  try { before = await lstat(filename); } catch (error) { if (missing(error)) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || !privateOwner(before) || before.size > MAX_BYTES) unsafe();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!sameFile(before, info) || !info.isFile() || !privateOwner(info)) unsafe();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES || !sameFile(info, await handle.stat()) || !sameFile(info, await lstat(filename))) unsafe();
    const bytes = buffer.subarray(0, bytesRead);
    let data: unknown;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { unsafe(); }
    return { info, bytes, descriptor: validatePublicConnection(data) };
  } finally { await handle.close(); }
}

/** Publish only after the daemon owns its fixed port; release before that port. */
export async function publishPublicConnection(directory: string, input: PublicConnection): Promise<{ release(): Promise<boolean> }> {
  const descriptor = validatePublicConnection(input);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !privateOwner(directoryInfo) || await realpath(directory) !== directory) unsafe();
  const sameDirectory = async () => {
    try { const current = await lstat(directory); return current.isDirectory() && !current.isSymbolicLink() && privateOwner(current) && sameIdentity(directoryInfo, current) && await realpath(directory) === directory; }
    catch { return false; }
  };
  const filename = path.join(directory, PUBLIC_CONNECTION_FILE);
  const previous = await inspect(filename);
  if (previous && (previous.descriptor.origin !== descriptor.origin || previous.descriptor.stateId !== descriptor.stateId)) unsafe();
  const temporary = path.join(directory, `connection-${descriptor.instanceId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  let created: Stats | undefined;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    created = await lstat(temporary);
    if (!await sameDirectory()) unsafe();
    const current = await inspect(filename);
    if (previous ? !current || !sameFile(previous.info, current.info) || !previous.bytes.equals(current.bytes) : current !== null) unsafe();
    await rename(temporary, filename);
    const published = await inspect(filename);
    if (!published || !sameIdentity(created, published.info) || !published.bytes.equals(bytes)) unsafe();
    const publishedInfo = published.info;
    return { async release() {
      // Changed or substituted files are not ours to remove. This must not keep
      // a daemon alive just because someone changed public metadata on disk.
      try {
        if (!await sameDirectory()) return false;
        const current = await inspect(filename);
        if (!current || !sameFile(publishedInfo, current.info) || !current.bytes.equals(bytes)) return false;
        await unlink(filename);
        return true;
      } catch { return false; }
    } };
  } catch (error) {
    if (created) {
      try { const current = await lstat(temporary); if (await sameDirectory() && sameFile(created, current)) await unlink(temporary); } catch { /* Preserve uncertain files. */ }
    }
    throw error;
  }
}
