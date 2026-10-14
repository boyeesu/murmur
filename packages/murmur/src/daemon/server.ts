import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoordinationStore } from '../storage/store.js';
import { STATE_HEADER, PROTOCOL_HEADER } from '../protocol/agent.js';
import { ExtendedServices } from './extensions.js';
import { BrowserAccess, beginEventStream, serveDashboard } from './browser.js';
import { PROTOCOL_VERSION, TOOLS, assert, authorizeProject, authorizeSession, callerId, integer, MurmurError, object, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal, Tool } from '../protocol/index.js';
import { discoverProject, normalizeResources } from '../workspaces/identity.js';
import { prepareStateDirectory, stateIdentity, statePort } from './config.js';
import { publishPublicConnection } from './connection.js';
import { connectionQuery } from './connections.js';
import { ENROLLMENT_MAX_BYTES } from '../protocol/external.js';
import type { ExternalOperation } from '../protocol/external.js';

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}
async function readBody(request: IncomingMessage, maximum = 65536): Promise<Record<string, unknown>> {
  assert(request.headers['content-type']?.split(';')[0].trim() === 'application/json', 'Content-Type must be application/json.', 'UNSUPPORTED_MEDIA_TYPE', 415);
  const declared = request.headers['content-length'];
  assert(declared === undefined || /^\d+$/.test(declared) && Number(declared) <= maximum, 'Request body exceeds the allowed size.', 'BODY_TOO_LARGE', 413);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    assert(size <= maximum, maximum === 65536 ? 'Request body exceeds 64 KiB.' : 'Enrollment request body exceeds 16 KiB.', 'BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MurmurError('Malformed JSON request.', 'INVALID_JSON'); }
  return object(parsed);
}
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startDaemon(inputDirectory: string) {
  const directory = await prepareStateDirectory(inputDirectory);
  const port = statePort(directory);
  const host = `127.0.0.1:${port}`;
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const descriptorPath = path.join(directory, 'daemon.json');
  const temporaryDescriptor = path.join(directory, `daemon-${instanceId}.json`);
  let store: CoordinationStore | undefined;
  let closing = false;
  let ready = false;
  let services: ExtendedServices | undefined;
  let publicConnection: Awaited<ReturnType<typeof publishPublicConnection>> | undefined;
  const browser = new BrowserAccess();
  let closePromise: Promise<void> | undefined;
  const active = new Set<Promise<void>>();

  const server = http.createServer((request, response) => {
    const work = handle(request, response);
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      ready = false;
      await services?.close();
      browser.close();
      server.closeAllConnections();
      await Promise.allSettled([...active]);
      // Remove our descriptor before releasing the port; a new owner must not
      // have its credential deleted by this instance's shutdown.
      try {
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
        if (descriptor.instanceId === instanceId) await unlink(descriptorPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await publicConnection?.release();
      store?.close();
      store = undefined;
      await new Promise<void>(resolve => server.close(() => resolve()));
    })();
    return closePromise;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      assert(ready && !closing && store, 'Daemon is starting or stopping.', 'UNAVAILABLE', 503);
      assert(request.headers.host === host, 'Unexpected Host header.', 'FORBIDDEN', 403);
      response.setHeader(STATE_HEADER, stateIdentity(directory));
      response.setHeader(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
      const checkManagedIdentity = () => {
        assert(request.headers[STATE_HEADER.toLowerCase()] === stateIdentity(directory), 'Persistent service identity does not match.', 'SERVICE_IDENTITY_MISMATCH', 409);
        assert(request.headers[PROTOCOL_HEADER.toLowerCase()] === String(PROTOCOL_VERSION), 'Managed protocol does not match.', 'PROTOCOL_MISMATCH', 409);
      };
      const origin = request.headers.origin;
      assert(origin === undefined || origin === `http://${host}`, 'Unexpected browser origin.', 'FORBIDDEN', 403);
      const url = new URL(request.url || '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/ui') {
        response.writeHead(302, { Location: '/ui/', 'Cache-Control': 'no-store' }); response.end(); return;
      }
      if (request.method === 'GET' && await serveDashboard(url.pathname, response)) return;
      if (request.method === 'POST' && url.pathname === '/v1/browser/bootstrap') {
        assert(origin === `http://${host}`, 'Dashboard sign-in requires the same browser origin.', 'FORBIDDEN', 403);
        const body = await readBody(request);
        reply(response, 200, browser.exchange(text(body.code, 'code', 64))); return;
      }
      if (url.pathname === '/v1/enrollment/requests' || url.pathname === '/v1/enrollment/status') {
        assert(request.method === 'POST', 'Enrollment requires POST.', 'METHOD_NOT_ALLOWED', 405);
        assert(origin === undefined, 'Enrollment is not a browser interface.', 'FORBIDDEN', 403);
        checkManagedIdentity();
        connectionQuery(url, []);
        const body = await readBody(request, ENROLLMENT_MAX_BYTES);
        if (url.pathname === '/v1/enrollment/requests') {
          assert(request.headers.authorization === undefined, 'Enrollment submits hashes, not bearer authority.', 'FORBIDDEN', 403);
          const key = text(request.headers['idempotency-key'], 'Idempotency-Key', 128);
          assert(/^[a-zA-Z0-9_.:-]+$/.test(key), 'Invalid Idempotency-Key.');
          reply(response, 200, services!.external.createEnrollment(body, key));
        } else {
          assert(Object.keys(body).length === 1 && Object.hasOwn(body, 'requestId'), 'Enrollment status accepts only a request reference.', 'CONNECTION_INPUT');
          const proof = request.headers.authorization;
          assert(typeof proof === 'string' && proof.startsWith('Bearer ') && proof.length <= 256, 'A request polling proof is required.', 'UNAUTHORIZED', 401);
          reply(response, 200, services!.external.pollStatus({ requestId: body.requestId, pollSecret: proof.slice(7) }));
        }
        return;
      }
      const authorization = request.headers.authorization;
      assert(typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.length <= 256, 'Bearer authentication required.', 'UNAUTHORIZED', 401);
      const credential = authorization.slice(7);
      if (url.pathname.startsWith('/v1/launch-control/')) {
        assert(origin === undefined, 'Supervisor control is not a browser interface.', 'FORBIDDEN', 403);
        checkManagedIdentity();
        const action = url.pathname.slice('/v1/launch-control/'.length);
        assert(['status', 'claim', 'started', 'heartbeat', 'end'].includes(action), 'Unknown launch control operation.', 'NOT_FOUND', 404);
        if (action === 'status') {
          assert(request.method === 'GET', 'Supervisor status requires GET.', 'METHOD_NOT_ALLOWED', 405);
          reply(response, 200, services!.launches.control('status', credential, { launchId: text(url.searchParams.get('launchId'), 'launchId') })); return;
        }
        assert(request.method === 'POST', 'Supervisor mutations require POST.', 'METHOD_NOT_ALLOWED', 405);
        const controlBody = await readBody(request);
        const controlKey = text(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        assert(/^[a-zA-Z0-9_.:-]+$/.test(controlKey), 'Invalid Idempotency-Key.');
        reply(response, 200, services!.launches.control(action as 'claim' | 'started' | 'heartbeat' | 'end', credential, controlBody, controlKey)); return;
      }
      const externalPrincipal = await services!.external.authenticateExternal(credential);
      if (externalPrincipal) {
        assert(origin === undefined, 'External clients use the scoped non-browser interface.', 'FORBIDDEN', 403);
        checkManagedIdentity();
        assert(url.pathname.startsWith('/v1/external/'), 'This capability cannot use general Murmur endpoints.', 'EXTERNAL_FORBIDDEN', 403);
        const operation = url.pathname.slice('/v1/external/'.length) as ExternalOperation;
        const reads: ExternalOperation[] = ['identity', 'context', 'member-status'];
        const writes: ExternalOperation[] = ['intent', 'task-status', 'check-plan', 'propose-decision', 'reserve', 'release', 'leave'];
        assert(reads.includes(operation) || writes.includes(operation), 'Unknown external operation.', 'NOT_FOUND', 404);
        connectionQuery(url, operation === 'context' ? ['after'] : []);
        if (reads.includes(operation)) {
          assert(request.method === 'GET', 'External reads require GET.', 'METHOD_NOT_ALLOWED', 405);
          const payload = operation === 'context' ? { after: integer(Number(url.searchParams.get('after') ?? 0), 'after', 0, Number.MAX_SAFE_INTEGER) } : {};
          reply(response, 200, await services!.external.dispatch(operation, payload, externalPrincipal));
        } else {
          assert(request.method === 'POST', 'External mutations require POST.', 'METHOD_NOT_ALLOWED', 405);
          const body = await readBody(request);
          const key = text(request.headers['idempotency-key'], 'Idempotency-Key', 128);
          assert(/^[a-zA-Z0-9_.:-]+$/.test(key), 'Invalid Idempotency-Key.');
          reply(response, 200, await services!.external.dispatch(operation, body, externalPrincipal, key));
        }
        return;
      }
      assert(!url.pathname.startsWith('/v1/external/'), 'A current external capability is required.', 'EXTERNAL_UNAUTHORIZED', 401);
      let managedSessionId: string | undefined;
      let principal: Principal;
      if (matches(credential, token)) {
        assert(origin === undefined, 'Use a dashboard session rather than the local service credential in a browser.', 'FORBIDDEN', 403);
        principal = { kind: 'human' };
      } else if (browser.authenticated(credential)) principal = { kind: 'human' };
      else {
        const session = store.authenticateSession(credential);
        assert(session, 'Invalid credential.', 'UNAUTHORIZED', 401);
        principal = { kind: 'session', sessionId: session.id, projectId: session.projectId };
        if (session.credentialMode === 'managed') {
          assert(origin === undefined, 'Managed agent calls use the scoped non-browser interface.', 'FORBIDDEN', 403);
          checkManagedIdentity();
          managedSessionId = session.id;
        }
      }
      if (request.method === 'GET') {
        if (managedSessionId) services!.launches.authorizeAgent(managedSessionId, 'GET', url);
        if (url.pathname === '/v1/agent/identity') {
          assert(managedSessionId, 'A managed agent credential is required.', 'FORBIDDEN', 403);
          reply(response, 200, services!.launches.identity(managedSessionId)); return;
        }
        if (url.pathname === '/health') {
          reply(response, 200, { protocolVersion: PROTOCOL_VERSION, instanceId, stateId: stateIdentity(directory) }); return;
        }
        const projectId = url.searchParams.has('projectId') ? text(url.searchParams.get('projectId'), 'projectId') : principal.kind === 'session' ? principal.projectId : undefined;
        if (projectId) authorizeProject(principal, projectId);
        if (url.pathname === '/v1/status') {
          const launches = services!.launches.list(projectId);
          const snapshot = store.snapshot(projectId);
          const grouped = new Map<string, string[]>();
          for (const session of snapshot.sessions) grouped.set(String(session.workspaceRoot), [...(grouped.get(String(session.workspaceRoot)) ?? []), String(session.id)]);
          const warnings = [...grouped].filter(([, ids]) => ids.length > 1).map(([workspaceRoot, sessionIds]) => ({ kind: 'shared_workspace', workspaceRoot, sessionIds, message: 'Multiple registered sessions share this checkout. Registration does not isolate or relocate processes.' }));
          reply(response, 200, { ...snapshot, warnings, launches }); return;
        }
        if (url.pathname === '/v1/stream') {
          const project = text(projectId, 'projectId');
          const after = integer(Number(url.searchParams.get('after') ?? 0), 'after', 0, Number.MAX_SAFE_INTEGER);
          const isBrowser = browser.authenticated(credential);
          beginEventStream(request, response, store, project, after, () => !closing && (!isBrowser || browser.authenticated(credential))); return;
        }
        const extended = await services!.read(url, principal);
        if (extended.handled) { reply(response, 200, extended.result); return; }
        if (url.pathname === '/v1/events') {
          const project = text(projectId, 'projectId');
          const after = integer(Number(url.searchParams.get('after') || 0), 'after', 0, Number.MAX_SAFE_INTEGER);
          const events = store.events(project, after);
          reply(response, 200, { events, nextCursor: Number(events.at(-1)?.sequence ?? after) }); return;
        }
        throw new MurmurError('Unknown endpoint.', 'NOT_FOUND', 404);
      }
      assert(request.method === 'POST', 'Method not supported.', 'METHOD_NOT_ALLOWED', 405);
      if (url.pathname.startsWith('/v1/groups/') || url.pathname.startsWith('/v1/connections/')) connectionQuery(url, []);
      const body = await readBody(request);
      if (managedSessionId) services!.launches.authorizeAgent(managedSessionId, 'POST', url, body);
      const key = text(request.headers['idempotency-key'], 'Idempotency-Key', 128);
      assert(/^[a-zA-Z0-9_.:-]+$/.test(key), 'Invalid Idempotency-Key.');
      const mutation: Mutation = { key, caller: callerId(principal), operation: url.pathname, input: body };
      if (['/v1/projects', '/v1/sessions', '/v1/reservations/acquire'].includes(url.pathname)) {
        if (url.pathname === '/v1/reservations/acquire') {
          const sessionId = text(body.sessionId, 'sessionId');
          const projectId = text(body.projectId, 'projectId');
          authorizeSession(principal, sessionId); authorizeProject(principal, projectId);
          const task = store.task(text(body.taskId, 'taskId'));
          assert(task.ownerSessionId === sessionId && task.projectId === projectId, 'Task belongs to another owner or project.', 'FORBIDDEN', 403);
        } else requireHuman(principal);
        const cached = store.replay(mutation);
        if (cached.found) { reply(response, 200, cached.response); return; }
      }
      const extended = await services!.write(url.pathname, body, principal, mutation);
      if (extended.handled) { reply(response, 200, extended.result); return; }
      let result: unknown;
      if (url.pathname === '/v1/daemon/stop') {
        requireHuman(principal);
        reply(response, 200, { stopping: true });
        setImmediate(() => { void close().catch(() => { process.exitCode = 1; }); }); return;
      } else if (url.pathname === '/v1/browser/ticket') {
        requireHuman(principal);
        result = browser.ticket(`http://${host}`, key);
      } else if (url.pathname === '/v1/projects') {
        requireHuman(principal);
        result = store.registerProject(await discoverProject(text(body.root, 'root', 4096)), mutation);
      } else if (url.pathname === '/v1/sessions') {
        requireHuman(principal);
        const projectId = text(body.projectId, 'projectId');
        const project = store.project(projectId);
        const workspace = await discoverProject(text(body.workspaceRoot, 'workspaceRoot', 4096));
        assert(workspace.mode === project.mode && workspace.canonicalPath === project.canonicalPath, 'Workspace does not belong to this registered project.', 'PROJECT_MISMATCH');
        store.verifyProjectIdentity(projectId, workspace.fingerprint);
        const tool = text(body.tool, 'tool') as Tool;
        assert(TOOLS.includes(tool), 'Unknown tool.');
        result = store.registerSession({ projectId, workspaceRoot: workspace.root, tool, nativeId: text(body.nativeId, 'nativeId'), instanceId: text(body.instanceId, 'instanceId') }, mutation);
      } else if (url.pathname === '/v1/sessions/heartbeat') {
        const sessionId = text(body.sessionId, 'sessionId');
        authorizeSession(principal, sessionId);
        result = store.heartbeat(sessionId, integer(body.revision, 'revision', 1, Number.MAX_SAFE_INTEGER), mutation);
      } else if (url.pathname === '/v1/tasks' || url.pathname === '/v1/reservations/acquire') {
        const projectId = text(body.projectId, 'projectId');
        const sessionId = text(body.sessionId, 'sessionId');
        authorizeProject(principal, projectId);
        authorizeSession(principal, sessionId);
        if (url.pathname === '/v1/tasks') {
          result = store.createTask({ projectId, sessionId, title: text(body.title, 'title', 2000), featureKey: body.featureKey === undefined || body.featureKey === null ? null : text(body.featureKey, 'featureKey', 128).trim().toLowerCase() }, mutation);
        } else {
          const project = store.project(projectId);
          const session = store.session(sessionId);
          assert(session.projectId === projectId, 'Session belongs to another project.', 'FORBIDDEN', 403);
          let workspace;
          try { workspace = await discoverProject(session.workspaceRoot); }
          catch { throw new MurmurError('The registered workspace is missing or changed. Reattach it before reserving paths.', 'WORKSPACE_CHANGED', 409); }
          assert(workspace.canonicalPath === project.canonicalPath && workspace.mode === project.mode, 'The workspace no longer belongs to this project.', 'WORKSPACE_CHANGED', 409);
          store.verifyProjectIdentity(projectId, workspace.fingerprint);
          const resources = await normalizeResources(body.resources, session.workspaceRoot, workspace.caseSensitive);
          result = store.acquire({ projectId, sessionId, taskId: text(body.taskId, 'taskId'), taskRevision: integer(body.taskRevision, 'taskRevision', 1, Number.MAX_SAFE_INTEGER), resources, ttlSeconds: integer(body.ttlSeconds ?? 90, 'ttlSeconds', 1, 300) }, mutation);
        }
      } else if (url.pathname === '/v1/reservations/renew' || url.pathname === '/v1/reservations/release') {
        const id = text(body.leaseId, 'leaseId');
        const sessionId = text(body.sessionId, 'sessionId');
        authorizeSession(principal, sessionId);
        const lease = store.lease(id);
        authorizeProject(principal, lease.projectId);
        result = store.changeLease({ id, sessionId, generation: integer(body.generation, 'generation', 1, Number.MAX_SAFE_INTEGER), ...(url.pathname.endsWith('/renew') ? { ttlSeconds: integer(body.ttlSeconds ?? 90, 'ttlSeconds', 1, 300) } : {}) }, mutation);
      } else throw new MurmurError('Unknown endpoint.', 'NOT_FOUND', 404);
      reply(response, 200, result);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof MurmurError) {
        if (error.code === 'BODY_TOO_LARGE') { response.setHeader('Connection', 'close'); response.once('finish', () => request.destroy()); }
        reply(response, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      }
      else reply(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected local failure. Inspect current status before retrying.' } });
    }
  }

  // Bind before opening SQLite or replacing credentials. The OS releases this
  // exclusive lock on crash. A colliding unrelated service is an error, never
  // permission to start on another port against the same database.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => reject(new MurmurError(error.code === 'EADDRINUSE' ? `Port ${port} is already bound. Murmur may already be running, or an unrelated service conflicts. No second writer was started.` : 'Could not bind the loopback service.', 'DAEMON_BIND_FAILED', 409));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  try {
    store = new CoordinationStore(path.join(directory, 'state.sqlite'));
    services = new ExtendedServices(store, directory, { origin: `http://${host}`, stateId: stateIdentity(directory), instanceId });
    await services.initialize();
    publicConnection = await publishPublicConnection(directory, { protocolVersion: PROTOCOL_VERSION, origin: `http://${host}`, stateId: stateIdentity(directory), instanceId });
    const descriptor = { protocolVersion: PROTOCOL_VERSION, instanceId, stateId: stateIdentity(directory), port, pid: process.pid, token };
    await writeFile(temporaryDescriptor, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    await rename(temporaryDescriptor, descriptorPath);
    ready = true;
    return { port, instanceId, directory, close };
  } catch (error) {
    await close();
    await unlink(temporaryDescriptor).catch(() => {});
    throw error;
  }
}
