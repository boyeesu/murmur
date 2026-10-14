import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { InstallationService } from '../packages/murmur/dist/integrations/index.js';
import { integrationsMain, integrationsHelp } from '../packages/murmur/dist/cli/integrations.js';
import { temporary } from './helpers.mjs';

const approval = ({ planId, planHash, generation }) => ({ planId, planHash, generation });
async function fixture(t, options = {}) {
  const root = await realpath(await temporary(t)), projectRoot = path.join(root, 'project'), stateDirectory = path.join(root, 'state');
  await mkdir(projectRoot, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  let version = 'one';
  const strategy = { provider: 'claude', version: 'fixture-v1', description: 'Fixture, not a native integration.', build(context) { return {
    files: [{ path: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'fixture', version }) + '\n' }, { path: 'skills/connect/SKILL.md', content: `fixture-${version}\n` }],
    activation: { kind: 'manual', cwd: context.projectRoot, instructions: 'Fixture does not load native tools.', testedVersion: 'fixture', nativeLoaded: 'unverified' },
    requestedBehavior: ['Fixture bundle only; no native configuration or processes.'], runtimeDirectories: ['existing-chats', 'existing-chats/claude'],
  }; } };
  const service = new InstallationService({ stateDirectory, env: {}, strategies: [strategy], ...options });
  const plan = (action) => service.plan({ action, provider: 'claude', projectRoot });
  return { root, projectRoot, stateDirectory, strategy, service, plan, changeVersion: () => { version = 'two'; } };
}
const target = plan => plan.affectedPaths.find(change => change.operation === 'create').path;

test('installation inspection is read-only; scoped human guards precede every IO including help', async t => {
  const f = await fixture(t);
  const inspection = await f.service.inspect(); assert.equal(inspection.generation, 0); assert.deepEqual(inspection.installations, []);
  await assert.rejects(lstat(path.join(f.stateDirectory, 'integrations')), { code: 'ENOENT' });
  assert.equal(await integrationsMain(['--help'], { env: {} }), integrationsHelp);
  for (const env of [{ MURMUR_AGENT_MODE: '1' }, { MURMUR_EXTERNAL_MODE: '1' }, { MURMUR_AGENT_CONNECTION: '' }, { MURMUR_EXTERNAL_CONNECTION: '' }]) {
    const service = new InstallationService({ stateDirectory: '/does-not-exist', env });
    for (const call of [() => service.inspect(), () => service.plan({ action: 'install', provider: 'claude', projectRoot: '/does-not-exist' }), () => service.apply({}), () => service.recover({}), () => integrationsMain(['--help'], { env })]) await assert.rejects(call(), { code: 'HUMAN_COMMAND_FORBIDDEN' });
  }
});

test('fresh install previews exact paths then applies a private versioned bundle without touching legacy config', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.projectRoot, '.claude'));
  const legacy = '{\n // keep comments and trust choices\n "env": { "KEEP": "yes" },\n "permissions": { "deny": ["Bash(rm *)"] },\n}\n';
  const config = path.join(f.projectRoot, '.claude', 'settings.local.json'); await writeFile(config, legacy);
  const plan = await f.plan('install'); assert.equal(plan.generation, 0); assert.equal(plan.scope, 'project'); assert.deepEqual(plan.nativeConfigurationChanges, []); assert.equal(plan.grantsRevoked, false); assert.equal(plan.grantDiscovery, 'unavailable');
  await assert.rejects(lstat(target(plan)), { code: 'ENOENT' });
  const result = await f.service.apply(approval(plan)); assert.equal(result.applied, true); assert.equal(result.installation.installedBundle, true); assert.equal(result.nativeLoaded, 'unverified'); assert.equal(result.generation, 1);
  assert.equal(await readFile(config, 'utf8'), legacy);
  assert.equal((await lstat(target(plan))).mode & 0o777, 0o600);
  for (const directory of [path.join(f.stateDirectory, 'integrations'), path.join(f.stateDirectory, 'integrations', 'objects'), path.join(f.stateDirectory, 'existing-chats'), result.installation.bundleDirectory]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const file of [path.join(f.stateDirectory, 'integrations', 'registry.json'), path.join(f.stateDirectory, 'integrations', 'plans', plan.planId + '.json'), ...plan.backupPaths]) assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert(!JSON.stringify(plan).includes('fixture-one')); // no raw asset contents in previews
});

test('update creates a new immutable version; rollback changes selection without touching running old bundles', async t => {
  const f = await fixture(t), install = await f.plan('install'); await f.service.apply(approval(install)); const first = target(install), before = await readFile(first, 'utf8');
  f.changeVersion(); const update = await f.plan('update'); const updated = await f.service.apply(approval(update));
  assert.notEqual(target(update), first); assert.equal(await readFile(first, 'utf8'), before); assert.notEqual(await readFile(target(update), 'utf8'), before);
  const rollback = await f.plan('rollback'); assert.equal(rollback.affectedPaths.length, 0); const rolledBack = await f.service.apply(approval(rollback));
  assert.notEqual(rolledBack.installation.activeVersion, updated.installation.activeVersion); assert.equal(rolledBack.installation.bundleDirectory, path.dirname(path.dirname(first))); assert.equal(rolledBack.installation.integrity, 'unchanged');
});

test('uninstall removes only unchanged owned content and rollback can restore from private objects', async t => {
  const f = await fixture(t), install = await f.plan('install'); await f.service.apply(approval(install));
  const runtime = path.join(f.stateDirectory, 'existing-chats', 'claude', 'membership.json'); await writeFile(runtime, 'runtime-owned', { mode: 0o600 });
  const remove = await f.plan('uninstall'); assert.equal(remove.affectedPaths.filter(change => change.operation === 'remove').length, 2);
  const removed = await f.service.apply(approval(remove)); assert.equal(removed.installation.status, 'removed'); await assert.rejects(lstat(target(install)), { code: 'ENOENT' }); assert.equal(await readFile(runtime, 'utf8'), 'runtime-owned');
  const rollback = await f.plan('rollback'); const result = await f.service.apply(approval(rollback)); assert.equal(result.installation.installedBundle, true); assert.equal(result.installation.bundleDirectory, path.dirname(path.dirname(target(install))));
  assert.equal(await readFile(runtime, 'utf8'), 'runtime-owned');
});

test('user-edited and untracked files block update and survive uninstall', async t => {
  const f = await fixture(t), install = await f.plan('install'); const installed = await f.service.apply(approval(install));
  await writeFile(target(install), 'human edit', { mode: 0o600 });
  const unknown = path.join(installed.installation.bundleDirectory, 'human-notes.txt'); await writeFile(unknown, 'do not remove', { mode: 0o600 });
  await assert.rejects(f.plan('update'), { code: 'INSTALLATION_COLLISION' }); assert.equal((await f.service.inspect()).installations[0].integrity, 'modified');
  const removal = await f.plan('uninstall'); assert.deepEqual(removal.preservedPaths, [target(install), unknown].sort()); await f.service.apply(approval(removal));
  assert.equal(await readFile(target(install), 'utf8'), 'human edit'); assert.equal(await readFile(unknown, 'utf8'), 'do not remove');
  await assert.rejects(f.plan('rollback'), { code: 'INSTALLATION_COLLISION' });
});

test('symlink target or parent replacement is refused without following or replacing user content', async t => {
  const f = await fixture(t), install = await f.plan('install'); await f.service.apply(approval(install)); const removal = await f.plan('uninstall');
  const outside = path.join(f.root, 'outside'); await writeFile(outside, 'private user data'); await unlink(target(install)); await symlink(outside, target(install));
  await assert.rejects(f.service.apply(approval(removal))); assert.equal(await readFile(outside, 'utf8'), 'private user data');
  const install2 = await fixture(t), preview = await install2.plan('install'), registry = path.join(install2.stateDirectory, 'integrations'); await rename(registry, registry + '-old'); await symlink(registry + '-old', registry);
  await assert.rejects(install2.service.apply(approval(preview)), { code: 'INSTALLATION_PATH' });
});

test('stale generation, changed files, wrong hashes, expiration and nonce replay are rejected', async t => {
  let now = 1_000; const f = await fixture(t, { now: () => now }); const one = await f.plan('install'), two = await f.plan('install');
  await assert.rejects(f.service.apply({ ...approval(one), planHash: 'a'.repeat(64) }), { code: 'INSTALLATION_SCHEMA' });
  await f.service.apply(approval(one)); await assert.rejects(f.service.apply(approval(one)), { code: 'INSTALLATION_REPLAY' }); await assert.rejects(f.service.apply(approval(two)), { code: 'INSTALLATION_STALE_PLAN' });
  const old = await f.plan('update'); now += 16 * 60_000; await assert.rejects(f.service.apply(approval(old)), { code: 'INSTALLATION_STALE_PLAN' });
  const changed = await f.plan('uninstall'); await writeFile(target(one), 'later edit'); await assert.rejects(f.service.apply(approval(changed)), { code: 'INSTALLATION_STALE_PLAN' });
});

test('interrupted multifile apply has a durable pending journal and explicit one-use abort recovery', async t => {
  let interrupt = true;
  const f = await fixture(t, { checkpoint(phase, index) { if (interrupt && phase === 'operation' && index === 0) throw new Error('fixture interruption'); } });
  const plan = await f.plan('install'); await assert.rejects(f.service.apply(approval(plan)), /fixture interruption/);
  const pending = (await f.service.inspect()).pending; assert.deepEqual(pending, approval(plan));
  await assert.rejects(f.plan('install'), { code: 'INSTALLATION_RECOVERY_REQUIRED' }); await assert.rejects(f.service.apply(approval(plan)), { code: 'INSTALLATION_REPLAY' });
  interrupt = false; const result = await f.service.recover(approval(plan)); assert.equal(result.recovered, true); assert.equal(result.installation, null); assert.equal((await f.service.inspect()).pending, null); await assert.rejects(lstat(target(plan)), { code: 'ENOENT' });
  await assert.rejects(f.service.recover(approval(plan)), { code: 'INSTALLATION_APPROVAL' }); await assert.rejects(f.service.apply(approval(plan)), { code: 'INSTALLATION_REPLAY' });
  const retry = await f.plan('install'); assert.notEqual(retry.planId, plan.planId); await f.service.apply(approval(retry));
});

test('interrupted uninstall restores the exact owned bytes; recovery refuses later user edits', async t => {
  let interrupt = false;
  const f = await fixture(t, { checkpoint(phase, index) { if (interrupt && phase === 'operation' && index === 0) throw new Error('fixture interruption'); } });
  const install = await f.plan('install'); await f.service.apply(approval(install)); const original = await readFile(target(install), 'utf8'); interrupt = true;
  const removal = await f.plan('uninstall'); await assert.rejects(f.service.apply(approval(removal)), /fixture interruption/); interrupt = false;
  await f.service.recover(approval(removal)); assert.equal(await readFile(target(install), 'utf8'), original);
  const other = await fixture(t, { checkpoint(phase, index) { if (phase === 'operation' && index === 0) throw new Error('fixture interruption'); } });
  const plan = await other.plan('install'); await assert.rejects(other.service.apply(approval(plan))); await writeFile(target(plan), 'human edit', { mode: 0o600 });
  await assert.rejects(other.service.recover(approval(plan)), { code: 'INSTALLATION_RECOVERY_CONFLICT' }); assert.equal(await readFile(target(plan), 'utf8'), 'human edit'); assert((await other.service.inspect()).pending);
});

test('unknown schemas, unsafe state and unowned bundle collisions fail closed', async t => {
  const f = await fixture(t), plan = await f.plan('install');
  const unknown = path.join(f.stateDirectory, 'integrations', 'bundles', plan.installationId); await mkdir(unknown, { mode: 0o700 }); await writeFile(path.join(unknown, 'user.txt'), 'keep'); await assert.rejects(f.service.apply(approval(plan)), { code: 'INSTALLATION_STALE_PLAN' });
  const registry = path.join(f.stateDirectory, 'integrations', 'registry.json'); await writeFile(registry, JSON.stringify({ schemaVersion: 99, hash: '0'.repeat(64), data: {} }), { mode: 0o600 }); await assert.rejects(f.service.inspect(), { code: 'INSTALLATION_SCHEMA' });
  const nested = new InstallationService({ stateDirectory: f.projectRoot, strategies: [f.strategy], env: {} }); await assert.rejects(nested.plan({ action: 'install', provider: 'claude', projectRoot: f.projectRoot }), { code: 'INSTALLATION_PATH' });
});

test('CLI uses strict preview/apply separation and forwards only public DTOs', async () => {
  const calls = [], service = Object.fromEntries(['inspect', 'plan', 'apply', 'recover'].map(action => [action, async input => { calls.push({ action, input }); return { public: true, agentToken: 'NEVER_OUTPUT', nested: { pollSecret: 'NEVER_OUTPUT' } }; }]));
  const dependencies = { service, env: {} };
  const result = await integrationsMain(['install', '--provider', 'claude', '--root', '/project'], dependencies); assert.deepEqual(result, { public: true, nested: {} }); assert.deepEqual(calls, [{ action: 'plan', input: { action: 'install', provider: 'claude', projectRoot: '/project' } }]);
  await integrationsMain(['apply', '--plan', 'id', '--hash', 'hash', '--generation', '0'], dependencies); assert.equal(calls.at(-1).action, 'apply'); assert.equal(calls.at(-1).input.generation, 0);
  for (const args of [['install', '--provider', 'claude', '--root', '/project', '--force'], ['apply', '--plan', 'id', '--hash', 'hash', '--generation', '-1'], ['inspect', '--provider', 'claude', '--provider', 'codex'], ['plan', '--provider', 'claude', '--root', '/project']]) await assert.rejects(integrationsMain(args, dependencies), { code: 'HUMAN_INPUT' });
});

test('abrupt process exit leaves a stale lock and durable journal recoverable by explicit approval', async t => {
  const f = await fixture(t), plan = await f.plan('install');
  const module = new URL('../packages/murmur/dist/integrations/index.js', import.meta.url).href;
  const script = `import { InstallationService } from ${JSON.stringify(module)}; const service = new InstallationService({stateDirectory:${JSON.stringify(f.stateDirectory)},env:{},strategies:[],checkpoint(phase,index){if(phase==='operation'&&index===0)process.exit(88);}}); await service.apply(${JSON.stringify(approval(plan))});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]), error => error.code === 88);
  assert((await f.service.inspect()).pending); await assert.rejects(f.plan('install'), { code: 'INSTALLATION_BUSY' });
  const recovered = await f.service.recover(approval(plan)); assert.equal(recovered.recovered, true); assert.equal(recovered.installation, null);
  await assert.rejects(lstat(path.join(f.stateDirectory, 'integrations', 'operation.lock')), { code: 'ENOENT' });
});

test('recovery normalizes only the exact interrupted staging hardlink before removing a created asset', async t => {
  const f = await fixture(t, { checkpoint(phase, index) { if (phase === 'operation' && index === 0) throw new Error('fixture interruption'); } }), plan = await f.plan('install');
  await assert.rejects(f.service.apply(approval(plan))); const staged = path.join(f.stateDirectory, 'integrations', 'transactions', plan.planId, '0.stage'); await link(target(plan), staged);
  assert.equal((await lstat(target(plan))).nlink, 2); await f.service.recover(approval(plan)); await assert.rejects(lstat(target(plan)), { code: 'ENOENT' });
});

test('partial known staging is recoverable but unknown staged user content is retained', async t => {
  for (const known of [true, false]) {
    const f = await fixture(t, { checkpoint(phase) { if (phase === 'prepared') throw new Error('fixture interruption'); } }), plan = await f.plan('install');
    await assert.rejects(f.service.apply(approval(plan))); const staging = path.join(f.stateDirectory, 'integrations', 'transactions', plan.planId, '0.stage');
    await writeFile(staging, known ? '{"name":' : 'human notes: preserve', { mode: 0o600 });
    if (known) { await f.service.recover(approval(plan)); await assert.rejects(lstat(staging), { code: 'ENOENT' }); }
    else { await assert.rejects(f.service.recover(approval(plan)), { code: 'INSTALLATION_RECOVERY_CONFLICT' }); assert.equal(await readFile(staging, 'utf8'), 'human notes: preserve'); }
  }
});

test('linked grant preview exposes identifiers only and never revokes anything', async t => {
  const f = await fixture(t, { linkedGrants: async () => [{ grantId: 'grant', projectId: 'project', sessionId: 'session', status: 'active', token: 'DO_NOT_OUTPUT' }] });
  const plan = await f.plan('install'); assert.equal(plan.grantDiscovery, 'available'); assert.deepEqual(plan.linkedGrants, [{ grantId: 'grant', projectId: 'project', sessionId: 'session', status: 'active' }]); assert(!JSON.stringify(plan).includes('DO_NOT_OUTPUT')); assert.equal(plan.grantsRevoked, false);
});

test('rollback and update pin unchanged bundle dependencies through apply', async t => {
  for (const action of ['rollback', 'update']) {
    const f = await fixture(t), install = await f.plan('install'); await f.service.apply(approval(install));
    f.changeVersion(); const update = await f.plan('update'), current = await f.service.apply(approval(update));
    const plan = await f.plan(action), filename = action === 'rollback' ? target(install) : target(update);
    await writeFile(filename, 'later human edit', { mode: 0o600 });
    await assert.rejects(f.service.apply(approval(plan)), { code: 'INSTALLATION_STALE_PLAN' });
    assert.equal((await f.service.inspect()).installations[0].activeVersion, current.installation.activeVersion);
    assert.equal(await readFile(filename, 'utf8'), 'later human edit');
  }
});

test('recovery preserves a user deletion of an uninstall operation never reached', async t => {
  let interrupt = false;
  const f = await fixture(t, { checkpoint(phase) { if (interrupt && phase === 'prepared') throw new Error('before removal'); } });
  const install = await f.plan('install'); await f.service.apply(approval(install));
  const removal = await f.plan('uninstall'); interrupt = true;
  await assert.rejects(f.service.apply(approval(removal)), /before removal/); await unlink(target(install));
  await assert.rejects(f.service.recover(approval(removal)), { code: 'INSTALLATION_RECOVERY_CONFLICT' });
  await assert.rejects(lstat(target(install)), { code: 'ENOENT' }); assert((await f.service.inspect()).pending);
});

test('lock publication crashes never expose a partial authoritative record', async t => {
  for (const phase of ['write', 'linked', 'committed']) {
    const f = await fixture(t), plan = await f.plan('install');
    const module = new URL('../packages/murmur/dist/integrations/index.js', import.meta.url).href;
    const script = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
      const phase=${JSON.stringify(phase)}, originalOpen=fs.open, originalLink=fs.link;
      fs.open=async function(filename,...args){const handle=await originalOpen(filename,...args);
        if(phase==='write'&&/\\.murmur-lock-[a-f0-9-]+\\.stage$/.test(filename)){const write=handle.writeFile;handle.writeFile=async function(content,...rest){await write.call(this,content.slice(0,20),...rest);await this.sync();process.exit(88);};}return handle;};
      fs.link=async function(from,to){await originalLink(from,to);if(phase==='linked'&&to.endsWith('/operation.lock'))process.exit(88);};syncBuiltinESMExports();
      const {InstallationService}=await import(${JSON.stringify(module)});const service=new InstallationService({stateDirectory:${JSON.stringify(f.stateDirectory)},env:{},strategies:[],checkpoint(value){if(phase==='committed'&&value==='committed')process.exit(88);}});await service.apply(${JSON.stringify(approval(plan))});`;
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]), error => error.code === 88);
    const inspection = await f.service.inspect();
    if (phase === 'write') {
      assert.equal(inspection.lock, null); assert.equal(inspection.pending, null);
      assert((await readdir(path.join(f.stateDirectory, 'integrations'))).some(name => name.startsWith('.murmur-lock-')));
      await f.service.apply(approval(plan));
    } else {
      assert.equal(inspection.lock.state, 'stale'); assert.deepEqual(inspection.lock.approval, approval(plan));
      const recovered = await f.service.recover(approval(plan)); assert.equal(recovered.recovered, true);
      assert.equal(recovered.installation?.installedBundle ?? false, phase === 'committed');
      await assert.rejects(lstat(path.join(f.stateDirectory, 'integrations', 'operation.lock')), { code: 'ENOENT' });
      await f.plan(phase === 'committed' ? 'update' : 'install');
    }
  }
});

test('unreadable lock repair requires reviewed fingerprint and stopped-owner confirmation and preserves bytes', async t => {
  const f = await fixture(t), plan = await f.plan('install'), filename = path.join(f.stateDirectory, 'integrations', 'operation.lock');
  const bytes = '{"schemaVersion":1,"'; await writeFile(filename, bytes, { mode: 0o600 });
  const inspection = await f.service.inspect(); assert.equal(inspection.lock.state, 'unreadable');
  await assert.rejects(f.service.recover(approval(plan)), { code: 'INSTALLATION_LOCK_REPAIR_REQUIRED' });
  await assert.rejects(f.service.apply(approval(plan)), { code: 'INSTALLATION_BUSY' });
  const repair = { fingerprint: inspection.lock.fingerprint, generation: inspection.generation, ownerStopped: true };
  await assert.rejects(f.service.repairLock({ ...repair, ownerStopped: false }), { code: 'INSTALLATION_APPROVAL' });
  await assert.rejects(f.service.repairLock({ ...repair, fingerprint: '0'.repeat(64) }), { code: 'INSTALLATION_STALE_PLAN' });
  await writeFile(filename, bytes + 'later edit', { mode: 0o600 });
  await assert.rejects(f.service.repairLock(repair), { code: 'INSTALLATION_STALE_PLAN' });
  const fresh = await f.service.inspect(), result = await f.service.repairLock({ ...repair, fingerprint: fresh.lock.fingerprint });
  assert.equal(result.repaired, true); assert.equal(await readFile(result.preservedPath, 'utf8'), bytes + 'later edit');
  assert.equal((await lstat(result.preservedPath)).mode & 0o777, 0o600);
  await assert.rejects(lstat(filename), { code: 'ENOENT' }); await f.service.apply(approval(plan));
});

test('lock repair refuses known live owners and symlinked unknown authority', async t => {
  const { encode } = await import('../packages/murmur/dist/integrations/filesystem.js');
  const f = await fixture(t); await f.plan('install'); const filename = path.join(f.stateDirectory, 'integrations', 'operation.lock');
  const bytes = encode({ schemaVersion: 1, pid: process.pid, nonce: '11111111-1111-1111-1111-111111111111', approval: null });
  await writeFile(filename, bytes, { mode: 0o600 }); let inspection = await f.service.inspect();
  await assert.rejects(f.service.repairLock({ fingerprint: inspection.lock.fingerprint, generation: inspection.generation, ownerStopped: true }), { code: 'INSTALLATION_BUSY' });
  assert.equal(await readFile(filename, 'utf8'), bytes); await unlink(filename);
  const outside = path.join(f.root, 'human-lock'); await writeFile(outside, 'human data', { mode: 0o600 }); await symlink(outside, filename);
  inspection = await f.service.inspect(); assert.equal(inspection.lock.state, 'unsafe'); assert.equal(inspection.lock.fingerprint, null);
  await assert.rejects(f.service.repairLock({ fingerprint: 'a'.repeat(64), generation: inspection.generation, ownerStopped: true }));
  assert.equal(await readFile(outside, 'utf8'), 'human data');
});

test('CLI lock repair is explicit, strictly parsed, human-only and fingerprint bound', async () => {
  const calls = [], dependencies = { env: {}, service: { repairLock: async input => { calls.push(input); return { repaired: true }; } } };
  const args = ['repair-lock', '--fingerprint', 'a'.repeat(64), '--generation', '0'];
  await assert.rejects(integrationsMain(args, dependencies), { code: 'HUMAN_INPUT' });
  await integrationsMain([...args, '--owner-stopped'], dependencies);
  assert.deepEqual(calls, [{ fingerprint: 'a'.repeat(64), generation: 0, ownerStopped: true }]);
  await assert.rejects(integrationsMain([...args, '--owner-stopped'], { ...dependencies, env: { MURMUR_AGENT_MODE: '1' } }), { code: 'HUMAN_COMMAND_FORBIDDEN' });
  const service = new InstallationService({ stateDirectory: '/does-not-exist', env: { MURMUR_EXTERNAL_MODE: '1' } });
  await assert.rejects(service.repairLock({}), { code: 'HUMAN_COMMAND_FORBIDDEN' });
});

test('stale-lock recovery cannot be used to unlock another reviewed plan', async t => {
  const f = await fixture(t), plan = await f.plan('install'), other = await f.plan('install');
  const module = new URL('../packages/murmur/dist/integrations/index.js', import.meta.url).href;
  const script = `import {InstallationService} from ${JSON.stringify(module)};const service=new InstallationService({stateDirectory:${JSON.stringify(f.stateDirectory)},env:{},strategies:[],checkpoint(phase){if(phase==='committed')process.exit(88);}});await service.apply(${JSON.stringify(approval(plan))});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]), error => error.code === 88);
  const filename = path.join(f.stateDirectory, 'integrations', 'operation.lock'), before = await readFile(filename, 'utf8');
  await assert.rejects(f.service.recover(approval(other)), { code: 'INSTALLATION_APPROVAL' });
  assert.equal(await readFile(filename, 'utf8'), before);
  await f.service.recover(approval(plan)); await assert.rejects(lstat(filename), { code: 'ENOENT' });
});

test('reviewed lock repair preserves pending transaction authority for a separate recovery', async t => {
  const f = await fixture(t, { checkpoint(phase) { if (phase === 'prepared') throw new Error('pending fixture'); } });
  const plan = await f.plan('install'); await assert.rejects(f.service.apply(approval(plan)), /pending fixture/);
  const filename = path.join(f.stateDirectory, 'integrations', 'operation.lock'); await writeFile(filename, 'partial old lock', { mode: 0o600 });
  const inspected = await f.service.inspect();
  const repaired = await f.service.repairLock({ fingerprint: inspected.lock.fingerprint, generation: inspected.generation, ownerStopped: true });
  assert.equal(await readFile(repaired.preservedPath, 'utf8'), 'partial old lock');
  const after = await f.service.inspect(); assert.equal(after.generation, inspected.generation); assert.deepEqual(after.pending, approval(plan));
  const result = await f.service.recover(approval(plan)); assert.equal(result.recovered, true); assert.equal((await f.service.inspect()).pending, null);
});
