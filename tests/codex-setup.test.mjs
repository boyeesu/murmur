import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from './helpers.mjs';
import { createNativeSetupBundle, exportExistingChatSetup, nativeMain, CODEX_HOOKS_TEMPLATE, CODEX_EXISTING_CHAT_CAPABILITY, quoteNativeShell } from '../packages/murmur/dist/adapters/existing-chat.js';
import { adapterDiagnostics } from '../packages/murmur/dist/adapters/capabilities.js';

const execute = promisify(execFile);
const errorCode = code => error => error.code === code;
async function fixture(t, version = 'codex-cli 0.154.0') {
  const root = await realpath(await temporary(t));
  const service = path.join(root, 'service'); await mkdir(service, { mode: 0o700 });
  const descriptorPath = path.join(service, 'connection.json');
  await writeFile(descriptorPath, JSON.stringify({ protocolVersion: 1, origin: 'http://127.0.0.1:43123', stateId: 'a'.repeat(64), instanceId: randomUUID() }), { mode: 0o600 });
  const codexExecutable = path.join(root, "codex's binary"), cliPath = path.join(root, "cli's entry.js");
  await writeFile(codexExecutable, `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$MURMUR_HOME" ] && [ "$CODEX_HOME" = "$HOME" ] || exit 9\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
  await writeFile(cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  return { root, service, descriptorPath, options: { tool: 'codex', outputDirectory: path.join(root, "new export's directory"), stateDirectory: service, nodeExecutable: await realpath(process.execPath), cliPath, codexExecutable, env: { OPENAI_API_KEY: 'DO-NOT-INHERIT', MURMUR_HOME: 'DO-NOT-INHERIT' } } };
}

test('Codex export produces reviewable fixed hooks without installing or overriding native settings', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  const result = await exportExistingChatSetup(f.options);
  assert.equal(result.tool, 'codex'); assert.equal(result.testedVersion, '0.154.0');
  assert.equal(result.exported, true); assert.equal(result.installed, false); assert.equal(result.connected, false);
  assert.equal(result.hotAttachVerified, false); assert.equal(result.configurationMode, 'human-reviewed-additive-merge');
  assert.equal(result.resumeCommand, `${quoteNativeShell(f.options.codexExecutable)} -c 'features.hooks=true' resume`);
  assert(!/allow-untrusted|dangerously|hooks\.UserPromptSubmit|--last|--fork/.test(result.resumeCommand));
  assert.match(result.nextStep, /without replacing existing hooks/); assert.match(result.nextStep, /\/hooks/);
  assert.deepEqual((await readdir(f.root)).sort(), [...before, path.basename(f.options.outputDirectory)].sort());
  const bundle = createNativeSetupBundle({ ...f.options, descriptorPath: f.descriptorPath });
  assert.deepEqual(bundle.files.map(file => file.path), ['hooks.json', 'SETUP.md']);
  for (const file of bundle.files) {
    assert.equal(await readFile(path.join(f.options.outputDirectory, file.path), 'utf8'), file.content);
    assert.equal((await lstat(path.join(f.options.outputDirectory, file.path))).mode & 0o077, 0);
  }
  const config = JSON.parse(bundle.files[0].content);
  assert.deepEqual(Object.keys(config.hooks), ['UserPromptSubmit']);
  const hook = config.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.type, 'command'); assert.equal(hook.timeout, 30);
  assert.equal(hook.command, `${quoteNativeShell(f.options.nodeExecutable)} ${quoteNativeShell(f.options.cliPath)} native codex-hook --descriptor ${quoteNativeShell(f.descriptorPath)}`);
  assert(!/ARGUMENTS|CODEX_THREAD_ID|session_id|--force|--cwd|DO-NOT-INHERIT/.test(hook.command));
  // Execute only our owned argument-reporting fixture, not a model or native process.
  const parsed = await execute('/bin/sh', ['-c', hook.command], { cwd: f.root, env: { PATH: '/usr/bin:/bin' } });
  assert.deepEqual(JSON.parse(parsed.stdout), ['native', 'codex-hook', '--descriptor', f.descriptorPath]);
  for (const directory of ['existing-chats', 'existing-chats/codex']) assert.equal((await lstat(path.join(f.service, directory))).mode & 0o077, 0);
  await assert.rejects(lstat(path.join(f.service, 'existing-chats', 'claude')), { code: 'ENOENT' });
  await assert.rejects(exportExistingChatSetup(f.options), errorCode('NATIVE_SETUP_EXISTS'));
  assert.equal(await readFile(path.join(f.options.outputDirectory, 'hooks.json'), 'utf8'), bundle.files[0].content);
});

test('Codex setup preflight rejects unknown versions before export', async t => {
  for (const version of ['codex-cli 0.153.0', 'codex-cli 0.155.0', '0.154.0', 'unrelated 0.154.0']) {
    const f = await fixture(t, version);
    await assert.rejects(exportExistingChatSetup(f.options), errorCode('NATIVE_SETUP_VERSION'));
    await assert.rejects(lstat(f.options.outputDirectory), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.service), ['connection.json']);
  }
});

test('Codex setup refuses native settings targets, links and unsafe private state', async t => {
  const f = await fixture(t);
  for (const segment of ['.codex', '.claude', '.config', '.agents']) {
    await assert.rejects(exportExistingChatSetup({ ...f.options, outputDirectory: path.join(f.root, segment) }), errorCode('NATIVE_SETUP_PATH'));
  }
  const alias = path.join(f.root, 'alias'); await symlink(f.service, alias);
  await assert.rejects(exportExistingChatSetup({ ...f.options, outputDirectory: alias }), errorCode('NATIVE_SETUP_EXISTS'));
  await chmod(f.service, 0o755);
  await assert.rejects(exportExistingChatSetup(f.options), errorCode('NATIVE_SETUP_PATH'));
  await assert.rejects(lstat(f.options.outputDirectory), { code: 'ENOENT' });
});

test('Codex fixed bundle handles shell-sensitive literal paths and rejects invalid paths', () => {
  const options = { tool: 'codex', nodeExecutable: "/fixture/node's bin", cliPath: '/fixture/cli $(literal).js', descriptorPath: '/fixture/state;literal/connection.json' };
  const bundle = createNativeSetupBundle(options); assert(Object.isFrozen(bundle));
  assert.equal(JSON.parse(bundle.files[0].content).hooks.UserPromptSubmit[0].hooks[0].command,
    `${quoteNativeShell(options.nodeExecutable)} ${quoteNativeShell(options.cliPath)} native codex-hook --descriptor ${quoteNativeShell(options.descriptorPath)}`);
  for (const field of ['nodeExecutable', 'cliPath', 'descriptorPath']) for (const value of ['relative', '/fixture/../invalid', '/fixture/line\nbreak']) {
    assert.throws(() => createNativeSetupBundle({ ...options, [field]: value }), errorCode('NATIVE_SETUP_PATH'));
  }
  assert.throws(() => createNativeSetupBundle({ ...options, descriptorPath: '/fixture/daemon.json' }), errorCode('NATIVE_SETUP_PATH'));
});

test('Codex native help and doctor separate implemented support from live verification', async () => {
  const help = await nativeMain(['--help']);
  assert.deepEqual(help.codex, CODEX_EXISTING_CHAT_CAPABILITY);
  assert.match(help.codexSyntax, /murmur-connect refresh/);
  const codex = (await adapterDiagnostics()).find(item => item.tool === 'codex');
  assert.equal(codex.existingChat.enabled, true); assert.equal(codex.existingChat.configured, null); assert.equal(codex.existingChat.connected, null);
  assert.equal(codex.existingChat.automaticContextRefresh, true); assert.equal(codex.verified, false);
  assert.equal(codex.implementation.nativeHookConfiguration, false, 'managed hook installation is a separate gate');
  for (const args of [['codex-hook'], ['codex-hook', '--descriptor', '/fixture/connection.json', '--session', 'other'], ['codex-hook', '--tool', 'claude']]) {
    await assert.rejects(nativeMain(args), errorCode('NATIVE_ADAPTER_UNVERIFIED'));
  }
});

test('packaged Codex hook template matches the pure setup builder template', async () => {
  assert.equal(await readFile(new URL('../packages/murmur/assets/native/codex/hooks.json', import.meta.url), 'utf8'), CODEX_HOOKS_TEMPLATE);
});


test('native hook templates preserve every dollar replacement token in literal paths', () => {
  for (const tool of ['codex', 'claude']) {
    for (const field of ['nodeExecutable', 'cliPath', 'descriptorPath']) {
      for (const token of ['$&', '$`', "$'", '$$', '$1', '$<name>']) {
        const options = { tool, nodeExecutable: '/fixture/node', cliPath: '/fixture/cli.js', descriptorPath: '/fixture/connection.json' };
        options[field] = `/fixture/${token}/${field === 'descriptorPath' ? 'connection.json' : field}`;
        const bundle = createNativeSetupBundle(options);
        const asset = bundle.files.find(file => file.path === (tool === 'codex' ? 'hooks.json' : 'hooks/hooks.json'));
        const hook = JSON.parse(asset.content).hooks.UserPromptSubmit[0].hooks[0];
        const entry = tool === 'codex' ? 'codex-hook' : 'hook';
        assert.equal(hook.command, `${quoteNativeShell(options.nodeExecutable)} ${quoteNativeShell(options.cliPath)} native ${entry} --descriptor ${quoteNativeShell(options.descriptorPath)}`, `${tool} ${field} ${token}`);
      }
    }
  }
});
