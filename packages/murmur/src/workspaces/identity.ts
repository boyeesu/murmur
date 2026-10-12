import { realpath, stat, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assert, MurmurError, object, text } from '../protocol/index.js';
import type { Resource } from '../protocol/index.js';

const execute = promisify(execFile);
export type ProjectIdentity = { root: string; canonicalPath: string; mode: 'git' | 'advisory'; caseSensitive: boolean; fingerprint?: string };
const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(name)));
async function git(root: string, args: string[]): Promise<string> {
  const result = await execute('git', ['-C', root, 'rev-parse', '--path-format=absolute', ...args], { env: gitEnvironment(), timeout: 5000, maxBuffer: 65536 });
  return result.stdout.replace(/\r?\n$/, '');
}
async function fingerprint(root: string): Promise<string> {
  const info = await stat(root);
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}
async function caseSensitive(root: string): Promise<boolean> {
  const basename = path.basename(root);
  const swapped = basename.replace(/[a-zA-Z]/, character => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
  if (basename === swapped) return false; // Conservative overlap reporting when undetectable.
  try {
    const [original, alternate] = await Promise.all([stat(root), stat(path.join(path.dirname(root), swapped))]);
    return original.dev !== alternate.dev || original.ino !== alternate.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
export async function discoverProject(input: string): Promise<ProjectIdentity> {
  assert(!/[\r\n\0]/.test(input), 'Project paths containing newlines or NUL are unsupported.');
  const root = await realpath(path.resolve(input));
  assert((await stat(root)).isDirectory(), 'Project root must be a directory.');
  try {
    const workspace = await realpath(await git(root, ['--show-toplevel']));
    const common = await realpath(await git(root, ['--git-common-dir']));
    return { root: workspace, canonicalPath: common, mode: 'git', caseSensitive: await caseSensitive(workspace), fingerprint: await fingerprint(common) };
  } catch (error) {
    const detail = error as { stderr?: string };
    if (!detail.stderr?.includes('not a git repository')) {
      throw new MurmurError('Could not inspect Git project. Ensure Git is installed and the repository is accessible.', 'GIT_DISCOVERY_FAILED');
    }
    return { root, canonicalPath: root, mode: 'advisory', caseSensitive: await caseSensitive(root), fingerprint: await fingerprint(root) };
  }
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function resolveProspectivePath(candidate: string): Promise<string> {
  try { return await realpath(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      const entry = await lstat(candidate);
      assert(!entry.isSymbolicLink(), 'Cannot reserve a dangling symlink.', 'PATH_ESCAPE');
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
    }
    const parent = path.dirname(candidate);
    assert(parent !== candidate, 'Cannot resolve resource path.');
    return path.join(await resolveProspectivePath(parent), path.basename(candidate));
  }
}
export async function normalizeResources(input: unknown, workspace: string, sensitive: boolean): Promise<Resource[]> {
  assert(Array.isArray(input) && input.length > 0 && input.length <= 64, 'resources must contain 1–64 entries.');
  const root = await realpath(workspace);
  const resources: Resource[] = [];
  for (const raw of input) {
    const entry = object(raw);
    const value = text(entry.value, 'resource value', 1024);
    assert(entry.kind === 'path' || entry.kind === 'resource', 'Resource kind must be path or resource.');
    if (entry.kind === 'resource') {
      assert(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value), 'Invalid named resource.');
      resources.push({ kind: 'resource', value });
      continue;
    }
    assert(!path.isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..'), 'Paths must be relative and cannot escape the workspace.');
    const physical = await resolveProspectivePath(path.resolve(root, value));
    assert(inside(root, physical), 'A symlink points outside the workspace.', 'PATH_ESCAPE');
    let logical = path.relative(root, physical).split(path.sep).join('/') || '.';
    assert(!logical.split('/').includes('.git'), 'Git metadata cannot be reserved as project source.');
    let boundary = root;
    for (const part of logical.split('/')) {
      if (part === '.') continue;
      boundary = path.join(boundary, part);
      try {
        await lstat(path.join(boundary, '.git'));
        throw new MurmurError('Nested repositories/submodules require separate project registration.', 'NESTED_REPOSITORY');
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
    }
    if (!sensitive) logical = logical.toLowerCase();
    resources.push({ kind: 'path', value: logical });
  }
  return [...new Map(resources.map(resource => [`${resource.kind}:${resource.value}`, resource])).values()].sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`));
}
export function resourcesOverlap(a: Resource, b: Resource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'resource') return a.value === b.value;
  // Logical reservations are conservative across worktrees on different volumes.
  const left = a.value.normalize('NFC').toLowerCase();
  const right = b.value.normalize('NFC').toLowerCase();
  return left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
