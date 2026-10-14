#!/usr/bin/env node
/** Explicit native integration test. Uses native-authored disposable history,
 * dummy credentials, an owned local static-response endpoint and fixture daemon.
 * No real model inference, user transcript lookup, or global native installation.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request } from '../packages/murmur/dist/cli/client.js';
import { exportExistingChatSetup } from '../packages/murmur/dist/adapters/existing-chat.js';

const cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const arg = process.argv.slice(2);
if (arg.length !== 2 || arg[0] !== '--claude' || !path.isAbsolute(arg[1])) throw new Error('Use --claude /absolute/executable.');
const binary = await realpath(arg[1]);
const root = await mkdtemp(path.join(await realpath(process.env.TMPDIR), 'murmur-connector-proof-'));
const children = new Set(), sockets = new Set();
let daemon, mock, interrupted = false, requests = 0;
const stop = () => { interrupted = true; for (const child of children) child.kill('SIGKILL'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const total = setTimeout(stop, 150000);
const report = { kind: 'native-connector-fixture', realModelCalls: false, realUserHistoryAccess: false, globalInstallation: false, nativeVersion: null, checks: {} };
try {
  for (const name of ['workspace','home','config','tmp','xdg-config','xdg-data','xdg-cache']) await mkdir(path.join(root,name), { mode: 0o700 });
  const workspace = path.join(root,'workspace'), state = path.join(root,'state');
  daemon = await startDaemon(state);
  const project = await request(state,'POST','/v1/projects',{root:workspace});
  mock = createServer({maxHeaderSize:8192,requestTimeout:2000,headersTimeout:2000}, (req,res) => {
    requests++;
    if (requests > 40) { req.destroy(); return; }
    let bytes = 0;
    req.on('error',()=>{}); res.on('error',()=>{});
    req.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)req.destroy();});
    req.on('end',()=>{
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404,{'content-type':'application/json'});res.end('{}');return; }
      const stream = [
        ['message_start',{type:'message_start',message:{id:'msg_'+randomUUID().replaceAll('-',''),type:'message',role:'assistant',model:'claude-opus-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}}}],
        ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
        ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'LOCAL STATIC FIXTURE'}}],
        ['content_block_stop',{type:'content_block_stop',index:0}],
        ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}}],
        ['message_stop',{type:'message_stop'}],
      ];
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'close'});
      res.end(stream.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n'));
    });
  });
  mock.maxConnections=8;
  mock.on('connection',socket=>{sockets.add(socket);socket.setTimeout(3000,()=>socket.destroy());socket.on('close',()=>sockets.delete(socket));});
  mock.on('clientError',(_e,socket)=>socket.destroy());
  mock.on('connect',(_req,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{mock.once('error',reject);mock.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${mock.address().port}`;
  const env={HOME:path.join(root,'home'),CLAUDE_CONFIG_DIR:path.join(root,'config'),TMPDIR:path.join(root,'tmp'),XDG_CONFIG_HOME:path.join(root,'xdg-config'),XDG_DATA_HOME:path.join(root,'xdg-data'),XDG_CACHE_HOME:path.join(root,'xdg-cache'),PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,SHELL:'/bin/sh',TERM:'dumb',ANTHROPIC_API_KEY:'DUMMY-MURMUR-CONNECTOR-FIXTURE',ANTHROPIC_BASE_URL:origin,HTTP_PROXY:origin,HTTPS_PROXY:origin,ALL_PROXY:origin,NO_PROXY:'127.0.0.1,localhost',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const bundle=await exportExistingChatSetup({tool:'claude',outputDirectory:path.join(root,'plugin'),stateDirectory:state,nodeExecutable:process.execPath,cliPath:cli,claudeExecutable:binary,env});
  assert.equal(bundle.exported,true); assert.equal(bundle.installed,false); assert.equal(bundle.connected,false); assert.equal(bundle.testedVersion,'2.1.247');
  const common=['--print','--verbose','--output-format','stream-json','--include-hook-events','--setting-sources','','--plugin-dir',path.join(root,'plugin'),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome'];
  const run = async (args) => {
    assert(!interrupted);
    const result=await new Promise(resolve=>{
      const child=spawn(binary,[...common,...args],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});children.add(child);
      let out='',err='',size=0,limited=false;
      const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
      for(const [stream,name] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{size+=chunk.length;if(size>256*1024){limited=true;child.kill('SIGKILL');}else if(name==='out')out+=chunk;else err+=chunk;});
      child.once('error',()=>{});
      child.once('close',(code,signal)=>{clearTimeout(timer);children.delete(child);resolve({code,signal,out,err,limited});});
    });
    assert.equal(result.code,0,'native fixture turn failed');assert(!result.limited);
    const rows=result.out.split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
    return {rows,init:rows.find(row=>row.type==='system'&&row.subtype==='init'),text:result.out};
  };
  const approve=async receipt=>{
    const review=await request(state,'POST','/v1/connections/review',{requestId:receipt.requestId,revision:receipt.revision});
    return request(state,'POST','/v1/connections/approve',{requestId:receipt.requestId,revision:review.revision,reviewDigest:review.reviewDigest,responsibility:receipt.responsibility});
  };
  const a=randomUUID(), b=randomUUID();
  await run(['--session-id',a,'/murmur:connect start Native connector proof | Own the API']);
  let pending=await request(state,'GET','/v1/connections/requests');
  const ra=pending.find(row=>row.native.nativeId===a);assert(ra&&ra.state==='pending','first native hook did not enroll');
  const aa=await approve(ra);report.checks.nativeStartRequestedHumanApproval=true;
  const refreshedA=await run(['--resume',a,'/murmur:connect refresh']);
  assert.equal(refreshedA.init.session_id,a);assert(refreshedA.text.includes('Own the API'));
  report.checks.resumeRetainsApprovedScope=true;
  const invite=randomBytes(32).toString('base64url');
  await request(state,'POST','/v1/groups/invite',{groupId:aa.group.id,inviteHash:createHash('sha256').update(invite).digest('hex')});
  await run(['--session-id',b,`/murmur:connect join ${invite} | Own the tests`]);
  pending=await request(state,'GET','/v1/connections/requests');const rb=pending.find(row=>row.native.nativeId===b);assert(rb&&rb.state==='pending');
  const ab=await approve(rb);assert.notEqual(aa.member.sessionId,ab.member.sessionId);assert.notEqual(aa.member.taskId,ab.member.taskId);
  const refreshedB=await run(['--resume',b,'/murmur:connect refresh']);assert(refreshedB.text.includes('Own the API')&&refreshedB.text.includes('Own the tests'));
  report.checks.twoSameWorkspaceChatsHaveSeparateOwners=true;
  const fork=await run(['--resume',a,'--fork-session','/murmur:connect status']);assert.notEqual(fork.init.session_id,a);assert(fork.text.includes('disconnected'));
  report.checks.forkDoesNotInheritParentGrant=true;
  const clear=await run(['--resume',a,'/clear']);assert.notEqual(clear.init.session_id,a);assert(clear.rows.some(row=>row.type==='conversation_reset'));
  const afterClear=await run(['--resume',clear.init.session_id,'/murmur:connect status']);assert(afterClear.text.includes('disconnected'));
  report.checks.clearDoesNotInheritParentGrant=true;
  const originalAgain=await run(['--resume',a,'/murmur:connect refresh']);assert(originalAgain.text.includes('Own the API'));
  report.checks.explicitOriginalResumeStillWorks=true;
  const left=await run(['--resume',a,'/murmur:connect leave']); assert(left.text.includes('Murmur connection left.')); assert(!left.text.includes('NATIVE_ACTION_FAILED'));
  const grants=await request(state,'GET','/v1/connections/grants?projectId='+project.id);
  assert(grants.find(g=>g.id===aa.grant.id).revokedAt!==null);assert.equal(grants.find(g=>g.id===ab.grant.id).revokedAt,null);
  const current=await request(state,'GET','/v1/status?projectId='+project.id);assert(current.tasks.some(t=>t.id===aa.member.taskId&&t.ownerSessionId===aa.member.sessionId));
  report.checks.leavePreservesTasksAndOtherGrant=true;
  report.mockRequests=requests;report.nativeVersion='2.1.247';report.success=true;
} catch(error) {
  report.success=false;report.failure=error instanceof assert.AssertionError?error.message:'fixture-failed';process.exitCode=1;
} finally {
  clearTimeout(total);process.off('SIGINT',stop);process.off('SIGTERM',stop);
  for(const child of children)child.kill('SIGKILL');
  await daemon?.close();
  if(mock)await new Promise(resolve=>{mock.close(resolve);for(const socket of sockets)socket.destroy();});
  await rm(root,{recursive:true,force:true});report.disposableStateRemoved=true;
}
console.log(JSON.stringify(report,null,2));
