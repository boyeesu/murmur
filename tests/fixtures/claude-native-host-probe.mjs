#!/usr/bin/env node
// Explicit opt-in native evidence. Disposable profile, static dummy localhost
// responses, normal permissions, no account or real transcript access.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2);
assert(args.length===2&&args[0]==='--claude'&&path.isAbsolute(args[1]),'Use --claude /absolute/executable');
const binary=await realpath(args[1]),root=await mkdtemp(path.join(await realpath(process.env.TMPDIR),'murmur-native-host-'));
const children=new Set(),sockets=new Set(),findings=[];let server,requests=0,turnRequests=0;
const observedTools=new Set();
const report={realModelCalls:false,userHistoryAccess:false,permissionBypass:false,probe:'actorless-mcp-post-hook',checks:[]};
const timer=setTimeout(()=>{for(const c of children)c.kill('SIGKILL')},140000);
try{
  for(const name of ['home','config','workspace','tmp','xdg-config','xdg-data','xdg-cache'])await mkdir(path.join(root,name),{mode:0o700});
  const log=path.join(root,'events.jsonl'),hook=path.join(root,'hook.mjs'),settings=path.join(root,'settings.json');
  await writeFile(hook,`import {appendFile} from 'node:fs/promises';let b='';for await(const c of process.stdin){b+=c;if(Buffer.byteLength(b)>16384)process.exit(0)}let e;try{e=JSON.parse(b)}catch{process.exit(0)}await appendFile(${JSON.stringify(log)},JSON.stringify({event:e.hook_event_name,id:e.session_id,cwd:e.cwd,tool:e.tool_name,toolId:e.tool_use_id,envId:process.env.CLAUDE_CODE_SESSION_ID,response:e.tool_response,input:e.tool_input})+'\\n',{mode:0o600});process.stdout.write('{}\\n');`,{mode:0o600});
  const plugin=path.join(root,'plugin'),formatter=path.join(root,'formatter.mjs');
  await mkdir(path.join(plugin,'.claude-plugin'),{recursive:true,mode:0o700});
  await writeFile(path.join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'murmur',version:'0.0.0'}),{mode:0o600});
  await writeFile(formatter,`import {createInterface} from 'node:readline';const lines=createInterface({input:process.stdin});for await(const line of lines){if(line.length>16384)process.exit(1);let r;try{r=JSON.parse(line)}catch{continue}if(r.id===undefined)continue;let result;if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'murmur-native-fixture',version:'0.0.0'}};else if(r.method==='tools/list')result={tools:[{name:'declare_intent',description:'Pure fixture formatter. No side effects or file/network access.',inputSchema:{type:'object',properties:{revision:{type:'integer',minimum:1},writes:{type:'array',items:{type:'string'}}},required:['revision'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]};else if(r.method==='tools/call'){const receipt={schemaVersion:1,status:'awaiting_native_bridge',operation:'intent',input:r.params.arguments};result={content:[{type:'text',text:JSON.stringify(receipt)}],structuredContent:receipt};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}`,{mode:0o600});
  await writeFile(path.join(plugin,'.mcp.json'),JSON.stringify({mcpServers:{murmur_requests:{command:process.execPath,args:[formatter]}}}),{mode:0o600});
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'",command=`${quote(process.execPath)} ${quote(hook)}`;
  await writeFile(settings,JSON.stringify({hooks:Object.fromEntries(['UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure'].map(e=>[e,[{hooks:[{type:'command',command,timeout:5}]}]]))}),{mode:0o600});
  server=createServer((req,res)=>{
    let size=0;const chunks=[];req.on('error',()=>{});res.on('error',()=>{});
    req.on('data',c=>{size+=c.length;if(size>1048576)req.destroy();else chunks.push(c)});
    req.on('end',()=>{
      const endpoint=new URL(req.url,'http://localhost').pathname;
      if(endpoint==='/v1/messages/count_tokens'){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1}');return}
      if(++requests>80||req.method!=='POST'||endpoint!=='/v1/messages'){res.writeHead(403,{'content-type':'application/json'});res.end('{}');return}
      let body;try{body=JSON.parse(Buffer.concat(chunks))}catch{res.writeHead(400);res.end();return}
      const result=body.messages?.flatMap(m=>Array.isArray(m.content)?m.content:[]).findLast(v=>v.type==='tool_result');
      const complete=++turnRequests>1;
      if(result){const text=JSON.stringify(result.content);findings.push({receiptObserved:text.includes('awaiting_native_bridge'),error:result.is_error===true})}
      for(const tool of body.tools??[])if(typeof tool.name==='string'&&tool.name.includes('murmur_requests'))observedTools.add(tool.name);
      const nativeTool=[...observedTools].find(name=>name.endsWith('declare_intent'));
      const input={revision:1,writes:['fixture.ts']};
      const stream=[
        ['message_start',{type:'message_start',message:{id:'msg_'+randomUUID().replaceAll('-',''),type:'message',role:'assistant',model:'claude-opus-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}}}],
        ['content_block_start',{type:'content_block_start',index:0,content_block:complete?{type:'text',text:''}:{type:'tool_use',id:'toolu_'+randomUUID().replaceAll('-',''),name:nativeTool??'mcp__plugin_murmur_murmur_requests__declare_intent',input:{}}}],
        ['content_block_delta',{type:'content_block_delta',index:0,delta:complete?{type:'text_delta',text:'LOCAL STATIC FIXTURE DONE'}:{type:'input_json_delta',partial_json:JSON.stringify(input)}}],
        ['content_block_stop',{type:'content_block_stop',index:0}],
        ['message_delta',{type:'message_delta',delta:{stop_reason:complete?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:3}}],
        ['message_stop',{type:'message_stop'}],
      ];
      res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});res.end(stream.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n'));
    });
  });
  server.maxConnections=8;server.on('connection',s=>{sockets.add(s);s.setTimeout(5000,()=>s.destroy());s.on('close',()=>sockets.delete(s))});server.on('connect',(_r,s)=>s.destroy());
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});
  const origin=`http://127.0.0.1:${server.address().port}`,workspace=path.join(root,'workspace');
  const env={HOME:path.join(root,'home'),CLAUDE_CONFIG_DIR:path.join(root,'config'),TMPDIR:path.join(root,'tmp'),XDG_CONFIG_HOME:path.join(root,'xdg-config'),XDG_DATA_HOME:path.join(root,'xdg-data'),XDG_CACHE_HOME:path.join(root,'xdg-cache'),PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,SHELL:'/bin/sh',TERM:'dumb',ANTHROPIC_API_KEY:'DUMMY-NATIVE-HOST-PROBE',ANTHROPIC_BASE_URL:origin,HTTP_PROXY:origin,HTTPS_PROXY:origin,ALL_PROXY:origin,NO_PROXY:'127.0.0.1,localhost',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const run=async(label,args)=>{
    const before=findings.length;turnRequests=0;
    const r=await new Promise(resolve=>{
      const c=spawn(binary,['--print','--verbose','--output-format','stream-json','--include-hook-events','--setting-sources','','--settings',settings,'--plugin-dir',plugin,'--no-chrome',...args],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});children.add(c);let out='',err='',size=0;
      const timeout=setTimeout(()=>c.kill('SIGKILL'),20000);
      for(const[s,key]of[[c.stdout,'out'],[c.stderr,'err']])s.on('data',b=>{size+=b.length;if(size>262144)c.kill('SIGKILL');else if(key==='out')out+=b;else err+=b});
      c.once('close',(code,signal)=>{clearTimeout(timeout);children.delete(c);resolve({code,signal,out,err})});
    });
    const rows=r.out.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}),init=rows.find(r=>r.type==='system'&&r.subtype==='init'),final=rows.findLast(r=>r.type==='result'),observations=findings.slice(before);
    report.checks.push({label,exitCode:r.code,nativeId:init?.session_id,observations,formatterReceiptObserved:observations.some(o=>o.receiptObserved&&!o.error),permissionDenial:Boolean(final?.permission_denials?.length),error:final?.is_error?String(final.result??final.errors??'').slice(0,500):undefined,stderrEmpty:!r.err});
    return init?.session_id;
  };
  const a=randomUUID(),b=randomUUID();
  await run('fresh-a',['--session-id',a,'Run the read-only identity fixture.']);
  await run('fresh-b',['--session-id',b,'Run the read-only identity fixture.']);
  await run('resume-a',['--resume',a,'Run the read-only identity fixture again.']);
  await run('fork-a',['--resume',a,'--fork-session','Run the read-only identity fixture in this fork.']);
  const clear=await run('clear-a',['--resume',a,'/clear']);
  if(clear&&clear!==a)await run('after-clear',['--resume',clear,'Run the read-only identity fixture after clear.']);
  const rows=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  report.hooks=rows.map(e=>({event:e.event,id:e.id,tool:e.tool,toolId:e.toolId,envId:e.envId??null,envMatchesEvent:e.envId===e.id,cwdMatchesFixture:e.cwd===workspace,response:e.response,input:e.input}));report.mockRequests=requests;report.observedTools=[...observedTools];report.postToolUseObserved=rows.some(e=>e.event==='PostToolUse');report.publicationEnabled=false;report.blocker=report.postToolUseObserved?'post-result-contract-review-required':'normal-native-permission-denied-before-PostToolUse';
}catch(error){report.failure=error?.code??error?.name??'fixture-failed';process.exitCode=1}
finally{clearTimeout(timer);for(const c of children)c.kill('SIGKILL');if(server)await new Promise(r=>{server.close(r);for(const s of sockets)s.destroy()});await rm(root,{recursive:true,force:true});report.disposableStateRemoved=true}
console.log(JSON.stringify(report,null,2));
