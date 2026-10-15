import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assert } from '../protocol/index.js';

export const MAINTENANCE_SCHEMA_VERSION = 1;
const definitions = [
  'CREATE TABLE murmur_maintenance_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
  'CREATE TABLE maintenance_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision > 0))',
  'CREATE TABLE manual_credentials (sessionId TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER NOT NULL CHECK(revision > 0), revokedAt INTEGER, changedAt INTEGER NOT NULL)',
  'CREATE TABLE retired_session_credentials (tokenHash TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), retiredAt INTEGER NOT NULL)',
  'CREATE TABLE mutation_tombstones (caller TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, createdAt INTEGER NOT NULL, prunedAt INTEGER NOT NULL, PRIMARY KEY(caller,key))',
  'CREATE TABLE event_retention (projectId TEXT PRIMARY KEY REFERENCES projects(id), prunedThrough INTEGER NOT NULL, prunedCount INTEGER NOT NULL, prunedAt INTEGER NOT NULL)',
  'CREATE TABLE context_retention (projectId TEXT PRIMARY KEY REFERENCES projects(id), before INTEGER NOT NULL, prunedCount INTEGER NOT NULL, prunedAt INTEGER NOT NULL)',
  'CREATE TABLE request_redactions (requestId TEXT PRIMARY KEY, requestDigest TEXT NOT NULL, originalPayloadDigest TEXT NOT NULL, redactedAt INTEGER NOT NULL)',
  'CREATE INDEX mutation_tombstone_age ON mutation_tombstones(prunedAt)',
];
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
/** Validate before opening a v4 DB; missing metadata must never be auto-repaired. */
export function validateMaintenanceSchema(db: DatabaseSync): void {
  assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='murmur_maintenance_schema'").get(), 'Missing maintenance schema for this database compatibility version.', 'INVALID_SCHEMA');
  const rows = db.prepare('SELECT singleton,version FROM murmur_maintenance_schema').all();
  assert(rows.length === 1 && rows[0]!.singleton === 1, 'Invalid maintenance schema metadata.', 'INVALID_SCHEMA');
  assert(rows[0]!.version === MAINTENANCE_SCHEMA_VERSION, 'Unsupported maintenance schema version; rollback is unsupported.', Number(rows[0]!.version) > MAINTENANCE_SCHEMA_VERSION ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
  for (const sql of definitions) {
    const name = sql.match(/^CREATE (?:TABLE|INDEX) (\w+)/)![1]!;
    const row = db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name);
    assert(typeof row?.sql === 'string' && normalize(row.sql) === normalize(sql), 'Unrecognized or incomplete maintenance schema.', 'INVALID_SCHEMA');
  }
  const names = definitions.map(sql => sql.match(/^CREATE (?:TABLE|INDEX) (\w+)/)![1]!);
  assert(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger'").all().length, 'Triggers require an explicit maintenance migration.', 'INVALID_SCHEMA');
  assert(!db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'maintenance_%' OR name LIKE 'murmur_maintenance_%'").all().some(row => !names.includes(String(row.name))), 'Unknown maintenance extension; rollback is unsupported.', 'INVALID_SCHEMA');
  assert(!db.prepare("SELECT 1 FROM sessions s WHERE s.credentialMode='manual' AND NOT EXISTS (SELECT 1 FROM manual_credentials c WHERE c.sessionId=s.id)").get(), 'Manual credential metadata is missing; restore is required.', 'INVALID_SCHEMA');
  const state = db.prepare('SELECT singleton,revision FROM maintenance_state').all();
  assert(state.length === 1 && state[0]!.singleton === 1 && Number.isSafeInteger(state[0]!.revision) && Number(state[0]!.revision) > 0, 'Invalid maintenance revision.', 'INVALID_SCHEMA');
  assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Maintenance database foreign keys are invalid.', 'INVALID_SCHEMA');
}
/** Additive tables, unchanged v3 session layout, and an atomic v4 compatibility
 * marker so old binaries cannot bypass credential revocation or replay tombstones. */
export function initializeMaintenanceSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    assert(version === 3 || version === 4, 'Unsupported database compatibility version.', version > 4 ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
    if (version === 4) {
      validateMaintenanceSchema(db);
    } else {
      const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='murmur_maintenance_schema'").get();
      if (!existing) {
        for (const sql of definitions) {
          const name = sql.match(/^CREATE (?:TABLE|INDEX) (\w+)/)![1]!;
          assert(!db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name), 'Unversioned maintenance schema exists.', 'INVALID_SCHEMA');
        }
        for (const sql of definitions) db.exec(sql);
        db.exec('INSERT INTO murmur_maintenance_schema VALUES (1,1); INSERT INTO maintenance_state VALUES (1,1)');
        db.exec("INSERT INTO manual_credentials SELECT id,1,NULL,createdAt FROM sessions WHERE credentialMode='manual'");
      }
      validateMaintenanceSchema(db);
      db.exec('PRAGMA user_version=4');
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Exact, reviewed DDL fingerprints. A new authority extension must add an explicit
// restore invalidation handler before its schema may be admitted here. Normalizing
// only whitespace and SQLite's own table-name quoting preserves every constraint.
const restoreSchema: Record<string, string> = {
  active_feature_owner: 'da78b8a14f75ccd1d173ef2ff59fbe2baa5b39fe282bcd4b0d622cb26b8cba5d',
  connection_requests: '8438b02802b80afc6664bc4dde59166678a4d79a855f027745f9b6da7d9f66c9',
  connection_requests_pending: '81b9e8a56d0da1af1912d382c325fcdf12334bb903b7aa0136b1b114813d391d',
  context_retention: '671f9996815115cc8f66747a0f471fd24d9ff6a0ea5498714ac056e391daa1f0',
  coordination_alert_dismissals: 'fc01b68786261184073c86c50782aed702ee2102afd2bbeca363e510f834405f',
  coordination_context_deliveries: 'cfa45f3173c25901122c63192dae4182765d3ea3cf7304374654c318d51455ef',
  coordination_decisions: '3049ac10f6f373375cd452e100059e78bf87a10abb4349890083639e55e934e0',
  coordination_decisions_project: 'b61567ef9c70e8dc618d190a6be6ef06401eed392979386992728d8a953994ea',
  coordination_deliveries_project: 'c474c1044a7289a583f0bfda6c63237ff4679fb8dc5f2f392c735b10202b09a7',
  coordination_intents: '2b2266f215c39acb2975a05dd9f2058197dbc75e92a290b8ae7b2537b0bebefc',
  coordination_intents_project: 'cb4f25b730629f4faaf629d0900d7a31c5c4c7ea536619a896e6721c17878395',
  coordination_one_accepted_decision: 'e88ae2930808e87d55b7f8c7893aceeece6600de7ab7148ba628806ca225d859',
  event_retention: '4317594512897c272508b8d16606b99793404564e3e3103a9c3b142343d2a9bc',
  events: '2c7478d3e693f4a44dfa8243193efdaa6aa1dd58e5d7fec351546acfbc89d4cb',
  external_grant_deadlines: '2815e5f7dfa17fd67661de94772de450d7d68db7cfcdafac0da0db793618f007',
  external_grant_lease_owner: '87d58749c2850b7d7382beb3559f36c49c216f2590361df355d8c8433e32bf56',
  external_grant_leases: 'd1b47ce59b1c35ae6c9c9969f1738d11e9c0a14d48d8ef29756f4dc27aa5adc2',
  external_grants: '8ff51a1d6e2b42596d88aa623b41cb6c0e79f72da9e255eff5507b20007177e5',
  group_active_native: '3dfd1c24db9cca34ffabed039e9e491168e6733d7674d2a76a3ed9eb9765414a',
  group_active_session: '55064ed090fe89d978a470141360048d6abceec9c3085b391d6ebe980b43c0f6',
  group_invitations: 'fecb957f042402b915f6b4fef3f21845d12edb8c5fcb342d89f24008f4591412',
  group_members: 'c0b70e7e274ad39965cdebd6dd51b0d6537b9fbed4fcc56a8f1eda735b04dc86',
  group_members_group: '4dc0d20c8a65cec61a6788aa100635162a963b411f1648077fbfe4de50cbbbb3',
  group_provenance: '169ec68c03d742f940c15b47e6997eea19ba8ef7c04e22f083dbf2fa043f8b80',
  leases: '778728561ee4260226f7caef5e57e97cfb7d80faea617c9c313f9895b72332ba',
  live_leases: '1101ca2b2812efd7e17db79a12418b20fe0fa508b1014ebf714ed786aed8cd4f',
  maintenance_state: 'ed8deaf7778ef2b7e2df404bec8a2310673ce75589a6fd919e5ace03e6d8e7c2',
  manual_credentials: 'a07db2703a44932921688241a7c70549117548db900ec8e578254ed42f0f154f',
  murmur_coordination_schema: 'a3c63bc8f5867fe80b7ad8072023610a08e19c959664eb2e3197b13c0d8dfccb',
  murmur_groups_schema: 'a6db4b265d12996444aed91f1426a2b070dfc389386225c610e52ee1d6430961',
  murmur_launch_deadlines: 'c3d1d82c836eb0734ca12e8c2f13c2543c915f3314d8ca97ddb29c6fad2be9f6',
  murmur_launch_project: 'f35e2025cb105047f13befb484844829be84e0830a1051adf09f910bebd0aa62',
  murmur_launch_schema: '43cd32ba65daeafcee7126d4ecf6378bdcedda62ed6ffcea16f51d6ff39ae925',
  murmur_launches: 'fac0f225247b1d784db399a90acaf4eb345acede4067343d1e52afaa66a24f48',
  murmur_maintenance_schema: '7a49d89c18e23dc86a8126fbafb334709031e2192f2e369e067dd1e031356dfe',
  murmur_project_bindings: '9c20e90f9a3be3a9213ab11ec4ae7d01c3ded079a93c4da808af8c3de827c174',
  murmur_workspace_observations: 'dbee50dc1704073be749244378364126459c171411d5cd8baf5e8cb048aaeb53',
  mutation_tombstone_age: '6500c9e8dd75b3bbab939a0deae4d22d6d67787b928a2164cbe5ed4be4a36b37',
  mutation_tombstones: '3f064ce1eb48c61d182fd195d301efcb32e73c2f64c41a733b62940c732e2d63',
  mutations: '888d7ecd388e904103b238df2fa78359832fa9fe6baa7f9e7124580f87481be1',
  project_events: '6039bcb57a83c80a3ed64c498828e3116289e571bf12b86428bcdb02b14603da',
  projects: '98ec6f0df72760b3b316606d43a4357b58fcfa24754fcfe8078162029f0fd745',
  request_redactions: '2453df8a12e06b0e2cc182c8568bc5fb70b6eea9e0a45d481af46af400e479eb',
  retired_session_credentials: 'f1cf15ca14dbebcbb1dcecad179f511a01f860774c05fc2374797f8b7516adf2',
  sessions: '154d7975ef41f8dca940037f65d0494225766c9aa00f13c8f375244c96486143',
  task_blocker_notes: '69fb90cb76a14be1fa4ce32f30a36b964a65b9033b043406c0e62a86a183f169',
  tasks: '8e7de928ec782419339499406f81950ac628fb4fcfb3184be032235f941b50c1',
  work_groups: '80f560c54e12cbf5ee45f59050afff17176d46d3d2cdcd773cd8b3e7fa472e85',
  workflow_attachments: '7e5c1d1c56669eaab964daff7ec32dd453ed64e1ba4db00cc2f74241391ec81e',
  workflow_changesets: '758f401e839fc3f644aeca6d3677f4ef7477a992c263dc28b2fae2d0241debeb',
  workflow_configs: '25b62e9c5b4fbc377704edbbdc0adb00ed037351fdeafb949f162c3ef150e2e1',
  workflow_jobs: '1eeee543e5993f7bbe03ff66ce63823d9b1b2f08ca2860b4068279904db68933',
  workflow_jobs_project: '4d9004622c03e2c197dfaae1c475d78c8c70fa23088ceee2fe34f5582fc6dd46',
  workflow_projects: 'ad2a042c00f78968ff38367a89788e218b21e8dd38a2183cd3ee3c0f737e3c64',
  workflow_requests: '2bf0efa6a80f2178e0726b5e1c0826512fcda7a45639d9d01c4931e2e300b30d',
  workflow_requests_project: '429e20a98d75a7e59dcc998d3f4bf5a3ac55ad12c57ed3c3c57eb3712176d085',
  workflow_schema: '3ed6a4a28bb045608e24c1a2d2e572bcb41783cb0123d940d751019e159adf00',
  workflow_workspaces: '66f0e89811b572210e8fbecc23b7a2ca52d8795117a23e0c962f3b3e01bc6bab',
};
export function validateMaintenanceDatabase(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  assert(version === 4, 'Restore requires a supported v4 backup; upgrade older backups first. Rollback is unsupported.', version > 4 ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
  const actual = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema').all();
  const names = new Set(actual.map(row => String(row.name)));
  for (const row of actual) {
    if (row.name === 'sqlite_sequence' && row.type === 'table' && row.sql === 'CREATE TABLE sqlite_sequence(name,seq)') continue;
    if (row.sql === null && row.type === 'index' && String(row.name).startsWith('sqlite_autoindex_') && Object.hasOwn(restoreSchema, String(row.tbl_name))) continue;
    const sql = typeof row.sql === 'string' ? normalize(row.sql).replace(/^CREATE TABLE "(\w+)"/, 'CREATE TABLE $1') : '';
    assert(Object.hasOwn(restoreSchema, String(row.name)) && createHash('sha256').update(sql).digest('hex') === restoreSchema[String(row.name)], 'Unknown or modified schema requires explicit maintenance/restore support; no data was changed.', 'UNSUPPORTED_MAINTENANCE_SCHEMA');
  }
  const families = [
    ['murmur_coordination_schema', 'singleton', 1, 1, Object.keys(restoreSchema).filter(name => name.startsWith('coordination_') || name === 'murmur_coordination_schema')],
    ['murmur_groups_schema', 'singleton', 1, 1, Object.keys(restoreSchema).filter(name => /^(group_|external_grant|connection_request)/.test(name) || ['murmur_groups_schema','work_groups','task_blocker_notes'].includes(name))],
    ['murmur_launch_schema', 'name', 'launches', 2, Object.keys(restoreSchema).filter(name => name.startsWith('murmur_launch'))],
    ['workflow_schema', 'name', 'git', 1, Object.keys(restoreSchema).filter(name => name.startsWith('workflow_'))],
  ] as const;
  const optional = new Set<string>(['murmur_workspace_observations']);
  for (const [table, key, value, expected, family] of families) {
    for (const name of family) optional.add(name);
    if (!family.some(name => names.has(name))) continue;
    assert(family.every(name => names.has(name)), 'Incomplete extension schema; restore cannot infer missing authority.', 'INVALID_SCHEMA');
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    assert(rows.length === 1 && rows[0]![key] === value && rows[0]!.version === expected, 'Unsupported extension schema version; rollback is unsupported.', Number(rows[0]?.version) > expected ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
  }
  assert(Object.keys(restoreSchema).every(name => optional.has(name) || names.has(name)), 'Incomplete base or maintenance schema.', 'INVALID_SCHEMA');
  const maintenance = db.prepare('SELECT * FROM murmur_maintenance_schema').all();
  assert(maintenance.length === 1 && maintenance[0]!.singleton === 1 && maintenance[0]!.version === MAINTENANCE_SCHEMA_VERSION, 'Unsupported maintenance schema version; rollback is unsupported.', Number(maintenance[0]?.version) > MAINTENANCE_SCHEMA_VERSION ? 'SCHEMA_TOO_NEW' : 'INVALID_SCHEMA');
  const state = db.prepare('SELECT * FROM maintenance_state').all();
  assert(state.length === 1 && state[0]!.singleton === 1 && Number.isSafeInteger(state[0]!.revision) && Number(state[0]!.revision) > 0, 'Invalid maintenance revision.', 'INVALID_SCHEMA');
  assert(!db.prepare("SELECT 1 FROM sessions s WHERE s.credentialMode='manual' AND NOT EXISTS (SELECT 1 FROM manual_credentials c WHERE c.sessionId=s.id)").get(), 'Backup manual credential metadata is missing.', 'INVALID_SCHEMA');
  assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Backup foreign keys are invalid.', 'INVALID_SCHEMA');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  assert(integrity.length === 1 && integrity[0]!.integrity_check === 'ok', 'Backup integrity check failed.', 'INVALID_SCHEMA');
}
