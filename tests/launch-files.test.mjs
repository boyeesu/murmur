import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, lstat, readdir, symlink, unlink } from 'node:fs/promises';
import { createLaunchFiles, applyLaunchFiles } from '../packages/murmur/dist/adapters/launch-files.js';
import { parseRunArguments } from '../packages/murmur/dist/cli/run.js';
import { temporary } from './helpers.mjs';
function preparation(tool,root) {
  const id=randomUUID();
  return {launch:{id,tool,workspaceRoot:root,nativeSessionId:tool==='claude'?randomUUID():null},agent:{protocolVersion:1,origin:'http://127.0.0.1:32123',stateId:'a'.repeat(64),launchId:id,projectId:'project',sessionId:'session',taskId:'task',agentToken:'a'.repeat(43)},supervisor:{supervisorToken:'b'.repeat(43)},briefing:'fixture'};
}
test('Claude launch configs contain env references and advisory hooks, never credentials',async t=>{
  const root=await temporary(t), workspace=path.join(root,'workspace'); await mkdir(workspace);
  const prepared=preparation('claude',workspace);
  const files=await createLaunchFiles(prepared,{bridge:'mcp',contextHooks:true,temporaryRoot:root,nodeExecutable:process.execPath,cliPath:path.resolve('packages/murmur/dist/cli/index.js')});
  const mcp=JSON.parse(await readFile(path.join(files.directory,'mcp.json'),'utf8'));
  const server=mcp.mcpServers[files.serverName];
  assert.equal(server.env.MURMUR_AGENT_CONNECTION,'${MURMUR_AGENT_CONNECTION}');
  assert.equal(server.env.MURMUR_AGENT_MODE,'${MURMUR_AGENT_MODE}');
  assert.deepEqual(server.args.slice(-2),['mcp','serve']);
  const hooks=JSON.parse(await readFile(path.join(files.directory,'context-hooks.json'),'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks),['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse']);
  assert(hooks.hooks.PreToolUse[0].hooks[0].command.includes('hook claude --event PreToolUse'));
  const text=JSON.stringify({mcp,hooks,args:files.nativeArguments,env:files.environment});
  assert(!text.includes(prepared.agent.agentToken)); assert(!text.includes(prepared.supervisor.supervisorToken));
  assert(!text.includes('permissionDecision')&&!text.includes('bypass')&&!text.includes('permissions'));
  assert.equal((await stat(files.directory)).mode&0o077,0);
  assert.equal((await stat(path.join(files.directory,'mcp.json'))).mode&0o077,0);
  assert.equal(files.environment.MURMUR_HOOK_WORKSPACE,workspace);
  const cleaned=await files.cleanup(); assert.equal(cleaned.retained.length,0);
  await assert.rejects(lstat(files.directory),{code:'ENOENT'});
  assert.deepEqual(await readdir(workspace),[]);
});
test('Codex MCP forwards names through env_vars and never changes native permissions',async t=>{
  const root=await temporary(t), workspace=path.join(root,'workspace'); await mkdir(workspace);
  const files=await createLaunchFiles(preparation('codex',workspace),{bridge:'mcp',temporaryRoot:root});
  const values=new Map();
  for(let index=0;index<files.nativeArguments.length;index+=2) {
    assert.equal(files.nativeArguments[index],'-c');
    const argument=files.nativeArguments[index+1], equals=argument.indexOf('=');
    values.set(argument.slice(0,equals),JSON.parse(argument.slice(equals+1)));
  }
  assert.deepEqual(values.get(`mcp_servers.${files.serverName}.env_vars`),['MURMUR_AGENT_MODE','MURMUR_AGENT_CONNECTION']);
  assert.equal(values.get(`mcp_servers.${files.serverName}.cwd`),workspace);
  assert(!files.nativeArguments.join(' ').includes('hooks.'));
  const invocation=applyLaunchFiles({executable:'codex',args:['--cd',workspace,'prompt'],cwd:workspace,env:{MURMUR_AGENT_MODE:'1'}},files);
  assert.deepEqual(invocation.args.slice(-3),['--cd',workspace,'prompt']);
  await files.cleanup();
});
test('changed or substituted config files are retained without touching targets',async t=>{
  const root=await temporary(t), workspace=path.join(root,'workspace'); await mkdir(workspace);
  const files=await createLaunchFiles(preparation('claude',workspace),{bridge:'mcp',temporaryRoot:root});
  const filename=path.join(files.directory,'mcp.json'); await writeFile(filename,'user changed this');
  assert((await files.cleanup()).retained.includes(filename)); assert.equal(await readFile(filename,'utf8'),'user changed this');
  const second=await createLaunchFiles(preparation('claude',workspace),{bridge:'mcp',temporaryRoot:root});
  const target=path.join(root,'other-file'); await writeFile(target,'do not change');
  await unlink(path.join(second.directory,'mcp.json')); await symlink(target,path.join(second.directory,'mcp.json'));
  assert((await second.cleanup()).retained.length>0); assert.equal(await readFile(target,'utf8'),'do not change');
});
test('dynamic hook cache survives conservative cleanup and unsafe env injection is rejected',async t=>{
  const root=await temporary(t), workspace=path.join(root,'workspace'); await mkdir(workspace);
  const files=await createLaunchFiles(preparation('claude',workspace),{contextHooks:true,temporaryRoot:root});
  const cache=path.join(files.environment.MURMUR_HOOK_STATE_DIR,'cache.json'); await writeFile(cache,'{}',{mode:0o600});
  assert((await files.cleanup()).retained.length>0); assert.equal(await readFile(cache,'utf8'),'{}');
  assert.throws(()=>applyLaunchFiles({executable:'node',args:[],cwd:workspace,env:{}},{...files,environment:{MURMUR_SUPERVISOR_TOKEN:'bad'}}));
});
test('run flags preserve CLI defaults and unverified hook setup fails before config writes',async t=>{
  assert.deepEqual(parseRunArguments(['claude','--project','p','--title','work']),{tool:'claude',projectId:'p',title:'work'});
  assert.equal(parseRunArguments(['claude','--project','p','--title','work','--bridge','mcp','--context-hooks']).contextHooks,true);
  assert.throws(()=>parseRunArguments(['claude','--project','p','--title','work','--bridge','unknown']));
  const root=await temporary(t);
  await assert.rejects(createLaunchFiles(preparation('codex',root),{contextHooks:true,temporaryRoot:root}),error=>error.code==='NATIVE_HOOK_CONFIG_UNVERIFIED');
  assert.deepEqual(await readdir(root),[]);
});
