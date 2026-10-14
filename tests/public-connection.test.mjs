import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, symlink, unlink, rename, chmod, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { temporary } from './helpers.mjs';
import { publishPublicConnection, validatePublicConnection } from '../packages/murmur/dist/daemon/connection.js';
import { startDaemon } from '../packages/murmur/dist/daemon/server.js';
const metadata = () => ({ protocolVersion: 1, origin: 'http://127.0.0.1:29999', stateId: 'a'.repeat(64), instanceId: randomUUID() });
async function privateDirectory(t) { const directory = path.join(await temporary(t), 'state'); await mkdir(directory, { mode: 0o700 }); return realpath(directory); }
const insecure = error => error.code === 'INSECURE_CONNECTION';

test('public connection descriptor has only location metadata and private permissions', async t => {
  const directory = await privateDirectory(t), value = metadata();
  const owner = await publishPublicConnection(directory, value);
  const filename = path.join(directory, 'connection.json');
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), value);
  assert.equal((await stat(filename)).mode & 0o077, 0);
  assert.equal(await owner.release(), true);
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
});

test('public connection rejects unexpected credentials and noncanonical destinations', () => {
  for (const origin of ['https://127.0.0.1:29999', 'http://localhost:29999', 'http://127.0.0.1:29999/', 'http://127.1:29999', 'http://127.0.0.1:29999?x=1', 'http://user@127.0.0.1:29999', ' http://127.0.0.1:29999']) {
    assert.throws(() => validatePublicConnection({ ...metadata(), origin }), insecure);
  }
  assert.throws(() => validatePublicConnection({ ...metadata(), token: 'not-public' }), insecure);
  assert.throws(() => validatePublicConnection({ ...metadata(), protocolVersion: 999 }), insecure);
});

test('publishing refuses unknown files and symlinks without touching their contents', async t => {
  const directory = await privateDirectory(t), filename = path.join(directory, 'connection.json');
  const bytes = '{"token":"unrelated private data"}';
  await writeFile(filename, bytes, { mode: 0o600 });
  await assert.rejects(publishPublicConnection(directory, metadata()), insecure);
  assert.equal(await readFile(filename, 'utf8'), bytes);
  await unlink(filename);
  const target = path.join(directory, 'unrelated.json');
  await writeFile(target, bytes, { mode: 0o600 });
  await symlink(target, filename);
  await assert.rejects(publishPublicConnection(directory, metadata()), insecure);
  assert.equal(await readFile(target, 'utf8'), bytes);
});

test('descriptor cleanup preserves modified files and replacement service ownership', async t => {
  const directory = await privateDirectory(t), first = metadata();
  const owner = await publishPublicConnection(directory, first);
  const replacement = await publishPublicConnection(directory, { ...first, instanceId: randomUUID() });
  assert.equal(await owner.release(), false);
  const filename = path.join(directory, 'connection.json');
  const changed = JSON.stringify({ ...first, instanceId: randomUUID() });
  await writeFile(filename, changed);
  assert.equal(await replacement.release(), false);
  assert.equal(await readFile(filename, 'utf8'), changed);
});

test('unsafe directory and descriptor substitutions are retained', async t => {
  const directory = await privateDirectory(t), value = metadata();
  const owner = await publishPublicConnection(directory, value);
  await rename(directory, `${directory}-original`);
  await mkdir(directory, { mode: 0o700 });
  const filename = path.join(directory, 'connection.json');
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  assert.equal(await owner.release(), false);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), value);
  await chmod(filename, 0o644);
  await assert.rejects(publishPublicConnection(directory, value), insecure);
});

test('daemon publishes no human authority and removes only its own connection descriptor', async t => {
  const directory = path.join(await temporary(t), 'state');
  let daemon = await startDaemon(directory);
  try {
    const publicFile = path.join(directory, 'connection.json');
    const publicValue = JSON.parse(await readFile(publicFile, 'utf8'));
    const human = JSON.parse(await readFile(path.join(directory, 'daemon.json'), 'utf8'));
    assert.deepEqual(Object.keys(publicValue).sort(), ['instanceId', 'origin', 'protocolVersion', 'stateId']);
    assert.equal(publicValue.origin, `http://127.0.0.1:${daemon.port}`);
    assert.equal(publicValue.instanceId, daemon.instanceId);
    assert.equal(publicValue.stateId, human.stateId);
    assert(!JSON.stringify(publicValue).includes(human.token));
    await daemon.close();
    await assert.rejects(readFile(publicFile), { code: 'ENOENT' });
    daemon = await startDaemon(directory);
    const restarted = JSON.parse(await readFile(publicFile, 'utf8'));
    assert.equal(restarted.stateId, publicValue.stateId);
    assert.notEqual(restarted.instanceId, publicValue.instanceId);
  } finally { await daemon.close(); }
});
