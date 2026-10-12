import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartupPrompts } from '../packages/murmur/dist/adapters/drivers.js';
import { validateAgentConnection, validateSupervisorConnection, readAgentConnection, requireHumanEnvironment } from '../packages/murmur/dist/protocol/agent.js';
const agent={protocolVersion:1,origin:'http://127.0.0.1:32123',stateId:'a'.repeat(64),launchId:'launch',projectId:'project',sessionId:'session',taskId:'task',agentToken:'x'.repeat(43)};

test('managed origins must retain exact canonical loopback spelling',()=>{
  assert.equal(validateAgentConnection(agent).origin,agent.origin);
  for(const origin of ['http://2130706433:32123','http://127.1:32123','http://127.0.0.1:32123/a/..','http://127.0.0.1:32123/',' http://127.0.0.1:32123','http://127.0.0.1:32123?token=x','https://127.0.0.1:32123','http://user:secret@127.0.0.1:32123','http://example.com:32123']) {
    assert.throws(()=>validateAgentConnection({...agent,origin}));
    assert.throws(()=>validateSupervisorConnection({protocolVersion:1,origin,stateId:agent.stateId,launchId:'launch',supervisorToken:'y'.repeat(43)}));
  }
});

test('any partial managed environment prevents human credential discovery',()=>{
  assert.throws(()=>requireHumanEnvironment({MURMUR_AGENT_MODE:'1'}),error=>error.code==='HUMAN_COMMAND_FORBIDDEN');
  assert.throws(()=>requireHumanEnvironment({MURMUR_AGENT_CONNECTION:''}),error=>error.code==='HUMAN_COMMAND_FORBIDDEN');
  assert.throws(()=>readAgentConnection({MURMUR_AGENT_MODE:'1'}),error=>error.code==='AGENT_CONFIGURATION');
  assert.deepEqual(readAgentConnection({MURMUR_AGENT_MODE:'1',MURMUR_AGENT_CONNECTION:JSON.stringify(agent)}),agent);
});

test('startup guidance requests structured intent and cooperative refresh without exposing credentials',()=>{
  const preparation={launch:{title:'Implement an endpoint',workspaceRoot:'/workspace',baseSha:'a'.repeat(40)},agent:{agentToken:'x'.repeat(43)},supervisor:{supervisorToken:'y'.repeat(43)},briefing:'Related work is pending.'};
  const prompts=buildStartupPrompts(preparation,{nodeExecutable:'/bin/node',cliPath:'/app/cli.js'});
  assert(prompts.instructions.includes('intent and check-plan'));
  assert(prompts.instructions.includes('there is no per-turn push guarantee'));
  assert(prompts.instructions.includes('human accepts'));
  assert(!JSON.stringify(prompts).includes(preparation.agent.agentToken));
  assert(!JSON.stringify(prompts).includes(preparation.supervisor.supervisorToken));
});
