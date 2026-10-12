import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { temporary, mutation } from './helpers.mjs';

function register(store) {
  const data={root:'/migration',canonicalPath:'/migration',mode:'advisory',caseSensitive:true};
  const project=store.registerProject(data,mutation('project',data));
  const input={projectId:project.id,tool:'manual',nativeId:'old',instanceId:'one',workspaceRoot:'/migration'};
  return store.registerSession(input,mutation('session',input));
}

test('schema v1 sessions migrate to explicit manual mode without losing credentials', async t=>{
  const root=await temporary(t), filename=path.join(root,'state.sqlite');
  const original=new CoordinationStore(filename);
  const {session,token}=register(original);
  original.db.exec('ALTER TABLE sessions DROP COLUMN credentialMode; PRAGMA user_version=1;');
  original.close();
  const migrated=new CoordinationStore(filename); t.after(()=>migrated.close());
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,2);
  assert.equal(migrated.authenticateSession(token).id,session.id);
  assert.equal(migrated.session(session.id).credentialMode,'manual');
  assert.equal(migrated.heartbeat(session.id,1,mutation('heartbeat',{sessionId:session.id,revision:1})).revision,2);
});

test('managed credentials fail closed without lifecycle metadata', t=>{
  const store=new CoordinationStore(':memory:',()=>1000); t.after(()=>store.close());
  const {session,token}=register(store);
  store.db.prepare("UPDATE sessions SET credentialMode='managed' WHERE id=?").run(session.id);
  assert.equal(store.authenticateSession(token),undefined);
  store.db.exec('CREATE TABLE murmur_launches(sessionId TEXT,state TEXT,expiresAt INTEGER)');
  assert.equal(store.authenticateSession(token),undefined);
  store.db.prepare('INSERT INTO murmur_launches VALUES(?,?,?)').run(session.id,'claimed',1001);
  assert.equal(store.authenticateSession(token).id,session.id);
  store.db.prepare('UPDATE murmur_launches SET expiresAt=?').run(1000);
  assert.equal(store.authenticateSession(token),undefined);
  store.db.prepare("UPDATE murmur_launches SET state='ended',expiresAt=99999").run();
  assert.equal(store.authenticateSession(token),undefined);
});
