import { assert } from '../protocol/index.js';
import type { CoordinationStore } from './store.js';

const definitions = [
  `CREATE TABLE murmur_groups_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)`,
  `CREATE TABLE work_groups (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, goal TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','closed')), createdAt INTEGER NOT NULL, createdBy TEXT NOT NULL, closedAt INTEGER)`,
  `CREATE TABLE group_members (id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES work_groups(id), projectId TEXT NOT NULL REFERENCES projects(id), sessionId TEXT NOT NULL REFERENCES sessions(id), taskId TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL CHECK(kind IN ('manual','managed','external')), responsibility TEXT NOT NULL, summary TEXT NOT NULL, handoff TEXT, native TEXT, nativeKey TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','left')), createdAt INTEGER NOT NULL, leftAt INTEGER)`,
  `CREATE UNIQUE INDEX group_active_session ON group_members(sessionId) WHERE state = 'active'`,
  `CREATE UNIQUE INDEX group_active_native ON group_members(nativeKey) WHERE state = 'active' AND nativeKey IS NOT NULL`,
  `CREATE INDEX group_members_group ON group_members(groupId, state)`,
  `CREATE TABLE group_invitations (id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES work_groups(id), inviteHash TEXT NOT NULL UNIQUE, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, consumedAt INTEGER, revokedAt INTEGER)`,
  `CREATE TABLE connection_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('external','managed')), caller TEXT NOT NULL, requestKey TEXT NOT NULL, requestDigest TEXT NOT NULL, payload TEXT NOT NULL, capabilityHash TEXT UNIQUE, pollSecretHash TEXT, sessionId TEXT REFERENCES sessions(id), taskId TEXT REFERENCES tasks(id), state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired')), revision INTEGER NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, decidedAt INTEGER, review TEXT, UNIQUE(caller,requestKey))`,
  `CREATE INDEX connection_requests_pending ON connection_requests(state, expiresAt)`,
  `CREATE TABLE external_grants (id TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE REFERENCES connection_requests(id), projectId TEXT NOT NULL REFERENCES projects(id), sessionId TEXT NOT NULL REFERENCES sessions(id), taskId TEXT NOT NULL REFERENCES tasks(id), memberId TEXT NOT NULL UNIQUE REFERENCES group_members(id), groupId TEXT NOT NULL REFERENCES work_groups(id), capabilityHash TEXT NOT NULL UNIQUE, workspaceRoot TEXT NOT NULL, workspaceFingerprint TEXT NOT NULL, canonicalPath TEXT NOT NULL, projectFingerprint TEXT NOT NULL, gitMarkerFingerprint TEXT, projectMode TEXT NOT NULL, sessionRevision INTEGER NOT NULL, nativeKey TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER, revokeReason TEXT, bridgeFirstSeenAt INTEGER, bridgeLastSeenAt INTEGER)`,
  `CREATE INDEX external_grant_deadlines ON external_grants(expiresAt, revokedAt)`,
  `CREATE TABLE external_grant_leases (grantId TEXT NOT NULL REFERENCES external_grants(id), leaseId TEXT NOT NULL REFERENCES leases(id), generation INTEGER NOT NULL, PRIMARY KEY(leaseId,generation))`,
  `CREATE INDEX external_grant_lease_owner ON external_grant_leases(grantId)`,
  `CREATE TABLE group_provenance (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), groupId TEXT NOT NULL REFERENCES work_groups(id), memberId TEXT REFERENCES group_members(id), requestId TEXT REFERENCES connection_requests(id), grantId TEXT REFERENCES external_grants(id), entityType TEXT NOT NULL, entityId TEXT NOT NULL, actor TEXT NOT NULL, createdAt INTEGER NOT NULL)`,
  `CREATE TABLE task_blocker_notes (taskId TEXT PRIMARY KEY REFERENCES tasks(id), taskRevision INTEGER NOT NULL, blocker TEXT, updatedBy TEXT NOT NULL, updatedAt INTEGER NOT NULL)`,
];
const normalize = (sql: string): string => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
export function initializeGroupsSchema(store: CoordinationStore): void {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const metadata = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='murmur_groups_schema'").get();
    if (!metadata) {
      for (const sql of definitions) {
        const name = sql.match(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/)![1]!;
        assert(!db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name), 'Unversioned group schema already exists.', 'INVALID_SCHEMA');
      }
      for (const sql of definitions) db.exec(sql);
      db.exec('INSERT INTO murmur_groups_schema VALUES (1,1)');
    }
    const rows = db.prepare('SELECT singleton,version FROM murmur_groups_schema').all();
    assert(rows.length === 1 && rows[0]!.singleton === 1, 'Invalid groups schema metadata.', 'INVALID_SCHEMA');
    assert(rows[0]!.version === 1, 'Unsupported groups schema version.', Number(rows[0]!.version) > 1 ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
    for (const sql of definitions) {
      const name = sql.match(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/)![1]!;
      const actual = db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name);
      assert(typeof actual?.sql === 'string' && normalize(actual.sql) === normalize(sql), 'Unrecognized groups schema.', 'INVALID_SCHEMA');
    }
    assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Groups database foreign keys are invalid.', 'INVALID_SCHEMA');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
