import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { groupMain, groupHelp } from '../packages/murmur/dist/cli/group.js';
import { connectMain, connectHelp } from '../packages/murmur/dist/cli/connect.js';
import { readHumanJson } from '../packages/murmur/dist/cli/human-input.js';
import { temporary } from './helpers.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() { const calls = [], output = []; return { calls, output, dependencies: { env: {}, stateDirectory: '/never-discovered', stderr: value => output.push(value), request: async (...args) => { calls.push(args); return { okay: true, token: 'PRIVATE', capability: 'PRIVATE', nested: { pollSecret: 'PRIVATE' } }; } } }; }

test('human group/connect help exports and scoped-environment guards precede all IO', async () => {
  const f = fixture(); assert.equal(await groupMain(['--help'], f.dependencies), groupHelp); assert.equal(await connectMain(['--help'], f.dependencies), connectHelp); assert.equal(f.calls.length, 0);
  for (const env of [{ MURMUR_AGENT_MODE: '1' }, { MURMUR_AGENT_CONNECTION: 'partial' }, { MURMUR_EXTERNAL_MODE: '1' }, { MURMUR_EXTERNAL_CONNECTION: 'partial' }]) for (const main of [groupMain, connectMain]) await assert.rejects(main(['--help'], { ...f.dependencies, env }), { code: 'HUMAN_COMMAND_FORBIDDEN' });
  assert.equal(f.calls.length, 0);
});

test('human command parsers reject duplicates, selectors, missing fields and conflicting JSON before requests', async () => {
  const f = fixture();
  for (const argv of [['create','--project','p','--project','p','--title','t'], ['create','--project','p'], ['list','--project','p','extra'], ['show','--group','p','--token','secret'], ['create','--project','p','--title','t','--data','{"projectId":"different"}'], ['add','--group','g','--session','s','--task','t','--responsibility','r','--data','{"token":"bad"}']]) await assert.rejects(groupMain(argv, f.dependencies));
  for (const argv of [['approve','--request','r','--revision','1'], ['requests','--session','x'], ['approve','--request','r','--revision','1','--digest','bad','--responsibility','r'], ['review','--request','r','--revision','1','--revision','2'], ['revoke','--grant','g','--data','{"agentToken":"bad"}']]) await assert.rejects(connectMain(argv, f.dependencies));
  assert.equal(f.calls.length, 0);
});

test('strict human mutations bind routes payloads request IDs and never return credential fields', async () => {
  const f = fixture(), key = randomUUID();
  const result = await groupMain(['create','--project','p','--title','Shared goal','--goal','A shared objective','--request-id',key], f.dependencies);
  assert.deepEqual(result, { okay: true, nested: {} });
  assert.deepEqual(f.calls[0], ['/never-discovered','POST','/v1/groups/create',{ projectId:'p',title:'Shared goal',goal:'A shared objective' },{ key }]);
  await groupMain(['leave','--member','m','--revision','3','--request-id','leave-key'], f.dependencies);
  assert.deepEqual(f.calls.at(-1).slice(1), ['POST','/v1/groups/members/leave',{ memberId:'m',revision:3 },{ key:'leave-key' }]);
  await connectMain(['approve','--request','r','--revision','2','--digest','a'.repeat(64),'--responsibility','Reviewed work','--expires','28800','--reconnect-grant','previous','--request-id','approval-key'], f.dependencies);
  assert.deepEqual(f.calls.at(-1).slice(1), ['POST','/v1/connections/approve',{ requestId:'r',reviewDigest:'a'.repeat(64),responsibility:'Reviewed work',reconnectGrantId:'previous',revision:2,expiresInSeconds:28800 },{ key:'approval-key' }]);
  await connectMain(['grants','--project','p'], f.dependencies); assert.equal(f.calls.at(-1)[2], '/v1/connections/grants?projectId=p');
});

test('invitation generation retains exact public code and request key before uncertain result and hashes only on wire', async t => {
  const root = await temporary(t), file = path.join(root, 'invite.json'), f = fixture();
  f.dependencies.request = async (...args) => { assert(f.output.length > 0); f.calls.push(args); throw new Error('PRIVATE SERVER TOKEN'); };
  await assert.rejects(groupMain(['invite','--group','g','--out',file], f.dependencies), error => !error.message.includes('PRIVATE'));
  const retained = JSON.parse(await readFile(file, 'utf8'));
  assert.match(retained.code, /^[A-Za-z0-9_-]{43}$/); assert(retained.requestId); assert.equal(f.calls[0][3].inviteHash, hash(retained.code)); assert(!JSON.stringify(f.calls).includes(retained.code));
  f.dependencies.request = async (...args) => { f.calls.push(args); return { id:'invite-1',groupId:'g' }; };
  const retried = await groupMain(['invite','--group','g','--code',retained.code,'--request-id',retained.requestId], f.dependencies);
  assert.equal(retried.inviteCode, retained.code); assert.deepEqual(f.calls[1][3], f.calls[0][3]); assert.equal(f.calls[1][4].key, f.calls[0][4].key);
  const before = f.calls.length;
  await assert.rejects(groupMain(['invite','--group','g','--request-id',retained.requestId], f.dependencies));
  await assert.rejects(groupMain(['invite','--group','g','--out',file], f.dependencies), { code:'HUMAN_EXPORT' }); assert.equal(f.calls.length,before);
});

test('explicit data and handoff files are bounded UTF8 JSON regular files with safe keys', async t => {
  const root = await temporary(t), file = path.join(root,'input.json'), link = path.join(root,'link.json');
  await writeFile(file,JSON.stringify({summary:'Reviewed',writes:['src'],decisions:[{key:'api',version:'1',value:'proposed',rationale:'review'}]}));
  const f=fixture(); await groupMain(['add','--group','g','--session','s','--task','t','--responsibility','r','--handoff',file],f.dependencies); assert.equal(f.calls[0][3].handoff.summary,'Reviewed');
  await symlink(file,link); await assert.rejects(readHumanJson(link), {code:'HUMAN_INPUT_FILE'});
  await writeFile(file,'x'.repeat(16385)); await assert.rejects(readHumanJson(file));
  await writeFile(file,'{"__proto__":{"bad":true}}'); await assert.rejects(readHumanJson(file));
  await writeFile(file,Buffer.from([0xff,0x7b])); await assert.rejects(readHumanJson(file));
  await mkdir(path.join(root,'directory')); await assert.rejects(readHumanJson(path.join(root,'directory')));
});

test('group export and native setup exports never overwrite existing output', async t => {
  const root = await temporary(t), output = path.join(root,'handoff.json'), f=fixture();
  f.dependencies.request=async()=>({version:1,kind:'reviewed_replacement_handoff',group:{id:'g'},member:{id:'m'},responsibility:'Reviewed',summary:'Summary',briefing:'Untrusted',warning:'replacement',agentToken:'PRIVATE'});
  const result=await groupMain(['export','--member','m','--out',output],f.dependencies);assert.equal(result.exported,true);assert(!(await readFile(output,'utf8')).includes('PRIVATE'));
  await assert.rejects(groupMain(['export','--member','m','--out',output],f.dependencies),{code:'HUMAN_EXPORT'});
  const canonicalRoot=await realpath(root),service=path.join(canonicalRoot,'service'),bin=path.join(canonicalRoot,'bin');await mkdir(service,{mode:0o700});await mkdir(bin);
  await writeFile(path.join(service,'connection.json'),JSON.stringify({protocolVersion:1,origin:'http://127.0.0.1:43123',stateId:'a'.repeat(64),instanceId:randomUUID()}),{mode:0o600});
  await writeFile(path.join(bin,'claude'),'#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 1\nprintf "2.1.247 (Claude Code)\\n"\n',{mode:0o700});
  const setup=path.join(canonicalRoot,'native-plugin'),dependencies={...f.dependencies,stateDirectory:service,env:{PATH:bin}};
  const exported=await connectMain(['setup','--tool','claude','--out',setup],dependencies);assert.equal(exported.enabled,true);assert.equal(exported.exported,true);assert.equal(exported.installed,false);assert.equal(exported.connected,false);assert.match(exported.resumeCommand,/--resume$/);
  await assert.rejects(connectMain(['setup','--tool','claude','--out',setup],dependencies),{code:'NATIVE_SETUP_EXISTS'});
});

test('human handoff JSON accepts bounded prior-path and remaining-work reports as separate fields',async()=>{
 const f=fixture();await groupMain(['add','--group','g','--session','s','--task','t','--responsibility','r','--data',JSON.stringify({handoff:{summary:'Reviewed state',changedFiles:['existing.ts'],remainingWork:['Add tests']}})],f.dependencies);
 assert.deepEqual(f.calls[0][3].handoff.changedFiles,['existing.ts']);assert.deepEqual(f.calls[0][3].handoff.remainingWork,['Add tests']);assert.equal(f.calls[0][3].handoff.writes,undefined);
 await assert.rejects(connectMain(['approve','--request','r','--revision','2','--digest','a'.repeat(64),'--responsibility','r','--data',JSON.stringify({handoff:{summary:'x',changedFiles:['../outside']}})],f.dependencies));
});
