#!/usr/bin/env node
/** Offline smoke test of the EXACT candidate archive, not a freshly repacked one. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-package.mjs ARCHIVE');
const archive = await realpath(process.argv[2]);
const pkg = JSON.parse(await readFile(path.join(root, 'packages/murmur/package.json'), 'utf8'));
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'murmur-candidate-')));
try {
  const installation = path.join(temporary, 'installation');
  await mkdir(installation);
  // No inherited credentials, npm registry config, NODE_PATH or loader hooks.
  const env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary,
    NPM_CONFIG_USERCONFIG: path.join(temporary, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(temporary, 'global.npmrc'),
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const run = (command, args) => promisify(execFile)(command, args, { cwd: installation, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const cache = path.join(temporary, 'cache');
  await run('npm', ['install', archive, '--prefix', installation, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache]);
  await run('npm', ['ls', '--all', '--omit=dev', '--offline', '--json', '--cache', cache]);
  const installed = path.join(installation, 'node_modules', pkg.name);
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error('Installed candidate identity/version mismatch');
  const { stdout } = await run(process.execPath, [path.join(installed, 'dist/cli/index.js'), '--help']);
  if (!stdout.includes('murmur')) throw new Error('Installed candidate CLI did not return help');
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== sha256) throw new Error('Candidate changed during verification');
  console.log(JSON.stringify({ archive, sha256, offlineInstall: true, cliHelp: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
