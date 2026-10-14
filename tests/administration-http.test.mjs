import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {startDaemon} from '../packages/murmur/dist/daemon/server.js';
import {request,loadDescriptor} from '../packages/murmur/dist/cli/client.js';
import {temporary} from './helpers.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const root=await realpath(await temporary(t)),home=path.join(root,'state'),workspace=path.join(root,'workspace');await mkdir(workspace);
 const daemon=await startDaemon(home);t.after(()=>daemon.close());
 const project=await request(home,'POST','/v1/projects',{root:workspace});
 const actor=await request(home,'POST','/v1/sessions',{projectId:project.id,workspaceRoot:workspace,tool:'manual',nativeId:randomUUID(),instanceId:randomUUID()});
 const descriptor=await loadDescriptor(home);
 const raw=async(endpoint,method='GET',body,token=descriptor.token,key=randomUUID())=>{
  const response=await fetch(`http://127.0.0.1:${daemon.port}${endpoint}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(method==='POST'?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
 };
 return {root,home,workspace,project,actor,descriptor,daemon,raw};
}

test('maintenance HTTP credentials rotate with independent CAS and immediately invalidate old access',async t=>{
 const f=await fixture(t),url=`/v1/maintenance/credentials?sessionId=${f.actor.session.id}`;
 assert.equal((await f.raw(url,'GET',undefined,f.actor.token)).status,403);
 const first=await f.raw(url);assert.equal(first.data.revision,1);
 await request(f.home,'POST','/v1/sessions/heartbeat',{sessionId:f.actor.session.id,revision:f.actor.session.revision},{token:f.actor.token});
 assert.equal((await f.raw(url)).data.revision,1);
 const token=randomBytes(32).toString('base64url');
 const rotated=await f.raw('/v1/maintenance/credentials/rotate','POST',{sessionId:f.actor.session.id,revision:1,tokenHash:hash(token)});
 assert.equal(rotated.status,200);assert.equal(rotated.data.revision,2);assert(!JSON.stringify(rotated.data).includes(token));
 assert.equal((await f.raw('/v1/status','GET',undefined,f.actor.token)).status,401);
 assert.equal((await f.raw('/v1/status','GET',undefined,token)).status,200);
 assert.equal((await f.raw('/v1/maintenance/credentials/revoke','POST',{sessionId:f.actor.session.id,revision:2},token)).status,403);
 assert.equal((await f.raw('/v1/maintenance/credentials/revoke','POST',{sessionId:f.actor.session.id,revision:2})).status,200);
 assert.equal((await f.raw('/v1/status','GET',undefined,token)).status,401);
});

test('retention HTTP exposes a gap and keeps retired request keys from executing again',async t=>{
 const f=await fixture(t),key=randomUUID(),body={projectId:f.project.id,sessionId:f.actor.session.id,title:'Retained task'};
 const created=await request(f.home,'POST','/v1/tasks',body,{key});
 await new Promise(r=>setTimeout(r,5));
 const input={before:Date.now(),classes:['events','context-records','mutation-payloads']};
 const denied=await f.raw('/v1/maintenance/retention/preview','POST',input,f.actor.token);assert.equal(denied.status,403);
 const preview=await request(f.home,'POST','/v1/maintenance/retention/preview',input);
 const applied=await request(f.home,'POST','/v1/maintenance/retention/apply',{...input,revision:preview.revision,previewDigest:preview.previewDigest});assert.equal(applied.applied,true);
 const events=await request(f.home,'GET',`/v1/events?projectId=${f.project.id}&after=0`);assert.equal(events.history.historyPruned,true);
 const context=await request(f.home,'GET',`/v1/context?projectId=${f.project.id}&taskId=${created.id}`);assert.equal(context.history.historyPruned,true);assert.equal(context.task.id,created.id);assert.match(context.briefing,/Event history was pruned through sequence/);
 const current=await request(f.home,'GET',`/v1/context?projectId=${f.project.id}&taskId=${created.id}&after=${context.history.prunedThrough}`);assert.equal(current.history.historyPruned,false);assert(!current.briefing.includes('Event history was pruned'));
 const replay=await f.raw('/v1/tasks','POST',body,undefined,key);assert.equal(replay.status,410);assert.equal(replay.data.error.code,'IDEMPOTENCY_RETIRED');
 const stream=await fetch(`http://127.0.0.1:${f.daemon.port}/v1/stream?projectId=${f.project.id}&after=0`,{headers:{Authorization:`Bearer ${f.descriptor.token}`},signal:AbortSignal.timeout(4000)});
 const reader=stream.body.getReader(),decoder=new TextDecoder();let text='';try{while(!text.includes('event: reset')){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value);}}finally{await reader.cancel();}
 assert(text.includes('event: reset'));assert(text.includes('history_pruned'));
});

test('manual session event streams close after credential revocation',async t=>{
 const f=await fixture(t);
 const stream=await fetch(`http://127.0.0.1:${f.daemon.port}/v1/stream?projectId=${f.project.id}&after=0`,{headers:{Authorization:`Bearer ${f.actor.token}`},signal:AbortSignal.timeout(5000)});
 const reader=stream.body.getReader();await reader.read();
 await request(f.home,'POST','/v1/maintenance/credentials/revoke',{sessionId:f.actor.session.id,revision:1});
 let done=false;while(!done){const part=await reader.read();done=part.done;}
 assert.equal(done,true);
});

test('backup and installation administration are human-only and never expose offline restore',async t=>{
 const f=await fixture(t),destination=path.join(f.root,'backup.sqlite');
 assert.equal((await f.raw('/v1/maintenance/backup','POST',{destination},f.actor.token)).status,403);
 const backup=await f.raw('/v1/maintenance/backup','POST',{destination});assert.equal(backup.status,200);assert.equal(backup.data.sensitive,true);assert.equal((await stat(destination)).mode&0o077,0);
 assert.equal((await f.raw('/v1/maintenance/backup','POST',{destination})).status,409);
 assert.equal((await f.raw('/v1/maintenance/restore','POST',{backupPath:destination,stateDirectory:path.join(f.root,'restore')})).status,404);
 assert.equal((await f.raw('/v1/integrations','GET',undefined,f.actor.token)).status,403);
 const listed=await f.raw('/v1/integrations');assert.equal(listed.status,200);assert(listed.data.providers.some(p=>p.provider==='claude'));
 assert.equal((await f.raw('/v1/integrations/plan','POST',{action:'install',provider:'claude',projectRoot:f.workspace},f.actor.token)).status,403);
 assert.equal((await f.raw('/v1/integrations?provider=claude&provider=codex')).status,400);
});
