import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'murmur-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export function mutation(operation, input, key = randomUUID(), caller = 'human') {
  return { operation, input, key, caller };
}
export function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Murmur tests', GIT_AUTHOR_EMAIL: 'tests@example.invalid', GIT_COMMITTER_NAME: 'Murmur tests', GIT_COMMITTER_EMAIL: 'tests@example.invalid' },
  }).trim();
}
export async function repository(root) {
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'README.md'), 'A disposable Murmur test fixture.\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'Create disposable test fixture\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>');
  return root;
}
