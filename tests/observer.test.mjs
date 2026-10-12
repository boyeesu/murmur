import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { WorkspaceObserver } from '../packages/murmur/dist/daemon/observer.js';
import { mutation } from './helpers.mjs';

function setup(t) {
  const store = new CoordinationStore(':memory:');
  const identity = { root:'/fixture', canonicalPath:'/fixture/.git', mode:'git', caseSensitive:true };
  const project = store.registerProject(identity, mutation('register', identity));
  let rows = [];
  const observer = new WorkspaceObserver(store, { reconcile: async () => structuredClone(rows) });
  t.after(async () => { await observer.close(); store.close(); });
  return { store, observer, project, setRows: value => { rows = value; } };
}
const row = (id, root, paths) => ({ workspaceId:id, root, identityValid:true, changedPaths:paths.map(path=>({path,status:' M'})), overlaps:[], observation:'Observed changes, actor unknown.' });

test('continuous observation persists snapshots but emits events only for actual changes', async t => {
  const f=setup(t);
  f.setRows([row('a','/a',['src/auth.ts'])]);
  const mutationCount=f.store.db.prepare('SELECT count(*) AS count FROM mutations').get().count;
  await f.observer.sampleNow();
  const events=f.store.events(f.project.id,0).filter(e=>e.type==='workspace.observed');
  assert.equal(events.length,1);
  await f.observer.sampleNow();
  assert.equal(f.store.events(f.project.id,0).filter(e=>e.type==='workspace.observed').length,1);
  assert.equal(f.observer.list(f.project.id)[0].actor,'unknown');
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM mutations').get().count,mutationCount);
  f.setRows([row('a','/a',[])]);
  await f.observer.sampleNow();
  assert.equal(f.store.events(f.project.id,0).filter(e=>e.type==='workspace.observed').length,2);
});

test('observed cross-workspace overlap is evidence, not inferred duplicate ownership', async t => {
  const f=setup(t);
  f.setRows([row('a','/a',['src/Auth.ts']),row('b','/b',['src/auth.ts']),row('c','/c',['unrelated.ts'])]);
  await f.observer.sampleNow();
  const alerts=f.observer.alerts(f.project.id);
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].kind,'observed_workspace_overlap');
  assert.equal(alerts[0].dismissible,false);
  assert.equal(alerts[0].evidence.actor,'unknown');
  f.setRows([row('a','/a',[]),row('b','/b',['src/auth.ts']),row('c','/c',['unrelated.ts'])]);
  await f.observer.sampleNow();
  assert.equal(f.observer.alerts(f.project.id).length,0);
});

test('observation bounds paths and reports failed identity checks rather than cleanliness', async t => {
  const f=setup(t);
  f.setRows([row('a','/a',Array.from({length:120},(_,i)=>`src/${i}.ts`)),{...row('b','/b',[]),identityValid:false}]);
  await f.observer.sampleNow();
  const rows=f.observer.list(f.project.id);
  assert.equal(rows[0].changedPaths.length,100);
  assert.equal(rows[0].truncated,true);
  assert.equal(rows[1].identityValid,false);
});

test('stopped observers do not access the database on a later tick', async t => {
  const f=setup(t);
  await f.observer.close();
  f.setRows([row('a','/a',['file.ts'])]);
  await f.observer.sampleNow();
  assert.equal(f.observer.list(f.project.id).length,0);
});

test('stale observation is not presented as current overlap evidence', async t => {
  const f=setup(t);
  f.setRows([row('a','/a',['same.ts']),row('b','/b',['same.ts'])]);
  await f.observer.sampleNow();
  assert.equal(f.observer.alerts(f.project.id).length,1);
  const after=f.store.now()+31000;
  f.store.now=()=>after;
  assert(f.observer.list(f.project.id).every(item=>item.stale));
  assert.equal(f.observer.alerts(f.project.id).length,0);
});
