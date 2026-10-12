import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, lstat } from 'node:fs/promises';
import { assert } from '../protocol/index.js';

export function defaultStateDirectory(): string {
  if (process.env.MURMUR_HOME) return path.resolve(process.env.MURMUR_HOME);
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Murmur');
  return path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'murmur');
}
export async function prepareStateDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  assert(info.isDirectory(), 'Murmur state must be a directory.');
  assert((info.mode & 0o077) === 0, 'State directory must be private (mode 0700). Use a dedicated directory.', 'INSECURE_STATE');
  if (process.getuid) assert(info.uid === process.getuid(), 'State directory belongs to another user.', 'INSECURE_STATE');
  for (const name of ['state.sqlite', 'daemon.json']) {
    try {
      const entry = await lstat(path.join(directory, name));
      assert(entry.isFile() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0, `Unsafe state file: ${name}.`, 'INSECURE_STATE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return realpath(directory);
}
export function stateIdentity(directory: string): string {
  return createHash('sha256').update(directory).digest('hex');
}
export function statePort(directory: string): number {
  // The same canonical state directory always binds the same OS-owned lock.
  // No override/fallback: selecting another port could start a second DB writer.
  return 20000 + (Number.parseInt(stateIdentity(directory).slice(0, 8), 16) % 20000);
}
