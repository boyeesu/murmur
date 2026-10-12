import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';
const execute = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));

test('packed CLI installs offline and runs outside the source checkout', async t => {
  const root = await temporary(t);
  const destination = path.join(root, 'package');
  const installation = path.join(root, 'installation');
  const cache = path.join(root, 'cache');
  await mkdir(destination); await mkdir(installation);
  const packed = await execute('npm', ['pack', '--workspace=murmur-local', '--pack-destination', destination, '--offline', '--ignore-scripts', '--cache', cache, '--json'], { cwd: project, timeout: 30000 });
  const info = JSON.parse(packed.stdout)[0];
  assert(info.files.some(file => file.path === 'LICENSE'));
  assert(info.files.some(file => file.path === 'docs/user-guide.md'));
  assert(info.files.some(file => file.path === 'docs/release-checklist.md'));
  assert(info.files.some(file => file.path === 'dist/dashboard/index.html'));
  assert(!info.files.some(file => file.path.includes('daemon.json') || file.path.includes('.claude')));
  await execute('npm', ['install', path.join(destination, info.filename), '--prefix', installation, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], { cwd: installation, timeout: 30000 });
  const cli = path.join(installation, 'node_modules', 'murmur-local', 'dist', 'cli', 'index.js');
  const result = await execute(process.execPath, [cli, '--help'], { cwd: installation, timeout: 10000 });
  assert(result.stdout.includes('integration approve'));
  await access(path.join(installation, 'node_modules', 'murmur-local', 'dist', 'dashboard', 'app.js'));
  const guide = await readFile(path.join(installation, 'node_modules', 'murmur-local', 'docs', 'user-guide.md'), 'utf8');
  assert(guide.includes('managed CLI launches'));
  assert(guide.includes('Create a manual session'));
  const packageRoot = path.join(installation, 'node_modules', 'murmur-local');
  const documents = info.files.filter(file => file.path.endsWith('.md')).map(file => file.path);
  for (const document of documents) {
    const filename = path.join(packageRoot, document);
    const markdown = await readFile(filename, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1].split('#')[0];
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      await access(path.resolve(path.dirname(filename), href));
    }
  }
  const manifest = JSON.parse(await readFile(path.join(installation, 'node_modules', 'murmur-local', 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
});
