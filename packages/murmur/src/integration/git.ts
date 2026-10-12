import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assert, MurmurError } from '../protocol/index.js';
import { discoverProject } from '../workspaces/identity.js';

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; truncated: boolean; stdoutBytes: number; stderrBytes: number };
export type Fingerprint = { root: string; common: string; gitDir: string; rootId: string; commonId: string; gitDirId: string };
export type ChangedPath = { path: string; status: string; previousPath?: string };
const LIMIT = 128 * 1024;

// Deliberately do not inherit credentials, agent tokens, GIT_* overrides, HOME,
// or Node/Python loader options. This is environment hygiene, NOT an OS sandbox.
export function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, CI: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Murmur integration', GIT_AUTHOR_EMAIL: 'integration@localhost.invalid', GIT_COMMITTER_NAME: 'Murmur integration', GIT_COMMITTER_EMAIL: 'integration@localhost.invalid' };
}
export async function run(command: string, args: string[], cwd: string, timeoutMs = 30000, signal?: AbortSignal, limit = LIMIT): Promise<RunResult> {
  if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false, stdoutBytes: 0, stderrBytes: 0 };
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { cwd, env: commandEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
    catch { reject(new MurmurError('Could not start the approved executable.', 'PROCESS_START_FAILED')); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let out = 0, err = 0, timedOut = false, cancelled = false, truncated = false, done = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (force = false) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* The process may already have exited. */ }
    };
    const stop = () => { kill(); escalation ??= setTimeout(() => kill(true), 250); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (chunks: Buffer[], chunk: Buffer, previous: number) => {
      const remaining = Math.max(0, limit - previous);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) { truncated = true; stop(); }
    };
    child.stdout.on('data', (chunk: Buffer) => { collect(stdout, chunk, out); out += chunk.length; });
    child.stderr.on('data', (chunk: Buffer) => { collect(stderr, chunk, err); err += chunk.length; });
    const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); signal?.removeEventListener('abort', abort); };
    child.on('error', () => { if (!done) { done = true; cleanup(); reject(new MurmurError('Could not start the approved executable.', 'PROCESS_START_FAILED')); } });
    child.on('close', code => {
      if (done) return;
      done = true; cleanup();
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut, cancelled, truncated, stdoutBytes: out, stderrBytes: err });
    });
  });
}
export async function git(root: string, args: string[], allowFailure = false): Promise<RunResult> {
  const result = await run('git', ['--no-replace-objects', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null', '-c', 'submodule.recurse=false', '-c', 'commit.gpgsign=false', '-c', 'merge.gpgsign=false', '-c', 'protocol.allow=never', ...args], root);
  assert(!result.timedOut && !result.cancelled && !result.truncated, 'Git inspection exceeded its time or output limit; no clean-state assumption was made.', 'GIT_LIMIT');
  if (!allowFailure) assert(result.code === 0, 'Git operation failed. Preserved work and recovery metadata must be inspected locally.', 'GIT_FAILED', 409);
  return result;
}
export async function value(root: string, args: string[]): Promise<string> { return (await git(root, args)).stdout.trimEnd(); }
export async function revision(root: string, ref: string): Promise<string> {
  const sha = await value(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  assert(/^[a-f0-9]{40,64}$/.test(sha), 'Expected a committed Git revision.', 'INVALID_REVISION');
  return sha;
}
export async function refValue(root: string, ref: string): Promise<string | null> {
  const symbolic = await git(root, ['symbolic-ref', '--quiet', ref], true);
  assert(symbolic.code === 1, 'Symbolic workflow refs are unsupported; no referenced branch was changed.', 'SYMBOLIC_REF', 409);
  const result = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref], true);
  if (result.code === 1) return null;
  assert(result.code === 0, 'Could not read the integration ref.', 'GIT_FAILED');
  const sha = result.stdout.trim();
  assert(/^[a-f0-9]{40,64}$/.test(sha), 'Integration ref is not a commit.', 'INVALID_REVISION');
  return sha;
}
export async function fingerprint(input: string, common: string): Promise<Fingerprint> {
  const root = await realpath(path.resolve(input));
  const identity = await discoverProject(root);
  assert(identity.mode === 'git' && identity.canonicalPath === common && identity.root === root, 'Workspace is not the recorded project worktree root.', 'WORKSPACE_IDENTITY_CHANGED', 409);
  const gitDir = await realpath(await value(root, ['rev-parse', '--path-format=absolute', '--git-dir']));
  const stamp = async (location: string) => { const info = await stat(location, { bigint: true }); return `${info.dev}:${info.ino}`; };
  return { root, common, gitDir, rootId: await stamp(root), commonId: await stamp(common), gitDirId: await stamp(gitDir) };
}
export async function checkIdentity(recorded: Fingerprint): Promise<void> {
  let current: Fingerprint;
  try { current = await fingerprint(recorded.root, recorded.common); }
  catch { throw new MurmurError('Recorded workspace was moved, replaced, or is unavailable; manual inspection is required.', 'WORKSPACE_IDENTITY_CHANGED', 409); }
  assert(JSON.stringify(current) === JSON.stringify(recorded), 'Recorded workspace identity changed; no work was removed.', 'WORKSPACE_IDENTITY_CHANGED', 409);
}
export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function worktrees(root: string): Promise<{ root: string; branch: string | null }[]> {
  const fields = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0');
  const rows: { root: string; branch: string | null }[] = [];
  for (const field of fields) {
    if (field.startsWith('worktree ')) rows.push({ root: field.slice(9), branch: null });
    if (field.startsWith('branch ') && rows.length) rows[rows.length - 1]!.branch = field.slice(7);
  }
  return rows;
}
export async function nonnested(root: string, candidate: string): Promise<void> {
  for (const item of await worktrees(root)) {
    let existing = path.resolve(item.root);
    try { existing = await realpath(existing); } catch { /* A missing worktree is still not disposable. */ }
    assert(existing === candidate || (!inside(existing, candidate) && !inside(candidate, existing)), 'Nested workspaces are unsupported; choose a sibling or external worktree.', 'NESTED_WORKSPACE');
  }
}
export async function status(root: string): Promise<ChangedPath[]> {
  const indexed = (await git(root, ['ls-files', '-v', '-z'])).stdout.split('\0').filter(Boolean);
  assert(!indexed.some(entry => entry[0] === 'S' || /^[a-z]/.test(entry)), 'Assume-unchanged or skip-worktree index flags can conceal edits; clear them yourself before using the workflow.', 'HIDDEN_INDEX_CHANGES', 409);
  const result = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const fields = result.stdout.split('\0');
  const paths: ChangedPath[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (!field) continue;
    assert(field.length >= 4 && field[2] === ' ', 'Could not parse Git status safely.', 'GIT_STATUS_INVALID');
    const entry: ChangedPath = { status: field.slice(0, 2), path: field.slice(3) };
    if (/[RC]/.test(entry.status)) {
      const original = fields[++index];
      assert(original, 'Incomplete Git rename evidence.', 'GIT_STATUS_INVALID');
      entry.previousPath = original;
    }
    paths.push(entry);
  }
  return paths;
}
export async function clean(root: string): Promise<void> {
  assert((await status(root)).length === 0, 'Workspace has tracked or untracked changes. Commit or resolve them yourself; Murmur never auto-commits or stashes source work.', 'DIRTY_WORKSPACE', 409);
}
export async function ancestor(root: string, base: string, tip: string): Promise<void> {
  const result = await git(root, ['merge-base', '--is-ancestor', base, tip], true);
  assert(result.code === 0, 'Recorded base is not an ancestor; unrelated, rewritten, or unsupported histories require manual reconciliation.', 'UNSUPPORTED_HISTORY', 409);
}
export async function supported(root: string, sha?: string): Promise<void> {
  assert(await value(root, ['rev-parse', '--is-shallow-repository']) === 'false', 'Shallow repositories are unsupported.', 'UNSUPPORTED_HISTORY');
  const config = await git(root, ['config', '--name-only', '--get-regexp', '^(filter\..*\.(clean|smudge|process|required)|merge\..*\.driver|core\.sparsecheckout|index\.sparse|extensions\.partialclone|remote\..*\.promisor)$'], true);
  assert(config.code === 1 && config.stdout === '', 'Custom checkout filters, merge drivers, sparse checkouts, and partial clones are unsupported.', 'UNSUPPORTED_GIT_CONFIG');
  const grafts = await value(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']);
  try { assert((await stat(grafts)).size === 0, 'Git graft histories are unsupported.', 'UNSUPPORTED_HISTORY'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (sha) {
    const tree = (await git(root, ['ls-tree', '-r', '-z', sha])).stdout;
    assert(!tree.split('\0').some(item => item.startsWith('160000 ')), 'Submodule changesets are unsupported by local integration.', 'UNSUPPORTED_HISTORY');
  }
}
export function privatePath(input: string): boolean {
  return input.split('/').some(part => /^(?:\.env(?:\..*)?|\.murmur|\.claude|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|credentials(?:\..*)?|id_(?:rsa|ed25519))$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
}
