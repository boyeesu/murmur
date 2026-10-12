import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { assert, canonicalJson, MurmurError } from '../protocol/index.js';
import type { Mutation, Resource, Tool } from '../protocol/index.js';
import { resourcesOverlap } from '../workspaces/identity.js';
import type { ProjectIdentity } from '../workspaces/identity.js';

export type Project = { id: string; root: string; canonicalPath: string; mode: 'git' | 'advisory'; caseSensitive: number; createdAt: number };
export type Session = { id: string; projectId: string; tool: Tool; nativeId: string; instanceId: string; workspaceRoot: string; revision: number; createdAt: number; lastSeenAt: number; credentialMode: 'manual' | 'managed' };
export type Task = { id: string; projectId: string; ownerSessionId: string; title: string; featureKey: string | null; status: string; revision: number; createdAt: number };
export type Lease = { id: string; projectId: string; sessionId: string; taskId: string; generation: number; resources: Resource[]; expiresAt: number; releasedAt: number | null };
const sessionColumns = 'id, projectId, tool, nativeId, instanceId, workspaceRoot, revision, createdAt, lastSeenAt, credentialMode';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const decodeLease = (row: Record<string, unknown>): Lease => ({ ...row, resources: JSON.parse(row.resources as string) }) as Lease;

export class CoordinationStore {
  db: DatabaseSync;
  now: () => number;
  constructor(filename: string, now: () => number = Date.now) {
    if (filename !== ':memory:') {
      try { closeSync(openSync(filename, 'wx', 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    this.now = now;
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      assert(version <= 2, 'This database was created by a newer Murmur version.', 'SCHEMA_TOO_NEW');
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, root TEXT NOT NULL, canonicalPath TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL, caseSensitive INTEGER NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
          tool TEXT NOT NULL, nativeId TEXT NOT NULL, instanceId TEXT NOT NULL,
          workspaceRoot TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
          createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL,
          UNIQUE(projectId, tool, nativeId, instanceId)
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
          ownerSessionId TEXT NOT NULL REFERENCES sessions(id), title TEXT NOT NULL,
          featureKey TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX active_feature_owner ON tasks(projectId, featureKey)
          WHERE featureKey IS NOT NULL AND status NOT IN ('integrated', 'abandoned');
        CREATE TABLE leases (
          generation INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          projectId TEXT NOT NULL REFERENCES projects(id), sessionId TEXT NOT NULL REFERENCES sessions(id),
          taskId TEXT NOT NULL REFERENCES tasks(id), resources TEXT NOT NULL,
          expiresAt INTEGER NOT NULL, releasedAt INTEGER
        );
        CREATE INDEX live_leases ON leases(projectId, expiresAt);
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL REFERENCES projects(id),
          type TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE INDEX project_events ON events(projectId, sequence);
        CREATE TABLE mutations (
          caller TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
          response TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(caller, key)
        );
        PRAGMA user_version = 1;
        COMMIT;
      `);
      if (version < 2) this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN credentialMode TEXT NOT NULL DEFAULT 'manual' CHECK(credentialMode IN ('manual','managed'));
        PRAGMA user_version = 2;
        COMMIT;
      `);
      this.db.exec('CREATE TABLE IF NOT EXISTS murmur_project_bindings (projectId TEXT PRIMARY KEY REFERENCES projects(id), fingerprint TEXT NOT NULL)');
      const bindingColumns = this.db.prepare('PRAGMA table_info(murmur_project_bindings)').all().map(row => row.name);
      assert(bindingColumns.join(',') === 'projectId,fingerprint', 'Unsupported project identity binding schema.', 'SCHEMA_TOO_NEW');
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  replay<T>(mutation: Mutation): { found: false } | { found: true; response: T } {
    const cached = this.db.prepare('SELECT digest, response FROM mutations WHERE caller = ? AND key = ?').get(mutation.caller, mutation.key) as { digest: string; response: string } | undefined;
    if (!cached) return { found: false };
    const hash = digest(canonicalJson({ operation: mutation.operation, input: mutation.input }));
    assert(cached.digest === hash, 'Idempotency key was already used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
    return { found: true, response: JSON.parse(cached.response) as T };
  }
  mutate<T>(mutation: Mutation, operation: () => T): T {
    const hash = digest(canonicalJson({ operation: mutation.operation, input: mutation.input }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cached = this.db.prepare('SELECT digest, response FROM mutations WHERE caller = ? AND key = ?').get(mutation.caller, mutation.key) as { digest: string; response: string } | undefined;
      if (cached) {
        assert(cached.digest === hash, 'Idempotency key was already used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
        this.db.exec('COMMIT');
        return JSON.parse(cached.response) as T;
      }
      const response = operation();
      this.db.prepare('INSERT INTO mutations VALUES (?, ?, ?, ?, ?)').run(mutation.caller, mutation.key, hash, JSON.stringify(response), this.now());
      this.db.exec('COMMIT');
      return response;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(projectId: string, type: string, payload: unknown): void {
    this.db.prepare('INSERT INTO events(projectId, type, payload, createdAt) VALUES (?, ?, ?, ?)').run(projectId, type, JSON.stringify(payload), this.now());
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    assert(row, 'Unknown project.', 'NOT_FOUND', 404);
    return row;
  }
  session(id: string): Session {
    const row = this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`).get(id) as Session | undefined;
    assert(row, 'Unknown session.', 'NOT_FOUND', 404);
    return row;
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    assert(row, 'Unknown task.', 'NOT_FOUND', 404);
    return row;
  }
  authenticateSession(token: string): Session | undefined {
    const session = this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE tokenHash = ?`).get(digest(token)) as Session | undefined;
    if (!session || session.credentialMode === 'manual') return session;
    if (session.credentialMode !== 'managed') return undefined;
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='murmur_launches'").get()) return undefined;
    const managed = this.db.prepare('SELECT state, expiresAt FROM murmur_launches WHERE sessionId = ?').get(session.id);
    if (!managed || !['claimed', 'running'].includes(String(managed.state)) || typeof managed.expiresAt !== 'number' || !Number.isSafeInteger(managed.expiresAt) || managed.expiresAt <= this.now()) return undefined;
    return session;
  }
  registerProject(identity: ProjectIdentity, mutation: Mutation): Project {
    return this.mutate(mutation, () => {
      const existing = this.db.prepare('SELECT * FROM projects WHERE canonicalPath = ?').get(identity.canonicalPath) as Project | undefined;
      if (existing) {
        if (identity.fingerprint) {
          const bound = this.db.prepare('SELECT fingerprint FROM murmur_project_bindings WHERE projectId = ?').get(existing.id);
          if (bound) this.verifyProjectIdentity(existing.id, identity.fingerprint);
          else {
            this.db.prepare('INSERT INTO murmur_project_bindings VALUES (?, ?)').run(existing.id, identity.fingerprint);
            this.event(existing.id, 'project.identity_bound', { projectId: existing.id });
          }
        }
        return existing;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(id, identity.root, identity.canonicalPath, identity.mode, Number(identity.caseSensitive), this.now());
      if (identity.fingerprint) this.db.prepare('INSERT INTO murmur_project_bindings VALUES (?, ?)').run(id, identity.fingerprint);
      this.event(id, 'project.registered', { id, mode: identity.mode });
      return this.project(id);
    });
  }
  verifyProjectIdentity(projectId: string, fingerprint: string | undefined): void {
    const row = this.db.prepare('SELECT fingerprint FROM murmur_project_bindings WHERE projectId = ?').get(projectId);
    assert(row, 'Older project registration needs an explicit init before workspace operations.', 'PROJECT_IDENTITY_UNBOUND', 409);
    assert(fingerprint && row.fingerprint === fingerprint, 'The project directory has been replaced. Existing tasks must not attach to unrelated source.', 'WORKSPACE_CHANGED', 409);
  }
  registerSession(input: { projectId: string; tool: Tool; nativeId: string; instanceId: string; workspaceRoot: string }, mutation: Mutation): { session: Session; token: string } {
    return this.mutate(mutation, () => {
      this.project(input.projectId);
      const existing = this.db.prepare('SELECT id FROM sessions WHERE projectId = ? AND tool = ? AND nativeId = ? AND instanceId = ?').get(input.projectId, input.tool, input.nativeId, input.instanceId);
      assert(!existing, 'Session already registered. Retain its credential or replay the original idempotency key.', 'SESSION_EXISTS', 409);
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const now = this.now();
      this.db.prepare('INSERT INTO sessions(id,projectId,tool,nativeId,instanceId,workspaceRoot,tokenHash,revision,createdAt,lastSeenAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.projectId, input.tool, input.nativeId, input.instanceId, input.workspaceRoot, digest(token), 1, now, now);
      this.event(input.projectId, 'session.registered', { id, tool: input.tool });
      return { session: this.session(id), token };
    });
  }
  heartbeat(sessionId: string, revision: number, mutation: Mutation): Session {
    return this.mutate(mutation, () => {
      const session = this.session(sessionId);
      assert(session.revision === revision, 'Session revision is stale.', 'STALE_REVISION', 409);
      this.db.prepare('UPDATE sessions SET lastSeenAt = ?, revision = revision + 1 WHERE id = ?').run(this.now(), sessionId);
      this.event(session.projectId, 'session.heartbeat', { id: sessionId, revision: revision + 1 });
      return this.session(sessionId);
    });
  }
  createTask(input: { projectId: string; sessionId: string; title: string; featureKey: string | null }, mutation: Mutation): Task {
    return this.mutate(mutation, () => {
      const session = this.session(input.sessionId);
      assert(session.projectId === input.projectId, 'Task owner belongs to another project.', 'FORBIDDEN', 403);
      if (input.featureKey) {
        const owner = this.db.prepare("SELECT id, ownerSessionId, title FROM tasks WHERE projectId = ? AND featureKey = ? AND status NOT IN ('integrated', 'abandoned')").get(input.projectId, input.featureKey);
        if (owner) throw new MurmurError('Another active task already owns this feature key. Coordinate or hand off instead of duplicating ownership.', 'FEATURE_ALREADY_OWNED', 409, owner);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.projectId, input.sessionId, input.title, input.featureKey, 'active', 1, this.now());
      this.event(input.projectId, 'task.created', { id, ownerSessionId: input.sessionId });
      return this.task(id);
    });
  }
  acquire(input: { projectId: string; sessionId: string; taskId: string; taskRevision: number; resources: Resource[]; ttlSeconds: number }, mutation: Mutation): Lease {
    return this.mutate(mutation, () => {
      const task = this.task(input.taskId);
      assert(task.projectId === input.projectId && task.ownerSessionId === input.sessionId, 'Only the assigned task owner may acquire its reservations.', 'FORBIDDEN', 403);
      assert(!['integrated', 'abandoned'].includes(task.status), 'Terminal tasks cannot acquire reservations.', 'TASK_TERMINAL', 409);
      assert(task.revision === input.taskRevision, 'Task revision is stale.', 'STALE_REVISION', 409);
      const now = this.now();
      const rows = this.db.prepare('SELECT * FROM leases WHERE projectId = ? AND releasedAt IS NULL AND expiresAt > ?').all(input.projectId, now);
      for (const row of rows) {
        const lease = decodeLease(row);
        const overlaps = input.resources.filter(resource => lease.resources.some(existing => resourcesOverlap(resource, existing)));
        if (overlaps.length) throw new MurmurError('Requested resources overlap an active reservation.', 'RESERVATION_CONFLICT', 409, { leaseId: lease.id, taskId: lease.taskId, sessionId: lease.sessionId, resources: overlaps, expiresAt: lease.expiresAt });
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO leases(id, projectId, sessionId, taskId, resources, expiresAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.projectId, input.sessionId, input.taskId, JSON.stringify(input.resources), now + input.ttlSeconds * 1000);
      const lease = this.lease(id);
      this.event(input.projectId, 'reservation.acquired', lease);
      return lease;
    });
  }
  lease(id: string): Lease {
    const row = this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id);
    assert(row, 'Unknown reservation.', 'NOT_FOUND', 404);
    return decodeLease(row);
  }
  changeLease(input: { id: string; sessionId: string; generation: number; ttlSeconds?: number }, mutation: Mutation): Lease {
    return this.mutate(mutation, () => {
      const lease = this.lease(input.id);
      assert(lease.sessionId === input.sessionId, 'Reservation belongs to another session.', 'FORBIDDEN', 403);
      assert(lease.generation === input.generation && lease.releasedAt === null && lease.expiresAt > this.now(), 'Reservation is expired, released, or has a stale fencing token.', 'STALE_LEASE', 409);
      if (input.ttlSeconds !== undefined) assert(!['integrated', 'abandoned'].includes(this.task(lease.taskId).status), 'Terminal tasks cannot renew reservations.', 'TASK_TERMINAL', 409);
      if (input.ttlSeconds !== undefined) this.db.prepare('UPDATE leases SET expiresAt = ? WHERE id = ?').run(this.now() + input.ttlSeconds * 1000, input.id);
      else this.db.prepare('UPDATE leases SET releasedAt = ? WHERE id = ?').run(this.now(), input.id);
      const updated = this.lease(input.id);
      this.event(lease.projectId, input.ttlSeconds !== undefined ? 'reservation.renewed' : 'reservation.released', updated);
      return updated;
    });
  }
  snapshot(projectId?: string) {
    if (projectId) this.project(projectId);
    const where = projectId ? ' WHERE projectId = ?' : '';
    const args = projectId ? [projectId] : [];
    return {
      now: this.now(),
      projects: projectId ? [this.project(projectId)] : this.db.prepare('SELECT * FROM projects ORDER BY createdAt, id').all(),
      sessions: this.db.prepare(`SELECT ${sessionColumns} FROM sessions${where} ORDER BY createdAt, id`).all(...args),
      tasks: this.db.prepare(`SELECT * FROM tasks${where} ORDER BY createdAt, id`).all(...args),
      reservations: this.db.prepare(`SELECT * FROM leases${where} ${where ? 'AND' : 'WHERE'} releasedAt IS NULL AND expiresAt > ? ORDER BY generation`).all(...args, this.now()).map(decodeLease),
    };
  }
  events(projectId: string, after: number) {
    this.project(projectId);
    return this.db.prepare('SELECT * FROM events WHERE projectId = ? AND sequence > ? ORDER BY sequence LIMIT 500').all(projectId, after).map(row => ({ ...row, payload: JSON.parse(row.payload as string) }));
  }
}
