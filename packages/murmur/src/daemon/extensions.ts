import { LaunchService } from '../core/launches.js';
import { GroupsService } from '../core/groups.js';
import { ExternalGrantService } from '../core/external-grants.js';
import { readConnections, writeConnections } from './connections.js';
import { WorkspaceObserver } from './observer.js';
import { CoordinationService } from '../core/coordination.js';
import { GitWorkflow } from '../integration/workflow.js';
import { adapterDiagnostics } from '../adapters/capabilities.js';
import { assert, authorizeProject, integer, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';
import type { CoordinationStore } from '../storage/store.js';

export class ExtendedServices {
  coordination: CoordinationService;
  workflow: GitWorkflow;
  observer: WorkspaceObserver;
  launches: LaunchService;
  groups: GroupsService;
  external: ExternalGrantService;
  private externalSweep: NodeJS.Timeout | undefined;
  constructor(store: CoordinationStore, directory: string, runtime: { origin: string; stateId: string; instanceId: string }) {
    this.coordination = new CoordinationService(store);
    this.workflow = new GitWorkflow(store, directory);
    this.observer = new WorkspaceObserver(store, this.workflow);
    this.launches = new LaunchService(store, this.workflow, this.coordination, runtime);
    this.groups = new GroupsService(store, this.coordination);
    this.external = new ExternalGrantService(store, this.coordination, this.groups, runtime);
  }
  async initialize(): Promise<void> {
    await this.workflow.initialize();
    this.external.sweep();
    this.externalSweep = setInterval(() => {
      try { this.external.sweep(); } catch { /* Every authenticated operation also checks expiry. */ }
    }, 1000);
    this.externalSweep.unref();
    this.launches.start(); this.observer.start();
  }
  async close(): Promise<void> {
    if (this.externalSweep) clearInterval(this.externalSweep);
    this.externalSweep = undefined;
    this.workflow.close(); await this.launches.close(); await this.observer.close();
  }
  async read(url: URL, principal: Principal): Promise<{ handled: boolean; result?: unknown }> {
    const connection = await readConnections(this.groups, this.external, url, principal);
    if (connection.handled) return connection;
    if (url.pathname === '/v1/launches') {
      requireHuman(principal);
      return { handled: true, result: this.launches.list(url.searchParams.get('projectId') ?? undefined) };
    }
    if (url.pathname === '/v1/adapters') {
      requireHuman(principal);
      return { handled: true, result: await adapterDiagnostics() };
    }
    if (url.pathname === '/v1/integration/job') {
      const id = text(url.searchParams.get('jobId'), 'jobId');
      authorizeProject(principal, this.workflow.getJob(id).projectId);
      return { handled: true, result: await this.workflow.inspectJob(id) };
    }
    const routes = ['/v1/context', '/v1/alerts', '/v1/decisions', '/v1/workspaces', '/v1/integration/jobs', '/v1/observations'];
    if (!routes.includes(url.pathname)) return { handled: false };
    const projectId = text(url.searchParams.get('projectId') ?? (principal.kind === 'session' ? principal.projectId : undefined), 'projectId');
    authorizeProject(principal, projectId);
    let result: unknown;
    switch (url.pathname) {
      case '/v1/context': result = this.coordination.context(projectId, url.searchParams.get('taskId') ?? undefined, integer(Number(url.searchParams.get('after') ?? 0), 'after', 0, Number.MAX_SAFE_INTEGER)); break;
      case '/v1/alerts': result = [...this.coordination.getAlerts(projectId), ...this.observer.alerts(projectId)]; break;
      case '/v1/decisions': result = this.coordination.listDecisions(projectId); break;
      case '/v1/workspaces': {
        const observations = this.observer.list(projectId);
        result = this.workflow.listWorkspaces(projectId).map(workspace => {
          const observation = observations.find(row => row.workspaceId === workspace.id);
          return { ...workspace, observation, observedState: !observation ? 'not_observed' : observation.stale ? 'stale' : !observation.identityValid ? 'unverified' : observation.changedPaths.length ? 'dirty' : 'clean' };
        }); break;
      }
      case '/v1/observations': result = this.observer.list(projectId); break;
      case '/v1/integration/jobs': result = this.workflow.listJobs(projectId); break;
    }
    return { handled: true, result };
  }
  async write(endpoint: string, body: Record<string, unknown>, principal: Principal, mutation: Mutation): Promise<{ handled: boolean; result?: unknown }> {
    const connection = await writeConnections(this.groups, this.external, endpoint, body, principal, mutation);
    if (connection.handled) return connection;
    const coordination = this.coordination;
    const workflow = this.workflow;
    const routes: Record<string, () => unknown | Promise<unknown>> = {
      '/v1/launches/prepare': () => this.launches.prepare(body, principal, mutation),
      '/v1/tasks/update': () => coordination.updateTask(body, principal, mutation),
      '/v1/intents': () => coordination.declareIntent(body, principal, mutation),
      '/v1/decisions/propose': () => coordination.proposeDecision(body, principal, mutation),
      '/v1/decisions/accept': () => coordination.acceptDecision(body, principal, mutation),
      '/v1/alerts/dismiss': () => coordination.dismissAlert(body, principal, mutation),
      '/v1/workspaces/create': () => workflow.createWorkspace(body, principal, mutation),
      '/v1/workspaces/adopt': () => workflow.adoptWorkspace(body, principal, mutation),
      '/v1/workspaces/attach': () => workflow.attachWorkspace(body, principal, mutation),
      '/v1/validation/config': () => workflow.configureValidation(body, principal, mutation),
      '/v1/submissions': () => workflow.submit(body, principal, mutation),
      '/v1/integration/prepare': () => workflow.prepare(body, principal, mutation),
      '/v1/integration/validate': () => workflow.validate(body, principal, mutation),
      '/v1/integration/approve': () => workflow.approve(body, principal, mutation),
    };
    if (Object.hasOwn(routes, endpoint)) return { handled: true, result: await routes[endpoint]() };
    if (endpoint === '/v1/check-plan') {
      const projectId = text(body.projectId, 'projectId');
      authorizeProject(principal, projectId);
      const { projectId: _, ...candidate } = body;
      return { handled: true, result: coordination.checkPlan(projectId, candidate) };
    }
    if (endpoint === '/v1/workspaces/reconcile') {
      const projectId = text(body.projectId, 'projectId');
      authorizeProject(principal, projectId);
      return { handled: true, result: await this.observer.sampleProject(projectId) };
    }
    if (endpoint === '/v1/integration/cancel') {
      requireHuman(principal);
      const jobId = text(body.jobId, 'jobId');
      assert(workflow.getJob(jobId), 'Unknown integration job.');
      return { handled: true, result: { cancelled: workflow.cancelValidation(jobId, principal) } };
    }
    return { handled: false };
  }
}
