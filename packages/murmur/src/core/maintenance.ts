import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { assert, canonicalJson, integer, object, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';
import type { CoordinationStore, Session } from '../storage/store.js';
import { MAINTENANCE_SCHEMA_VERSION, validateMaintenanceDatabase } from '../storage/maintenance-schema.js';

export const RETENTION_CLASSES = ['unreviewed-drafts', 'events', 'context-records', 'mutation-payloads'] as const;
export type RetentionClass = typeof RETENTION_CLASSES[number];
export type CredentialStatus = { sessionId: string; projectId: string; mode: Session['credentialMode']; revision: number | null; revokedAt: number | null; changedAt: number | null; canRotate: boolean };
type RetentionInput = { before: number; classes: RetentionClass[] };
type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Candidates = { drafts: Row[]; events: Row[]; contexts: Row[]; mutations: Row[] };
export type RetentionPreview = RetentionInput & {
  revision: number; previewDigest: string; counts: Record<RetentionClass, number>;
  cutoffs: { before: number; events: { projectId: string; throughSequence: number; count: number }[]; contexts: { projectId: string; before: number; count: number }[] };
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const revision = (value: unknown) => integer(value, 'revision', 1, Number.MAX_SAFE_INTEGER - 1);
function fields(raw: unknown, allowed: string[]): Record<string, unknown> {
  const input = object(raw); assert(Object.keys(input).every(key => allowed.includes(key)), 'Unknown maintenance input field.'); return input;
}
function id(value: unknown): string {
  const result = text(value, 'sessionId', 128); assert(/^[A-Za-z0-9_-]+$/.test(result), 'Invalid sessionId.'); return result;
}
function sha256(value: unknown): string {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Expected a SHA-256 hex digest.'); return value;
}
function retentionInput(input: Record<string, unknown>, now: number): RetentionInput {
  const before = integer(input.before, 'before', 1, Number.MAX_SAFE_INTEGER - 1);
  assert(before <= now, 'Retention cutoff must not be in the future.');
  assert(Array.isArray(input.classes) && input.classes.length > 0 && input.classes.length <= RETENTION_CLASSES.length && input.classes.every(value => RETENTION_CLASSES.includes(value)), 'Select explicit retention classes.');
  assert(new Set(input.classes).size === input.classes.length, 'Duplicate retention class.');
  return { before, classes: RETENTION_CLASSES.filter(value => (input.classes as unknown[]).includes(value)) };
}
function meta(principal: Principal, mutation: Mutation, operation: string, input: unknown): Mutation {
  requireHuman(principal);
  assert(mutation.caller === 'human' && mutation.authorization === undefined, 'Maintenance mutation must use local human authority.', 'FORBIDDEN', 403);
  const key = text(mutation.key, 'idempotency key', 200);
  assert(/^[A-Za-z0-9_.:-]+$/.test(key), 'Invalid idempotency key.');
  return { caller: 'human', key, operation: `maintenance.${operation}`, input };
}
function advance(db: DatabaseSync): number {
  const before = revision(db.prepare('SELECT revision FROM maintenance_state WHERE singleton=1').get()!.revision);
  db.prepare('UPDATE maintenance_state SET revision=? WHERE singleton=1').run(before + 1); return before + 1;
}
function tombstone(db: DatabaseSync, row: Row, now: number): void {
  const old = db.prepare('SELECT digest FROM mutation_tombstones WHERE caller=? AND key=?').get(row.caller!, row.key!);
  assert(!old || old.digest === row.digest, 'Conflicting mutation retirement metadata.', 'INVALID_SCHEMA');
  db.prepare('INSERT OR IGNORE INTO mutation_tombstones VALUES (?,?,?,?,?)').run(row.caller!, row.key!, row.digest!, row.createdAt!, now);
}

/** Human-only, explicit maintenance. Never schedules pruning or touches source/workspaces. */
export class MaintenanceService {
  readonly store: CoordinationStore;
  constructor(store: CoordinationStore) { this.store = store; }
  credentialStatus(sessionId: string, principal: Principal): CredentialStatus {
    requireHuman(principal);
    const session = this.store.session(id(sessionId));
    const credential = session.credentialMode === 'manual' ? this.store.db.prepare('SELECT revision,revokedAt,changedAt FROM manual_credentials WHERE sessionId=?').get(session.id) : undefined;
    assert(session.credentialMode !== 'manual' || credential, 'Manual credential metadata is missing.', 'INVALID_SCHEMA');
    return { sessionId: session.id, projectId: session.projectId, mode: session.credentialMode, revision: credential ? Number(credential.revision) : null, revokedAt: credential?.revokedAt === null || !credential ? null : Number(credential.revokedAt), changedAt: credential ? Number(credential.changedAt) : null, canRotate: session.credentialMode === 'manual' };
  }
  revokeManual(raw: unknown, principal: Principal, mutation: Mutation): CredentialStatus {
    requireHuman(principal);
    const input = fields(raw, ['sessionId','revision']);
    const data = { sessionId: id(input.sessionId), revision: revision(input.revision) };
    return this.changeCredential(data, null, principal, meta(principal, mutation, 'credentials.revoke', data));
  }
  rotateManual(raw: unknown, principal: Principal, mutation: Mutation): CredentialStatus {
    requireHuman(principal);
    const input = fields(raw, ['sessionId','revision','tokenHash']);
    const data = { sessionId: id(input.sessionId), revision: revision(input.revision), tokenHash: sha256(input.tokenHash) };
    return this.changeCredential(data, data.tokenHash, principal, meta(principal, mutation, 'credentials.rotate', data));
  }
  private changeCredential(data: { sessionId: string; revision: number }, nextHash: string | null, principal: Principal, mutation: Mutation): CredentialStatus {
    return this.store.mutate(mutation, () => {
      requireHuman(principal);
      const current = this.credentialStatus(data.sessionId, principal), db = this.store.db;
      assert(current.mode === 'manual', 'Managed and external authority use their own lifecycle, not manual credentials.', 'CREDENTIAL_MODE', 409);
      assert(current.revision === data.revision, 'Credential revision is stale. Inspect credentials; heartbeat revisions are unrelated.', 'STALE_REVISION', 409);
      const old = db.prepare('SELECT tokenHash FROM sessions WHERE id=?').get(data.sessionId)!;
      if (nextHash !== null) {
        assert(!db.prepare('SELECT 1 FROM sessions WHERE tokenHash=?').get(nextHash) && !db.prepare('SELECT 1 FROM retired_session_credentials WHERE tokenHash=?').get(nextHash), 'Use a fresh, never-used session credential.', 'CREDENTIAL_REUSED', 409);
      } else assert(current.revokedAt === null, 'Manual credential is already revoked.', 'CREDENTIAL_REVOKED', 409);
      const now = this.store.now();
      db.prepare('INSERT OR IGNORE INTO retired_session_credentials VALUES (?,?,?)').run(old.tokenHash!, data.sessionId, now);
      // A revoked row never retains an authenticatable hash; no raw secret enters this service.
      db.prepare('UPDATE sessions SET tokenHash=? WHERE id=?').run(nextHash ?? hash(randomBytes(32).toString('hex')), data.sessionId);
      db.prepare('UPDATE manual_credentials SET revision=revision+1,revokedAt=?,changedAt=? WHERE sessionId=? AND revision=?').run(nextHash === null ? now : null, now, data.sessionId, data.revision);
      advance(db);
      this.store.event(current.projectId, nextHash === null ? 'session.credential_revoked' : 'session.credential_rotated', { sessionId: data.sessionId, revision: data.revision + 1 });
      return this.credentialStatus(data.sessionId, principal);
    });
  }
  private candidates(data: RetentionInput): Candidates {
    const db = this.store.db;
    // Unknown foreign-key/provenance/authority extensions cannot silently become eligible.
    validateMaintenanceDatabase(db);
    const result: Candidates = { drafts: [], events: [], contexts: [], mutations: [] };
    if (data.classes.includes('unreviewed-drafts') && hasTable(db, 'connection_requests')) {
      result.drafts = db.prepare(`SELECT r.* FROM connection_requests r
        WHERE r.kind='external' AND r.state IN ('pending','expired','rejected') AND r.expiresAt < ? AND r.createdAt < ?
        AND r.review IS NULL AND r.sessionId IS NULL AND r.taskId IS NULL
        AND NOT EXISTS (SELECT 1 FROM request_redactions d WHERE d.requestId=r.id)
        AND NOT EXISTS (SELECT 1 FROM external_grants g WHERE g.requestId=r.id)
        AND NOT EXISTS (SELECT 1 FROM group_provenance p WHERE p.requestId=r.id OR p.entityId=r.id)
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.instanceId=r.id OR s.tokenHash=r.capabilityHash)
        AND NOT EXISTS (SELECT 1 FROM group_members m WHERE m.nativeKey IN (SELECT nativeKey FROM external_grants WHERE requestId=r.id))
        ORDER BY r.id`).all(data.before, data.before);
    }
    if (data.classes.includes('events')) result.events = db.prepare('SELECT * FROM events WHERE createdAt < ? ORDER BY sequence').all(data.before);
    if (data.classes.includes('context-records') && hasTable(db, 'coordination_context_deliveries')) result.contexts = db.prepare('SELECT * FROM coordination_context_deliveries WHERE generatedAt < ? ORDER BY id').all(data.before);
    if (data.classes.includes('mutation-payloads')) {
      // Workflow replay tables and launch preparation/phase journals are deliberately
      // excluded even when old. Their terminal safety is not inferred from age.
      const workflow = hasTable(db, 'workflow_requests') ? 'AND NOT EXISTS (SELECT 1 FROM workflow_requests w WHERE w.caller=m.caller AND w.key=m.key)' : '';
      const launches = hasTable(db, 'murmur_launches') ? 'AND NOT EXISTS (SELECT 1 FROM murmur_launches l WHERE l.requestCaller=m.caller AND l.requestKey=m.key)' : '';
      result.mutations = db.prepare(`SELECT m.* FROM mutations m WHERE m.createdAt < ? AND m.key NOT LIKE 'launch:%' AND m.key NOT LIKE 'workflow:%' ${workflow} ${launches} ORDER BY m.caller,m.key`).all(data.before);
    }
    return result;
  }
  private preview(data: RetentionInput, candidates: Candidates): RetentionPreview {
    const currentRevision = revision(this.store.db.prepare('SELECT revision FROM maintenance_state WHERE singleton=1').get()!.revision);
    const events = new Map<string, { projectId: string; throughSequence: number; count: number }>();
    const contexts = new Map<string, { projectId: string; before: number; count: number }>();
    for (const row of candidates.events) {
      const projectId = String(row.projectId), value = events.get(projectId) ?? { projectId, throughSequence: 0, count: 0 };
      value.throughSequence = Math.max(value.throughSequence, Number(row.sequence)); value.count++; events.set(projectId, value);
    }
    for (const row of candidates.contexts) {
      const projectId = String(row.projectId), value = contexts.get(projectId) ?? { projectId, before: data.before, count: 0 }; value.count++; contexts.set(projectId, value);
    }
    return { ...data, revision: currentRevision, previewDigest: hash(canonicalJson({ ...data, revision: currentRevision, candidates })), counts: { 'unreviewed-drafts': candidates.drafts.length, events: candidates.events.length, 'context-records': candidates.contexts.length, 'mutation-payloads': candidates.mutations.length }, cutoffs: { before: data.before, events: [...events.values()], contexts: [...contexts.values()] } };
  }
  previewRetention(raw: unknown, principal: Principal): RetentionPreview {
    requireHuman(principal);
    const data = retentionInput(fields(raw, ['before','classes']), this.store.now());
    // Read-only snapshot; creating a preview never creates a mutation or changes a row.
    this.store.db.exec('BEGIN');
    try { const result = this.preview(data, this.candidates(data)); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  applyRetention(raw: unknown, principal: Principal, mutation: Mutation): RetentionPreview & { applied: true; newRevision: number } {
    requireHuman(principal);
    const input = fields(raw, ['before','classes','previewDigest','revision']);
    const data = { ...retentionInput(input, this.store.now()), previewDigest: sha256(input.previewDigest), revision: revision(input.revision) };
    return this.store.mutate(meta(principal, mutation, 'retention.apply', data), () => {
      requireHuman(principal);
      const candidates = this.candidates(data), preview = this.preview({ before: data.before, classes: data.classes }, candidates), db = this.store.db;
      assert(preview.revision === data.revision && preview.previewDigest === data.previewDigest, 'Retention preview is stale. Run a new dry-run and inspect its counts before applying.', 'STALE_RETENTION_PREVIEW', 409);
      const now = this.store.now();
      for (const row of candidates.drafts) {
        db.prepare('INSERT INTO request_redactions VALUES (?,?,?,?)').run(row.id!, row.requestDigest!, hash(String(row.payload)), now);
        const payload = { workspaceRoot: '[redacted]', native: { tool: 'manual', nativeId: '[redacted]', incarnationId: '[redacted]' }, responsibility: '[redacted]', handoff: null, groupTitle: null, groupGoal: null, inviteHash: null, redacted: true };
        db.prepare("UPDATE connection_requests SET payload=?,state=CASE WHEN state='pending' THEN 'expired' ELSE state END,revision=revision+1 WHERE id=?").run(JSON.stringify(payload), row.id!);
      }
      for (const row of candidates.mutations) { tombstone(db, row, now); db.prepare('DELETE FROM mutations WHERE caller=? AND key=?').run(row.caller!, row.key!); }
      for (const row of candidates.events) db.prepare('DELETE FROM events WHERE sequence=?').run(row.sequence!);
      for (const row of candidates.contexts) db.prepare('DELETE FROM coordination_context_deliveries WHERE id=?').run(row.id!);
      for (const cutoff of preview.cutoffs.events) db.prepare(`INSERT INTO event_retention VALUES (?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET prunedThrough=MAX(prunedThrough,excluded.prunedThrough),prunedCount=prunedCount+excluded.prunedCount,prunedAt=excluded.prunedAt`).run(cutoff.projectId, cutoff.throughSequence, cutoff.count, now);
      for (const cutoff of preview.cutoffs.contexts) db.prepare(`INSERT INTO context_retention VALUES (?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET before=MAX(before,excluded.before),prunedCount=prunedCount+excluded.prunedCount,prunedAt=excluded.prunedAt`).run(cutoff.projectId, cutoff.before, cutoff.count, now);
      return { ...preview, applied: true, newRevision: advance(db) };
    });
  }
  async backup(raw: unknown, principal: Principal): Promise<{ destination: string; pages: number; schemaVersion: number; sensitive: true }> {
    requireHuman(principal);
    const input = fields(raw, ['destination']);
    validateMaintenanceDatabase(this.store.db);
    const destination = await privateFilePath(input.destination), file = await reserveFile(destination);
    try {
      // This is SQLite's online backup API, not a live DB/WAL filesystem copy.
      const pages = await sqliteBackup(this.store.db, destination);
      await checkSameFile(destination, file);
      const db = new DatabaseSync(destination);
      try { db.exec('PRAGMA journal_mode=DELETE'); validateMaintenanceDatabase(db); } finally { db.close(); }
      await file.sync(); await syncDirectory(path.dirname(destination));
      return { destination, pages, schemaVersion: MAINTENANCE_SCHEMA_VERSION, sensitive: true };
    } finally { await file.close(); }
  }
}

function absolutePath(value: unknown, name: string): string {
  const filename = text(value, name, 4096);
  assert(path.isAbsolute(filename) && !/[\u0000-\u001f\u007f]/.test(filename), `${name} must be an absolute path without control characters.`);
  return path.resolve(filename);
}
/** Reject symlinked parents and require an owned, private destination directory. */
async function privateFilePath(raw: unknown): Promise<string> {
  const filename = absolutePath(raw, 'destination'), parent = path.dirname(filename);
  assert(parent === await realpath(parent), 'Use a canonical destination without symlinked parents.', 'INSECURE_STATE');
  const info = await lstat(parent);
  assert(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid()), 'Destination directory must be owned and private (0700).', 'INSECURE_STATE');
  return filename;
}
async function reserveFile(filename: string): Promise<FileHandle> {
  const file = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { await checkSameFile(filename, file); return file; } catch (error) { await file.close(); throw error; }
}
async function checkSameFile(filename: string, file: FileHandle): Promise<void> {
  const before = await file.stat(), current = await lstat(filename);
  assert(before.isFile() && current.isFile() && !current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino && before.nlink === 1 && (before.mode & 0o077) === 0 && (!process.getuid || before.uid === process.getuid()), 'Private file identity or permissions changed.', 'INSECURE_STATE');
}
async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
/** Used for the CLI's pre-request private credential/retry record. Never publicOutput. */
export async function writeNewPrivateJson(filename: string, value: unknown): Promise<void> {
  const destination = await privateFilePath(filename), source = JSON.stringify(value, null, 2) + '\n';
  assert(Buffer.byteLength(source) <= 16 * 1024, 'Private output is too large.');
  const file = await reserveFile(destination);
  try { await file.writeFile(source); await file.sync(); await checkSameFile(destination, file); await syncDirectory(path.dirname(destination)); }
  finally { await file.close(); }
}

/** Offline only. The target is NEW; no descriptor, integration registry, process or workspace is copied. */
export async function restoreBackup(raw: unknown, principal: Principal): Promise<{ stateDirectory: string; database: string; restored: true; authorityInvalidated: true; recoveryRequired: true }> {
  requireHuman(principal);
  const input = fields(raw, ['backupPath','stateDirectory']);
  const backupPath = await privateFilePath(input.backupPath), stateDirectory = await privateFilePath(input.stateDirectory);
  const sourceFile = await open(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let source: DatabaseSync | undefined;
  try {
    await checkSameFile(backupPath, sourceFile);
    // Only exported, self-contained backups are accepted, never a live state database.
    for (const suffix of ['-wal','-shm','-journal']) {
      try { await lstat(backupPath + suffix); assert(false, 'Restore requires a standalone backup without live SQLite sidecars.', 'LIVE_BACKUP'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    source = new DatabaseSync(backupPath, { readOnly: true });
    await checkSameFile(backupPath, sourceFile); validateMaintenanceDatabase(source);
    await mkdir(stateDirectory, { mode: 0o700 }); // No recursive/existing-directory fallback.
    const directoryInfo = await lstat(stateDirectory);
    assert(directoryInfo.isDirectory() && (directoryInfo.mode & 0o777) === 0o700, 'New restore directory must be mode 0700.', 'INSECURE_STATE');
    const staging = path.join(stateDirectory, 'restore-incomplete.sqlite'), target = path.join(stateDirectory, 'state.sqlite');
    // A crash must not let daemon startup silently initialize a fresh empty DB in
    // a partially restored directory. Only our successful atomic publication
    // replaces this exclusive, deliberately invalid SQLite startup barrier.
    const barrier = await reserveFile(target);
    let stageFile: FileHandle | undefined;
    try {
      await barrier.writeFile('Murmur restore incomplete. Retain this private directory for inspection; restore again into a NEW directory.\n');
      await barrier.sync(); await syncDirectory(stateDirectory);
      stageFile = await reserveFile(staging);
      await sqliteBackup(source, staging);
      await checkSameFile(staging, stageFile);
      const db = new DatabaseSync(staging);
      try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
        try {
          validateMaintenanceDatabase(db);
          const now = Date.now();
          for (const session of db.prepare('SELECT id,tokenHash,credentialMode FROM sessions').all()) {
            db.prepare('INSERT OR IGNORE INTO retired_session_credentials VALUES (?,?,?)').run(session.tokenHash!, session.id!, now);
            // External hashes are also immutable reconnect provenance, not session
            // login authority. Keep that binding while revoking every copied grant
            // below; a fresh human-approved enrollment must supply a new capability.
            if (session.credentialMode !== 'external') db.prepare('UPDATE sessions SET tokenHash=? WHERE id=?').run(hash(randomBytes(32).toString('hex')), session.id!);
          }
          db.prepare('UPDATE manual_credentials SET revokedAt=?,changedAt=?,revision=revision+1').run(now, now);
          db.prepare('UPDATE leases SET releasedAt=? WHERE releasedAt IS NULL').run(now);
          // All cached authority (including historical registration responses) is retired.
          for (const row of db.prepare('SELECT * FROM mutations').all()) tombstone(db, row, now);
          db.exec('DELETE FROM mutations');
          if (hasTable(db, 'external_grants')) {
            db.prepare("UPDATE external_grants SET revokedAt=COALESCE(revokedAt,?),revokeReason='backup_restore'").run(now);
            // Match ordinary revocation's membership lifecycle. The grant sweeper
            // intentionally ignores revoked rows and cannot release these slots.
            db.exec("UPDATE work_groups SET revision=revision+1 WHERE id IN (SELECT groupId FROM group_members WHERE kind='external' AND state='active')");
            db.prepare("UPDATE group_members SET state='left',leftAt=?,revision=revision+1 WHERE kind='external' AND state='active'").run(now);
            db.prepare('UPDATE group_invitations SET revokedAt=COALESCE(revokedAt,?)').run(now);
            db.prepare("UPDATE connection_requests SET pollSecretHash=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END,revision=revision+1").run();
          }
          if (hasTable(db, 'murmur_launches')) {
            db.prepare(`UPDATE murmur_launches SET agentHash=NULL,agentToken=NULL,supervisorHash=NULL,supervisorToken=NULL,
              expiresAt=NULL,controllerId=NULL,pid=NULL,lifecycleRevision=lifecycleRevision+1,
              state=CASE WHEN state IN ('preparing','prepared','claimed','running') THEN 'recovery_required' ELSE state END,
              errorCode='BACKUP_RESTORED',endReason='backup_restore'`).run();
          }
          if (hasTable(db, 'workflow_requests')) {
            // A workflow journal can contain stale success/authority independently of mutations.
            // Retain caller/key/digest/entity bookkeeping, but never replay a pre-restore result.
            // Unlike a normal interrupted request, restored journals must never be
            // completed by crash recovery, even if no mutation response was saved.
            db.exec("UPDATE workflow_requests SET status='retired',response=NULL,error=NULL");
            db.exec("UPDATE workflow_workspaces SET status='recovery_required',recovery='Backup restored; inspect retained workspace and refs.' WHERE status!='removed'");
            db.exec("UPDATE workflow_projects SET targetStatus='recovery_required' WHERE targetStatus!='absent'");
            db.exec("UPDATE workflow_changesets SET status='recovery_required' WHERE status NOT IN ('integrated','abandoned')");
            for (const row of db.prepare('SELECT id,status,validation FROM workflow_jobs').all()) {
              const validation = row.validation === null ? null : { ...object(JSON.parse(String(row.validation))), status: 'invalidated' };
              db.prepare("UPDATE workflow_jobs SET status=CASE WHEN status='promoted' THEN status ELSE 'recovery_required' END,validation=?,updatedAt=?,recovery='Backup restored; validation is stale and refs require inspection.' WHERE id=?").run(validation === null ? null : JSON.stringify(validation), now, row.id!);
            }
          }
          advance(db); validateMaintenanceDatabase(db); db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        // Remove free-page secret remnants in the newly restored copy, never the source.
        db.exec('VACUUM'); validateMaintenanceDatabase(db);
      } finally { db.close(); }
      await stageFile.sync(); await checkSameFile(staging, stageFile);
      // Replace only the startup barrier that we created in this NEW directory.
      await checkSameFile(target, barrier);
      const currentDirectory = await lstat(stateDirectory);
      assert(currentDirectory.ino === directoryInfo.ino && currentDirectory.dev === directoryInfo.dev && !currentDirectory.isSymbolicLink(), 'Restore directory identity changed.', 'INSECURE_STATE');
      await rename(staging, target); await syncDirectory(stateDirectory); await syncDirectory(path.dirname(stateDirectory));
      return { stateDirectory, database: target, restored: true, authorityInvalidated: true, recoveryRequired: true };
    } finally { await stageFile?.close(); await barrier.close(); }
  } finally { source?.close(); await sourceFile.close(); }
}
