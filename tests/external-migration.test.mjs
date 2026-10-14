import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoordinationStore } from '../packages/murmur/dist/storage/store.js';
import { CoordinationService } from '../packages/murmur/dist/core/coordination.js';
import { GroupsService } from '../packages/murmur/dist/core/groups.js';
import { temporary, mutation } from './helpers.mjs';
function downgrade(db, version) {
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='sessions'").get().sql.replace(/^CREATE TABLE "?sessions"?/, 'CREATE TABLE sessions_old').replace(",'external'", '');
  const indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='sessions' AND sql IS NOT NULL").all();
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  db.exec(sql);
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name).join(',');
  db.exec(`INSERT INTO sessions_old(rowid,${columns}) SELECT rowid,${columns} FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_old RENAME TO sessions;`);
  for (const index of indexes) db.exec(index.sql);
  if (version === 1) db.exec('ALTER TABLE sessions DROP COLUMN credentialMode');
  db.exec(`PRAGMA user_version=${version}; COMMIT; PRAGMA foreign_keys=ON`);
}
function seed(store) {
  const project = store.registerProject({ root: '/migration', canonicalPath: '/migration', mode: 'advisory', caseSensitive: true, fingerprint: '1:2:3' }, mutation('project', {}));
  const registered = store.registerSession({ projectId: project.id, tool: 'manual', nativeId: 'native', instanceId: 'i', workspaceRoot: '/migration' }, mutation('session', {}));
  const task = store.createTask({ projectId: project.id, sessionId: registered.session.id, title: 'Preserved task', featureKey: 'exclusive' }, mutation('task', {}));
  store.db.exec('CREATE TABLE custom_extension (id INTEGER PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,taskId TEXT REFERENCES tasks(id),value BLOB); CREATE INDEX custom_session_index ON sessions(workspaceRoot);');
  store.db.prepare('INSERT INTO custom_extension VALUES (1,?,?,?)').run(registered.session.id, task.id, Buffer.from([0, 255, 3]));
  store.db.prepare('UPDATE sessions SET rowid=91 WHERE id=?').run(registered.session.id);
  return { project, registered, task };
}
for (const version of [1, 2]) test(`base v${version} rebuild preserves rowids, credentials, complete extension state and foreign keys`, async t => {
  const root = await temporary(t), filename = path.join(root, 'db.sqlite');
  const original = new CoordinationStore(filename), f = seed(original);
  const coordination = new CoordinationService(original), groups = new GroupsService(original, coordination);
  const group = groups.create({ projectId: f.project.id, title: 'Existing group' }, { kind: 'human' }, mutation('group', {}));
  groups.addExisting({ groupId: group.id, sessionId: f.registered.session.id, taskId: f.task.id, responsibility: 'Existing manual owner', handoff: { summary: 'Preserved reviewed handoff', writes: ['original'], blocker: 'Retained blocker', decisions: [{ key: 'preserved', version: '1', value: 'value', rationale: 'reviewed' }] } }, { kind: 'human' }, mutation('add', {}));
  downgrade(original.db, version);
  const tables = original.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='sessions'").all().map(row => row.name);
  const rows = Object.fromEntries(tables.map(name => [name, original.db.prepare(`SELECT * FROM "${name}"`).all()]));
  const sessions = original.db.prepare('SELECT rowid,* FROM sessions').all();
  const schemas = original.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name!='sessions' ORDER BY type,name").all();
  original.close();
  const migrated = new CoordinationStore(filename); t.after(() => migrated.close());
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(migrated.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(migrated.db.prepare('SELECT rowid FROM sessions').get().rowid, 91);
  assert.equal(migrated.authenticateSession(f.registered.token).id, f.registered.session.id);
  const after = migrated.db.prepare('SELECT rowid,* FROM sessions').all().map(row => version === 1 ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'credentialMode')) : row);
  assert.deepEqual(after.map(row => ({ ...row })), sessions.map(row => ({ ...row })));
  for (const name of tables) assert.deepEqual(migrated.db.prepare(`SELECT * FROM "${name}"`).all(), rows[name]);
  assert.deepEqual(migrated.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name!='sessions' ORDER BY type,name").all(), schemas);
  assert(migrated.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='custom_session_index'").get());
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  const session = migrated.session(f.registered.session.id); assert.equal(session.credentialMode, 'manual');
  migrated.db.prepare("UPDATE sessions SET credentialMode='external' WHERE id=?").run(session.id);
  assert.equal(migrated.authenticateSession(f.registered.token), undefined);
});

test('base migration rejects unknown columns, triggers, newer versions and rolls back full validation failures', async t => {
  const root = await temporary(t);
  for (const scenario of ['column','trigger','newer','invalid-fk']) {
    const filename = path.join(root, `${scenario}.sqlite`), store = new CoordinationStore(filename); seed(store); downgrade(store.db, 2);
    if (scenario === 'column') store.db.exec('ALTER TABLE sessions ADD COLUMN futureAuthority TEXT');
    if (scenario === 'trigger') store.db.exec('CREATE TRIGGER session_trigger AFTER UPDATE ON sessions BEGIN SELECT 1; END');
    if (scenario === 'newer') store.db.exec('PRAGMA user_version=9');
    if (scenario === 'invalid-fk') store.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO custom_extension VALUES(2,'missing-session',NULL,NULL); PRAGMA foreign_keys=ON");
    const before = store.db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(), sessions = store.db.prepare('SELECT rowid,* FROM sessions').all(); store.close();
    assert.throws(() => new CoordinationStore(filename), error => ['SESSION_SCHEMA_INVALID','SCHEMA_TOO_NEW'].includes(error.code));
    const check = new DatabaseSync(filename);
    assert.deepEqual(check.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(), before);
    assert.deepEqual(check.prepare('SELECT rowid,* FROM sessions').all(), sessions);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, scenario === 'newer' ? 9 : 2);
    assert(!check.prepare("SELECT 1 FROM sqlite_schema WHERE name='sessions_v3_migration'").get()); check.close();
  }
});

test('groups schema is additive independently versioned and fails closed for partial or newer schemas', t => {
  const store = new CoordinationStore(':memory:'); t.after(() => store.close());
  const coordination = new CoordinationService(store); new GroupsService(store, coordination);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.db.prepare('SELECT version FROM murmur_groups_schema').get().version, 1);
  store.db.exec('UPDATE murmur_groups_schema SET version=2');
  assert.throws(() => new GroupsService(store, coordination), { code: 'SCHEMA_TOO_NEW' });
  store.db.exec('UPDATE murmur_groups_schema SET version=1; DROP INDEX group_active_session');
  assert.throws(() => new GroupsService(store, coordination), { code: 'INVALID_SCHEMA' });
});

test('migration restores foreign-key enforcement on rollback, including dependent FK violations', async t => {
  const { migrateSessions } = await import('../packages/murmur/dist/storage/session-migration.js');
  const store = new CoordinationStore(':memory:'); t.after(() => store.close()); seed(store); downgrade(store.db, 2);
  store.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO custom_extension VALUES(2,'missing',NULL,NULL); PRAGMA foreign_keys=ON");
  assert.throws(() => migrateSessions(store.db), { code: 'SESSION_SCHEMA_INVALID' });
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.throws(() => store.db.exec("INSERT INTO custom_extension VALUES(3,'missing',NULL,NULL)"), /FOREIGN KEY/);
});
