import { createHash } from 'node:crypto';
import { canonicalJson, assert } from '../protocol/index.js';
import { resourcesOverlap } from '../workspaces/identity.js';
import type { CoordinationStore } from '../storage/store.js';
import type { GitWorkflow } from '../integration/workflow.js';

type Observation = { projectId: string; workspaceId: string | null; root: string; actor: 'unknown'; identityValid: boolean; changedPaths: any[]; overlaps: any[]; truncated: boolean; observation: string; digest: string; observedAt: number; stale?: boolean };
const hash = (input: unknown) => createHash('sha256').update(canonicalJson(input)).digest('hex');

export class WorkspaceObserver {
  private store: CoordinationStore;
  private workflow: Pick<GitWorkflow, 'reconcile'>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(store: CoordinationStore, workflow: Pick<GitWorkflow, 'reconcile'>) {
    this.store = store; this.workflow = workflow;
    store.db.exec('CREATE TABLE IF NOT EXISTS murmur_workspace_observations (projectId TEXT NOT NULL REFERENCES projects(id), workspaceKey TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, observedAt INTEGER NOT NULL, PRIMARY KEY(projectId,workspaceKey))');
    const columns = store.db.prepare('PRAGMA table_info(murmur_workspace_observations)').all().map(row => row.name);
    assert(columns.join(',') === 'projectId,workspaceKey,digest,payload,observedAt', 'Unsupported workspace observation schema.', 'SCHEMA_TOO_NEW');
  }
  start(): void {
    if (this.timer || this.stopped) return;
    // Git reconciliation is the portable source of truth. Polling is deliberately
    // bounded and skips a tick instead of accumulating concurrent scans.
    this.timer = setInterval(() => { void this.sampleNow(); }, 10000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  sampleNow(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    const run = async () => {
      const projects = this.store.db.prepare("SELECT id FROM projects WHERE mode = 'git'").all();
      for (const project of projects) {
        if (this.stopped) break;
        try { await this.sampleProject(String(project.id)); } catch { /* Explicit scans surface errors; background failures preserve prior state. */ }
      }
    };
    this.running = run().finally(() => { this.running = undefined; });
    return this.running;
  }
  async sampleProject(projectId: string): Promise<Observation[]> {
    this.store.project(projectId);
    const rows = await this.workflow.reconcile(projectId);
    if (this.stopped) return this.list(projectId);
    const observations: Observation[] = rows.map(row => {
      const data = { projectId, workspaceId: row.workspaceId ?? null, root: String(row.root), actor: 'unknown' as const,
        identityValid: row.identityValid === true, changedPaths: (row.changedPaths ?? []).slice(0, 100), overlaps: (row.overlaps ?? []).slice(0, 64),
        truncated: Boolean(row.truncated || row.changedPaths?.length > 100 || row.overlaps?.length > 64), observation: String(row.observation ?? '') };
      return { ...data, digest: hash(data), observedAt: this.store.now() };
    });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const observation of observations) {
        const key = observation.workspaceId ?? `root:${observation.root}`;
        const previous = this.store.db.prepare('SELECT digest FROM murmur_workspace_observations WHERE projectId = ? AND workspaceKey = ?').get(projectId, key);
        this.store.db.prepare('INSERT INTO murmur_workspace_observations VALUES (?, ?, ?, ?, ?) ON CONFLICT(projectId,workspaceKey) DO UPDATE SET digest=excluded.digest,payload=excluded.payload,observedAt=excluded.observedAt').run(projectId, key, observation.digest, JSON.stringify(observation), observation.observedAt);
        if (previous?.digest !== observation.digest) this.store.event(projectId, 'workspace.observed', { workspaceId: observation.workspaceId, identityValid: observation.identityValid, changedCount: observation.changedPaths.length, truncated: observation.truncated });
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return observations;
  }
  list(projectId: string): Observation[] {
    this.store.project(projectId);
    return this.store.db.prepare('SELECT payload FROM murmur_workspace_observations WHERE projectId = ? ORDER BY workspaceKey').all(projectId).map(row => { const observation = JSON.parse(String(row.payload)); return { ...observation, stale: this.store.now() - observation.observedAt > 30000 }; });
  }
  alerts(projectId: string): any[] {
    const rows = this.list(projectId).filter(row => row.identityValid && !row.stale && row.changedPaths.length);
    const tasks = this.store.db.prepare("SELECT t.id,s.workspaceRoot FROM tasks t JOIN sessions s ON s.id=t.ownerSessionId WHERE t.projectId=? AND t.status NOT IN ('integrated','abandoned')").all(projectId);
    const alerts: any[] = [];
    for (let left = 0; left < rows.length; left++) for (let right = left + 1; right < rows.length; right++) {
      const a = rows[left], b = rows[right];
      if (a.root === b.root) continue;
      const paths = a.changedPaths.filter(change => b.changedPaths.some(other => resourcesOverlap({ kind: 'path', value: change.path }, { kind: 'path', value: other.path }))).map(change => change.path).slice(0, 12);
      if (!paths.length) continue;
      const taskIds = tasks.filter(task => task.workspaceRoot === a.root || task.workspaceRoot === b.root).map(task => String(task.id));
      const evidence = { workspaceIds: [a.workspaceId, b.workspaceId], paths, actor: 'unknown', observationDigests: [a.digest, b.digest], truncated: a.truncated || b.truncated };
      alerts.push({ id: `observed-${hash(evidence)}`, projectId, kind: 'observed_workspace_overlap', severity: 'warning', taskIds, evidence, dismissible: false,
        message: 'Two working copies currently have changes in overlapping paths. This is not proof of duplicate intent or who made the edits.',
        suggestedAction: 'Inspect both working copies and coordinate before integrating. This alert clears when the observed overlap clears.' });
    }
    return alerts;
  }
}
