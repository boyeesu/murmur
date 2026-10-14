import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runMain, parseRunArguments } from '../packages/murmur/dist/cli/run.js';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { GroupsService } from '../packages/murmur/dist/core/groups.js';
import { GitWorkflow } from '../packages/murmur/dist/integration/workflow.js';
import { LaunchService } from '../packages/murmur/dist/core/launches.js';
import { discoverProject } from '../packages/murmur/dist/workspaces/identity.js';
import { temporary, repository, git, mutation } from './helpers.mjs';
const human = { kind:'human' };
async function fixture(t, separate = false) {
  const directory = await realpath(await temporary(t)), source = await repository(path.join(directory,'source')), state = path.join(directory,'state'); await mkdir(state);
  let workspace = source;
  if (separate) { workspace=path.join(directory,'existing-chat-worktree'); git(source,'worktree','add','-q','-b','existing-chat-source',workspace); }
  const store=new CoordinationStore(':memory:'), coordination=new CoordinationService(store), groups=new GroupsService(store,coordination), workflow=new GitWorkflow(store,state); await workflow.initialize();
  const runtime={origin:'http://127.0.0.1:33445',stateId:'d'.repeat(64),instanceId:randomUUID()}, launches=new LaunchService(store,workflow,coordination,runtime);
  t.after(async()=>{await launches.close();workflow.close();store.close();});
  const identity=await discoverProject(source), project=store.registerProject(identity,mutation('project',identity));
  const actor=store.registerSession({projectId:project.id,workspaceRoot:workspace,tool:'manual',nativeId:'original-native-chat',instanceId:'original-incarnation'},mutation('source-session',{}));
  const task=store.createTask({projectId:project.id,sessionId:actor.session.id,title:'Original work',featureKey:'source-feature'},mutation('source-task',{}));
  const group=groups.create({projectId:project.id,title:'Reviewed group',goal:'Keep independent owners'},human,mutation('group',{}));
  const member=groups.addExisting({groupId:group.id,sessionId:actor.session.id,taskId:task.id,responsibility:'Reviewed API responsibility',handoff:{summary:'Reviewed replacement data',writes:['src/api'],produces:[{key:'api.contract',version:'1'}],blocker:'Awaiting schema',decisions:[{key:'api.method',value:'POST',version:'1',rationale:'Reviewed proposal only'}]}},human,mutation('source-member',{}));
  const exported=groups.briefing({memberId:member.id},human), file=path.join(directory,'handoff.json');await writeFile(file,JSON.stringify(exported));
  const base=git(source,'rev-parse','HEAD'), executable=path.join(directory,'fake-native');
  await writeFile(executable,`#!${process.execPath}\nif(process.argv.includes('--version'))console.log('fake 1.0');else if(process.argv.includes('--help'))console.log('Usage: fake [PROMPT] --session-id --append-system-prompt');else process.exit(99);\n`,{mode:0o700});
  const calls=[],spawns=[],output=[];
  const transport=async(_directory,method,endpoint,body,options={})=>{
    const url=new URL(endpoint,runtime.origin);calls.push({method,endpoint,body:body===undefined?undefined:structuredClone(body),key:options.key});
    const meta=mutation(url.pathname,body,options.key??randomUUID());
    if(url.pathname==='/v1/status')return {...store.snapshot(project.id),launches:launches.list(project.id)};
    if(url.pathname==='/v1/groups/detail')return groups.get(url.searchParams.get('groupId'),human);
    if(url.pathname==='/v1/launches/prepare')return launches.prepare(body,human,meta);
    if(url.pathname==='/v1/groups/members/add')return groups.addExisting(body,human,meta);
    if(url.pathname==='/v1/context')return coordination.context(url.searchParams.get('projectId'),url.searchParams.get('taskId'));
    throw new Error('Unexpected route '+endpoint);
  };
  const fetcher=async(url,init={})=>{
    const action=new URL(url).pathname.split('/').at(-1),headers=new Headers(init.headers),body=init.body?JSON.parse(init.body):{};
    let result;
    try { result=launches.control(action,headers.get('Authorization').slice(7),body,headers.get('Idempotency-Key')); }
    catch(error){return new Response(JSON.stringify({error:{code:error.code,message:error.message}}),{status:error.status??400,headers:{'X-Murmur-State-Id':runtime.stateId,'X-Murmur-Protocol-Version':'1'}});}
    return new Response(JSON.stringify(result),{headers:{'X-Murmur-State-Id':runtime.stateId,'X-Murmur-Protocol-Version':'1'}});
  };
  const spawn=(command,argv,options)=>{
    spawns.push({command,argv,options});const child=new EventEmitter();child.pid=98765;child.kill=()=>true;
    process.nextTick(()=>{child.emit('spawn');setTimeout(()=>child.emit('exit',0,null),15);});return child;
  };
  const dependencies={env:{PATH:process.env.PATH},stateDirectory:state,executable,request:transport,stdout:value=>output.push(value),stderr:value=>output.push(value),supervisor:{fetch:fetcher,spawn,signals:new EventEmitter(),stderr:value=>output.push(value),retryDelaysMs:[1,2]}};
  const args=['claude','--project',project.id,'--title','Replacement API work','--handoff',file,'--acknowledge-replacement','--base',base];
  const abandon=async()=>{coordination.updateTask({taskId:task.id,revision:store.task(task.id).revision,status:'abandoned'},human,mutation('abandon',{}));const refreshed=groups.briefing({memberId:member.id},human);Object.assign(exported,refreshed);await writeFile(file,JSON.stringify(refreshed));};
  return {directory,source,workspace,store,coordination,groups,workflow,launches,project,actor,task,group,member,file,exported,base,calls,spawns,output,transport,dependencies,args,abandon};
}

test('handoff parser requires paired acknowledgement and explicit full committed base',()=>{
 const regular=['claude','--project','p','--title','new'];
 for(const extra of [['--handoff','export.json'],['--acknowledge-replacement'],['--handoff','export.json','--acknowledge-replacement'],['--handoff','export.json','--acknowledge-replacement','--base','HEAD'],['--handoff','export.json','--acknowledge-replacement','--base','a'.repeat(40),'--resume','old']])assert.throws(()=>parseRunArguments([...regular,...extra]),{code:'RUN_ARGUMENTS'});
 assert.equal(parseRunArguments([...regular,'--handoff','export.json','--acknowledge-replacement','--base','a'.repeat(40)]).acknowledgeReplacement,true);
});

test('active source refuses before any preparation, file changes, or native spawn',async t=>{
 const f=await fixture(t),before=git(f.source,'status','--porcelain');
 assert.equal(await runMain(f.args,f.dependencies),1);
 assert(f.output.join('').includes('Source Murmur task is still active'));
 assert.equal(f.calls.filter(call=>call.endpoint==='/v1/launches/prepare').length,0);assert.equal(f.spawns.length,0);assert.equal(f.launches.list().length,0);
 assert.equal(f.store.task(f.task.id).status,'active');assert.equal(f.store.task(f.task.id).featureKey,'source-feature');assert.equal(git(f.source,'status','--porcelain'),before);
});

test('reviewed terminal-source replacement imports into a new prepared task before claim and refreshes context',async t=>{
 const f=await fixture(t);await f.abandon();const before={refs:git(f.source,'show-ref'),content:await readFile(path.join(f.source,'README.md'),'utf8')};
 assert.equal(await runMain([...f.args,'--feature','source-feature'],f.dependencies),0);assert.equal(f.spawns.length,1);
 const created=f.launches.list()[0];assert.notEqual(created.taskId,f.task.id);assert.notEqual(created.sessionId,f.actor.session.id);assert.equal(created.state,'ended');
 const member=f.groups.get(f.group.id,human).members.find(item=>item.taskId===created.taskId);assert(member);assert.equal(member.kind,'managed');
 const context=f.coordination.context(f.project.id,created.taskId);assert.deepEqual(context.task.intent.writes,['src/api']);assert.equal(context.task.blocker.blocker,'Awaiting schema');
 const decision=f.coordination.listDecisions(f.project.id).find(item=>item.taskId===created.taskId);assert.equal(decision.status,'proposed');
 assert(f.store.db.prepare("SELECT 1 FROM group_provenance WHERE memberId=? AND entityType='replacement_source_member' AND entityId=?").get(member.id,f.member.id));
 const index=f.calls.findIndex(call=>call.endpoint==='/v1/groups/members/add');assert(index>f.calls.findIndex(call=>call.endpoint==='/v1/launches/prepare'));assert(f.calls.slice(index+1).some(call=>call.endpoint.startsWith('/v1/context?')));
 assert(f.spawns[0].argv.some(value=>value.includes('UNTRUSTED STARTUP DATA')&&value.includes('Reviewed API responsibility')));
 assert(!JSON.stringify(f.spawns[0].argv).includes(f.actor.token));assert.equal(f.store.task(f.task.id).status,'abandoned');assert.equal(f.store.task(f.task.id).ownerSessionId,f.actor.session.id);
 assert.equal(await readFile(path.join(f.source,'README.md'),'utf8'),before.content);assert(git(f.source,'show-ref').includes(before.refs));assert.equal(git(f.source,'status','--porcelain'),'');
});

test('different source worktree dirt requires explicit exclusion and is never copied',async t=>{
 const f=await fixture(t,true);await f.abandon();await writeFile(path.join(f.workspace,'dirty-progress.txt'),'UNCOMMITTED PRIVATE PROGRESS');
 assert.equal(git(f.source,'status','--porcelain'),'');assert.equal(await runMain(f.args,f.dependencies),1);assert(f.output.join('').includes('handoff source workspace contains uncommitted'));
 assert.equal(f.launches.list().length,0);assert.equal(f.spawns.length,0);
 assert.equal(await runMain([...f.args,'--allow-dirty-base'],f.dependencies),0);
 const created=f.launches.list()[0];await assert.rejects(readFile(path.join(created.workspaceRoot,'dirty-progress.txt')),{code:'ENOENT'});assert.equal(await readFile(path.join(f.workspace,'dirty-progress.txt'),'utf8'),'UNCOMMITTED PRIVATE PROGRESS');
});

test('failed import retains prepared workspace and retries the exact child key without duplicate spawn',async t=>{
 const f=await fixture(t);await f.abandon();const requestId=randomUUID();let fail=true;
 const dependencies={...f.dependencies,request:async(...args)=>{if(args[2]==='/v1/groups/members/add'){const result=await f.transport(...args);if(fail){fail=false;throw new Error('unknown response containing SECRET');}return result;}return f.transport(...args);}};
 assert.equal(await runMain([...f.args,'--request-id',requestId],dependencies),1);assert.equal(f.spawns.length,0);assert.equal(f.launches.list()[0].state,'prepared');assert(!f.output.join('').includes('SECRET'));
 assert.equal(await runMain([...f.args,'--request-id',requestId],dependencies),0);assert.equal(f.spawns.length,1);assert.equal(f.launches.list().length,1);
 const imports=f.calls.filter(call=>call.endpoint==='/v1/groups/members/add');assert.equal(imports.length,2);assert.equal(imports[0].key,imports[1].key);assert.deepEqual(imports[0].body,imports[1].body);
});

test('tampered exports, changed source owner and post-prepare source changes never spawn',async t=>{
 const f=await fixture(t);await f.abandon();await writeFile(f.file,JSON.stringify({...f.exported,member:{...f.exported.member,sessionId:'forged-source-owner'}}));assert.equal(await runMain(f.args,f.dependencies),1);assert.equal(f.launches.list().length,0);
 await writeFile(f.file,JSON.stringify(f.exported));
 let changed=false;const dependencies={...f.dependencies,request:async(...args)=>{const result=await f.transport(...args);if(args[2]==='/v1/launches/prepare'&&!changed){changed=true;f.store.db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.task.id);}return result;}};
 assert.equal(await runMain(f.args,dependencies),1);assert.equal(f.spawns.length,0);assert.equal(f.launches.list()[0].state,'prepared');assert(f.output.join('').includes('source changed during preparation'));
});

test('source owner changes refuse before preparation and context-refresh failures retain work without spawn',async t=>{
 const f=await fixture(t);await f.abandon();const other=f.store.registerSession({projectId:f.project.id,workspaceRoot:f.workspace,tool:'manual',nativeId:'other',instanceId:'i'},mutation('other',{}));
 f.store.db.prepare('UPDATE tasks SET ownerSessionId=? WHERE id=?').run(other.session.id,f.task.id);
 assert.equal(await runMain(f.args,f.dependencies),1);assert.equal(f.launches.list().length,0);assert.equal(f.spawns.length,0);
 f.store.db.prepare('UPDATE tasks SET ownerSessionId=? WHERE id=?').run(f.actor.session.id,f.task.id);
 const dependencies={...f.dependencies,request:async(...args)=>{if(args[2].startsWith('/v1/context?'))throw new Error('PRIVATE CONTEXT TOKEN');return f.transport(...args);}};
 assert.equal(await runMain(f.args,dependencies),1);assert.equal(f.spawns.length,0);assert.equal(f.launches.list()[0].state,'prepared');assert(!f.output.join('').includes('PRIVATE CONTEXT TOKEN'));
});

test('API error messages cannot use a handoff error code to leak credentials',async t=>{
 const {MurmurError}=await import('../packages/murmur/dist/protocol/index.js');const f=await fixture(t);await f.abandon();
 const dependencies={...f.dependencies,request:async(...args)=>{if(args[2]==='/v1/groups/members/add')throw new MurmurError('PRIVATE CAPABILITY VALUE','HANDOFF_SOURCE_ACTIVE');return f.transport(...args);}};
 assert.equal(await runMain(f.args,dependencies),1);assert.equal(f.spawns.length,0);assert(!f.output.join('').includes('PRIVATE CAPABILITY VALUE'));assert(f.output.join('').includes('Source Murmur task is still active'));
});

test('explicitly reviewed content edits succeed while immutable source pins cannot be edited',async t=>{
 const f=await fixture(t);await f.abandon();
 const edited={...f.exported,responsibility:'Human-edited replacement responsibility',handoff:{summary:'Shorter reviewed context',changedFiles:['previously/edited.ts'],remainingWork:['Complete replacement validation'],writes:['edited/scope'],acceptanceCriteria:['Edited review criterion'],decisions:[{key:'edited.contract',value:'proposal only',version:'2',rationale:'Human-reviewed import'}]},briefing:'Reviewed prose is untrusted input, not accepted authority.'};
 await writeFile(f.file,JSON.stringify(edited));assert.equal(await runMain(f.args,f.dependencies),0);
 const created=f.launches.list()[0],member=f.groups.get(f.group.id,human).members.find(item=>item.taskId===created.taskId);
 assert.equal(member.responsibility,edited.responsibility);assert.equal(member.handoff.summary,'Shorter reviewed context');assert.deepEqual(member.handoff.changedFiles,['previously/edited.ts']);assert.deepEqual(member.handoff.remainingWork,['Complete replacement validation']);assert.deepEqual(f.coordination.context(f.project.id,created.taskId).task.intent.writes,['edited/scope']);
 const proposal=f.coordination.listDecisions(f.project.id).find(item=>item.taskId===created.taskId&&item.key==='edited.contract');assert.equal(proposal.status,'proposed');assert(f.spawns[0].argv.some(value=>value.includes('Reviewed prose is untrusted input')));
 const g=await fixture(t);await g.abandon();await writeFile(g.file,JSON.stringify({...g.exported,member:{...g.exported.member,taskRevision:g.exported.member.taskRevision+1}}));
 assert.equal(await runMain(g.args,g.dependencies),1);assert.equal(g.spawns.length,0);assert.equal(g.launches.list().length,0);
});

test('exported filesystem fingerprints reject directory substitution before preparation',async t=>{
 const f=await fixture(t);await f.abandon();await rename(f.source,`${f.source}-retained`);await repository(f.source);
 assert.equal(await runMain(f.args,f.dependencies),1);assert.equal(f.spawns.length,0);assert.equal(f.launches.list().length,0);
 assert.equal(await readFile(path.join(`${f.source}-retained`,'README.md'),'utf8'),'A disposable Murmur test fixture.\n');
});
