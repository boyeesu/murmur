import type { DatabaseSync } from 'node:sqlite';
import { assert } from '../protocol/index.js';
import { validateMaintenanceSchema } from './maintenance-schema.js';

function sessionSql(name: string, version: number): string {
  return `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
    tool TEXT NOT NULL, nativeId TEXT NOT NULL, instanceId TEXT NOT NULL,
    workspaceRoot TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
    createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL${version >= 2 ? `,
    credentialMode TEXT NOT NULL DEFAULT 'manual' CHECK(credentialMode IN ('manual','managed'${version >= 3 ? ",'external'" : ''}))` : ''},
    UNIQUE(projectId, tool, nativeId, instanceId)
  )`;
}
const normalized = (sql: string): string => sql.trim().replace(/;$/, '').replace(/"sessions"/, 'sessions').replace(/\s+/g, '');
function validate(db: DatabaseSync, version: number): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='sessions'").get();
  assert(typeof row?.sql === 'string' && normalized(row.sql) === normalized(sessionSql('sessions', version)), 'Unrecognized session schema; an automatic rewrite is unsafe.', 'SESSION_SCHEMA_INVALID');
  assert(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name='sessions'").get(), 'Session triggers require an explicit migration.', 'SESSION_SCHEMA_INVALID');
}
/** Foreign keys are disabled ONLY outside the rebuild transaction and restored on all exits. */
export function migrateSessions(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  assert(version >= 1 && version <= 4, 'Unsupported base schema version; rollback is unsupported.', version > 4 ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
  if (version === 4) validateMaintenanceSchema(db);
  validate(db, Math.min(version, 3));
  if (version >= 3) return;
  const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name='sessions' AND sql IS NOT NULL ORDER BY name").all();
  const before = db.prepare('SELECT rowid, * FROM sessions ORDER BY rowid').all();
  const schemaBefore = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name != 'sessions' ORDER BY type,name").all();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    assert(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys === 0, 'Cannot disable foreign keys inside a transaction.', 'SESSION_SCHEMA_INVALID');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Repeat validation under the write lock; another connection may have migrated since opening.
      assert(Number(db.prepare('PRAGMA user_version').get()!.user_version) === version, 'Concurrent schema change; reopen the database.', 'SESSION_SCHEMA_INVALID');
      validate(db, version);
      db.exec(sessionSql('sessions_v3_migration', 3));
      const columns = db.prepare('PRAGMA table_info(sessions)').all().map(row => `"${row.name}"`).join(',');
      db.exec(`INSERT INTO sessions_v3_migration (rowid,${columns}) SELECT rowid,${columns} FROM sessions`);
      db.exec('DROP TABLE sessions');
      db.exec('ALTER TABLE sessions_v3_migration RENAME TO sessions');
      for (const index of indexes) db.exec(index.sql as string);
      validate(db, 3);
      const after = db.prepare(`SELECT rowid,${columns} FROM sessions ORDER BY rowid`).all();
      assert(JSON.stringify(before) === JSON.stringify(after), 'Session rebuild did not preserve every row and credential.', 'SESSION_SCHEMA_INVALID');
      const schemaAfter = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name != 'sessions' ORDER BY type,name").all();
      assert(JSON.stringify(schemaBefore) === JSON.stringify(schemaAfter), 'Session rebuild changed dependent schema.', 'SESSION_SCHEMA_INVALID');
      assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Session rebuild failed full foreign-key validation.', 'SESSION_SCHEMA_INVALID');
      const check = db.prepare('PRAGMA integrity_check').all();
      assert(check.length === 1 && check[0]!.integrity_check === 'ok', 'Session rebuild failed database integrity validation.', 'SESSION_SCHEMA_INVALID');
      db.exec('PRAGMA user_version = 3; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
