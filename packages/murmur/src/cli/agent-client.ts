import { randomUUID } from 'node:crypto';
import { assert, canonicalJson, integer, MurmurError, object, text } from '../protocol/index.js';
import { PROTOCOL_HEADER, STATE_HEADER, validateAgentConnection } from '../protocol/agent.js';
import type { AgentConnection, AgentIdentity } from '../protocol/agent.js';

export type AgentTransport = { fetch?: typeof fetch; timeoutMs?: number };
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const bindings = ['stateId', 'launchId', 'projectId', 'sessionId', 'taskId'] as const;

// Snapshot JSON before awaiting the handshake. Do not invoke user-defined toJSON/getters,
// silently drop undefined fields, or let a caller change an in-flight mutation.
function jsonValue(value: unknown, depth = 0): unknown {
  assert(depth <= 32, 'JSON nesting exceeds the supported limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { assert(Number.isFinite(value), 'JSON numbers must be finite.'); return value; }
  if (Array.isArray(value)) return Array.from(value, item => jsonValue(item, depth + 1));
  const input = object(value);
  assert(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null, 'Expected plain JSON data.');
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(input)).map(([key, descriptor]) => {
    assert('value' in descriptor && descriptor.enumerable, 'Expected plain JSON fields.');
    return [key, jsonValue(descriptor.value, depth + 1)];
  }));
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const input = object(value);
  assert(Object.keys(input).every(key => allowed.includes(key)), 'Unrecognized or unavailable agent input field.', 'AGENT_INPUT');
  return input;
}
function plain(value: unknown, name: string, limit: number): string {
  const result = text(value, name, limit);
  assert(!/[\u0000-\u001f\u007f]/.test(result), `${name} must not contain control characters.`);
  return result;
}
function identifier(value: unknown, name: string): string {
  const result = plain(value, name, 128);
  assert(/^[A-Za-z0-9_-]+$/.test(result), `Invalid ${name}.`);
  return result;
}
function relativePath(value: unknown): void {
  const result = plain(value, 'path', 1024);
  assert(!result.startsWith('/') && !/^[A-Za-z]:/.test(result) && !/[\\*?\[\]]/.test(result) && !result.split('/').includes('..'), 'Paths must be relative literal paths without parent traversal.', 'PATH_ESCAPE');
}
function list(input: Record<string, unknown>, name: string, count: number, validate: (value: unknown) => void): void {
  if (!Object.hasOwn(input, name)) return;
  const items = input[name];
  assert(Array.isArray(items) && items.length <= count, `${name} has too many entries or is not an array.`);
  items.forEach(validate);
}
function planFields(input: Record<string, unknown>): void {
  for (const name of ['reads', 'writes']) list(input, name, 64, relativePath);
  for (const name of ['produces', 'consumes']) list(input, name, 32, value => {
    const contract = fields(value, ['key', 'version', 'value']);
    const key = plain(contract.key, 'contract key', 128);
    assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(key), 'Invalid contract key.');
    plain(contract.version, 'contract version', 64);
    if (Object.hasOwn(contract, 'value')) plain(contract.value, 'contract value', 2048);
  });
}
function revision(value: unknown, name = 'revision'): void {
  assert(value !== undefined, 'An explicit revision is required. Refresh context and supply its current task revision.', 'AGENT_REVISION_REQUIRED');
  integer(value, name, 1, MAX_REVISION);
}

/** A managed, immutable task capability. There is deliberately no public request API. */
export class AgentClient {
  #connection: AgentConnection;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #handshake: Promise<AgentIdentity> | undefined;

  constructor(connection: AgentConnection, transport: AgentTransport | typeof fetch = {}) {
    this.#connection = Object.freeze(validateAgentConnection(connection));
    // Reject URL spellings that the URL parser might normalize into a loopback origin.
    assert(connection.origin === this.#connection.origin, 'Use the exact managed loopback origin.', 'AGENT_CONFIGURATION');
    const options = typeof transport === 'function' ? { fetch: transport } : transport;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = integer(options.timeoutMs ?? 10000, 'timeoutMs', 1, 30000);
  }

  async identity(): Promise<AgentIdentity> {
    // Explicit identity calls revalidate; ordinary operations share the initial handshake.
    const pending = this.#readIdentity();
    this.#handshake = pending;
    return pending;
  }

  async #readIdentity(): Promise<AgentIdentity> {
    const input = object(await this.#request('GET', '/v1/agent/identity'));
    assert(input.role === 'agent' && input.protocolVersion === this.#connection.protocolVersion, 'The service did not return a managed agent identity.', 'AGENT_IDENTITY_MISMATCH', 409);
    for (const name of bindings) assert(input[name] === this.#connection[name], 'The service identity does not match the managed connection.', 'AGENT_IDENTITY_MISMATCH', 409);
    identifier(input.instanceId, 'instanceId');
    assert(Number.isSafeInteger(input.expiresAt) && Number(input.expiresAt) > Date.now(), 'The managed agent credential has expired or has an invalid expiry.', 'AGENT_CREDENTIAL_EXPIRED', 401);
    // Never return additional identity fields (in particular, credentials).
    return { role: 'agent', protocolVersion: this.#connection.protocolVersion, stateId: this.#connection.stateId,
      instanceId: input.instanceId as string, launchId: this.#connection.launchId, projectId: this.#connection.projectId,
      sessionId: this.#connection.sessionId, taskId: this.#connection.taskId, expiresAt: input.expiresAt as number };
  }

  async #ready(): Promise<void> {
    const pending = this.#handshake ??= this.#readIdentity();
    const identity = await pending;
    if (identity.expiresAt <= Date.now()) {
      // The supervisor may have renewed this same credential since our last read.
      // Refresh identity, not registration or credentials; coalesce concurrent refreshes.
      if (this.#handshake === pending) this.#handshake = this.#readIdentity();
      await this.#handshake;
    }
  }

  async context(after = 0): Promise<any> {
    integer(after, 'after', 0, Number.MAX_SAFE_INTEGER);
    const query = new URLSearchParams({ projectId: this.#connection.projectId, taskId: this.#connection.taskId, after: String(after) });
    await this.#ready();
    return this.#request('GET', `/v1/context?${query}`);
  }

  async updates(after = 0): Promise<any> {
    const context = object(await this.context(after));
    return { projectId: this.#connection.projectId, taskId: this.#connection.taskId, events: context.events,
      nextCursor: context.nextCursor, truncated: object(context.truncated).events, delivery: context.delivery,
      meaning: 'generated_context_event_metadata_only' };
  }

  #payload(value: unknown, allowed: string[], bound: (typeof bindings[number])[]): Record<string, unknown> {
    const input = object(jsonValue(value));
    for (const name of bindings) {
      if (Object.hasOwn(input, name)) assert(input[name] === this.#connection[name], 'Agent project, session, task, launch, and state bindings cannot be changed.', 'AGENT_BINDING_MISMATCH', 403);
    }
    fields(input, allowed);
    for (const name of bound) input[name] = this.#connection[name];
    return input;
  }

  async intent(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['taskId', 'revision', 'acceptanceCriteria', 'reads', 'writes', 'produces', 'consumes', 'dependencies'], ['taskId']);
    revision(input.revision);
    list(input, 'acceptanceCriteria', 32, value => { plain(value, 'acceptance criterion', 512); });
    list(input, 'dependencies', 32, value => { identifier(value, 'dependency'); });
    planFields(input);
    return this.#post('/v1/intents', input, key);
  }

  async update(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['taskId', 'revision', 'status'], ['taskId']);
    revision(input.revision);
    assert(['active', 'blocked', 'ready'].includes(input.status as string), 'Agent status must be active, blocked, or ready.', 'AGENT_INPUT');
    return this.#post('/v1/tasks/update', input, key);
  }

  async checkPlan(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['projectId', 'taskId', 'title', 'writes', 'produces', 'consumes'], ['projectId', 'taskId']);
    if (Object.hasOwn(input, 'title')) plain(input.title, 'candidate title', 512);
    planFields(input);
    return this.#post('/v1/check-plan', input, key);
  }

  async proposeDecision(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['projectId', 'taskId', 'key', 'value', 'version', 'rationale'], ['projectId', 'taskId']);
    const contractKey = plain(input.key, 'decision key', 128);
    assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(contractKey), 'Invalid decision key.');
    plain(input.value, 'decision value', 2048);
    plain(input.version, 'decision version', 64);
    plain(input.rationale, 'rationale', 2048);
    return this.#post('/v1/decisions/propose', input, key);
  }

  async reserve(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['projectId', 'sessionId', 'taskId', 'taskRevision', 'resources', 'ttlSeconds'], ['projectId', 'sessionId', 'taskId']);
    revision(input.taskRevision, 'taskRevision');
    assert(Array.isArray(input.resources) && input.resources.length > 0, 'At least one reservation resource is required.');
    list(input, 'resources', 64, value => {
      const resource = fields(value, ['kind', 'value']);
      assert(resource.kind === 'path' || resource.kind === 'resource', 'Resource kind must be path or resource.');
      if (resource.kind === 'path') relativePath(resource.value);
      else assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(plain(resource.value, 'resource value', 1024)), 'Invalid named resource.');
    });
    if (Object.hasOwn(input, 'ttlSeconds')) integer(input.ttlSeconds, 'ttlSeconds', 1, 300);
    return this.#post('/v1/reservations/acquire', input, key);
  }

  async release(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['sessionId', 'leaseId', 'generation'], ['sessionId']);
    identifier(input.leaseId, 'leaseId');
    integer(input.generation, 'generation', 1, Number.MAX_SAFE_INTEGER);
    return this.#post('/v1/reservations/release', input, key);
  }

  async submit(payload: unknown, key?: string): Promise<any> {
    const input = this.#payload(payload, ['taskId', 'revision'], ['taskId']);
    revision(input.revision);
    return this.#post('/v1/submissions', input, key);
  }

  async #post(endpoint: string, payload: Record<string, unknown>, key: string = randomUUID()): Promise<any> {
    assert(typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key), 'Invalid agent request ID.', 'AGENT_INPUT');
    const body = canonicalJson(payload);
    assert(Buffer.byteLength(body, 'utf8') <= MAX_REQUEST_BYTES, 'Agent input exceeds 64 KiB.', 'AGENT_INPUT_TOO_LARGE', 413);
    await this.#ready();
    // No retry, new key, revision increment, credential refresh, or discovery on failure.
    return this.#request('POST', endpoint, body, key);
  }

  #redact(value: unknown, depth = 0): unknown {
    assert(depth <= 64, 'Service JSON nesting exceeds the supported limit.', 'AGENT_RESPONSE_INVALID', 502);
    if (typeof value === 'string') return value.replaceAll(this.#connection.agentToken, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    if (Array.isArray(value)) return value.map(item => this.#redact(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [this.#redact(name, depth + 1) as string,
      /^(?:.*token|authorization|password|secret)$/i.test(name) ? '[REDACTED]' : this.#redact(item, depth + 1)]));
    return value;
  }

  async #request(method: 'GET' | 'POST', endpoint: string, body?: string, key?: string): Promise<any> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelReader: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new MurmurError('The managed service timed out. No automatic retry was attempted.', 'AGENT_TIMEOUT', 504)); controller.abort(); }, this.#timeoutMs);
    });
    const exchange = async (): Promise<unknown> => {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.#connection.agentToken}`, Accept: 'application/json',
        [STATE_HEADER]: this.#connection.stateId, [PROTOCOL_HEADER]: String(this.#connection.protocolVersion) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (key !== undefined) headers['Idempotency-Key'] = key;
      const url = `${this.#connection.origin}${endpoint}`;
      const response = await this.#fetch(url, { method, headers, body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      try {
        assert(!controller.signal.aborted, 'The managed service timed out. No automatic retry was attempted.', 'AGENT_TIMEOUT', 504);
        assert(!response.redirected && (response.url === '' || response.url === url) && !(response.status >= 300 && response.status < 400), 'Managed service redirects are not allowed.', 'AGENT_REDIRECT', 502);
        assert(response.headers.get(STATE_HEADER) === this.#connection.stateId, 'Persistent service identity changed or is missing. No rediscovery was attempted.', 'AGENT_STATE_MISMATCH', 409);
        assert(response.headers.get(PROTOCOL_HEADER) === String(this.#connection.protocolVersion), 'Service protocol changed or is missing.', 'AGENT_PROTOCOL_MISMATCH', 409);
        assert(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'The managed service returned a non-JSON response.', 'AGENT_RESPONSE_INVALID', 502);
        const length = response.headers.get('content-length');
        assert(length === null || (/^\d+$/.test(length) && Number(length) <= MAX_RESPONSE_BYTES), 'Managed service response exceeds 256 KiB or has an invalid length.', 'AGENT_RESPONSE_TOO_LARGE', 502);
        assert(response.body, 'The managed service returned an empty response.', 'AGENT_RESPONSE_INVALID', 502);
        const reader = response.body.getReader();
        cancelReader = () => { void reader.cancel().catch(() => {}); };
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            assert(size <= MAX_RESPONSE_BYTES, 'Managed service response exceeds 256 KiB.', 'AGENT_RESPONSE_TOO_LARGE', 502);
            chunks.push(value);
          }
        } finally { cancelReader(); cancelReader = undefined; reader.releaseLock(); }
        let result: unknown;
        try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
        catch { throw new MurmurError('The managed service returned malformed JSON.', 'AGENT_RESPONSE_INVALID', 502); }
        assert(result !== null && typeof result === 'object' && !Array.isArray(result), 'The managed service returned an invalid response object.', 'AGENT_RESPONSE_INVALID', 502);
        if (!response.ok) {
          const failure = object(result).error;
          assert(failure !== null && typeof failure === 'object' && !Array.isArray(failure), 'The managed service returned a malformed error.', 'AGENT_RESPONSE_INVALID', 502);
          const code = object(failure).code;
          assert(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) && typeof object(failure).message === 'string', 'The managed service returned a malformed error.', 'AGENT_RESPONSE_INVALID', 502);
          // Preserve domain error codes, but never echo arbitrary server messages/details.
          const safeCode = code.includes(this.#connection.agentToken) ? 'AGENT_REQUEST_FAILED' : code;
          const message = code === 'STALE_REVISION' ? 'Task revision is stale. Refresh context and explicitly supply the current revision.'
            : code === 'IDEMPOTENCY_CONFLICT' ? 'Request ID was already used with different input. Do not change a replayed mutation.'
            : 'The managed service rejected this request. No automatic retry was attempted.';
          throw new MurmurError(message, safeCode, response.status);
        }
        return this.#redact(result);
      } finally { if (response.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
    };
    try { return await Promise.race([exchange(), timeout]); }
    catch (error) {
      if (error instanceof MurmurError) throw error;
      throw new MurmurError('The managed service could not be reached or returned an unreadable response. No automatic retry or discovery was attempted.', 'AGENT_UNAVAILABLE', 503);
    } finally { clearTimeout(timer); controller.abort(); cancelReader?.(); }
  }
}
