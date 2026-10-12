import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
import { request, loadDescriptor } from '../packages/murmur/dist/cli/client.js';
import { temporary, repository, git } from './helpers.mjs';
const execute=promisify(execFile);
const cli=fileURLToPath(new URL('../packages/murmur/dist/cli/index.js',import.meta.url));

test('two fake native CLIs launch automatically and exchange scoped coordination',async t=>{
  const root=await temporary(t), home=path.join(root,'state'), bin=path.join(root,'bin'), signals=path.join(root,'signals');
  await mkdir(bin); await mkdir(signals);
  const source=await repository(path.join(root,'source'));
  const original=git(source,'rev-parse','HEAD');
  const daemon=await startDaemon(home);
  let runs=[];
  try {
    const project=await request(home,'POST','/v1/projects',{root:source});
    const descriptor=await loadDescriptor(home);
    for(const tool of ['claude','codex']) {
      const code=`#!${process.execPath}
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const tool=${JSON.stringify(tool)};
if(process.argv.includes('--version')) { console.log(tool==='claude'?'2.1.247 (Claude Code)':'codex-cli 0.154.0'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('Usage: '+tool+' [PROMPT] --session-id --append-system-prompt --cd -C'); process.exit(0); }
(async()=>{
 const connection=JSON.parse(process.env.MURMUR_AGENT_CONNECTION);
 const invoke=(...args)=>JSON.parse(execFileSync(process.execPath,[${JSON.stringify(cli)},'agent',...args],{encoding:'utf8',env:process.env}));
 const context=invoke('context');
 invoke('intent','--revision',String(context.task.revision),'--data',JSON.stringify({writes:['src/'+tool+'.ts'],produces:[{key:'shared-fixture-contract',version:'v1',value:'202'}]}));
 fs.writeFileSync(path.join(${JSON.stringify(signals)},tool),context.task.id);
 const until=Date.now()+10000;
 while(!fs.existsSync(path.join(${JSON.stringify(signals)},tool==='claude'?'codex':'claude'))) { if(Date.now()>until)throw new Error('Other fake worker did not arrive');await new Promise(r=>setTimeout(r,50)); }
 const updated=invoke('context');
 let humanBlocked=false;
 try { execFileSync(process.execPath,[${JSON.stringify(cli)},'status'],{encoding:'utf8',env:process.env,stdio:['ignore','pipe','pipe']}); } catch(error) { humanBlocked=String(error.stderr).includes('HUMAN_COMMAND_FORBIDDEN'); }
 const result={tool,cwd:process.cwd(),taskId:connection.taskId,sessionId:connection.sessionId,alertKinds:updated.alerts.map(x=>x.kind),humanBlocked,hasHumanEnv:Boolean(process.env.MURMUR_HOME||process.env.MURMUR_ADMIN_TOKEN||process.env.MURMUR_SUPERVISOR_TOKEN),hasAgentCredential:Boolean(connection.agentToken),sessionArgument:process.argv.includes('--session-id')?process.argv[process.argv.indexOf('--session-id')+1]:null};
 console.log('MURMUR_FAKE_RESULT '+JSON.stringify(result));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
`;
      const filename=path.join(bin,tool); await writeFile(filename,code); await chmod(filename,0o755);
    }
    const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,MURMUR_HOME:home,MURMUR_ADMIN_TOKEN:descriptor.token,MURMUR_SUPERVISOR_TOKEN:'must-not-inherit'};
    runs=['claude','codex'].map(tool=>execute(process.execPath,[cli,'run',tool,'--project',project.id,'--title',`Fake ${tool} work`,'--request-id',randomUUID()],{env,timeout:45000,maxBuffer:1024*1024}));
    const completed=await Promise.all(runs);
    const results=completed.map(output=>JSON.parse(output.stdout.split('\n').find(line=>line.startsWith('MURMUR_FAKE_RESULT ')).slice('MURMUR_FAKE_RESULT '.length)));
    assert.notEqual(results[0].cwd,results[1].cwd);
    for(const result of results) {
      assert.notEqual(result.cwd,await realpath(source));
      assert(result.alertKinds.includes('duplicate_contract_producers'));
      assert.equal(result.humanBlocked,true);
      assert.equal(result.hasHumanEnv,false);
      assert.equal(result.hasAgentCredential,true);
    }
    const status=await request(home,'GET',`/v1/status?projectId=${project.id}`);
    assert.equal(status.launches.length,2);
    assert(status.launches.every(launch=>launch.state==='ended'));
    assert(status.tasks.every(task=>task.status==='active'));
    assert(status.sessions.every(session=>session.credentialMode==='managed'));
    const claude=status.launches.find(launch=>launch.tool==='claude');
    assert.equal(results.find(result=>result.tool==='claude').sessionArgument,claude.nativeSessionId);
    assert.equal(status.launches.find(launch=>launch.tool==='codex').nativeSessionId,null);
    for(const output of completed) assert(!output.stdout.includes(descriptor.token)&&!output.stderr.includes(descriptor.token));
    assert.equal(git(source,'rev-parse','HEAD'),original);
    assert.equal(git(source,'status','--porcelain'),'');
  } finally {await Promise.allSettled(runs);await daemon.close();}
});
