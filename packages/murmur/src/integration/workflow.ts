import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assert, authorizeProject, authorizeSession, callerId, canonicalJson, integer, MurmurError, object, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';
import type { CoordinationStore, Project } from '../storage/store.js';
import { resourcesOverlap } from '../workspaces/identity.js';
import { ancestor, checkIdentity, clean, fingerprint, git, nonnested, privatePath, refValue, revision, run, status, supported, value, worktrees } from './git.js';

type Row = Record<string, any>;
export type ValidationCommand = { command: string; args: string[]; timeoutMs: number };
export type Workspace = { id: string; projectId: string; root: string; kind: 'managed' | 'adopted'; disposable: boolean; status: string; baseSha: string; baseRef: string; branch: string | null; createdAt: number; recovery: string | null };
export type Changeset = { id: string; projectId: string; taskId: string; workspaceId: string; sourceSha: string; baseSha: string; sourceRef: string; taskRevision: number; submittedRevision: number; status: string; createdAt: number };
export type ValidationResult = { status: 'passed' | 'failed' | 'unverified' | 'invalidated'; candidateSha: string; targetSha: string; configHash: string; configRevision: number; checks: Row[]; checkedAt: number };
export type IntegrationJob = { id: string; projectId: string; changesetId: string; status: string; sourceSha: string; baseSha: string; targetSha: string; candidateSha: string | null; targetRef: string; sourceRef: string; targetPinRef: string; candidateRef: string; candidateRoot: string; validation: ValidationResult | null; createdAt: number; updatedAt: number; recovery: string | null };
const hash = (input: unknown) => createHash('sha256').update(canonicalJson(input)).digest('hex');
const terminalTask = (state: string) => state === 'integrated' || state === 'abandoned';
const queues = new Map<string, Promise<void>>();
const activeRequests = new Set<string>();
const emptyConfig = () => ({ revision: 0, commands: [] as ValidationCommand[], configHash: hash([]) });

/** Local, journaled Git integration. A single daemon owns the database/state directory. */
export class GitWorkflow {
  store: CoordinationStore;
  stateDirectory: string;
  private initializing: Promise<void> | undefined;
  private controllers = new Map<string, AbortController>();

  constructor(store: CoordinationStore, stateDirectory: string) {
    this.store = store;
    this.stateDirectory = path.resolve(stateDirectory);
    this.transaction(() => {
      store.db.exec('CREATE TABLE IF NOT EXISTS workflow_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL)');
      const schema = store.db.prepare("SELECT version FROM workflow_schema WHERE name = 'git'").get() as Row | undefined;
      assert(!schema || schema.version === 1, 'Unsupported workflow schema version.', 'SCHEMA_TOO_NEW');
      if (!schema) {
        store.db.exec(`
          CREATE TABLE workflow_projects (
            projectId TEXT PRIMARY KEY REFERENCES projects(id), identity TEXT NOT NULL,
            targetRef TEXT NOT NULL, integrationBase TEXT, targetStatus TEXT NOT NULL DEFAULT 'absent'
          );
          CREATE TABLE workflow_workspaces (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), root TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL, status TEXT NOT NULL, baseSha TEXT NOT NULL, baseRef TEXT NOT NULL,
            branch TEXT, identity TEXT, createdAt INTEGER NOT NULL, recovery TEXT
          );
          CREATE TABLE workflow_attachments (
            taskId TEXT PRIMARY KEY REFERENCES tasks(id), workspaceId TEXT NOT NULL REFERENCES workflow_workspaces(id)
          );
          CREATE TABLE workflow_configs (
            projectId TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL,
            commands TEXT NOT NULL, configHash TEXT NOT NULL
          );
          CREATE TABLE workflow_changesets (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), taskId TEXT NOT NULL REFERENCES tasks(id),
            workspaceId TEXT NOT NULL REFERENCES workflow_workspaces(id), sourceSha TEXT NOT NULL, baseSha TEXT NOT NULL,
            sourceRef TEXT NOT NULL, taskRevision INTEGER NOT NULL, submittedRevision INTEGER NOT NULL,
            status TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(taskId, submittedRevision)
          );
          CREATE TABLE workflow_jobs (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), changesetId TEXT NOT NULL REFERENCES workflow_changesets(id),
            status TEXT NOT NULL, sourceSha TEXT NOT NULL, baseSha TEXT NOT NULL, targetSha TEXT NOT NULL,
            candidateSha TEXT, targetRef TEXT NOT NULL, sourceRef TEXT NOT NULL, targetPinRef TEXT NOT NULL,
            candidateRef TEXT NOT NULL, candidateRoot TEXT NOT NULL, identity TEXT, validation TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, recovery TEXT
          );
          CREATE TABLE workflow_requests (
            caller TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id),
            method TEXT NOT NULL, status TEXT NOT NULL, entityKind TEXT, entityId TEXT, response TEXT, error TEXT,
            createdAt INTEGER NOT NULL, PRIMARY KEY(caller, key)
          );
          CREATE INDEX workflow_jobs_project ON workflow_jobs(projectId, createdAt);
          CREATE INDEX workflow_requests_project ON workflow_requests(projectId, status);
          INSERT INTO workflow_schema VALUES ('git', 1);
        `);
      }
    });
  }
  private transaction<T>(operation: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private async serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.store.project(projectId).canonicalPath;
    const before = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    const queued = before.then(() => tail);
    queues.set(key, queued);
    await before;
    try { return await operation(); }
    finally { release(); if (queues.get(key) === queued) queues.delete(key); }
  }
  private requestKey(mutation: Mutation): string { return `${mutation.caller}\0${mutation.key}`; }
  private request(mutation: Mutation): Row | undefined {
    return this.store.db.prepare('SELECT * FROM workflow_requests WHERE caller = ? AND key = ?').get(mutation.caller, mutation.key) as Row | undefined;
  }
  private replay(method: string, input: unknown, principal: Principal, mutation: Mutation): { found: boolean; response?: any } {
    assert(mutation.caller === callerId(principal), 'Mutation caller does not match the authenticated principal.', 'FORBIDDEN', 403);
    text(mutation.key, 'idempotency key', 200); text(mutation.operation, 'operation', 200);
    assert(canonicalJson(mutation.input) === canonicalJson(input), 'Mutation payload must match the requested input.', 'INVALID_INPUT');
    const row = this.request(mutation);
    if (row) {
      assert(row.digest === hash({ method, operation: mutation.operation, input }), 'Idempotency key was used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
      if (row.status === 'complete') return { found: true, response: JSON.parse(row.response) };
      if (row.status === 'failed') {
        const error = JSON.parse(row.error);
        throw new MurmurError(error.message, error.code, error.status, error.details);
      }
      throw new MurmurError('This request is in progress or was interrupted. Inspect the recorded entity; use a new key only for an explicit new attempt.', row.status === 'running' ? 'WORKFLOW_IN_PROGRESS' : 'RECOVERY_REQUIRED', 409, { entityKind: row.entityKind, entityId: row.entityId });
    }
    return this.store.replay(mutation);
  }
  private entity(mutation: Mutation, kind: string, id: string): void {
    this.store.db.prepare('UPDATE workflow_requests SET entityKind = ?, entityId = ? WHERE caller = ? AND key = ?').run(kind, id, mutation.caller, mutation.key);
  }
  private async mutation(input: unknown, principal: Principal, meta: Mutation, method: string, projectId: string, human: boolean, operation: () => Promise<any>): Promise<any> {
    authorizeProject(principal, projectId);
    if (human) requireHuman(principal);
    const cached = this.replay(method, input, principal, meta);
    if (cached.found) return cached.response;
    await this.initialize();
    return this.serial(projectId, async () => {
      const again = this.replay(method, input, principal, meta);
      if (again.found) return again.response;
      this.transaction(() => {
        const busy = this.store.db.prepare("SELECT key FROM workflow_requests WHERE projectId = ? AND status = 'running'").get(projectId);
        assert(!busy, 'Project has a pending workflow operation; reconcile it before continuing.', 'WORKFLOW_BUSY', 409);
        this.store.db.prepare('INSERT INTO workflow_requests(caller,key,digest,projectId,method,status,createdAt) VALUES (?,?,?,?,?,?,?)').run(meta.caller, meta.key, hash({ method, operation: meta.operation, input }), projectId, method, 'running', this.store.now());
      });
      const activeKey = this.requestKey(meta);
      activeRequests.add(activeKey);
      try {
        const response = await operation();
        return this.store.mutate(meta, () => {
          this.store.db.prepare("UPDATE workflow_requests SET status = 'complete', response = ? WHERE caller = ? AND key = ?").run(JSON.stringify(response), meta.caller, meta.key);
          return response;
        });
      } catch (raw) {
        const error = raw instanceof MurmurError ? raw : new MurmurError('Workflow operation failed; any recorded work was preserved for inspection.', 'WORKFLOW_FAILED', 409);
        const row = this.request(meta)!;
        this.transaction(() => {
          if (row.entityKind === 'workspace') this.store.db.prepare("UPDATE workflow_workspaces SET status = 'recovery_required', recovery = ? WHERE id = ? AND status = 'creating'").run(error.code, row.entityId);
          if (row.entityKind === 'changeset') this.store.db.prepare("UPDATE workflow_changesets SET status = 'recovery_required' WHERE id = ? AND status = 'pinning'").run(row.entityId);
          if (row.entityKind === 'job') this.store.db.prepare("UPDATE workflow_jobs SET status = CASE WHEN status = 'validating' THEN 'invalidated' ELSE 'recovery_required' END, recovery = ?, updatedAt = ? WHERE id = ? AND status IN ('preparing','validating')").run(error.code, this.store.now(), row.entityId);
          const promoting = row.entityKind === 'job' && this.jobRow(row.entityId).status === 'promoting';
          this.store.db.prepare('UPDATE workflow_requests SET status = ?, error = ? WHERE caller = ? AND key = ?').run(promoting ? 'interrupted' : 'failed', JSON.stringify({ message: error.message, code: error.code, status: error.status, details: { ...(error.details && typeof error.details === 'object' ? error.details : {}), entityKind: row.entityKind, entityId: row.entityId } }), meta.caller, meta.key);
        });
        throw error;
      } finally { activeRequests.delete(activeKey); }
    });
  }

  /** Observe interrupted stages, never reset/delete worktrees or force refs. */
  initialize(): Promise<void> {
    this.initializing ??= this.recover();
    return this.initializing;
  }
  private async recover(): Promise<void> {
    const projects = this.store.db.prepare('SELECT * FROM workflow_projects').all() as Row[];
    for (const project of projects) await this.serial(project.projectId, async () => {
      try {
        await checkIdentity(JSON.parse(project.identity));
        if (project.targetStatus === 'initializing') {
          const target = await refValue(this.store.project(project.projectId).root, project.targetRef);
          this.store.db.prepare('UPDATE workflow_projects SET targetStatus = ? WHERE projectId = ?').run(target === project.integrationBase ? 'ready' : 'recovery_required', project.projectId);
        }
        const pending = this.store.db.prepare("SELECT * FROM workflow_jobs WHERE projectId = ? AND status = 'promoting'").all(project.projectId) as Row[];
        for (const job of pending) {
          const current = await refValue(this.store.project(project.projectId).root, job.targetRef);
          if (current === job.candidateSha && job.candidateSha) {
            // A matching ref alone is not enough: verify our pinned source/candidate.
            await this.candidate(job);
            assert(await refValue(this.store.project(project.projectId).root, job.sourceRef) === job.sourceSha, 'Recovery source ref moved.', 'RECOVERY_REQUIRED');
            this.finishPromotion(job);
          } else this.updateJob(job.id, 'recovery_required', current === job.targetSha ? 'Promotion interrupted before ref update; nothing retried.' : 'Integration target changed during interruption.');
        }
      } catch {
        this.store.db.prepare("UPDATE workflow_jobs SET status = 'recovery_required', recovery = 'Interrupted promotion cannot be verified; inspect refs and worktrees manually.' WHERE projectId = ? AND status = 'promoting'").run(project.projectId);
      }
    });
    this.transaction(() => {
      const requests = this.store.db.prepare("SELECT * FROM workflow_requests WHERE status IN ('running','interrupted')").all() as Row[];
      for (const request of requests) {
        if (activeRequests.has(`${request.caller}\0${request.key}`)) continue;
        if (request.entityKind === 'job' && this.jobRow(request.entityId).status === 'promoted') {
          this.store.db.prepare("UPDATE workflow_requests SET status = 'complete', response = ? WHERE caller = ? AND key = ?").run(JSON.stringify(this.getJob(request.entityId)), request.caller, request.key);
        } else this.store.db.prepare("UPDATE workflow_requests SET status = 'interrupted' WHERE caller = ? AND key = ?").run(request.caller, request.key);
      }
      this.store.db.exec("UPDATE workflow_workspaces SET status = 'recovery_required', recovery = 'Creation interrupted; worktree and refs were retained.' WHERE status = 'creating'; UPDATE workflow_changesets SET status = 'recovery_required' WHERE status = 'pinning'; UPDATE workflow_jobs SET status = 'recovery_required', recovery = 'Preparation interrupted; worktree and refs were retained.' WHERE status = 'preparing'; UPDATE workflow_jobs SET status = 'invalidated', recovery = 'Validation interrupted; no successful result is assumed.' WHERE status = 'validating';");
    });
  }
  private async projectIdentity(projectId: string): Promise<Project> {
    const project = this.store.project(projectId);
    assert(project.mode === 'git', 'Plain folders are advisory-only; isolation and integration require a local Git repository.', 'GIT_REQUIRED');
    const row = this.store.db.prepare('SELECT * FROM workflow_projects WHERE projectId = ?').get(projectId) as Row | undefined;
    if (row) await checkIdentity(JSON.parse(row.identity));
    else {
      const identity = await fingerprint(project.root, project.canonicalPath);
      assert(/^[a-zA-Z0-9-]+$/.test(projectId), 'Unsupported project ID for integration refs.');
      this.store.db.prepare('INSERT INTO workflow_projects(projectId,identity,targetRef) VALUES (?,?,?)').run(projectId, JSON.stringify(identity), `refs/heads/murmur/integration/${projectId}`);
    }
    await supported(project.root);
    return project;
  }
  private workspaceRow(id: string): Row {
    const row = this.store.db.prepare('SELECT * FROM workflow_workspaces WHERE id = ?').get(id) as Row | undefined;
    assert(row, 'Unknown workspace.', 'NOT_FOUND', 404); return row;
  }
  private workspace(id: string): Workspace {
    const { identity: _identity, ...row } = this.workspaceRow(id);
    return { ...row, disposable: row.kind === 'managed' } as Workspace;
  }
  private async validWorkspace(id: string): Promise<Row> {
    const row = this.workspaceRow(id);
    assert(row.status === 'ready' && row.identity, 'Workspace requires manual recovery.', 'RECOVERY_REQUIRED', 409);
    await checkIdentity(JSON.parse(row.identity));
    assert(await refValue(row.root, row.baseRef) === row.baseSha, 'Workspace base pin changed.', 'WORKSPACE_IDENTITY_CHANGED', 409);
    return row;
  }
  listWorkspaces(projectId: string): Workspace[] {
    this.store.project(projectId);
    return (this.store.db.prepare('SELECT id FROM workflow_workspaces WHERE projectId = ? ORDER BY createdAt,id').all(projectId) as Row[]).map(row => this.workspace(row.id));
  }
  async createWorkspace(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), projectId = text(data.projectId, 'projectId');
    return this.mutation(input, principal, mutation, 'createWorkspace', projectId, true, async () => {
      assert(data.allowDirtyBase === undefined || typeof data.allowDirtyBase === 'boolean', 'allowDirtyBase must be a boolean.');
      const project = await this.projectIdentity(projectId);
      const dirty = await status(project.root);
      assert(!dirty.length || data.allowDirtyBase === true, 'Original checkout is dirty. Explicitly allow a committed base; dirty files will never be copied or stashed.', 'DIRTY_BASE', 409);
      const baseSha = await revision(project.root, data.baseRevision === undefined ? 'HEAD' : text(data.baseRevision, 'baseRevision', 256));
      await supported(project.root, baseSha);
      const id = randomUUID(), branch = `murmur/workspace/${id}`, baseRef = `refs/murmur/bases/${id}`;
      await mkdir(path.join(this.stateDirectory, 'workspaces'), { recursive: true, mode: 0o700 });
      const parent = await realpath(path.join(this.stateDirectory, 'workspaces'));
      const root = path.join(parent, id);
      await nonnested(project.root, root);
      this.transaction(() => {
        this.store.db.prepare('INSERT INTO workflow_workspaces(id,projectId,root,kind,status,baseSha,baseRef,branch,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(id, projectId, root, 'managed', 'creating', baseSha, baseRef, branch, this.store.now());
        this.entity(mutation, 'workspace', id);
      });
      await git(project.root, ['update-ref', '--no-deref', baseRef, baseSha, '']);
      await git(project.root, ['worktree', 'add', '-b', branch, '--', root, baseSha]);
      const identity = await fingerprint(root, project.canonicalPath);
      await clean(root);
      assert(await revision(root, 'HEAD') === baseSha, 'Created worktree changed unexpectedly.', 'WORKSPACE_IDENTITY_CHANGED');
      this.transaction(() => {
        this.store.db.prepare("UPDATE workflow_workspaces SET identity = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(identity), id);
        this.store.event(projectId, 'workspace.created', { id, baseSha, dirtyBaseExcluded: dirty.length > 0 });
      });
      return { ...this.workspace(id), dirtyBaseExcluded: dirty.length > 0 };
    });
  }
  async adoptWorkspace(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), projectId = text(data.projectId, 'projectId');
    return this.mutation(input, principal, mutation, 'adoptWorkspace', projectId, true, async () => {
      const project = await this.projectIdentity(projectId);
      const identity = await fingerprint(text(data.root, 'root', 4096), project.canonicalPath);
      await nonnested(project.root, identity.root);
      assert(!this.store.db.prepare('SELECT id FROM workflow_workspaces WHERE root = ?').get(identity.root), 'Workspace is already recorded.', 'WORKSPACE_EXISTS', 409);
      const baseSha = await revision(identity.root, 'HEAD');
      await supported(identity.root, baseSha);
      const id = randomUUID(), baseRef = `refs/murmur/bases/${id}`;
      const branchResult = await git(identity.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
      assert(branchResult.code === 0 || branchResult.code === 1, 'Could not inspect workspace branch.', 'GIT_FAILED');
      this.transaction(() => {
        this.store.db.prepare('INSERT INTO workflow_workspaces(id,projectId,root,kind,status,baseSha,baseRef,branch,identity,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, projectId, identity.root, 'adopted', 'creating', baseSha, baseRef, branchResult.code === 0 ? branchResult.stdout.trim() : null, JSON.stringify(identity), this.store.now());
        this.entity(mutation, 'workspace', id);
      });
      await git(project.root, ['update-ref', '--no-deref', baseRef, baseSha, '']);
      await checkIdentity(identity);
      this.transaction(() => {
        this.store.db.prepare("UPDATE workflow_workspaces SET status = 'ready' WHERE id = ?").run(id);
        this.store.event(projectId, 'workspace.adopted', { id, disposable: false, baseSha });
      });
      return this.workspace(id);
    });
  }
  async attachWorkspace(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), task = this.store.task(text(data.taskId, 'taskId'));
    return this.mutation(input, principal, mutation, 'attachWorkspace', task.projectId, true, async () => {
      const expected = integer(data.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
      const workspace = this.workspaceRow(text(data.workspaceId, 'workspaceId'));
      assert(workspace.projectId === task.projectId, 'Workspace belongs to another project.', 'FORBIDDEN', 403);
      await this.projectIdentity(task.projectId);
      await this.validWorkspace(workspace.id);
      return this.transaction(() => {
        const current = this.store.task(task.id), session = this.store.session(current.ownerSessionId);
        assert(current.revision === expected && !terminalTask(current.status), 'Task revision is stale or task is closed.', 'STALE_REVISION', 409);
        assert(!this.store.db.prepare('SELECT id FROM leases WHERE sessionId = ? AND releasedAt IS NULL AND expiresAt > ? LIMIT 1').get(session.id, this.store.now()), 'Release live reservations before changing workspace.', 'LIVE_RESERVATIONS', 409);
        const other = this.store.db.prepare("SELECT t.id, w.root FROM tasks t LEFT JOIN workflow_attachments a ON a.taskId = t.id LEFT JOIN workflow_workspaces w ON w.id = a.workspaceId WHERE t.ownerSessionId = ? AND t.id != ? AND t.status NOT IN ('integrated','abandoned')").all(session.id, current.id) as Row[];
        assert(other.every(row => (row.root ?? session.workspaceRoot) === workspace.root), 'Session owns other active tasks in another workspace.', 'SESSION_WORKSPACE_CONFLICT', 409);
        this.store.db.prepare('INSERT INTO workflow_attachments VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET workspaceId = excluded.workspaceId').run(current.id, workspace.id);
        this.store.db.prepare('UPDATE sessions SET workspaceRoot = ?, revision = revision + 1 WHERE id = ?').run(workspace.root, session.id);
        this.store.db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?').run(current.id);
        this.store.event(task.projectId, 'workspace.attached', { workspaceId: workspace.id, taskId: task.id, sessionId: session.id, restartRequired: true });
        return { task: this.store.task(current.id), session: this.store.session(session.id), workspace: this.workspace(workspace.id), restartRequired: true, message: 'Bookkeeping updated only. Restart or launch the assigned tool in this workspace; a running process was not relocated.' };
      });
    });
  }
  async reconcile(projectId: string): Promise<any[]> {
    await this.initialize();
    return this.serial(projectId, async () => {
      const project = this.store.project(projectId);
      if (project.mode !== 'git') return [{ projectId, root: project.root, mode: 'advisory', actor: 'unknown', changedPaths: [], observation: 'Git workspaces are unavailable for plain folders.' }];
      let originalValid = true;
      try { await this.projectIdentity(projectId); } catch { originalValid = false; }
      const recorded = this.listWorkspaces(projectId);
      const rows: Row[] = recorded.map(row => ({ ...row, workspaceId: row.id }));
      if (!recorded.some(row => row.root === project.root)) rows.unshift({ projectId, workspaceId: null, root: project.root, kind: 'original', disposable: false });
      const leases = this.store.db.prepare('SELECT id,taskId,sessionId,resources,expiresAt FROM leases WHERE projectId = ? AND releasedAt IS NULL AND expiresAt > ?').all(projectId, this.store.now()) as Row[];
      for (const row of rows) {
        row.actor = 'unknown'; row.changedPaths = []; row.overlaps = [];
        try {
          assert(originalValid, 'Original identity is unavailable.', 'WORKSPACE_IDENTITY_CHANGED');
          if (row.workspaceId) await this.validWorkspace(row.workspaceId);
          const changes = await status(row.root);
          const visible = changes.filter(entry => !privatePath(entry.path) && (!entry.previousPath || !privatePath(entry.previousPath)));
          row.changedPaths = visible.slice(0, 512);
          row.truncated = visible.length > 512;
          row.identityValid = true;
          // Never infer which process made a change from a reservation or a timestamp.
          for (const changed of row.changedPaths) for (const lease of leases) {
            const names: string[] = [changed.path, ...(changed.previousPath ? [changed.previousPath] : [])];
            const overlaps = (JSON.parse(lease.resources) as Row[]).some(resource => resource.kind === 'path' && names.some(name =>
              resourcesOverlap({ kind: 'path', value: name }, { kind: 'path', value: resource.value })
            ));
            if (overlaps && row.overlaps.length < 128) row.overlaps.push({ path: changed.path, leaseId: lease.id, taskId: lease.taskId, sessionId: lease.sessionId, expiresAt: lease.expiresAt, evidence: 'Changed path overlaps a live advisory reservation; actor is unknown.' });
          }
          row.observation = 'Ignored/private paths and file contents are not exposed; this is an observation, not attribution or a lock.';
        } catch { row.identityValid = false; row.observation = 'Workspace identity or Git status could not be verified. No work was changed or removed.'; }
      }
      return rows;
    });
  }
  private config(projectId: string): { revision: number; commands: ValidationCommand[]; configHash: string } {
    const row = this.store.db.prepare('SELECT * FROM workflow_configs WHERE projectId = ?').get(projectId) as Row | undefined;
    return row ? { revision: row.revision, commands: JSON.parse(row.commands), configHash: row.configHash } : emptyConfig();
  }
  async configureValidation(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), projectId = text(data.projectId, 'projectId');
    return this.mutation(input, principal, mutation, 'configureValidation', projectId, true, async () => {
      assert(this.store.project(projectId).mode === 'git', 'Validation configuration requires a Git project.', 'GIT_REQUIRED');
      const expected = integer(data.revision, 'revision', 0, Number.MAX_SAFE_INTEGER);
      assert(Array.isArray(data.commands) && data.commands.length <= 8, 'commands must be an array of at most eight explicitly trusted argv commands.');
      const commands: ValidationCommand[] = data.commands.map(raw => {
        const item = object(raw), command = text(item.command, 'command', 1024);
        assert(!/[\s\0;&|<>`$]/.test(command) && !command.startsWith('-'), 'Use one executable name/path, never a shell command string.');
        assert(!/^(?:ba|da|z|k|c|fi|tc)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(path.basename(command)), 'Shell interpreters are not supported validation executables; approve an executable plus argv instead.');
        assert(Array.isArray(item.args) && item.args.length <= 64 && item.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')), 'args must contain at most 64 bounded strings.');
        assert(item.args.join('').length <= 32768, 'Combined argv exceeds the command limit.');
        return { command, args: item.args as string[], timeoutMs: item.timeoutMs === undefined ? 30000 : integer(item.timeoutMs, 'timeoutMs', 100, 120000) };
      });
      assert(commands.reduce((total, command) => total + command.timeoutMs, 0) <= 300000, 'Total configured timeout must not exceed five minutes.');
      return this.transaction(() => {
        assert(this.config(projectId).revision === expected, 'Validation configuration revision is stale.', 'STALE_REVISION', 409);
        const revision = expected + 1, configHash = hash({ revision, commands });
        this.store.db.prepare('INSERT INTO workflow_configs VALUES (?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET revision = excluded.revision, commands = excluded.commands, configHash = excluded.configHash').run(projectId, revision, JSON.stringify(commands), configHash);
        this.store.db.prepare("UPDATE workflow_jobs SET status = 'invalidated', recovery = 'Validation configuration changed; validate again.' WHERE projectId = ? AND status IN ('prepared','validated','unverified','validation_failed')").run(projectId);
        this.store.event(projectId, 'validation.configured', { revision, configHash, commandCount: commands.length });
        return { projectId, revision, configHash, commands, trustedBy: 'human', isolation: 'none: approved commands run with local user privileges and a filtered environment' };
      });
    });
  }
  private attachment(taskId: string): Row {
    const row = this.store.db.prepare('SELECT * FROM workflow_attachments WHERE taskId = ?').get(taskId) as Row | undefined;
    assert(row, 'Attach this task to a recorded workspace first.', 'WORKSPACE_REQUIRED', 409); return row;
  }
  private changeset(id: string): Changeset {
    const row = this.store.db.prepare('SELECT * FROM workflow_changesets WHERE id = ?').get(id) as Row | undefined;
    assert(row, 'Unknown changeset.', 'NOT_FOUND', 404); return { ...row } as Changeset;
  }
  async submit(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    const data = object(input), task = this.store.task(text(data.taskId, 'taskId'));
    authorizeProject(principal, task.projectId); authorizeSession(principal, task.ownerSessionId);
    return this.mutation(input, principal, mutation, 'submit', task.projectId, false, async () => {
      const expected = integer(data.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
      const existing = this.store.db.prepare("SELECT * FROM workflow_changesets WHERE taskId = ? AND submittedRevision = ? AND status = 'ready'").get(task.id, expected) as Row | undefined;
      if (existing) return { ...existing };
      const current = this.store.task(task.id);
      assert(current.revision === expected && !terminalTask(current.status), 'Task revision is stale or task is closed.', 'STALE_REVISION', 409);
      authorizeSession(principal, current.ownerSessionId);
      const project = await this.projectIdentity(task.projectId);
      const attached = this.attachment(task.id), workspace = await this.validWorkspace(attached.workspaceId);
      assert(this.store.session(current.ownerSessionId).workspaceRoot === workspace.root, 'Session bookkeeping no longer matches the attached workspace.', 'WORKSPACE_IDENTITY_CHANGED', 409);
      await clean(workspace.root);
      const sourceSha = await revision(workspace.root, 'HEAD');
      await supported(workspace.root, sourceSha);
      await ancestor(project.root, workspace.baseSha, sourceSha);
      const id = randomUUID(), sourceRef = `refs/murmur/changesets/${id}`;
      this.transaction(() => {
        this.store.db.prepare('INSERT INTO workflow_changesets VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, task.projectId, task.id, workspace.id, sourceSha, workspace.baseSha, sourceRef, expected + 1, expected, 'pinning', this.store.now());
        this.entity(mutation, 'changeset', id);
      });
      await git(project.root, ['update-ref', '--no-deref', sourceRef, sourceSha, '']);
      await clean(workspace.root);
      assert(await revision(workspace.root, 'HEAD') === sourceSha, 'Source changed during submission; the incomplete pin was retained for inspection.', 'SOURCE_CHANGED', 409);
      return this.transaction(() => {
        const latest = this.store.task(task.id);
        assert(latest.revision === expected && latest.ownerSessionId === current.ownerSessionId && this.attachment(task.id).workspaceId === workspace.id, 'Task changed during submission.', 'STALE_REVISION', 409);
        this.store.db.prepare("UPDATE tasks SET status = 'ready', revision = revision + 1 WHERE id = ?").run(task.id);
        this.store.db.prepare("UPDATE workflow_changesets SET status = 'ready' WHERE id = ?").run(id);
        this.store.event(task.projectId, 'changeset.submitted', { id, taskId: task.id, workspaceId: workspace.id, sourceSha, baseSha: workspace.baseSha });
        return this.changeset(id);
      });
    });
  }
  private jobRow(id: string): Row {
    const row = this.store.db.prepare('SELECT * FROM workflow_jobs WHERE id = ?').get(id) as Row | undefined;
    assert(row, 'Unknown integration job.', 'NOT_FOUND', 404); return row;
  }
  getJob(jobId: string): IntegrationJob {
    const { identity: _identity, validation, ...row } = this.jobRow(jobId);
    return { ...row, validation: validation ? JSON.parse(validation) : null } as IntegrationJob;
  }
  listJobs(projectId: string): IntegrationJob[] {
    this.store.project(projectId);
    return (this.store.db.prepare('SELECT id FROM workflow_jobs WHERE projectId = ? ORDER BY createdAt,id').all(projectId) as Row[]).map(row => this.getJob(row.id));
  }
  private updateJob(id: string, status: string, recovery: string | null = null): void {
    this.store.db.prepare('UPDATE workflow_jobs SET status = ?, recovery = ?, updatedAt = ? WHERE id = ?').run(status, recovery, this.store.now(), id);
  }
  private currentTask(changeset: Changeset): void {
    const task = this.store.task(changeset.taskId);
    assert(task.revision === changeset.taskRevision && task.status === 'ready' && this.attachment(task.id).workspaceId === changeset.workspaceId, 'Task or workspace assignment changed after this changeset was submitted.', 'STALE_CHANGESET', 409);
  }
  async prepare(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), changeset = this.changeset(text(data.changesetId, 'changesetId'));
    return this.mutation(input, principal, mutation, 'prepare', changeset.projectId, true, async () => {
      assert(changeset.status === 'ready', 'Changeset is incomplete and requires inspection.', 'RECOVERY_REQUIRED', 409);
      this.currentTask(changeset);
      const project = await this.projectIdentity(changeset.projectId);
      await this.validWorkspace(changeset.workspaceId);
      assert(await refValue(project.root, changeset.sourceRef) === changeset.sourceSha, 'Submitted source pin changed.', 'SOURCE_CHANGED', 409);
      await supported(project.root, changeset.sourceSha);
      const integration = this.store.db.prepare('SELECT * FROM workflow_projects WHERE projectId = ?').get(project.id) as Row;
      assert(integration.targetStatus === 'absent' || integration.targetStatus === 'ready', 'Integration target requires manual recovery.', 'RECOVERY_REQUIRED', 409);
      const existingTarget = await refValue(project.root, integration.targetRef);
      if (integration.targetStatus === 'absent') assert(existingTarget === null, 'Dedicated integration ref already exists but was not initialized by Murmur; it will not be adopted or overwritten.', 'TARGET_EXISTS', 409);
      else assert(existingTarget, 'Recorded integration target disappeared.', 'TARGET_MOVED', 409);
      const targetSha = existingTarget ?? changeset.baseSha;
      await ancestor(project.root, changeset.baseSha, targetSha);
      await ancestor(project.root, changeset.baseSha, changeset.sourceSha);
      await supported(project.root, targetSha);
      const id = randomUUID();
      await mkdir(path.join(this.stateDirectory, 'integration'), { recursive: true, mode: 0o700 });
      const candidateRoot = path.join(await realpath(path.join(this.stateDirectory, 'integration')), id);
      await nonnested(project.root, candidateRoot);
      const sourceRef = `refs/murmur/jobs/${id}/source`, targetPinRef = `refs/murmur/jobs/${id}/target`, candidateRef = `refs/murmur/jobs/${id}/candidate`;
      this.transaction(() => {
        const now = this.store.now();
        this.store.db.prepare('INSERT INTO workflow_jobs(id,projectId,changesetId,status,sourceSha,baseSha,targetSha,targetRef,sourceRef,targetPinRef,candidateRef,candidateRoot,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, project.id, changeset.id, 'preparing', changeset.sourceSha, changeset.baseSha, targetSha, integration.targetRef, sourceRef, targetPinRef, candidateRef, candidateRoot, now, now);
        this.entity(mutation, 'job', id);
        if (!existingTarget) this.store.db.prepare("UPDATE workflow_projects SET integrationBase = ?, targetStatus = 'initializing' WHERE projectId = ?").run(changeset.baseSha, project.id);
      });
      if (!existingTarget) {
        await git(project.root, ['update-ref', '--no-deref', integration.targetRef, targetSha, '']);
        this.store.db.prepare("UPDATE workflow_projects SET targetStatus = 'ready' WHERE projectId = ?").run(project.id);
      }
      await git(project.root, ['update-ref', '--no-deref', sourceRef, changeset.sourceSha, '']);
      await git(project.root, ['update-ref', '--no-deref', targetPinRef, targetSha, '']);
      await git(project.root, ['worktree', 'add', '--detach', '--', candidateRoot, targetSha]);
      const identity = await fingerprint(candidateRoot, project.canonicalPath);
      this.store.db.prepare('UPDATE workflow_jobs SET identity = ? WHERE id = ?').run(JSON.stringify(identity), id);
      await clean(candidateRoot);
      const merge = await git(candidateRoot, ['merge', '--no-ff', '--no-commit', '--no-edit', '--no-stat', changeset.sourceSha], true);
      if (merge.code !== 0) {
        const conflicts = (await git(candidateRoot, ['ls-files', '--unmerged', '-z'])).stdout;
        assert(conflicts.length > 0, 'Merge failed without a supported textual conflict; candidate was retained.', 'MERGE_FAILED', 409);
        this.updateJob(id, 'conflicted', 'Resolve in a source workspace and submit a new committed changeset, then prepare a new candidate. This conflict worktree is retained; no automatic conflict resolution is performed.');
        this.store.event(project.id, 'integration.conflicted', { jobId: id, changesetId: changeset.id });
        return this.getJob(id);
      }
      const tree = await value(candidateRoot, ['write-tree']);
      const parents = targetSha === changeset.sourceSha ? ['-p', targetSha] : ['-p', targetSha, '-p', changeset.sourceSha];
      const candidateSha = await value(candidateRoot, ['commit-tree', tree, ...parents, '-m', `Murmur integration candidate ${id}`]);
      assert(/^[a-f0-9]{40,64}$/.test(candidateSha), 'Candidate commit was not created.', 'GIT_FAILED');
      // Only the disposable, detached candidate HEAD is changed. No hard reset,
      // stash, force checkout, branch rewrite, or source commit is performed.
      await git(project.root, ['update-ref', '--no-deref', candidateRef, candidateSha, '']);
      const detached = await git(candidateRoot, ['symbolic-ref', '--quiet', 'HEAD'], true);
      assert(detached.code === 1, 'Candidate is no longer detached.', 'CANDIDATE_CHANGED', 409);
      await git(candidateRoot, ['update-ref', '--no-deref', 'HEAD', candidateSha, targetSha]);
      const quit = await git(candidateRoot, ['merge', '--quit'], true);
      assert(quit.code === 0 || quit.code === 128, 'Could not finalize candidate merge metadata.', 'GIT_FAILED');
      await clean(candidateRoot);
      assert(await revision(candidateRoot, 'HEAD') === candidateSha, 'Candidate changed during preparation.', 'CANDIDATE_CHANGED', 409);
      const config = this.config(project.id);
      const validation: ValidationResult | null = config.commands.length ? null : { status: 'unverified', candidateSha, targetSha, configHash: config.configHash, configRevision: config.revision, checks: [], checkedAt: this.store.now() };
      this.transaction(() => {
        this.store.db.prepare('UPDATE workflow_jobs SET candidateSha = ?, validation = ?, status = ?, updatedAt = ? WHERE id = ?').run(candidateSha, validation ? JSON.stringify(validation) : null, validation ? 'unverified' : 'prepared', this.store.now(), id);
        this.store.event(project.id, 'integration.prepared', { jobId: id, candidateSha, targetSha, verified: false });
      });
      return this.getJob(id);
    });
  }
  private async candidate(job: Row): Promise<void> {
    assert(job.candidateSha && job.identity, 'This job has no complete candidate.', 'CANDIDATE_REQUIRED', 409);
    await checkIdentity(JSON.parse(job.identity));
    const detached = await git(job.candidateRoot, ['symbolic-ref', '--quiet', 'HEAD'], true);
    assert(detached.code === 1, 'Candidate is no longer detached.', 'CANDIDATE_CHANGED', 409);
    assert(await revision(job.candidateRoot, 'HEAD') === job.candidateSha && await refValue(job.candidateRoot, job.candidateRef) === job.candidateSha, 'Candidate differs from its recorded immutable commit.', 'CANDIDATE_CHANGED', 409);
    assert(await refValue(job.candidateRoot, job.targetPinRef) === job.targetSha, 'Candidate target pin changed.', 'TARGET_MOVED', 409);
    await clean(job.candidateRoot);
  }
  private async target(job: Row): Promise<void> {
    const root = this.store.project(job.projectId).root;
    assert(await refValue(root, job.targetRef) === job.targetSha, 'Integration target moved. Prepare a new candidate against the current target.', 'TARGET_MOVED', 409);
    assert(await refValue(root, job.sourceRef) === job.sourceSha, 'Pinned candidate source changed.', 'SOURCE_CHANGED', 409);
  }
  async validate(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), initial = this.jobRow(text(data.jobId, 'jobId'));
    return this.mutation(input, principal, mutation, 'validate', initial.projectId, true, async () => {
      const job = this.jobRow(initial.id);
      assert(['prepared', 'validated', 'unverified', 'validation_failed', 'invalidated'].includes(job.status), 'Job is not available for validation.', 'INVALID_JOB_STATE', 409);
      this.entity(mutation, 'job', job.id);
      const config = this.config(job.projectId);
      const checks: Row[] = [];
      this.updateJob(job.id, 'validating');
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      try {
        await this.projectIdentity(job.projectId);
        this.currentTask(this.changeset(job.changesetId));
        await this.candidate(job); await this.target(job);
        for (let index = 0; index < config.commands.length; index++) {
          const command = config.commands[index]!;
          await this.candidate(job); await this.target(job);
          assert(this.config(job.projectId).configHash === config.configHash, 'Validation configuration changed.', 'CONFIG_CHANGED', 409);
          const result = await run(command.command, command.args, job.candidateRoot, command.timeoutMs, controller.signal);
          // Raw output can include secrets printed by trusted tools. Capture it
          // only within the bounded subprocess buffer; persist/expose metadata,
          // not output text. Local reproduction is the way to inspect full logs.
          checks.push({ index, exitCode: result.code, timedOut: result.timedOut, cancelled: result.cancelled, truncated: result.truncated, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, stdoutHash: hash(result.stdout), stderrHash: hash(result.stderr), passed: result.code === 0 && !result.timedOut && !result.cancelled && !result.truncated });
          await this.candidate(job); await this.target(job);
          if (!checks[checks.length - 1]!.passed) break;
        }
        await this.candidate(job); await this.target(job);
        assert(this.config(job.projectId).configHash === config.configHash, 'Validation configuration changed.', 'CONFIG_CHANGED', 409);
        const verdict = !config.commands.length ? 'unverified' : checks.length === config.commands.length && checks.every(check => check.passed) ? 'passed' : 'failed';
        const validation: ValidationResult = { status: verdict, candidateSha: job.candidateSha, targetSha: job.targetSha, configHash: config.configHash, configRevision: config.revision, checks, checkedAt: this.store.now() };
        this.transaction(() => {
          this.store.db.prepare('UPDATE workflow_jobs SET validation = ?, status = ?, updatedAt = ?, recovery = NULL WHERE id = ?').run(JSON.stringify(validation), verdict === 'passed' ? 'validated' : verdict === 'failed' ? 'validation_failed' : 'unverified', this.store.now(), job.id);
          this.store.event(job.projectId, 'integration.validated', { jobId: job.id, candidateSha: job.candidateSha, configHash: config.configHash, status: verdict });
        });
        return this.getJob(job.id);
      } catch (error) {
        const invalidation: ValidationResult = { status: 'invalidated', candidateSha: job.candidateSha, targetSha: job.targetSha, configHash: config.configHash, configRevision: config.revision, checks, checkedAt: this.store.now() };
        this.store.db.prepare("UPDATE workflow_jobs SET status = 'invalidated', validation = ?, recovery = 'Candidate, target, task, configuration, or validation execution changed; no successful result is assumed.', updatedAt = ? WHERE id = ?").run(JSON.stringify(invalidation), this.store.now(), job.id);
        throw error;
      } finally { this.controllers.delete(job.id); }
    });
  }
  /** Cancels only an in-flight local validation; it never accepts a session credential. */
  cancelValidation(jobId: string, principal: Principal): boolean {
    requireHuman(principal);
    const controller = this.controllers.get(jobId);
    if (!controller) return false;
    controller.abort(); return true;
  }
  /** Daemon shutdown can stop validation children without modifying any worktree. */
  close(): void { for (const controller of this.controllers.values()) controller.abort(); }
  private finishPromotion(job: Row): void {
    this.transaction(() => {
      if (this.jobRow(job.id).status === 'promoted') return;
      const changeset = this.changeset(job.changesetId);
      this.currentTask(changeset);
      this.store.db.prepare("UPDATE tasks SET status = 'integrated', revision = revision + 1 WHERE id = ?").run(changeset.taskId);
      this.updateJob(job.id, 'promoted');
      this.store.event(job.projectId, 'integration.promoted', { jobId: job.id, taskId: changeset.taskId, sourceSha: job.sourceSha, candidateSha: job.candidateSha, previousTargetSha: job.targetSha, targetRef: job.targetRef });
    });
  }
  async approve(input: unknown, principal: Principal, mutation: Mutation): Promise<any> {
    requireHuman(principal);
    const data = object(input), initial = this.jobRow(text(data.jobId, 'jobId'));
    return this.mutation(input, principal, mutation, 'approve', initial.projectId, true, async () => {
      const job = this.jobRow(initial.id);
      assert(['validated', 'unverified'].includes(job.status), 'Candidate is not successfully validated or explicitly unverified.', 'VALIDATION_REQUIRED', 409);
      assert(data.candidateSha === job.candidateSha && data.targetSha === job.targetSha, 'Approval does not match the displayed candidate and target.', 'APPROVAL_MISMATCH', 409);
      assert(data.acknowledgeNoChecks === undefined || typeof data.acknowledgeNoChecks === 'boolean', 'acknowledgeNoChecks must be a boolean.');
      this.entity(mutation, 'job', job.id);
      try {
        await this.projectIdentity(job.projectId);
        const changeset = this.changeset(job.changesetId);
        this.currentTask(changeset);
        await this.validWorkspace(changeset.workspaceId);
        await this.candidate(job); await this.target(job);
        const config = this.config(job.projectId), validation: ValidationResult | null = job.validation ? JSON.parse(job.validation) : null;
        assert(validation && validation.configHash === config.configHash && validation.configRevision === config.revision && validation.candidateSha === job.candidateSha && validation.targetSha === job.targetSha, 'Validation does not match this candidate, target, and current configuration.', 'CONFIG_CHANGED', 409);
        if (config.commands.length) assert(validation.status === 'passed' && validation.checks.length === config.commands.length && validation.checks.every(check => check.passed), 'Every configured check must pass on the immutable candidate.', 'VALIDATION_REQUIRED', 409);
        else assert(validation.status === 'unverified' && data.acknowledgeNoChecks === true, 'No validation commands are configured. Explicitly acknowledge this unverified integration.', 'UNVERIFIED_ACK_REQUIRED', 409);
        const root = this.store.project(job.projectId).root;
        assert(!(await worktrees(root)).some(worktree => worktree.branch === job.targetRef), 'Integration target is checked out in a worktree. Switch that checkout away yourself; Murmur never rewrites it.', 'TARGET_CHECKED_OUT', 409);
        // Durable intent before the only promotion side effect. Recovery accepts
        // exactly the pinned candidate, never a descendant or an arbitrary tip.
        this.currentTask(changeset);
        assert(this.config(job.projectId).configHash === config.configHash, 'Validation configuration changed.', 'CONFIG_CHANGED', 409);
        this.updateJob(job.id, 'promoting');
        const update = await git(root, ['update-ref', '--no-deref', job.targetRef, job.candidateSha, job.targetSha], true);
        if (update.code !== 0) { this.updateJob(job.id, 'invalidated', 'Target compare-and-swap failed. Prepare again.'); throw new MurmurError('Integration target changed; atomic ref update was refused.', 'TARGET_MOVED', 409); }
        // If we crash here initialize() can finish the DB half, but never retries
        // the Git ref update. There is no push or original-checkout mutation.
        this.finishPromotion(job);
        return this.getJob(job.id);
      } catch (error) {
        const current = this.jobRow(job.id);
        if (current.status !== 'promoting' && current.status !== 'promoted' && error instanceof MurmurError && ['TARGET_MOVED', 'SOURCE_CHANGED', 'CANDIDATE_CHANGED', 'CONFIG_CHANGED', 'DIRTY_WORKSPACE', 'HIDDEN_INDEX_CHANGES', 'SYMBOLIC_REF', 'WORKSPACE_IDENTITY_CHANGED', 'STALE_CHANGESET'].includes(error.code)) this.updateJob(job.id, 'invalidated', error.code);
        throw error;
      }
    });
  }
  async inspectJob(jobId: string): Promise<any> {
    const initial = this.jobRow(jobId);
    return this.serial(initial.projectId, async () => {
      const job = this.getJob(jobId);
      const result: Row = { job, actor: 'unknown', changedPaths: [], result: job.validation, contentsOmitted: true, logsOmitted: true, note: 'Diff metadata only; private paths, raw file contents, command argv, and command output are not exposed.' };
      try {
        const project = await this.projectIdentity(job.projectId);
        if (job.candidateSha) {
          const raw = (await git(project.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', job.targetSha, job.candidateSha, '--'])).stdout;
          const paths = raw.split('\0').filter(name => name && !privatePath(name));
          result.changedPaths = paths.slice(0, 512); result.truncated = paths.length > 512;
        } else if (job.status === 'conflicted') {
          const row = this.jobRow(jobId);
          assert(row.identity, 'Missing conflict workspace identity.', 'RECOVERY_REQUIRED');
          await checkIdentity(JSON.parse(row.identity));
          const paths = (await status(job.candidateRoot)).filter(entry => !privatePath(entry.path) && (!entry.previousPath || !privatePath(entry.previousPath)));
          result.changedPaths = paths.slice(0, 512); result.truncated = paths.length > 512;
        }
      } catch { result.inspectionUnavailable = true; result.note = 'Identity or bounded Git inspection failed; retained files and refs require local inspection.'; }
      return result;
    });
  }
}
