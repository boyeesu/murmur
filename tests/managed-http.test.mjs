import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request, loadDescriptor } from '../packages/murmur/dist/cli/client.js';
import { AgentClient } from '../packages/murmur/dist/cli/agent-client.js';
import { AGENT_MODE_ENV, AGENT_CONNECTION_ENV } from '../packages/murmur/dist/protocol/agent.js';
import { temporary, repository, git } from './helpers.mjs';
const execute=promisify(execFile);
const cli=fileURLToPath(new URL('../packages/murmur/dist/cli/index.js',import.meta.url));

async function wire(connection, endpoint, body, token, key=randomUUID()) {
  const result=await fetch(connection.origin+endpoint, {method:body===undefined?'GET':'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json','X-Murmur-State-Id':connection.stateId,'X-Murmur-Protocol-Version':String(connection.protocolVersion),...(body===undefined?{}:{'Idempotency-Key':key})}, ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await result.json();
  if(!result.ok) throw Object.assign(new Error(value.error?.message),{status:result.status,code:value.error?.code});
  return value;
}
const control=(prepared,action,body,key)=>wire(prepared.supervisor,`/v1/launch-control/${action}`,{launchId:prepared.launch.id,...body},prepared.supervisor.supervisorToken,key);

async function setup(t) {
  const root=await temporary(t), home=path.join(root,'state'), source=await repository(path.join(root,'source'));
  let daemon=await startDaemon(home);
  try {
    const project=await request(home,'POST','/v1/projects',{root:source});
    return {root,home,source,project,get daemon(){return daemon;},async restart(){await daemon.close();daemon=await startDaemon(home);},async close(){await daemon.close();}};
  } catch(error) {await daemon.close();throw error;}
}
const prepare=(f,tool,title)=>request(f.home,'POST','/v1/launches/prepare',{projectId:f.project.id,tool,title},{timeoutMs:60000});

async function activate(prepared) {
  const controllerId=randomUUID();
  const claimed=await control(prepared,'claim',{controllerId,revision:prepared.launch.lifecycleRevision});
  const running=await control(prepared,'started',{controllerId,revision:claimed.lifecycleRevision,pid:process.pid});
  return {controllerId,running};
}

test('two managed bridges share context without receiving human authority',async t=>{
  const f=await setup(t);
  try {
    const original=git(f.source,'rev-parse','HEAD');
    const a=await prepare(f,'claude','Backend endpoint');
    const b=await prepare(f,'codex','Recovery implementation');
    assert.notEqual(a.launch.workspaceRoot,b.launch.workspaceRoot);
    assert.notEqual(a.agent.agentToken,a.supervisor.supervisorToken);
    const aa=await activate(a), bb=await activate(b);
    const clientA=new AgentClient(a.agent), clientB=new AgentClient(b.agent);
    assert.equal((await clientA.identity()).role,'agent');
    const contextA=await clientA.context();
    const declaredA=await clientA.intent({revision:contextA.task.revision,writes:['src/endpoint.ts'],produces:[{key:'reset-api',version:'v1',value:'202'}]},'intent-a');
    const contextB=await clientB.context();
    await clientB.intent({revision:contextB.task.revision,writes:['src/recovery.ts'],produces:[{key:'reset-api',version:'v1',value:'202'}]},'intent-b');
    assert((await clientB.context()).alerts.some(alert=>alert.kind==='duplicate_contract_producers'));
    const decision=await clientA.proposeDecision({key:'reset-api',value:'202',version:'v1',rationale:'Shared endpoint contract'},'propose');
    await assert.rejects(wire(a.agent,'/v1/decisions/accept',{decisionId:decision.id,revision:decision.revision,expectedAcceptedId:null},a.agent.agentToken),error=>error.status===403);
    await assert.rejects(wire(a.agent,'/v1/sessions/heartbeat',{sessionId:a.agent.sessionId,revision:1},a.agent.agentToken),error=>error.status===403);
    await assert.rejects(wire(a.agent,'/v1/tasks',{projectId:f.project.id,sessionId:a.agent.sessionId,title:'Unauthorized child task'},a.agent.agentToken),error=>error.status===403);
    await assert.rejects(wire(a.agent,'/v1/context?projectId='+f.project.id+'&taskId='+a.agent.taskId,undefined,a.supervisor.supervisorToken),error=>error.status===401);
    await assert.rejects(wire(a.agent,'/v1/launch-control/heartbeat',{launchId:a.launch.id,controllerId:aa.controllerId,revision:aa.running.lifecycleRevision},a.agent.agentToken),error=>error.status===401);
    const other=await request(f.home,'POST','/v1/tasks',{projectId:f.project.id,sessionId:a.agent.sessionId,title:'Another task owned by the same session'});
    await assert.rejects(wire(a.agent,'/v1/intents',{taskId:other.id,revision:other.revision,writes:['other.ts']},a.agent.agentToken),error=>error.status===403);
    const lease=await clientA.reserve({taskRevision:declaredA.task.revision,resources:[{kind:'path',value:'src/endpoint.ts'}],ttlSeconds:300},'reserve-a');
    assert(lease.id);
    const heartbeat={controllerId:aa.controllerId,revision:aa.running.lifecycleRevision};
    const first=await control(a,'heartbeat',heartbeat,'lost-heartbeat');
    const repeat=await control(a,'heartbeat',heartbeat,'lost-heartbeat');
    assert.equal(first.expiresAt,repeat.expiresAt);
    assert.equal(first.lifecycleRevision,repeat.lifecycleRevision);
    const end={controllerId:aa.controllerId,revision:first.lifecycleRevision,reason:'exited',exitCode:0};
    assert.equal((await control(a,'end',end,'end-a')).state,'ended');
    assert.equal((await control(a,'end',end,'end-a')).state,'ended');
    await assert.rejects(clientA.context());
    const status=await request(f.home,'GET',`/v1/status?projectId=${f.project.id}`);
    assert.equal(status.reservations.filter(item=>item.sessionId===a.agent.sessionId).length,0);
    assert.equal(status.tasks.find(task=>task.id===a.agent.taskId).status,'active');
    const events=await request(f.home,'GET',`/v1/events?projectId=${f.project.id}`);
    const publicText=JSON.stringify({status,events});
    for(const secret of [a.agent.agentToken,a.supervisor.supervisorToken,b.agent.agentToken,b.supervisor.supervisorToken]) assert(!publicText.includes(secret));
    await control(b,'end',{controllerId:bb.controllerId,revision:bb.running.lifecycleRevision,reason:'exited',exitCode:0});
    assert.equal(git(f.source,'rev-parse','HEAD'),original);
    assert.equal(git(f.source,'status','--porcelain'),'');
  } finally {await f.close();}
});

test('managed client survives same-state restart and human commands fail before discovery',async t=>{
  const f=await setup(t);
  try {
    const prepared=await prepare(f,'claude','Restart-safe task');
    const active=await activate(prepared);
    const first=await new AgentClient(prepared.agent).identity();
    const human=(await loadDescriptor(f.home)).token;
    await assert.rejects(new AgentClient({...prepared.agent,agentToken:human}).identity());
    await assert.rejects(new AgentClient({...prepared.agent,stateId:'0'.repeat(64)}).identity());
    await f.restart();
    const second=await new AgentClient(prepared.agent).identity();
    assert.notEqual(first.instanceId,second.instanceId);
    assert.equal(second.stateId,first.stateId);
    const env={...process.env,MURMUR_HOME:path.join(f.root,'nonexistent-human-state'),[AGENT_MODE_ENV]:'1',[AGENT_CONNECTION_ENV]:JSON.stringify(prepared.agent)};
    const result=await execute(process.execPath,[cli,'agent','context'],{env,timeout:15000});
    assert.equal(JSON.parse(result.stdout).task.id,prepared.agent.taskId);
    await assert.rejects(execute(process.execPath,[cli,'status','--json'],{env,timeout:10000}),error=>error.stderr.includes('HUMAN_COMMAND_FORBIDDEN')&&!error.stderr.includes(prepared.agent.agentToken));
    const partial={...env}; delete partial[AGENT_CONNECTION_ENV];
    await assert.rejects(execute(process.execPath,[cli,'status'],{env:partial,timeout:10000}),error=>error.stderr.includes('HUMAN_COMMAND_FORBIDDEN'));
    await control(prepared,'end',{controllerId:active.controllerId,revision:active.running.lifecycleRevision,reason:'exited',exitCode:0});
  } finally {await f.close();}
});
