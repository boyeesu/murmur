export const PROTOCOL_VERSION = 1;
export const TOOLS = ['claude', 'codex', 'cursor', 'opencode', 'manual'] as const;
export type Tool = typeof TOOLS[number];
export type Resource = { kind: 'path' | 'resource'; value: string };
export type ExternalPrincipal = Readonly<{ kind: 'external'; grantId: string; projectId: string; sessionId: string; taskId: string; memberId: string; groupId: string; workspaceRoot: string; expiresAt: number }>;
export type SessionPrincipal = Readonly<{ kind: 'session'; sessionId: string; projectId: string; authenticated?: true }>;
export type Principal = { kind: 'human' } | SessionPrincipal | ExternalPrincipal;
/** Authority is attached by server code, never deserialized from JSON or persisted. */
declare const authorizationBrand: unique symbol;
export type MutationAuthorization = { readonly [authorizationBrand]: true };
export type Mutation = { key: string; caller: string; operation: string; input: unknown; authorization?: MutationAuthorization };
const principalGuards = new WeakMap<object, () => void>();
const mutationGuards = new WeakMap<object, { caller: string; check: () => void; principal: SessionPrincipal | ExternalPrincipal }>();
export function authenticatedExternalPrincipal(binding: ExternalPrincipal, check: () => void): ExternalPrincipal {
  const principal = Object.freeze({ ...binding });
  principalGuards.set(principal, check);
  return principal;
}
/** Authenticated network sessions retain their exact credential guard across
 * awaits and replay. The enumerable marker survives copies, but the WeakMap
 * authority does not; serializing/spreading a principal cannot preserve access.
 * Plain session principals remain a trusted in-process compatibility surface.
 */
export function authenticatedSessionPrincipal(binding: Omit<SessionPrincipal, 'authenticated'>, check: () => void): SessionPrincipal {
  const principal = Object.freeze({ ...binding, authenticated: true as const });
  principalGuards.set(principal, check);
  return principal;
}
export function authorizePrincipal(principal: Principal): void {
  if (principal.kind === 'human' || principal.kind === 'session' && principal.authenticated !== true) return;
  const check = principalGuards.get(principal);
  assert(check, 'Scoped authority must come from an authenticated server capability.', principal.kind === 'external' ? 'EXTERNAL_UNAUTHORIZED' : 'SESSION_UNAUTHORIZED', 401);
  check();
}
/** Compatibility alias; both authenticated scoped principal kinds are checked. */
export function authorizeExternal(principal: Principal): void { authorizePrincipal(principal); }
export function withAuthorization(principal: Principal, mutation: Mutation): Mutation {
  if (principal.kind === 'human' || principal.kind === 'session' && principal.authenticated !== true) return mutation;
  authorizePrincipal(principal);
  assert(mutation.caller === callerId(principal), 'Mutation caller does not match external authority.', 'EXTERNAL_FORBIDDEN', 403);
  const authorization = Object.freeze({}) as MutationAuthorization;
  mutationGuards.set(authorization, { caller: mutation.caller, check: principalGuards.get(principal)!, principal });
  return { ...mutation, authorization };
}
export function authorizeMutation(mutation: Mutation): void {
  const entry = mutation.authorization && mutationGuards.get(mutation.authorization);
  if (mutation.caller.startsWith('external:') || mutation.authorization !== undefined) {
    assert(entry && entry.caller === mutation.caller, 'External mutations require trusted current authorization.', 'EXTERNAL_UNAUTHORIZED', 401);
    entry.check();
  }
}

export function externalMutationPrincipal(mutation: Mutation): ExternalPrincipal | undefined {
  authorizeMutation(mutation);
  const principal = mutation.authorization ? mutationGuards.get(mutation.authorization)?.principal : undefined;
  return principal?.kind === 'external' ? principal : undefined;
}

export class MurmurError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(message: string, code: string, status = 400, details: unknown = undefined) {
    super(message);
    this.name = 'MurmurError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assert(condition: unknown, message: string, code = 'INVALID_INPUT', status = 400): asserts condition {
  if (!condition) throw new MurmurError(message, code, status);
}
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, limit = 512): string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `${name} must be non-empty text (maximum ${limit} characters).`);
  assert(!value.includes('\0'), `${name} must not contain NUL.`);
  return value;
}
export function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  assert(Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum, `${name} must be an integer between ${minimum} and ${maximum}.`);
  return value as number;
}
export function callerId(principal: Principal): string {
  return principal.kind === 'human' ? 'human' : principal.kind === 'external' ? `external:${principal.grantId}:${principal.sessionId}` : `session:${principal.sessionId}`;
}
export function authorizeProject(principal: Principal, projectId: string): void {
  authorizeExternal(principal);
  assert(principal.kind === 'human' || principal.projectId === projectId, 'This credential belongs to another project.', 'FORBIDDEN', 403);
}
export function authorizeSession(principal: Principal, sessionId: string): void {
  authorizeExternal(principal);
  assert(principal.kind === 'human' || principal.sessionId === sessionId, 'This credential belongs to another session.', 'FORBIDDEN', 403);
}
export function requireHuman(principal: Principal): void {
  assert(principal.kind === 'human', 'This action requires the local user credential.', 'FORBIDDEN', 403);
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
