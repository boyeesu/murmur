import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InstallationService, createCodexInstallationStrategy } from '../packages/murmur/dist/integrations/index.js';
import { parseInstallationJsonc } from '../packages/murmur/dist/integrations/jsonc.js';
import { temporary } from './helpers.mjs';
const approval = ({planId,planHash,generation}) => ({planId,planHash,generation});
const legacy = '{\n // preserve native permission hooks\n "permissions": {"deny":["Bash(rm *)"]},\n "hooks": {\n   "PreToolUse": [{"hooks":[{"type":"command","command":"existing-permission-check"}]}],\n   "UserPromptSubmit": [{"hooks":[{"type":"command","command":"existing-prompt-hook"}]}],\n },\n}\n';
async function fixture(t, checkpoint) {
  const root = await realpath(await temporary(t)), projectRoot = path.join(root,'project'), stateDirectory = path.join(root,'state');
  await mkdir(projectRoot,{mode:0o700}); await mkdir(stateDirectory,{mode:0o700});
  await writeFile(path.join(stateDirectory,'connection.json'),JSON.stringify({protocolVersion:1,origin:'http://127.0.0.1:43123',stateId:'a'.repeat(64),instanceId:randomUUID()}),{mode:0o600});
  const cliPath=path.join(root,'cli.js');await writeFile(cliPath,'// fixture CLI; never executed\n',{mode:0o600});
  const options={cliPath},strategy=createCodexInstallationStrategy(options),service=new InstallationService({stateDirectory,strategies:[strategy],env:{},checkpoint});
  const config=path.join(projectRoot,'.codex','hooks.json');
  const plan=action=>service.plan({action,provider:'codex',projectRoot});
  return {root,projectRoot,stateDirectory,options,strategy,service,config,plan};
}
async function legacyConfig(f) {await mkdir(path.dirname(f.config),{mode:0o755});await writeFile(f.config,legacy,{mode:0o644});}
function assertLegacy(source) {const parsed=parseInstallationJsonc(source),original=parseInstallationJsonc(legacy);assert.deepEqual(parsed.permissions,original.permissions);assert.deepEqual(parsed.hooks.PreToolUse,original.hooks.PreToolUse);assert.deepEqual(parsed.hooks.UserPromptSubmit[0],original.hooks.UserPromptSubmit[0]);assert(source.includes('// preserve native permission hooks'));}

test('Codex native installer appends one exact owned group preserving permissions/comments and mode; no trust or load claim',async t=>{
 const f=await fixture(t);await legacyConfig(f);const plan=await f.plan('install');
 assert.deepEqual(plan.nativeConfigurationChanges,[{path:f.config,keys:['hooks.UserPromptSubmit'],operation:'append-owned-hook'}]);assert.equal(plan.affectedPaths.find(change=>change.path===f.config).operation,'replace');
 const installed=await f.service.apply(approval(plan));assert.equal(installed.installation.nativeConfigured,true);assert.equal(installed.installation.installedBundle,true);assert.equal(installed.nativeLoaded,'unverified');
 const source=await readFile(f.config,'utf8');assertLegacy(source);assert.equal(parseInstallationJsonc(source).hooks.UserPromptSubmit.length,2);assert.equal((await lstat(f.config)).mode&0o777,0o644);assert(source.includes(' native codex-hook --descriptor '));
 const changedCli=path.join(f.root,'cli-new.js');await writeFile(changedCli,'// replacement fixture CLI\n',{mode:0o600});f.options.cliPath=changedCli;
 const update=await f.plan('update');assert.equal(update.nativeConfigurationChanges[0].operation,'replace-owned-hook');await f.service.apply(approval(update));const updated=await readFile(f.config,'utf8');assertLegacy(updated);assert.equal(parseInstallationJsonc(updated).hooks.UserPromptSubmit.length,2);assert(updated.includes(changedCli));
 const rollback=await f.plan('rollback');await f.service.apply(approval(rollback));const restored=await readFile(f.config,'utf8');assertLegacy(restored);assert(!restored.includes(changedCli));
 const remove=await f.plan('uninstall');assert.equal(remove.nativeConfigurationChanges[0].operation,'remove-owned-hook');await f.service.apply(approval(remove));const removed=await readFile(f.config,'utf8');assertLegacy(removed);assert.deepEqual(parseInstallationJsonc(removed),parseInstallationJsonc(legacy));assert.equal((await lstat(f.config)).mode&0o777,0o644);
});

test('Codex fresh config creation is project-only; unchanged update does not rewrite hooks',async t=>{
 const f=await fixture(t),plan=await f.plan('install');assert(plan.affectedPaths.some(change=>change.path===path.dirname(f.config)));await f.service.apply(approval(plan));assert.equal((await lstat(f.config)).mode&0o777,0o600);
 const before=await readFile(f.config,'utf8'),stamp=await lstat(f.config),update=await f.plan('update');assert.deepEqual(update.nativeConfigurationChanges,[]);await f.service.apply(approval(update));assert.equal(await readFile(f.config,'utf8'),before);assert.equal((await lstat(f.config)).ino,stamp.ino);
});

test('Codex uninstall preserves an edited owned hook; update refuses it',async t=>{
 const f=await fixture(t);await legacyConfig(f);await f.service.apply(approval(await f.plan('install')));
 const source=await readFile(f.config,'utf8'),edited=source.replace('"timeout":30','"timeout":31');assert.notEqual(edited,source);await writeFile(f.config,edited,{mode:0o644});
 await assert.rejects(f.plan('update'),{code:'INSTALLATION_COLLISION'});const removal=await f.plan('uninstall');assert(removal.preservedPaths.includes(f.config));assert.deepEqual(removal.nativeConfigurationChanges,[]);await f.service.apply(approval(removal));assert.equal(await readFile(f.config,'utf8'),edited);
});

test('Codex full-command duplicate collision and stale native config refuse before apply',async t=>{
 const f=await fixture(t);await legacyConfig(f);const built=await f.strategy.build({stateDirectory:f.stateDirectory,projectRoot:f.projectRoot,installationId:'fixture',bundleDirectory:path.join(f.root,'unused')});
 const duplicate={hooks:{UserPromptSubmit:[{hooks:[{...built.projectHook.entry.hooks[0],timeout:99}]}]}};await writeFile(f.config,JSON.stringify(duplicate));await assert.rejects(f.plan('install'),{code:'INSTALLATION_COLLISION'});
 await writeFile(f.config,legacy);const plan=await f.plan('install');await writeFile(f.config,legacy+'// later human edit\n');await assert.rejects(f.service.apply(approval(plan)),{code:'INSTALLATION_STALE_PLAN'});assert((await readFile(f.config,'utf8')).endsWith('// later human edit\n'));
});

test('interrupted Codex config replacement recovers exact private backup bytes and original mode',async t=>{
 let interrupt=true;const f=await fixture(t,(phase,index)=>{if(interrupt&&phase==='operation'&&index===2)throw new Error('native fixture interruption');});await legacyConfig(f);const plan=await f.plan('install');
 await assert.rejects(f.service.apply(approval(plan)),/native fixture interruption/);assert.notEqual(await readFile(f.config,'utf8'),legacy);interrupt=false;await f.service.recover(approval(plan));assert.equal(await readFile(f.config,'utf8'),legacy);assert.equal((await lstat(f.config)).mode&0o777,0o644);assert.equal((await f.service.inspect()).installations.length,0);
});

test('native config and parent symlinks are not followed or replaced',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'hooks.json'),'user content');await symlink(outside,path.dirname(f.config));await assert.rejects(f.plan('install'),{code:'INSTALLATION_PATH'});assert.equal(await readFile(path.join(outside,'hooks.json'),'utf8'),'user content');
});

test('native recovery never resurrects user-deleted replacement targets', async t => {
  for (const when of ['prepared', 'replaced']) {
    const f = await fixture(t, (phase, index) => { if (when === 'prepared' ? phase === 'prepared' : phase === 'operation' && index === 2) throw new Error('native interruption'); });
    await legacyConfig(f); const plan = await f.plan('install');
    await assert.rejects(f.service.apply(approval(plan)), /native interruption/); await unlink(f.config);
    await assert.rejects(f.service.recover(approval(plan)), { code: 'INSTALLATION_RECOVERY_CONFLICT' });
    await assert.rejects(lstat(f.config), { code: 'ENOENT' }); assert((await f.service.inspect()).pending);
  }
});

test('unchanged native hooks and runtime permissions remain approval dependencies', async t => {
  const f = await fixture(t); await f.service.apply(approval(await f.plan('install')));
  const update = await f.plan('update'); assert.deepEqual(update.nativeConfigurationChanges, []);
  await writeFile(f.config, '{"hooks":{}}\n', { mode: 0o600 });
  await assert.rejects(f.service.apply(approval(update)), { code: 'INSTALLATION_STALE_PLAN' });
  assert.equal(await readFile(f.config, 'utf8'), '{"hooks":{}}\n');
  const other = await fixture(t), install = await other.plan('install'); await chmod(other.options.cliPath, 0o666);
  await assert.rejects(other.service.apply(approval(install)), { code: 'INSTALLATION_STALE_PLAN' });
  await assert.rejects(lstat(other.config), { code: 'ENOENT' }); assert.equal((await other.service.inspect()).pending, null);
});

test('BOM-prefixed native JSONC preserves exact backup and crash-recovery bytes', async t => {
  let interrupt = true;
  const f = await fixture(t, (phase, index) => { if (interrupt && phase === 'operation' && index === 2) throw new Error('BOM interruption'); });
  await legacyConfig(f); const original = '﻿' + legacy; await writeFile(f.config, original, { mode: 0o644 });
  const plan = await f.plan('install'); await assert.rejects(f.service.apply(approval(plan)), /BOM interruption/);
  assert((await readFile(f.config, 'utf8')).startsWith('﻿')); interrupt = false;
  await f.service.recover(approval(plan)); assert.equal(await readFile(f.config, 'utf8'), original);
  assert.equal((await lstat(f.config)).mode & 0o777, 0o644);
  await f.service.apply(approval(await f.plan('install'))); await f.service.apply(approval(await f.plan('uninstall')));
  const removed = await readFile(f.config, 'utf8'); assert(removed.startsWith('﻿')); assertLegacy(removed);
  assert.deepEqual(parseInstallationJsonc(removed), parseInstallationJsonc(original));
});

test('native staging works across filesystems including interrupted replacement recovery', async t => {
  const module = new URL('../packages/murmur/dist/integrations/index.js', import.meta.url).href;
  const run = async (f, plan, method = 'apply', crash = false) => {
    const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const project=${JSON.stringify(f.projectRoot)},device=p=>p.startsWith(project+'/')?'project':'state';
      for(const name of ['link','rename']){const original=fs[name];fs[name]=async(a,b,...rest)=>{if(device(a)!==device(b)){const error=new Error('cross-device operation');error.code='EXDEV';throw error;}return original(a,b,...rest);};}syncBuiltinESMExports();
      const {InstallationService}=await import(${JSON.stringify(module)});const service=new InstallationService({stateDirectory:${JSON.stringify(f.stateDirectory)},env:{},strategies:[],checkpoint(phase,index){if(${crash}&&phase==='operation'&&index===2)process.exit(88);}});
      const result=await service[${JSON.stringify(method)}](${JSON.stringify(approval(plan))});console.log(JSON.stringify(result));`;
    return promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  };
  for (const existing of [false, true]) {
    const f = await fixture(t); if (existing) await legacyConfig(f); const plan = await f.plan('install');
    const result = JSON.parse((await run(f, plan)).stdout); assert.equal(result.installation.nativeConfigured, true);
    if (existing) assertLegacy(await readFile(f.config, 'utf8'));
    await run(f, await f.plan('uninstall')); assert.equal(parseInstallationJsonc(await readFile(f.config, 'utf8')).hooks.UserPromptSubmit.length, existing ? 1 : 0);
  }
  const f = await fixture(t); await legacyConfig(f); const plan = await f.plan('install');
  await assert.rejects(run(f, plan, 'apply', true), error => error.code === 88);
  assert.notEqual(await readFile(f.config, 'utf8'), legacy); await run(f, plan, 'recover');
  assert.equal(await readFile(f.config, 'utf8'), legacy); assert.equal((await f.service.inspect()).pending, null);
});

test('unknown target-local staging is preserved and refuses apply before mutation', async t => {
  const f = await fixture(t); await legacyConfig(f); const plan = await f.plan('install');
  const staging = path.join(path.dirname(f.config), `.murmur-${plan.planId}-2.stage`);
  await writeFile(staging, 'human notes', { mode: 0o600 });
  await assert.rejects(f.service.apply(approval(plan)), { code: 'INSTALLATION_COLLISION' });
  assert.equal(await readFile(staging, 'utf8'), 'human notes'); assert.equal(await readFile(f.config, 'utf8'), legacy);
  assert.equal((await f.service.inspect()).pending, null);
});

test('Codex activation guidance enables hooks without approving native trust', async t => {
  const f = await fixture(t), plan = await f.plan('install');
  assert(plan.activation.instructions.includes("codex -c 'features.hooks=true' resume"));
  assert(plan.activation.instructions.includes('Do not enable allow-untrusted-hooks'));
  assert.equal(plan.activation.nativeLoaded, 'unverified');
});
