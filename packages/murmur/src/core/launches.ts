import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assert, callerId, canonicalJson, integer, MurmurError, object, PROTOCOL_VERSION, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';
import { HEARTBEAT_MS, MANAGED_TTL_MS } from '../protocol/agent.js';
import type { AgentConnection, AgentIdentity, LaunchPreparation, LaunchStatus, LaunchTool, SupervisorConnection } from '../protocol/agent.js';
import type { CoordinationStore } from '../storage/store.js';
import type { GitWorkflow } from '../integration/workflow.js';
import type { CoordinationService } from './coordination.js';

type Runtime = { origin: string; stateId: string; instanceId: string };
type PrepareInput = { projectId: string; tool: LaunchTool; title: string; featureKey: string | null; baseRevision?: string; allowDirtyBase?: boolean };
type LaunchRow = LaunchStatus & {
  requestCaller: string; requestKey: string; requestDigest: string; preparationInstanceId: string; phase: string;
  agentHash: string | null; agentToken: string | null; supervisorHash: string | null; supervisorToken: string | null;
  briefing: string | null; bridgeFirstSeenAt: number | null; endReason: string | null;
};
type ControlAction = 'status' | 'claim' | 'started' | 'heartbeat' | 'end';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = () => randomBytes(32).toString('base64url');
const live = (row: LaunchStatus, now: number) => (row.state === 'claimed' || row.state === 'running') && row.expiresAt !== null && row.expiresAt > now;
const own = (value: object, key: string) => Object.hasOwn(value, key);
function fields(raw: unknown, allowed: string[]): Record<string, unknown> {
  const input = object(raw);
  assert(Object.keys(input).every(key => allowed.includes(key)), 'Unexpected launch request fields.');
  return input;
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name, 128);
  assert(/^[A-Za-z0-9_-]+$/.test(result), `Invalid ${name}.`);
  return result;
}
function requestKey(value: unknown): string {
  const key = text(value, 'idempotency key', 200);
  assert(/^[A-Za-z0-9_.:-]+$/.test(key), 'Invalid idempotency key.');
  return key;
}
function publicStatus(row: LaunchRow): LaunchStatus {
  // Never spread a database row: the same table contains scoped credentials.
  return {
    id: row.id, projectId: row.projectId, tool: row.tool, title: row.title, featureKey: row.featureKey, state: row.state,
    sessionId: row.sessionId, taskId: row.taskId, workspaceId: row.workspaceId, workspaceRoot: row.workspaceRoot, baseSha: row.baseSha,
    nativeSessionId: row.nativeSessionId, nativeIdentitySource: row.nativeIdentitySource, lifecycleRevision: row.lifecycleRevision,
    expiresAt: row.expiresAt, controllerId: row.controllerId, pid: row.pid, createdAt: row.createdAt, startedAt: row.startedAt,
    endedAt: row.endedAt, exitCode: row.exitCode, errorCode: row.errorCode, bridgeLastSeenAt: row.bridgeLastSeenAt,
  };
}

const launchSchemaSql = 'CREATE TABLE murmur_launch_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL)';
const launchIndexes = [
  'CREATE INDEX murmur_launch_deadlines ON murmur_launches(state, expiresAt)',
  'CREATE INDEX murmur_launch_project ON murmur_launches(projectId, createdAt)',
];
function launchTableSql(name: string, version: 1 | 2): string {
  return `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), tool TEXT NOT NULL CHECK(tool IN (${version === 1 ? "'claude','codex'" : "'claude','codex','opencode'"})),
    title TEXT NOT NULL, featureKey TEXT, state TEXT NOT NULL CHECK(state IN ('preparing','prepared','claimed','running','ended','failed','expired','recovery_required')),
    sessionId TEXT UNIQUE REFERENCES sessions(id), taskId TEXT UNIQUE REFERENCES tasks(id), workspaceId TEXT,
    workspaceRoot TEXT, baseSha TEXT, nativeSessionId TEXT, nativeIdentitySource TEXT NOT NULL,
    lifecycleRevision INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER, controllerId TEXT, pid INTEGER,
    createdAt INTEGER NOT NULL, startedAt INTEGER, endedAt INTEGER, exitCode INTEGER, errorCode TEXT, bridgeLastSeenAt INTEGER,
    requestCaller TEXT NOT NULL, requestKey TEXT NOT NULL, requestDigest TEXT NOT NULL, preparationInstanceId TEXT NOT NULL,
    phase TEXT NOT NULL, agentHash TEXT, agentToken TEXT, supervisorHash TEXT, supervisorToken TEXT,
    briefing TEXT, bridgeFirstSeenAt INTEGER, endReason TEXT, UNIQUE(requestCaller, requestKey)
  )`;
}
function normalizedSchema(sql: string): string {
  // SQLite quotes the table name after RENAME; otherwise only normalize formatting
  // emitted by our own DDL. Unknown columns/constraints require an explicit migration.
  return sql.trim().replace(/;$/, '').replace(/\s+/g, ' ')
    .replace(/^CREATE TABLE "(murmur_launches|murmur_launch_schema)"/, 'CREATE TABLE $1');
}
function validateLaunchTable(store: CoordinationStore, version: 1 | 2): void {
  const table = store.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'murmur_launches'").get();
  assert(typeof table?.sql === 'string' && normalizedSchema(table.sql) === normalizedSchema(launchTableSql('murmur_launches', version)),
    'Unrecognized launch table schema; no automatic schema rewrite is safe.', 'LAUNCH_SCHEMA_INVALID');
  const indexes = store.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'murmur_launches' AND sql IS NOT NULL").all();
  for (const sql of launchIndexes) assert(indexes.some(index => typeof index.sql === 'string' && normalizedSchema(index.sql) === normalizedSchema(sql)),
    'Required launch index is missing or changed.', 'LAUNCH_SCHEMA_INVALID');
}
/** Runs inside the constructor's IMMEDIATE transaction, never base-store user_version. */
function initializeLaunchSchema(store: CoordinationStore): void {
  store.db.exec(launchSchemaSql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
  const metadata = store.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'murmur_launch_schema'").get();
  assert(typeof metadata?.sql === 'string' && normalizedSchema(metadata.sql) === normalizedSchema(launchSchemaSql),
    'Unrecognized launch schema metadata.', 'LAUNCH_SCHEMA_INVALID');
  const schema = store.db.prepare("SELECT version FROM murmur_launch_schema WHERE name = 'launches'").get();
  assert(!schema || schema.version === 1 || schema.version === 2, 'Unsupported launch schema version.', 'SCHEMA_TOO_NEW');
  if (!schema) {
    // No IF NOT EXISTS: an unversioned pre-existing launch table must fail closed.
    store.db.exec(launchTableSql('murmur_launches', 2));
    for (const sql of launchIndexes) store.db.exec(sql);
    store.db.exec("INSERT INTO murmur_launch_schema (name, version) VALUES ('launches', 2)");
  } else if (schema.version === 1) {
    validateLaunchTable(store, 1);
    // DROP must not cascade into an extension table. Unknown triggers may have
    // side effects when copying/deleting, so require explicit support for those too.
    const dependent = store.db.prepare(`SELECT 1 FROM sqlite_schema AS s, pragma_foreign_key_list(s.name) AS f
      WHERE s.type = 'table' AND f."table" = 'murmur_launches' LIMIT 1`).get();
    const trigger = store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'murmur_launches' LIMIT 1").get();
    assert(!dependent && !trigger, 'Launch schema extensions require an explicit migration.', 'LAUNCH_SCHEMA_INVALID');
    const indexes = store.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'murmur_launches' AND sql IS NOT NULL ORDER BY name").all();
    const columns = store.db.prepare('PRAGMA table_info(murmur_launches)').all().map(column => `"${column.name}"`).join(',');
    store.db.exec(launchTableSql('murmur_launches_v2_migration', 2));
    // Copy every persisted column, including NULL revoked tokens and private cache
    // fields, without re-preparing or minting credentials. Preserve rowids as well.
    store.db.exec(`INSERT INTO murmur_launches_v2_migration (rowid,${columns}) SELECT rowid,${columns} FROM murmur_launches`);
    store.db.exec('DROP TABLE murmur_launches');
    store.db.exec('ALTER TABLE murmur_launches_v2_migration RENAME TO murmur_launches');
    for (const index of indexes) store.db.exec(index.sql as string);
    assert(store.db.prepare('PRAGMA foreign_key_check(murmur_launches)').all().length === 0,
      'Launch schema migration failed foreign-key validation.', 'LAUNCH_SCHEMA_INVALID');
    store.db.exec("UPDATE murmur_launch_schema SET version = 2 WHERE name = 'launches'");
  }
  validateLaunchTable(store, 2);
}

/** Human preparation and supervisor liveness, not a process manager or a model sandbox. */
export class LaunchService {
  private store: CoordinationStore;
  private workflow: GitWorkflow;
  private coordination: CoordinationService;
  private runtime: Runtime;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private pending = new Map<string, { digest: string; promise: Promise<LaunchPreparation> }>();
  private queues = new Map<string, Promise<void>>();

  constructor(store: CoordinationStore, workflow: GitWorkflow, coordination: CoordinationService, runtime: Runtime) {
    this.store = store; this.workflow = workflow; this.coordination = coordination; this.runtime = { ...runtime };
    this.transaction(() => {
      initializeLaunchSchema(store);
      // A pre-spawn claim cannot establish whether the OS spawn happened. Never issue a replacement claim.
      const interrupted = store.db.prepare("SELECT * FROM murmur_launches WHERE state IN ('preparing','claimed') AND preparationInstanceId != ?").all(runtime.instanceId) as LaunchRow[];
      for (const row of interrupted) {
        this.recoverArtifacts(row);
        this.terminate(this.row(row.id), 'recovery_required', 'RECOVERY_REQUIRED', 'server_restart');
      }
    });
    this.sweep();
  }
  private transaction<T>(operation: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private row(id: string): LaunchRow {
    const row = this.store.db.prepare('SELECT * FROM murmur_launches WHERE id = ?').get(id) as LaunchRow | undefined;
    assert(row, 'Unknown launch.', 'NOT_FOUND', 404);
    return row;
  }
  private phaseMeta(id: string, phase: string, input: unknown): Mutation {
    return { caller: 'human', key: `launch:${id}:${phase}`, operation: `launch.${phase}`, input };
  }
  private phase(id: string, phase: string): void {
    const changed = this.store.db.prepare("UPDATE murmur_launches SET phase = ? WHERE id = ? AND state = 'preparing'").run(phase, id);
    assert(Number(changed.changes) === 1, 'Launch preparation was interrupted; inspect retained work.', 'RECOVERY_REQUIRED', 409);
  }
  private featureAvailable(projectId: string, featureKey: string | null, exceptId?: string): void {
    if (!featureKey) return;
    const task = this.store.db.prepare("SELECT id FROM tasks WHERE projectId = ? AND featureKey = ? AND status NOT IN ('integrated','abandoned')").get(projectId, featureKey);
    const launch = this.store.db.prepare("SELECT id FROM murmur_launches WHERE projectId = ? AND featureKey = ? AND id != ? AND state IN ('preparing','prepared','claimed','running','recovery_required')").get(projectId, featureKey, exceptId ?? '');
    assert(!task && !launch, 'An existing task or interrupted preparation already owns this feature. Coordinate instead of duplicating it.', 'FEATURE_ALREADY_OWNED', 409);
  }
  private async serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const before = this.queues.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    const queued = before.then(() => tail);
    this.queues.set(projectId, queued);
    await before;
    try { return await operation(); }
    finally { release(); if (this.queues.get(projectId) === queued) this.queues.delete(projectId); }
  }
  private preparation(row: LaunchRow): LaunchPreparation {
    assert(row.state === 'prepared' && row.expiresAt !== null && row.expiresAt > this.store.now(),
      'Preparation is no longer runnable. Inspect this launch; it will not be prepared or spawned again.',
      row.state === 'recovery_required' ? 'RECOVERY_REQUIRED' : 'LAUNCH_NOT_PREPARED', 409);
    assert(row.agentToken && row.supervisorToken && row.sessionId && row.taskId && row.briefing !== null, 'Incomplete launch metadata requires recovery.', 'RECOVERY_REQUIRED', 409);
    this.bound(row, false);
    const agent: AgentConnection = { protocolVersion: PROTOCOL_VERSION, origin: this.runtime.origin, stateId: this.runtime.stateId,
      launchId: row.id, projectId: row.projectId, sessionId: row.sessionId, taskId: row.taskId, agentToken: row.agentToken };
    const supervisor: SupervisorConnection = { protocolVersion: PROTOCOL_VERSION, origin: this.runtime.origin, stateId: this.runtime.stateId,
      launchId: row.id, supervisorToken: row.supervisorToken };
    return { launch: publicStatus(row), agent, supervisor, briefing: row.briefing };
  }
  async prepare(raw: unknown, principal: Principal, mutation: Mutation): Promise<LaunchPreparation> {
    requireHuman(principal);
    assert(!this.closing, 'Launch service is closing.', 'SERVICE_CLOSING', 503);
    const source = fields(raw, ['projectId', 'tool', 'title', 'featureKey', 'baseRevision', 'allowDirtyBase']);
    const data: PrepareInput = { projectId: identifier(source.projectId, 'projectId'),
      tool: source.tool as PrepareInput['tool'], title: text(source.title, 'title', 512),
      featureKey: source.featureKey === undefined ? null : text(source.featureKey, 'featureKey', 128).trim().toLowerCase() };
    assert(data.tool === 'claude' || data.tool === 'codex' || data.tool === 'opencode', 'Only new Claude, Codex, or OpenCode V2 tasks can be prepared.');
    if (own(source, 'baseRevision')) data.baseRevision = text(source.baseRevision, 'baseRevision', 256);
    if (own(source, 'allowDirtyBase')) {
      assert(typeof source.allowDirtyBase === 'boolean', 'allowDirtyBase must be a boolean.');
      data.allowDirtyBase = source.allowDirtyBase;
    }
    assert(mutation.caller === callerId(principal), 'Mutation caller must match the authenticated human.', 'FORBIDDEN', 403);
    const key = requestKey(mutation.key), operation = text(mutation.operation, 'operation', 200);
    const serialized = canonicalJson(source);
    assert(canonicalJson(mutation.input) === serialized, 'Mutation payload must match the preparation input.');
    // Snapshot caller-owned objects before the first await.
    const meta: Mutation = { caller: 'human', key, operation, input: JSON.parse(serialized) };
    const digest = hash(canonicalJson({ method: 'launch.prepare', operation, input: meta.input }));
    this.store.project(data.projectId);
    assert(this.store.project(data.projectId).mode === 'git', 'Managed launches require a Git project.', 'GIT_REQUIRED');
    this.sweep();
    const pendingKey = `${meta.caller}\0${key}`, pending = this.pending.get(pendingKey);
    if (pending) {
      assert(pending.digest === digest, 'Idempotency key was already used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
      const prepared = await pending.promise;
      return this.preparation(this.row(prepared.launch.id));
    }
    const replay = (): LaunchPreparation | undefined => {
      const existing = this.store.db.prepare('SELECT * FROM murmur_launches WHERE requestCaller = ? AND requestKey = ?').get(meta.caller, key) as LaunchRow | undefined;
      if (!existing) {
        assert(!this.store.replay(meta).found, 'Idempotency key belongs to another operation.', 'IDEMPOTENCY_CONFLICT', 409);
        return undefined;
      }
      assert(existing.requestDigest === digest, 'Idempotency key was already used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
      return this.preparation(existing);
    };
    const existing = replay();
    if (existing) return existing;
    this.featureAvailable(data.projectId, data.featureKey);
    const promise = this.serial(data.projectId, async () => {
      const again = replay();
      if (again) return again;
      const id = randomUUID(), nativeSessionId = data.tool === 'claude' ? randomUUID() : null;
      this.transaction(() => {
        this.featureAvailable(data.projectId, data.featureKey);
        assert(!this.store.db.prepare("SELECT id FROM murmur_launches WHERE projectId = ? AND state = 'preparing'").get(data.projectId), 'This project has an interrupted preparation.', 'RECOVERY_REQUIRED', 409);
        this.store.db.prepare(`INSERT INTO murmur_launches
          (id,projectId,tool,title,featureKey,state,nativeSessionId,nativeIdentitySource,createdAt,requestCaller,requestKey,requestDigest,preparationInstanceId,phase)
          VALUES (?,?,?,?,?,'preparing',?,?,?,?,?,?,?,'workspace')`)
          .run(id, data.projectId, data.tool, data.title, data.featureKey, nativeSessionId, data.tool === 'claude' ? 'requested' : 'unverified', this.store.now(), meta.caller, key, digest, this.runtime.instanceId);
        this.store.event(data.projectId, 'launch.preparing', { launchId: id });
      });
      try {
        const workspaceInput = { projectId: data.projectId, ...(data.baseRevision !== undefined ? { baseRevision: data.baseRevision } : {}), ...(data.allowDirtyBase !== undefined ? { allowDirtyBase: data.allowDirtyBase } : {}) };
        const workspace = await this.workflow.createWorkspace(workspaceInput, principal, this.phaseMeta(id, 'workspace', workspaceInput));
        this.phase(id, 'session');
        this.store.db.prepare('UPDATE murmur_launches SET workspaceId = ?, workspaceRoot = ?, baseSha = ? WHERE id = ?').run(workspace.id, workspace.root, workspace.baseSha, id);
        const sessionInput = { projectId: data.projectId, tool: data.tool, nativeId: nativeSessionId ?? `launch:${id}`, instanceId: id, workspaceRoot: workspace.root };
        const registered = this.store.registerSession(sessionInput, this.phaseMeta(id, 'session', sessionInput));
        this.store.db.prepare("UPDATE murmur_launches SET sessionId = ?, phase = 'task' WHERE id = ?").run(registered.session.id, id);
        const taskInput = { projectId: data.projectId, sessionId: registered.session.id, title: data.title, featureKey: data.featureKey };
        // Core createTask holds the final uniqueness check and insert in the same transaction.
        const task = this.store.createTask(taskInput, this.phaseMeta(id, 'task', taskInput));
        this.store.db.prepare("UPDATE murmur_launches SET taskId = ?, phase = 'attachment' WHERE id = ?").run(task.id, id);
        const attachInput = { taskId: task.id, workspaceId: workspace.id, revision: task.revision };
        await this.workflow.attachWorkspace(attachInput, principal, this.phaseMeta(id, 'attachment', attachInput));
        this.phase(id, 'binding');
        // context has its own short read transaction; never call it inside bind's write transaction.
        const briefing = this.coordination.context(data.projectId, task.id).briefing;
        const agentToken = credential(), supervisorToken = credential();
        const result = this.store.mutate(meta, () => {
          const row = this.row(id), current = this.store.task(task.id), session = this.store.session(registered.session.id);
          assert(row.state === 'preparing' && current.ownerSessionId === session.id && current.projectId === row.projectId && current.status === 'active', 'Task changed during preparation.', 'RECOVERY_REQUIRED', 409);
          const attachment = this.store.db.prepare('SELECT workspaceId FROM workflow_attachments WHERE taskId = ?').get(task.id);
          assert(attachment?.workspaceId === workspace.id && session.workspaceRoot === workspace.root, 'Workspace changed during preparation.', 'RECOVERY_REQUIRED', 409);
          this.store.db.prepare("UPDATE sessions SET tokenHash = ?, credentialMode = 'managed' WHERE id = ?").run(hash(agentToken), session.id);
          this.store.db.prepare(`UPDATE murmur_launches SET state = 'prepared', phase = 'complete', lifecycleRevision = 1,
            expiresAt = ?, agentHash = ?, agentToken = ?, supervisorHash = ?, supervisorToken = ?, briefing = ? WHERE id = ?`)
            .run(this.store.now() + MANAGED_TTL_MS, hash(agentToken), agentToken, hash(supervisorToken), supervisorToken, briefing, id);
          this.store.event(data.projectId, 'launch.prepared', publicStatus(this.row(id)));
          return { launchId: id }; // The general mutation journal never receives either runnable credential.
        });
        assert(result.launchId === id, 'Preparation identity changed.', 'IDEMPOTENCY_CONFLICT', 409);
        return this.preparation(this.row(id));
      } catch (rawError) {
        const safeCodes = new Set(['DIRTY_BASE', 'FEATURE_ALREADY_OWNED', 'RECOVERY_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_IDENTITY_CHANGED', 'PROJECT_IDENTITY_UNBOUND', 'GIT_REQUIRED', 'UNSUPPORTED_REPOSITORY']);
        const code = rawError instanceof MurmurError && safeCodes.has(rawError.code) ? rawError.code : 'LAUNCH_PREPARATION_FAILED';
        this.transaction(() => {
          const row = this.row(id);
          if (row.state !== 'preparing') return;
          this.recoverArtifacts(row);
          const recovered = this.row(id);
          this.terminate(recovered, recovered.workspaceId || recovered.sessionId || recovered.taskId ? 'recovery_required' : 'failed', code, 'preparation_failed');
        });
        throw new MurmurError('Launch preparation could not finish. Recorded work was preserved; inspect the launch before any explicit new attempt.', code, 409, { launchId: id });
      }
    });
    this.pending.set(pendingKey, { digest, promise });
    try { return await promise; }
    finally { this.pending.delete(pendingKey); }
  }
  /** Reconcile only IDs already journaled by core/workflow; never repeat a side effect after a crash. */
  private recoverArtifacts(row: LaunchRow): void {
    if (!row.workspaceId) {
      const request = this.store.db.prepare("SELECT entityId FROM workflow_requests WHERE caller = 'human' AND key = ? AND entityKind = 'workspace'").get(this.phaseMeta(row.id, 'workspace', {}).key);
      if (request) {
        const workspace = this.store.db.prepare('SELECT id, root, baseSha FROM workflow_workspaces WHERE id = ? AND projectId = ?').get(request.entityId!, row.projectId);
        if (workspace) this.store.db.prepare('UPDATE murmur_launches SET workspaceId = ?, workspaceRoot = ?, baseSha = ? WHERE id = ?').run(workspace.id!, workspace.root!, workspace.baseSha!, row.id);
      }
    }
    if (!row.sessionId) {
      const session = this.store.db.prepare('SELECT id FROM sessions WHERE projectId = ? AND tool = ? AND nativeId = ? AND instanceId = ?')
        .get(row.projectId, row.tool, row.nativeSessionId ?? `launch:${row.id}`, row.id);
      if (session) this.store.db.prepare('UPDATE murmur_launches SET sessionId = ? WHERE id = ?').run(session.id!, row.id);
    }
    if (!row.taskId) {
      const cached = this.store.db.prepare("SELECT response FROM mutations WHERE caller = 'human' AND key = ?").get(this.phaseMeta(row.id, 'task', {}).key);
      if (cached) {
        const result = JSON.parse(cached.response as string) as { id?: string };
        if (typeof result.id === 'string') {
          const task = this.store.db.prepare('SELECT id FROM tasks WHERE id = ? AND projectId = ? AND ownerSessionId = ?').get(result.id, row.projectId, this.row(row.id).sessionId);
          if (task) this.store.db.prepare('UPDATE murmur_launches SET taskId = ? WHERE id = ?').run(task.id!, row.id);
        }
      }
    }
  }
  private release(row: LaunchRow, reason: string): void {
    if (!row.sessionId || !row.taskId) return;
    const leases = this.store.db.prepare('SELECT id FROM leases WHERE projectId = ? AND sessionId = ? AND taskId = ? AND releasedAt IS NULL').all(row.projectId, row.sessionId, row.taskId);
    this.store.db.prepare('UPDATE leases SET releasedAt = ? WHERE projectId = ? AND sessionId = ? AND taskId = ? AND releasedAt IS NULL').run(this.store.now(), row.projectId, row.sessionId, row.taskId);
    for (const lease of leases) this.store.event(row.projectId, 'reservation.released', { id: lease.id, taskId: row.taskId, sessionId: row.sessionId, launchId: row.id, reason });
  }
  private terminate(row: LaunchRow, state: 'ended' | 'expired' | 'failed' | 'recovery_required', errorCode: string | null, reason: string, exitCode: number | null = null): void {
    if (row.sessionId) this.store.db.prepare("UPDATE sessions SET tokenHash = ?, credentialMode = 'managed' WHERE id = ?").run(hash(credential()), row.sessionId);
    this.release(row, reason);
    this.store.db.prepare(`UPDATE murmur_launches SET state = ?, lifecycleRevision = lifecycleRevision + 1,
      endedAt = ?, expiresAt = ?, exitCode = ?, errorCode = ?, endReason = ?, agentToken = NULL, supervisorToken = NULL WHERE id = ?`)
      .run(state, this.store.now(), this.store.now(), exitCode, errorCode, reason, row.id);
    this.store.event(row.projectId, `launch.${state}`, { ...publicStatus(this.row(row.id)), reason });
  }
  control(action: ControlAction, token: string, raw: unknown, key?: string): LaunchStatus {
    assert(['status', 'claim', 'started', 'heartbeat', 'end'].includes(action), 'Unknown supervisor operation.');
    const allowed = action === 'status' ? ['launchId'] : ['launchId', 'controllerId', 'revision', ...(action === 'started' ? ['pid'] : action === 'end' ? ['reason', 'exitCode'] : [])];
    const source = fields(raw, allowed), launchId = identifier(source.launchId, 'launchId');
    const row = this.store.db.prepare('SELECT * FROM murmur_launches WHERE id = ?').get(launchId) as LaunchRow | undefined;
    assert(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && row?.supervisorHash && timingSafeEqual(Buffer.from(row.supervisorHash, 'hex'), Buffer.from(hash(token), 'hex')),
      'A supervisor credential bound to this launch is required.', 'SUPERVISOR_UNAUTHORIZED', 401);
    this.sweep();
    if (action === 'status') return publicStatus(this.row(launchId));
    const controllerId = identifier(source.controllerId, 'controllerId'), revision = integer(source.revision, 'revision', 1, Number.MAX_SAFE_INTEGER - 1);
    const input: Record<string, unknown> = { launchId, controllerId, revision };
    if (action === 'started') input.pid = integer(source.pid, 'pid', 1, 2147483647);
    if (action === 'end') {
      assert(['exited', 'interrupted', 'spawn_failed', 'lease_lost'].includes(source.reason as string), 'Invalid launch end reason.');
      input.reason = source.reason;
      input.exitCode = source.exitCode === null ? null : integer(source.exitCode, 'exitCode', -2147483648, 2147483647);
    }
    const mutation: Mutation = { caller: `supervisor:${launchId}`, key: requestKey(key), operation: `launch.control.${action}`, input };
    const cached = this.store.replay<LaunchStatus>(mutation), current = this.row(launchId);
    if (cached.found) {
      assert(current.controllerId === controllerId, 'Only the claiming controller may control this launch.', 'CONTROLLER_MISMATCH', 403);
      if (action === 'end' && current.state === 'ended') return cached.response;
      assert(live(current, this.store.now()), 'Launch is no longer active; a cached response cannot revive it.', 'LAUNCH_INACTIVE', 409);
      return cached.response;
    }
    return this.store.mutate(mutation, () => {
      const current = this.row(launchId);
      if (action === 'claim') {
        assert(current.state === 'prepared' && current.controllerId === null && current.expiresAt !== null && current.expiresAt > this.store.now(), 'Launch was already claimed or is no longer prepared. No replacement spawn is permitted.', 'LAUNCH_NOT_PREPARED', 409);
        this.bound(current, false);
      } else {
        assert(live(current, this.store.now()), 'Launch is no longer active.', 'LAUNCH_INACTIVE', 409);
        assert(current.controllerId === controllerId, 'Only the claiming controller may control this launch.', 'CONTROLLER_MISMATCH', 403);
      }
      assert(current.lifecycleRevision === revision, 'Launch lifecycle revision is stale.', 'STALE_REVISION', 409);
      if (action === 'claim') this.store.db.prepare("UPDATE murmur_launches SET state = 'claimed', controllerId = ?, lifecycleRevision = lifecycleRevision + 1, agentToken = NULL, supervisorToken = NULL, preparationInstanceId = ? WHERE id = ? AND state = 'prepared' AND lifecycleRevision = ?")
        .run(controllerId, this.runtime.instanceId, launchId, revision);
      else if (action === 'started') {
        assert(current.state === 'claimed', 'A launch may be marked started only once after claim.', 'INVALID_LAUNCH_STATE', 409);
        this.store.db.prepare("UPDATE murmur_launches SET state = 'running', pid = ?, startedAt = ?, lifecycleRevision = lifecycleRevision + 1 WHERE id = ?").run(input.pid as number, this.store.now(), launchId);
      } else if (action === 'heartbeat') this.store.db.prepare('UPDATE murmur_launches SET expiresAt = ?, lifecycleRevision = lifecycleRevision + 1 WHERE id = ?').run(this.store.now() + MANAGED_TTL_MS, launchId);
      else {
        this.terminate(current, 'ended', input.reason === 'spawn_failed' ? 'SPAWN_FAILED' : input.reason === 'lease_lost' ? 'LEASE_LOST' : null, input.reason as string, input.exitCode as number | null);
        return publicStatus(this.row(launchId));
      }
      const result = publicStatus(this.row(launchId));
      this.store.event(current.projectId, `launch.${action === 'claim' ? 'claimed' : action}`, result);
      return result;
    });
  }
  private bound(row: LaunchRow, requireActive = true): { sessionId: string; taskId: string } {
    assert(!requireActive || live(row, this.store.now()), 'Managed launch is not active.', 'AGENT_UNAUTHORIZED', 401);
    const session = row.sessionId ? this.store.db.prepare('SELECT projectId, credentialMode, tokenHash, workspaceRoot FROM sessions WHERE id = ?').get(row.sessionId) : undefined;
    const task = row.taskId ? this.store.db.prepare('SELECT projectId, ownerSessionId FROM tasks WHERE id = ?').get(row.taskId) : undefined;
    assert(session && task && session.credentialMode === 'managed' && session.tokenHash === row.agentHash && session.projectId === row.projectId && task.projectId === row.projectId && task.ownerSessionId === row.sessionId && session.workspaceRoot === row.workspaceRoot,
      'Managed credential no longer owns its bound task and workspace.', 'AGENT_UNAUTHORIZED', 401);
    return { sessionId: row.sessionId!, taskId: row.taskId! };
  }
  identity(sessionId: string): AgentIdentity {
    this.sweep();
    const row = this.store.db.prepare('SELECT * FROM murmur_launches WHERE sessionId = ?').get(sessionId) as LaunchRow | undefined;
    assert(row, 'Managed launch metadata is missing.', 'AGENT_UNAUTHORIZED', 401);
    const bound = this.bound(row);
    return { role: 'agent', protocolVersion: PROTOCOL_VERSION, stateId: this.runtime.stateId, instanceId: this.runtime.instanceId,
      launchId: row.id, projectId: row.projectId, ...bound, expiresAt: row.expiresAt! };
  }
  authorizeAgent(sessionId: string, method: string, url: URL, body?: Record<string, unknown>): AgentIdentity {
    const identity = this.identity(sessionId);
    const deny = (condition: unknown) => assert(condition, 'This managed credential is restricted to its assigned task.', 'AGENT_FORBIDDEN', 403);
    if (method === 'GET') {
      deny(body === undefined);
      if (url.pathname === '/health' || url.pathname === '/v1/agent/identity') deny(!url.search);
      else {
        deny(url.pathname === '/v1/context');
        for (const key of url.searchParams.keys()) deny(['projectId', 'taskId', 'after'].includes(key) && url.searchParams.getAll(key).length === 1);
        deny(url.searchParams.get('projectId') === identity.projectId);
        deny(!url.searchParams.has('taskId') || url.searchParams.get('taskId') === identity.taskId);
        if (url.searchParams.has('after')) integer(Number(url.searchParams.get('after')), 'after', 0, Number.MAX_SAFE_INTEGER);
      }
    } else {
      deny(method === 'POST' && !url.search);
      const routes: Record<string, string[]> = {
        '/v1/intents': ['taskId', 'revision', 'acceptanceCriteria', 'reads', 'writes', 'produces', 'consumes', 'dependencies'],
        '/v1/check-plan': ['projectId', 'taskId', 'title', 'writes', 'produces', 'consumes'],
        '/v1/tasks/update': ['taskId', 'revision', 'status', 'blocker'],
        '/v1/decisions/propose': ['projectId', 'taskId', 'key', 'value', 'version', 'rationale'],
        '/v1/reservations/acquire': ['projectId', 'sessionId', 'taskId', 'taskRevision', 'resources', 'ttlSeconds'],
        '/v1/reservations/release': ['leaseId', 'sessionId', 'generation'],
        '/v1/submissions': ['taskId', 'revision'],
        '/v1/groups/requests': ['groupTitle', 'groupGoal', 'inviteHash', 'responsibility', 'handoff'],
        '/v1/groups/members/leave': ['memberId', 'revision'],
      };
      deny(own(routes, url.pathname));
      const input = object(body);
      deny(Object.keys(input).every(key => routes[url.pathname]!.includes(key)));
      if (url.pathname === '/v1/groups/requests') {
        // No selectors: GroupsService derives the existing immutable managed task binding.
      } else if (url.pathname === '/v1/groups/members/leave') {
        const member = this.store.db.prepare("SELECT projectId,sessionId,taskId,kind,state FROM group_members WHERE id=?").get(identifier(input.memberId, 'memberId'));
        deny(member && member.projectId === identity.projectId && member.sessionId === identity.sessionId && member.taskId === identity.taskId && member.kind === 'managed' && member.state === 'active');
      } else if (url.pathname === '/v1/reservations/release') {
        deny(input.sessionId === identity.sessionId);
        const lease = this.store.db.prepare('SELECT projectId, sessionId, taskId FROM leases WHERE id = ?').get(identifier(input.leaseId, 'leaseId'));
        deny(lease && lease.projectId === identity.projectId && lease.sessionId === identity.sessionId && lease.taskId === identity.taskId);
      } else deny(input.taskId === identity.taskId);
      if (routes[url.pathname]!.includes('projectId')) deny(input.projectId === identity.projectId);
      if (routes[url.pathname]!.includes('sessionId')) deny(input.sessionId === identity.sessionId);
      if (url.pathname === '/v1/tasks/update') deny(['active', 'blocked', 'ready'].includes(input.status as string));
    }
    // Bridge use is evidence of an authenticated request, never evidence of model compliance or supervisor liveness.
    this.transaction(() => {
      const row = this.row(identity.launchId);
      this.bound(row);
      if (row.bridgeFirstSeenAt === null) this.store.event(row.projectId, 'launch.bridge_used', { launchId: row.id, sessionId, taskId: row.taskId });
      this.store.db.prepare('UPDATE murmur_launches SET bridgeFirstSeenAt = COALESCE(bridgeFirstSeenAt, ?), bridgeLastSeenAt = ? WHERE id = ?').run(this.store.now(), this.store.now(), row.id);
    });
    return identity;
  }
  list(projectId?: string): LaunchStatus[] {
    this.sweep();
    if (projectId !== undefined) this.store.project(projectId);
    const rows = projectId === undefined ? this.store.db.prepare('SELECT * FROM murmur_launches ORDER BY createdAt,id').all()
      : this.store.db.prepare('SELECT * FROM murmur_launches WHERE projectId = ? ORDER BY createdAt,id').all(projectId);
    return (rows as LaunchRow[]).map(publicStatus);
  }
  get(id: string): LaunchStatus { this.sweep(); return publicStatus(this.row(id)); }
  sweep(): void {
    this.transaction(() => {
      const rows = this.store.db.prepare("SELECT * FROM murmur_launches WHERE state IN ('prepared','claimed','running') AND expiresAt <= ? ORDER BY expiresAt,id LIMIT 100").all(this.store.now()) as LaunchRow[];
      for (const row of rows) this.terminate(row, 'expired', 'LAUNCH_EXPIRED', 'supervisor_expired');
    });
  }
  start(): void {
    assert(!this.closing, 'Launch service is closing.', 'SERVICE_CLOSING', 503);
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.sweep(); } catch { /* A request still fails closed on its own deadline check. */ } }, Math.min(HEARTBEAT_MS, 5000));
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await Promise.allSettled([...this.pending.values()].map(item => item.promise));
  }
}
