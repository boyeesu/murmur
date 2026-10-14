import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assert, canonicalJson, integer, MurmurError, object, text, TOOLS } from '../protocol/index.js';
import { PROTOCOL_HEADER, STATE_HEADER } from '../protocol/agent.js';
import { ENROLLMENT_MAX_BYTES, validateExternalConnection, validatePublicConnectionDescriptor } from '../protocol/external.js';
import type { CreateEnrollmentInput, EnrollmentReceipt, ExternalConnection, ExternalIdentity, ExternalOperation, PublicConnectionDescriptor } from '../protocol/external.js';

export type ExternalTransport = { fetch?: typeof fetch; timeoutMs?: number; redactSecrets?: readonly string[] };
export const EXTERNAL_MAX_INPUT_BYTES = 64 * 1024;
export const EXTERNAL_MAX_OUTPUT_BYTES = 256 * 1024;
const bindingFields = ['stateId', 'grantId', 'projectId', 'sessionId', 'taskId', 'memberId', 'groupId', 'workspaceRoot', 'expiresAt'] as const;
const operationFields: Record<ExternalOperation, string[]> = {
  identity: [], context: ['after'], 'member-status': [], leave: [],
  intent: ['revision', 'acceptanceCriteria', 'reads', 'writes', 'produces', 'consumes', 'dependencies'],
  'task-status': ['revision', 'status', 'blocker'], 'check-plan': ['title', 'writes', 'produces', 'consumes'],
  'propose-decision': ['key', 'value', 'version', 'rationale'], reserve: ['revision', 'resources', 'ttlSeconds'], release: ['leaseId', 'generation'],
};

/** Snapshot plain JSON without executing accessors/toJSON or accepting sparse arrays. */
export function snapshotExternalJson(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  assert(depth <= 32 && ++budget.nodes <= 8192, 'External JSON is too deeply nested or has too many fields.', 'EXTERNAL_INPUT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { assert(Number.isFinite(value), 'External JSON numbers must be finite.', 'EXTERNAL_INPUT'); return value; }
  const input = value as object;
  assert(input !== null && typeof input === 'object' && Object.getOwnPropertySymbols(input).length === 0, 'Expected plain external JSON.', 'EXTERNAL_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Array.isArray(input)) {
    assert(Object.getPrototypeOf(input) === Array.prototype && Object.keys(descriptors).length === input.length + 1, 'Expected a dense plain JSON array.', 'EXTERNAL_INPUT');
    return Array.from({ length: input.length }, (_, index) => {
      const entry = descriptors[String(index)];
      assert(entry && 'value' in entry && entry.enumerable, 'Expected plain JSON array entries.', 'EXTERNAL_INPUT');
      return snapshotExternalJson(entry.value, depth + 1, budget);
    });
  }
  assert(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null, 'Expected a plain JSON object.', 'EXTERNAL_INPUT');
  return Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => {
    assert('value' in entry && entry.enumerable, 'Expected plain JSON fields.', 'EXTERNAL_INPUT');
    return [key, snapshotExternalJson(entry.value, depth + 1, budget)];
  }));
}
function fields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const data = object(raw);
  assert(Object.keys(data).every(key => allowed.includes(key)), 'Unexpected or unavailable external input fields.', 'EXTERNAL_INPUT');
  return data;
}
function plain(value: unknown, name: string, limit = 128): string {
  const result = text(value, name, limit);
  assert(!/[\u0000-\u001f\u007f]/.test(result), 'External input cannot contain control characters.', 'EXTERNAL_INPUT');
  return result;
}
function identifier(value: unknown): string {
  const result = plain(value, 'identifier');
  assert(/^[A-Za-z0-9_-]+$/.test(result), 'Invalid external identifier.', 'EXTERNAL_INPUT');
  return result;
}
function workspace(value: unknown): string {
  const result = plain(value, 'workspaceRoot', 4096);
  assert(path.isAbsolute(result) && path.normalize(result) === result, 'An exact absolute workspace root is required.', 'EXTERNAL_CONFIGURATION');
  return result;
}
function credential(value: unknown): string {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value), 'Invalid external private proof.', 'EXTERNAL_CONFIGURATION');
  return value;
}
function hash(value: unknown): void { assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'A SHA-256 hash is required.', 'EXTERNAL_INPUT'); }
function requestKey(value: unknown): string {
  assert(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value), 'Invalid external request ID.', 'EXTERNAL_INPUT'); return value;
}
function revision(value: unknown): void { integer(value, 'revision', 1, Number.MAX_SAFE_INTEGER - 1); }
function array(data: Record<string, unknown>, name: string, max: number, validate: (item: unknown) => void): void {
  if (!Object.hasOwn(data, name)) return;
  const items = data[name];
  assert(Array.isArray(items) && items.length <= max, 'Invalid external input list.', 'EXTERNAL_INPUT');
  items.forEach(validate);
}
function relative(value: unknown): void {
  const result = plain(value, 'path', 1024);
  assert(!path.isAbsolute(result) && !/^[A-Za-z]:/.test(result) && !/[\\*?\[\]]/.test(result) && !result.split('/').some(part => part === '..' || part === '.git'), 'External paths must be relative literal project paths.', 'PATH_ESCAPE');
}
function contractKey(value: unknown): void { assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(plain(value, 'contract key')), 'Invalid contract key.', 'EXTERNAL_INPUT'); }
function plan(data: Record<string, unknown>): void {
  for (const name of ['reads', 'writes']) array(data, name, 64, relative);
  for (const name of ['produces', 'consumes']) array(data, name, 32, raw => {
    const item = fields(raw, ['key', 'version', 'value']);
    contractKey(item.key); plain(item.version, 'version', 64);
    if (Object.hasOwn(item, 'value')) plain(item.value, 'value', 2048);
  });
}
function decision(raw: unknown): void {
  const input = fields(raw, ['key', 'value', 'version', 'rationale']);
  contractKey(input.key); plain(input.value, 'value', 2048); plain(input.version, 'version', 64); plain(input.rationale, 'rationale', 2048);
}
function serialize(value: unknown, maximum = EXTERNAL_MAX_INPUT_BYTES): string {
  const body = canonicalJson(value);
  assert(Buffer.byteLength(body) <= maximum, 'External input exceeds its byte limit.', 'EXTERNAL_INPUT_TOO_LARGE', 413);
  return body;
}
export function validateEnrollmentInput(raw: unknown): CreateEnrollmentInput {
  const input = fields(snapshotExternalJson(raw), ['capabilityHash', 'pollSecretHash', 'workspaceRoot', 'native', 'responsibility', 'handoff', 'groupTitle', 'groupGoal', 'inviteHash']);
  hash(input.capabilityHash); hash(input.pollSecretHash);
  assert(input.capabilityHash !== input.pollSecretHash, 'Candidate and polling proofs must be distinct.', 'EXTERNAL_INPUT');
  workspace(input.workspaceRoot); plain(input.responsibility, 'responsibility', 2048);
  const native = fields(input.native, ['tool', 'nativeId', 'incarnationId']);
  assert(TOOLS.includes(native.tool as typeof TOOLS[number]), 'Unsupported native tool.', 'EXTERNAL_INPUT');
  plain(native.nativeId, 'nativeId', 256); plain(native.incarnationId, 'incarnationId', 256);
  if (Object.hasOwn(input, 'inviteHash')) {
    hash(input.inviteHash);
    assert(!Object.hasOwn(input, 'groupTitle') && !Object.hasOwn(input, 'groupGoal'), 'Choose an invitation or a new group.', 'EXTERNAL_INPUT');
  } else {
    plain(input.groupTitle, 'groupTitle', 256);
    if (Object.hasOwn(input, 'groupGoal')) plain(input.groupGoal, 'groupGoal', 2048);
  }
  if (Object.hasOwn(input, 'handoff')) {
    const handoff = fields(input.handoff, ['summary', 'acceptanceCriteria', 'reads', 'writes', 'produces', 'consumes', 'dependencies', 'blocker', 'decisions', 'changedFiles', 'remainingWork']);
    plain(handoff.summary, 'summary', 4096); plan(handoff);
    // Reviewed reported history/checklist only; never native identity or file-copy input.
    array(handoff, 'changedFiles', 64, relative);
    array(handoff, 'remainingWork', 16, value => { plain(value, 'remaining work', 512); });
    array(handoff, 'acceptanceCriteria', 16, value => { plain(value, 'criterion', 512); });
    array(handoff, 'dependencies', 32, identifier); array(handoff, 'decisions', 8, decision);
    if (Object.hasOwn(handoff, 'blocker') && handoff.blocker !== null) plain(handoff.blocker, 'blocker', 2048);
  }
  serialize(input, ENROLLMENT_MAX_BYTES);
  return input as CreateEnrollmentInput;
}
export function validateEnrollmentReceipt(raw: unknown): EnrollmentReceipt {
  const input = fields(raw, ['requestId', 'state', 'revision', 'expiresAt', 'decidedAt']);
  const requestId = identifier(input.requestId);
  assert(['pending', 'approved', 'rejected', 'expired'].includes(input.state as string), 'Invalid enrollment receipt.', 'EXTERNAL_RESPONSE_INVALID', 502);
  const revision = integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
  const expiresAt = integer(input.expiresAt, 'expiresAt', 1, Number.MAX_SAFE_INTEGER);
  const decidedAt = input.decidedAt === null ? null : integer(input.decidedAt, 'decidedAt', 1, Number.MAX_SAFE_INTEGER);
  return { requestId, state: input.state as EnrollmentReceipt['state'], revision, expiresAt, decidedAt };
}
function identity(raw: unknown, target: PublicConnectionDescriptor, expectedRoot: string, bound?: ExternalConnection): ExternalIdentity {
  const input = object(raw);
  assert(input.role === 'external' && input.protocolVersion === target.protocolVersion && input.stateId === target.stateId && input.workspaceRoot === expectedRoot, 'The service did not return the expected external identity.', 'EXTERNAL_IDENTITY_MISMATCH', 409);
  if (bound) for (const field of bindingFields) assert(input[field] === bound[field], 'The immutable external binding changed.', 'EXTERNAL_IDENTITY_MISMATCH', 409);
  const expiresAt = integer(input.expiresAt, 'expiresAt', 1, Number.MAX_SAFE_INTEGER);
  assert(expiresAt > Date.now(), 'The external capability expired. A new human approval is required.', 'EXTERNAL_EXPIRED', 401);
  return { role: 'external', protocolVersion: target.protocolVersion, stateId: target.stateId, instanceId: identifier(input.instanceId),
    grantId: identifier(input.grantId), projectId: identifier(input.projectId), sessionId: identifier(input.sessionId), taskId: identifier(input.taskId),
    memberId: identifier(input.memberId), groupId: identifier(input.groupId), workspaceRoot: workspace(input.workspaceRoot), expiresAt,
    membershipRevision: integer(input.membershipRevision, 'membershipRevision', 1, Number.MAX_SAFE_INTEGER) };
}

/** Internal bounded transport: consumers cannot supply arbitrary endpoints. */
class ScopedTransport {
  #target: PublicConnectionDescriptor;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #secrets: readonly string[];
  constructor(target: PublicConnectionDescriptor, options: ExternalTransport, secrets: readonly string[]) {
    this.#target = Object.freeze(validatePublicConnectionDescriptor(snapshotExternalJson(target)));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = integer(options.timeoutMs ?? 10_000, 'timeoutMs', 1, 30_000);
    this.#secrets = [...secrets, ...(options.redactSecrets ?? [])].filter(value => typeof value === 'string' && value.length > 0);
  }
  sanitize(value: unknown, depth = 0): unknown {
    assert(depth <= 64, 'External response is too deeply nested.', 'EXTERNAL_RESPONSE_INVALID', 502);
    if (typeof value === 'string') {
      let result = value;
      for (const secret of this.#secrets) result = result.replaceAll(secret, '[REDACTED]');
      return result.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    }
    if (Array.isArray(value)) return value.map(item => this.sanitize(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [this.sanitize(name, depth + 1) as string,
      /capability|poll.?secret|token|authorization|password|secret/i.test(name) ? '[REDACTED]' : this.sanitize(item, depth + 1)]));
    return value;
  }
  async request(method: 'GET' | 'POST', endpoint: string, bearer?: string, body?: string, key?: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      reject(new MurmurError('External service timed out. No retry or discovery was attempted.', 'EXTERNAL_TIMEOUT', 504)); controller.abort();
    }, this.#timeoutMs); });
    const exchange = async () => {
      const headers: Record<string, string> = { Accept: 'application/json', [STATE_HEADER]: this.#target.stateId, [PROTOCOL_HEADER]: String(this.#target.protocolVersion) };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (key !== undefined) headers['Idempotency-Key'] = key;
      const url = `${this.#target.origin}${endpoint}`;
      const response = await this.#fetch(url, { method, headers, body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      try {
        assert(!controller.signal.aborted, 'External service timed out.', 'EXTERNAL_TIMEOUT', 504);
        assert(!response.redirected && (!response.url || response.url === url) && !(response.status >= 300 && response.status < 400), 'External redirects are forbidden.', 'EXTERNAL_REDIRECT', 502);
        assert(response.headers.get(STATE_HEADER) === this.#target.stateId, 'Persistent external service identity changed or is missing.', 'EXTERNAL_STATE_MISMATCH', 409);
        assert(response.headers.get(PROTOCOL_HEADER) === String(this.#target.protocolVersion), 'External protocol changed or is missing.', 'EXTERNAL_PROTOCOL_MISMATCH', 409);
        assert(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'External service returned non-JSON data.', 'EXTERNAL_RESPONSE_INVALID', 502);
        const length = response.headers.get('content-length');
        assert(length === null || /^\d+$/.test(length) && Number(length) <= EXTERNAL_MAX_OUTPUT_BYTES, 'External response exceeds 256 KiB or has an invalid length.', 'EXTERNAL_RESPONSE_TOO_LARGE', 502);
        assert(response.body, 'External service returned an empty response.', 'EXTERNAL_RESPONSE_INVALID', 502);
        const reader = response.body.getReader();
        cancel = () => { void reader.cancel().catch(() => {}); };
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) { const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            assert(size <= EXTERNAL_MAX_OUTPUT_BYTES, 'External response exceeds 256 KiB.', 'EXTERNAL_RESPONSE_TOO_LARGE', 502);
            chunks.push(next.value);
          }
        } finally { cancel(); cancel = undefined; reader.releaseLock(); }
        let result: unknown;
        try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
        catch { throw new MurmurError('External service returned malformed JSON.', 'EXTERNAL_RESPONSE_INVALID', 502); }
        const value = object(result);
        if (!response.ok) {
          const failure = object(value.error), code = failure.code;
          assert(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code), 'External service returned a malformed error.', 'EXTERNAL_RESPONSE_INVALID', 502);
          const safeCode = this.#secrets.some(secret => code.includes(secret)) ? 'EXTERNAL_REQUEST_FAILED' : code;
          throw new MurmurError('External service rejected this request. No automatic retry, renewal, or discovery was attempted.', safeCode, response.status);
        }
        return value;
      } finally { if (response.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
    };
    try { return await Promise.race([exchange(), timeout]); }
    catch (error) {
      if (error instanceof MurmurError) throw error;
      throw new MurmurError('External service was unavailable or returned unreadable data. No retry or discovery was attempted.', 'EXTERNAL_UNAVAILABLE', 503);
    } finally { clearTimeout(timer); controller.abort(); cancel?.(); }
  }
}

/** Explicit descriptor value only. Does not read a descriptor, HOME, or human client. */
export class EnrollmentClient {
  #target: PublicConnectionDescriptor;
  #options: ExternalTransport;
  constructor(descriptor: PublicConnectionDescriptor, transport: ExternalTransport = {}) {
    this.#target = Object.freeze(validatePublicConnectionDescriptor(snapshotExternalJson(descriptor)));
    this.#options = { ...transport, redactSecrets: [...(transport.redactSecrets ?? [])] };
    integer(transport.timeoutMs ?? 10_000, 'timeoutMs', 1, 30_000);
  }
  async request(input: CreateEnrollmentInput, key: string): Promise<EnrollmentReceipt> {
    const body = serialize(validateEnrollmentInput(input), ENROLLMENT_MAX_BYTES), id = requestKey(key);
    const transport = new ScopedTransport(this.#target, this.#options, []);
    const result = validateEnrollmentReceipt(await transport.request('POST', '/v1/enrollment/requests', undefined, body, id));
    assert(canonicalJson(result) === canonicalJson(transport.sanitize(result)), 'Enrollment receipt contains private material.', 'EXTERNAL_RESPONSE_INVALID', 502);
    return result;
  }
  async status(requestId: string, pollSecret: string): Promise<EnrollmentReceipt> {
    const id = identifier(requestId), secret = credential(pollSecret);
    const transport = new ScopedTransport(this.#target, this.#options, [secret]);
    const result = validateEnrollmentReceipt(await transport.request('POST', '/v1/enrollment/status', secret, serialize({ requestId: id })));
    assert(result.requestId === id, 'Enrollment status returned another request.', 'EXTERNAL_IDENTITY_MISMATCH', 409);
    assert(canonicalJson(result) === canonicalJson(transport.sanitize(result)), 'Enrollment receipt contains private material.', 'EXTERNAL_RESPONSE_INVALID', 502);
    return result;
  }
  /** Private return value; callers must persist it privately, NEVER print it. */
  async activate(candidateCapability: string, expectedWorkspaceRoot: string): Promise<ExternalConnection> {
    const secret = credential(candidateCapability), root = workspace(expectedWorkspaceRoot);
    const transport = new ScopedTransport(this.#target, this.#options, [secret]);
    const result = identity(await transport.request('GET', '/v1/external/identity', secret), this.#target, root);
    const { role: _role, instanceId: _instanceId, membershipRevision: _revision, ...binding } = result;
    return Object.freeze(validateExternalConnection({ ...binding, origin: this.#target.origin, capability: secret }));
  }
}

/** An immutable, explicit external capability; no human discovery or generic request API. */
export class ExternalClient {
  #connection: ExternalConnection;
  #target: PublicConnectionDescriptor;
  #transport: ScopedTransport;
  #handshake: Promise<ExternalIdentity> | undefined;
  constructor(connection: ExternalConnection, transport: ExternalTransport | typeof fetch = {}) {
    this.#connection = Object.freeze(validateExternalConnection(snapshotExternalJson(connection)));
    workspace(this.#connection.workspaceRoot);
    this.#target = { protocolVersion: this.#connection.protocolVersion, stateId: this.#connection.stateId, origin: this.#connection.origin, instanceId: 'validation' };
    this.#transport = new ScopedTransport(this.#target, typeof transport === 'function' ? { fetch: transport } : transport, [this.#connection.capability]);
  }
  #live(): void { assert(this.#connection.expiresAt > Date.now(), 'External approval expired. Obtain a new human approval.', 'EXTERNAL_EXPIRED', 401); }
  async #readIdentity(): Promise<ExternalIdentity> {
    this.#live();
    const result = identity(await this.#transport.request('GET', '/v1/external/identity', this.#connection.capability), this.#target, this.#connection.workspaceRoot, this.#connection);
    return this.#transport.sanitize(result) as ExternalIdentity;
  }
  async identity(): Promise<ExternalIdentity> { return this.#handshake = this.#readIdentity(); }
  async #ready(): Promise<void> { this.#live(); await (this.#handshake ??= this.#readIdentity()); this.#live(); }
  async context(after = 0): Promise<unknown> {
    integer(after, 'after', 0, Number.MAX_SAFE_INTEGER); await this.#ready();
    return this.#transport.sanitize(await this.#transport.request('GET', `/v1/external/context?after=${after}`, this.#connection.capability));
  }
  async memberStatus(): Promise<unknown> {
    await this.#ready(); return this.#transport.sanitize(await this.#transport.request('GET', '/v1/external/member-status', this.#connection.capability));
  }
  async #post(operation: ExternalOperation, raw: unknown, key: string = randomUUID()): Promise<unknown> {
    const input = fields(snapshotExternalJson(raw), operationFields[operation]);
    if (['intent', 'task-status', 'reserve'].includes(operation)) revision(input.revision);
    if (operation === 'intent') {
      array(input, 'acceptanceCriteria', 32, item => { plain(item, 'criterion', 512); });
      array(input, 'dependencies', 32, identifier); plan(input);
    }
    if (operation === 'task-status') {
      assert(['active', 'blocked', 'ready'].includes(input.status as string), 'Unsupported external task status.', 'EXTERNAL_INPUT');
      if (Object.hasOwn(input, 'blocker') && input.blocker !== null) plain(input.blocker, 'blocker', 2048);
    }
    if (operation === 'check-plan') { if (Object.hasOwn(input, 'title')) plain(input.title, 'title', 512); plan(input); }
    if (operation === 'propose-decision') decision(input);
    if (operation === 'reserve') {
      assert(Array.isArray(input.resources) && input.resources.length > 0, 'Reservation resources are required.', 'EXTERNAL_INPUT');
      array(input, 'resources', 64, value => { const item = fields(value, ['kind', 'value']);
        assert(item.kind === 'path' || item.kind === 'resource', 'Invalid resource kind.', 'EXTERNAL_INPUT');
        if (item.kind === 'path') relative(item.value); else contractKey(item.value);
      });
      if (Object.hasOwn(input, 'ttlSeconds')) integer(input.ttlSeconds, 'ttlSeconds', 1, 3600);
    }
    if (operation === 'release') { identifier(input.leaseId); integer(input.generation, 'generation', 1, Number.MAX_SAFE_INTEGER); }
    const body = serialize(input), id = requestKey(key);
    await this.#ready();
    return this.#transport.sanitize(await this.#transport.request('POST', `/v1/external/${operation}`, this.#connection.capability, body, id));
  }
  intent(input: unknown, key?: string): Promise<unknown> { return this.#post('intent', input, key); }
  taskStatus(input: unknown, key?: string): Promise<unknown> { return this.#post('task-status', input, key); }
  checkPlan(input: unknown, key?: string): Promise<unknown> { return this.#post('check-plan', input, key); }
  proposeDecision(input: unknown, key?: string): Promise<unknown> { return this.#post('propose-decision', input, key); }
  reserve(input: unknown, key?: string): Promise<unknown> { return this.#post('reserve', input, key); }
  release(input: unknown, key?: string): Promise<unknown> { return this.#post('release', input, key); }
  leave(key?: string): Promise<unknown> { return this.#post('leave', {}, key); }
}
