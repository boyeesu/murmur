export const PROTOCOL_VERSION = 1;
export const TOOLS = ['claude', 'codex', 'cursor', 'opencode', 'manual'] as const;
export type Tool = typeof TOOLS[number];
export type Resource = { kind: 'path' | 'resource'; value: string };
export type Principal = { kind: 'human' } | { kind: 'session'; sessionId: string; projectId: string };
export type Mutation = { key: string; caller: string; operation: string; input: unknown };

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
  return principal.kind === 'human' ? 'human' : `session:${principal.sessionId}`;
}
export function authorizeProject(principal: Principal, projectId: string): void {
  assert(principal.kind === 'human' || principal.projectId === projectId, 'This credential belongs to another project.', 'FORBIDDEN', 403);
}
export function authorizeSession(principal: Principal, sessionId: string): void {
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
