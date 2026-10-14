import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assert, canonicalJson, MurmurError } from '../protocol/index.js';

export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const inside = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);
export function literalPath(value: unknown): string {
  assert(typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && path.normalize(value) === value && !value.includes(String.fromCharCode(0x2028)) && !value.includes(String.fromCharCode(0x2029)) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Installation paths must be canonical literal absolute paths.', 'INSTALLATION_PATH');
  return value;
}
export function relativePath(value: unknown): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), 'Invalid installation asset path.', 'INSTALLATION_PATH');
  return value;
}
export type FileStamp = { dev: number; ino: number; birthtimeMs: number; mtimeMs: number; ctimeMs: number; size: number; mode: number; uid: number; gid: number; nlink: number; hash: string };
export type DirectoryStamp = { dev: number; ino: number; birthtimeMs: number };
export const directoryStamp = (info: Stats): DirectoryStamp => ({ dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs });
export const sameDirectory = (a: DirectoryStamp, b: DirectoryStamp): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
export async function directoryInfo(directory: string, privateOnly = true): Promise<Stats> {
  literalPath(directory);
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory && (!process.getuid || info.uid === process.getuid()) && (!privateOnly || (info.mode & 0o077) === 0), 'Installation directories must be canonical, owner-controlled and private for state.', 'INSTALLATION_PATH');
  return info;
}
export async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Pins directories, including every traversed private-state component. No
 * recursive mkdir, chmod of existing content, or symlink following is allowed.
 */
export class DirectoryGuard {
  readonly pins = new Map<string, { stamp: DirectoryStamp; privateOnly: boolean }>();
  async pin(directory: string, privateOnly = true): Promise<void> {
    const info = await directoryInfo(directory, privateOnly), prior = this.pins.get(directory);
    assert(!prior || sameDirectory(prior.stamp, info), 'An installation directory changed.', 'INSTALLATION_CHANGED');
    this.pins.set(directory, { stamp: directoryStamp(info), privateOnly });
  }
  async check(): Promise<void> {
    for (const [directory, pin] of this.pins) assert(sameDirectory(pin.stamp, await directoryInfo(directory, pin.privateOnly)), 'An installation directory changed.', 'INSTALLATION_CHANGED');
  }
  async ensure(directory: string): Promise<boolean> {
    assert(this.pins.has(path.dirname(directory)), 'Unpinned installation parent.', 'INSTALLATION_PATH');
    await this.check(); let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; await syncDirectory(path.dirname(directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await this.pin(directory); return created;
  }
}
export async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
export async function readSafe(filename: string, maximum = 8 * 1024 * 1024, privateOnly = true, maximumLinks = 1): Promise<{ content: string; stamp: FileStamp }> {
  literalPath(filename);
  assert(await realpath(path.dirname(filename)) === path.dirname(filename), 'Installation file parent is not canonical.', 'INSTALLATION_PATH');
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    assert(info.isFile() && info.nlink >= 1 && info.nlink <= maximumLinks && info.size <= maximum && (!process.getuid || info.uid === process.getuid()) && (privateOnly ? (info.mode & 0o077) === 0 : (info.mode & 0o022) === 0), 'Installation state must be a bounded, private, singly-linked regular file.', 'INSTALLATION_PATH');
    const bytes = Buffer.alloc(info.size + 1); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await file.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; }
    const after = await file.stat(), current = await lstat(filename);
    assert(used === info.size && sameDirectory(info, after) && sameDirectory(info, current) && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs && info.size === after.size && info.mode === after.mode && info.uid === after.uid && info.gid === after.gid && info.nlink === after.nlink, 'Installation file changed while being read.', 'INSTALLATION_CHANGED');
    let content: string;
    try { content = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used)); }
    catch { throw new MurmurError('Installation state is not valid UTF-8.', 'INSTALLATION_SCHEMA'); }
    return { content, stamp: { ...directoryStamp(info), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, mode: info.mode & 0o777, uid: info.uid, gid: info.gid, nlink: info.nlink, hash: digest(bytes.subarray(0, used)) } };
  } finally { await file.close(); }
}
export async function snapshot(filename: string, privateOnly = true): Promise<FileStamp | null> {
  try { return (await readSafe(filename, 8 * 1024 * 1024, privateOnly)).stamp; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function matches(actual: FileStamp | null, expected: FileStamp | null): boolean {
  return actual === null || expected === null ? actual === expected : canonicalJson(actual) === canonicalJson(expected);
}
export function encode(value: unknown): string { return JSON.stringify({ schemaVersion: 1, hash: digest(canonicalJson(value)), data: value }) + '\n'; }
export function decode<T>(source: string): T {
  let value: { schemaVersion?: number; hash?: string; data?: unknown };
  try { value = JSON.parse(source); } catch { throw new MurmurError('Installation state cannot be parsed.', 'INSTALLATION_SCHEMA'); }
  assert(value && typeof value === 'object' && Object.keys(value).length === 3 && value.schemaVersion === 1 && typeof value.hash === 'string' && value.hash === digest(canonicalJson(value.data)), 'Unknown installation state schema or integrity mismatch.', 'INSTALLATION_SCHEMA');
  return value.data as T;
}
export async function atomicReplace(filename: string, content: string, guard: DirectoryGuard): Promise<void> {
  await guard.check(); const before = await snapshot(filename), temporary = path.join(path.dirname(filename), `.murmur-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  try {
    await guard.check(); assert(matches(await snapshot(filename), before), 'Installation state changed before commit.', 'INSTALLATION_CHANGED');
    await rename(temporary, filename); await syncDirectory(path.dirname(filename));
  } finally { if (await exists(temporary)) await unlink(temporary); }
}
/** Atomic no-replace publication. A crash may leave the known staging hardlink;
 * normalizeStaging removes only that exact inode before recovery inspects files.
 */
export async function publishNew(filename: string, content: string, staging: string, guard: DirectoryGuard, mode = 0o600): Promise<void> {
  await guard.check();
  const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  if (mode !== 0o600) { const handle = await open(staging, constants.O_WRONLY | constants.O_NOFOLLOW); try { await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); } }
  await guard.check(); await link(staging, filename); await syncDirectory(path.dirname(filename));
  await unlink(staging); await syncDirectory(path.dirname(staging));
}
export async function replaceCompared(filename: string, content: string, expected: FileStamp, staging: string, guard: DirectoryGuard): Promise<void> {
  await guard.check();
  const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.chmod(expected.mode); await file.sync(); } finally { await file.close(); }
  await guard.check(); assert(matches(await snapshot(filename, false), expected), 'Native configuration changed before atomic replacement.', 'INSTALLATION_CHANGED');
  await rename(staging, filename); await syncDirectory(path.dirname(filename)); await syncDirectory(path.dirname(staging));
}
export async function normalizeStaging(staging: string, target: string, expectedHash: string, guard: DirectoryGuard, privateOnly = true, expectedContent?: string): Promise<void> {
  if (!await exists(staging)) return;
  await guard.check(); const staged = await lstat(staging);
  assert(staged.isFile() && !staged.isSymbolicLink() && (!privateOnly || (staged.mode & 0o077) === 0) && (!process.getuid || staged.uid === process.getuid()), 'Unsafe transaction staging content.', 'INSTALLATION_CHANGED');
  if (staged.nlink === 2) {
    const actual = await lstat(target); assert(sameDirectory(staged, actual) && actual.nlink === 2, 'Transaction hardlink changed.', 'INSTALLATION_CHANGED');
    await unlink(staging); await syncDirectory(path.dirname(staging));
    assert((await readSafe(target, 8 * 1024 * 1024, privateOnly)).stamp.hash === expectedHash, 'Published transaction content changed.', 'INSTALLATION_CHANGED');
  } else {
    assert(staged.nlink === 1, 'Unexpected transaction hardlinks.', 'INSTALLATION_CHANGED');
    // Only a known complete/prefix staging write is ours. Unknown content in a
    // reserved filename is retained, not treated as disposable user data.
    const partial = await readSafe(staging, 8 * 1024 * 1024, privateOnly);
    assert(expectedContent !== undefined && expectedContent.startsWith(partial.content), 'Transaction staging contains unknown content; recovery preserved it.', 'INSTALLATION_RECOVERY_CONFLICT');
    await unlink(staging); await syncDirectory(path.dirname(staging));
  }
}
