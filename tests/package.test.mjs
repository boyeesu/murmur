import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, access, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';
const execute = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));

test('packed CLI installs offline and runs outside the source checkout', async t => {
  const root = await realpath(await temporary(t));
  const destination = path.join(root, 'package');
  const installation = path.join(root, 'installation');
  const cache = path.join(root, 'cache');
  await mkdir(destination); await mkdir(installation);
  // No inherited NODE_PATH, loader hooks, managed credentials or provider env.
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root,
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const packed = await execute(process.execPath, [path.join(project, 'scripts', 'pack.mjs'), '--out', destination], { cwd: project, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  const info = JSON.parse(packed.stdout)[0];
  assert(info.files.some(file => file.path === 'LICENSE'));
  assert(info.files.some(file => file.path === 'docs/user-guide.md'));
  assert(info.files.some(file => file.path === 'docs/release-checklist.md'));
  assert(info.files.some(file => file.path === 'dist/dashboard/index.html'));
  assert(info.files.some(file => file.path === 'dist/native/claude/skills/connect/SKILL.md'));
  assert(info.files.some(file => file.path === 'dist/native/claude/hooks/hooks.json'));
  assert(info.files.some(file => file.path === 'docs/session-linking.md'));
  assert(info.files.some(file => file.path === 'docs/verification-existing-chats.md'));
  assert(!info.files.some(file => file.path.includes('daemon.json') || file.path.includes('.claude') && file.path !== 'dist/native/claude/.claude-plugin/plugin.json'));
  for (const name of ['@modelcontextprotocol/sdk', 'zod', 'zod-to-json-schema', 'ajv', 'express']) {
    assert(info.bundled.includes(name), `missing bundled runtime package: ${name}`);
  }
  assert(!info.bundled.includes('typescript'));
  assert(!info.bundled.includes('@types/node'));
  assert(!info.files.some(file => /node_modules\/(?:murmur-local|murmur-dashboard)\//.test(file.path)));
  const archive = path.join(destination, info.filename);
  const originalArchive = await readFile(archive);
  await assert.rejects(execute(process.execPath, [path.join(project, 'scripts', 'pack.mjs'), '--out', destination],
    { cwd: project, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 }), error => /EEXIST/.test(error.stderr));
  assert.deepEqual(await readFile(archive), originalArchive, 'packing must not overwrite an existing archive');
  await execute('npm', ['install', path.join(destination, info.filename), '--prefix', installation, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], { cwd: installation, env, timeout: 30000 });
  // npm must also see a valid installed closure with an empty offline cache.
  await execute('npm', ['ls', '--all', '--omit=dev', '--offline', '--json', '--cache', cache],
    { cwd: installation, env, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  const cli = path.join(installation, 'node_modules', 'murmur-local', 'dist', 'cli', 'index.js');
  const result = await execute(process.execPath, [cli, '--help'], { cwd: installation, env, timeout: 10000 });
  assert(result.stdout.includes('integration approve'));
  assert(result.stdout.includes('group <action>'));
  assert(result.stdout.includes('connect <action>'));
  for (const command of ['group', 'connect', 'external']) {
    const help = await execute(process.execPath, [cli, command, '--help'], { cwd: installation, env, timeout: 10000 });
    assert(help.stdout.includes('murmur ' + command));
  }
  const native = await execute(process.execPath, [cli, 'native', '--help'], { cwd: installation, env, timeout: 10000 });
  assert.equal(JSON.parse(native.stdout).claude.enabled, true);
  assert.equal(JSON.parse(native.stdout).claude.hotAttachVerified, false);
  await assert.rejects(execute(process.execPath, [cli, 'native', 'start'], { cwd: installation, env, timeout: 10000 }), error => error.stderr.includes('NATIVE_ADAPTER_UNVERIFIED') && !error.stdout);
  const assets = path.join(installation, 'node_modules', 'murmur-local', 'dist', 'native', 'claude');
  assert((await readFile(path.join(assets, 'skills', 'connect', 'SKILL.md'), 'utf8')).includes('/murmur:connect'));
  assert.equal(JSON.parse(await readFile(path.join(assets, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, '__MURMUR_FIXED_HOOK_COMMAND__');
  await access(path.join(installation, 'node_modules', 'murmur-local', 'dist', 'dashboard', 'app.js'));
  const guide = await readFile(path.join(installation, 'node_modules', 'murmur-local', 'docs', 'user-guide.md'), 'utf8');
  assert(guide.includes('managed launch'));
  assert(guide.includes('Create a manual session'));
  const packageRoot = path.join(installation, 'node_modules', 'murmur-local');
  const dependencyManifests = info.files.filter(file => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file.path));
  for (const file of dependencyManifests) {
    const directory = path.posix.dirname(file.path);
    const notices = info.files.filter(entry => path.posix.dirname(entry.path) === directory &&
      /^(?:licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(path.posix.basename(entry.path)));
    assert(notices.length, `missing license for ${directory}`);
    for (const notice of notices) assert((await readFile(path.join(packageRoot, notice.path))).length > 0);
  }
  // A real nested version must survive staging, rather than being flattened to
  // the SDK's incompatible hoisted content-type version.
  const nested = 'node_modules/express/node_modules/content-type/package.json';
  assert(dependencyManifests.some(file => file.path === nested));
  const hoistedType = JSON.parse(await readFile(path.join(packageRoot, 'node_modules/content-type/package.json'), 'utf8'));
  const nestedType = JSON.parse(await readFile(path.join(packageRoot, nested), 'utf8'));
  assert.notEqual(nestedType.version, hoistedType.version);
  const documents = info.files.filter(file => file.path === 'README.md' || file.path.startsWith('docs/') && file.path.endsWith('.md')).map(file => file.path);
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
  const probe = `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { pathToFileURL } = require('node:url');
    const path = require('node:path');
    const fs = require('node:fs');
    const root = fs.realpathSync(${JSON.stringify(installation)}) + path.sep;
    const packageRoot = ${JSON.stringify(packageRoot)};
    const req = createRequire(path.join(packageRoot, 'package.json'));
    function inside(filename) {
      assert(fs.realpathSync(filename).startsWith(root), 'Dependency resolved outside installed archive: ' + filename);
      return filename;
    }
    function load(requireFrom, name) {
      inside(requireFrom.resolve(name));
      return requireFrom(name);
    }
    for (const filename of ${JSON.stringify(dependencyManifests.map(file => file.path))}) inside(path.join(packageRoot, filename));
    load(req, '@modelcontextprotocol/sdk/server/mcp.js');
    load(req, '@modelcontextprotocol/sdk/server/stdio.js');
    load(req, '@modelcontextprotocol/sdk/server/streamableHttp.js');
    load(req, 'zod/v4');
    const sdkRequire = createRequire(req.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
    for (const name of ['zod-to-json-schema', 'ajv', 'ajv-formats', 'express', 'eventsource']) load(sdkRequire, name);
    const converterRequire = createRequire(sdkRequire.resolve('zod-to-json-schema'));
    assert.equal(inside(converterRequire.resolve('zod/v3')), inside(req.resolve('zod/v3')), 'SDK transitive peer must resolve to the bundled Zod');
    load(converterRequire, 'zod/v3');
    (async () => {
      const entry = inside(path.join(packageRoot, 'dist/mcp/server.js'));
      const { createMurmurMcpServer } = await import(pathToFileURL(entry));
      const { Client } = load(req, '@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = load(req, '@modelcontextprotocol/sdk/inMemory.js');
      let requests = 0;
      const server = createMurmurMcpServer({ protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: '1'.repeat(64),
        launchId: 'launch-package', projectId: 'project-package', sessionId: 'session-package', taskId: 'task-package', agentToken: 'z'.repeat(43) },
        { fetch: async () => { requests++; throw new Error('Package smoke test must not contact a daemon or model'); } });
      const client = new Client({ name: 'installed-package-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        assert.equal(client.getServerVersion().name, 'murmur');
        const { tools } = await client.listTools();
        assert(tools.some(tool => tool.name === 'murmur_identity'));
        assert(tools.some(tool => tool.name === 'murmur_submit_task'));
        assert(tools.every(tool => tool.inputSchema.type === 'object'));
        assert.equal(requests, 0);
        for (const filename of Object.keys(require.cache)) inside(filename);
        console.log('bundled-runtime-ok');
      } finally {
        await client.close();
        await server.close();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const dependencies = await execute(process.execPath, ['-e', probe], { cwd: installation, env, timeout: 10000 });
  assert(dependencies.stdout.includes('bundled-runtime-ok'));
  t.diagnostic(`Verified ${dependencyManifests.length} installed runtime package locations and their licenses (${info.size} byte archive).`);
});
