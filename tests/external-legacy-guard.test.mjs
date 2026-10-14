import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptor, request } from '../packages/murmur/dist/cli/client.js';
import { stateIdentity, statePort } from '../packages/murmur/dist/daemon/config.js';
import { requireHumanEnvironment, readAgentConnection } from '../packages/murmur/dist/protocol/agent.js';
import { temporary } from './helpers.mjs';
const execute = promisify(execFile), cli = fileURLToPath(new URL('../packages/murmur/dist/cli/index.js', import.meta.url));
const markers = [ { MURMUR_EXTERNAL_MODE: '1' }, { MURMUR_EXTERNAL_CONNECTION: '{}' }, { MURMUR_EXTERNAL_MODE: '0' }, { MURMUR_EXTERNAL_UNKNOWN: '' }, { MURMUR_EXTERNAL_MODE: '1', MURMUR_EXTERNAL_CONNECTION: '{invalid}' } ];
const blocked = error => error.code === 'HUMAN_COMMAND_FORBIDDEN';

test('every external marker blocks legacy human descriptor and request before discovery or fetch', async t => {
  const root = await temporary(t), directory = path.join(root, 'state'); await mkdir(directory, { mode: 0o700 });
  const home = await realpath(directory), humanToken = 'fixture-human-only-token'.padEnd(43, '_');
  await writeFile(path.join(home, 'daemon.json'), JSON.stringify({ protocolVersion: 1, instanceId: randomUUID(), stateId: stateIdentity(home), port: statePort(home), token: humanToken }), { mode: 0o600 });
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw new Error('Human transport must not run'); });
  const original = { ...process.env };
  try {
    for (const marker of markers) {
      for (const key of Object.keys(process.env)) if (key.startsWith('MURMUR_AGENT_') || key.startsWith('MURMUR_EXTERNAL_')) delete process.env[key];
      Object.assign(process.env, marker);
      assert.throws(() => requireHumanEnvironment(), blocked);
      await assert.rejects(loadDescriptor(home), blocked);
      await assert.rejects(loadDescriptor(path.join(root, 'must-not-discover')), blocked);
      await assert.rejects(request(home, 'POST', '/v1/tasks/update', { taskId: 'unused', revision: 1, status: 'abandoned' }), blocked);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith('MURMUR_AGENT_') || key.startsWith('MURMUR_EXTERNAL_')) delete process.env[key];
    for (const [key, value] of Object.entries(original)) if (key.startsWith('MURMUR_AGENT_') || key.startsWith('MURMUR_EXTERNAL_')) process.env[key] = value;
  }
  assert.equal(fetched, 0);
});

test('legacy CLI namespaces fail closed under full and partial external markers', async t => {
  const root = await temporary(t);
  const base = { PATH: process.env.PATH, HOME: root, TMPDIR: root, MURMUR_HOME: path.join(root, 'do-not-read') };
  for (const marker of markers) {
    for (const args of [['status'], ['daemon', 'stop'], ['task', 'update', '--task', 'unused', '--revision', '1', '--status', 'abandoned'], ['group', '--help'], ['connect', '--help']]) {
      await assert.rejects(execute(process.execPath, [cli, ...args], { env: { ...base, ...marker }, timeout: 10000 }), error => {
        assert.equal(error.stdout, ''); const data = JSON.parse(error.stderr); assert.equal(data.error.code, 'HUMAN_COMMAND_FORBIDDEN'); return true;
      });
    }
  }
});

test('managed environment reader rejects mixed external markers without changing its strict contract', () => {
  const connection = { protocolVersion: 1, origin: 'http://127.0.0.1:23456', stateId: 'a'.repeat(64), launchId: 'launch', projectId: 'project', sessionId: 'session', taskId: 'task', agentToken: 'a'.repeat(43) };
  const env = { MURMUR_AGENT_MODE: '1', MURMUR_AGENT_CONNECTION: JSON.stringify(connection) };
  assert.deepEqual(readAgentConnection(env), connection);
  for (const marker of markers) assert.throws(() => readAgentConnection({ ...env, ...marker }), { code: 'AGENT_CONFIGURATION' });
});
