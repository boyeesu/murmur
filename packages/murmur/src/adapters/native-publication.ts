import { z } from 'zod';
import { canonicalJson, MurmurError } from '../protocol/index.js';

export const NATIVE_REQUEST_INPUT_BYTES = 4096;
export const NATIVE_REQUEST_RESULT_BYTES = 12 * 1024;
export const NATIVE_REQUEST_SERVER = 'murmur_requests';
export const NATIVE_REQUEST_STATUS = 'awaiting_native_bridge';
const literal = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value));
const relative = literal(1024).refine(value => !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !/[\\*?\[\]]/.test(value) && !value.split('/').some(part => part === '..' || part === '.git'));
const identifier = literal(128).regex(/^[A-Za-z0-9_-]+$/);
const contractKey = literal(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const contract = z.object({ key: contractKey, version: literal(64), value: literal(2048).optional() }).strict();
const plan = { writes: z.array(relative).max(64).optional(), produces: z.array(contract).max(32).optional(), consumes: z.array(contract).max(32).optional() };
export const nativeRequestTools = Object.freeze([
  { name: 'declare_intent', operation: 'intent', title: 'Request publication of task intent', inputSchema: z.object({ revision, ...plan, acceptanceCriteria: z.array(literal(512)).max(32).optional(), reads: z.array(relative).max(64).optional(), dependencies: z.array(identifier).max(32).optional() }).strict() },
  { name: 'set_status', operation: 'task-status', title: 'Request task status update', inputSchema: z.object({ revision, status: z.enum(['active', 'blocked', 'ready']), blocker: literal(2048).nullable().optional() }).strict() },
  { name: 'propose_decision', operation: 'propose-decision', title: 'Request a decision proposal', inputSchema: z.object({ key: contractKey, value: literal(2048), version: literal(64), rationale: literal(2048) }).strict() },
  { name: 'check_plan', operation: 'check-plan', title: 'Request advisory plan checks', inputSchema: z.object({ title: literal(512).optional(), ...plan }).strict() },
] as const);
export type NativePublicationOperation = typeof nativeRequestTools[number]['operation'];
export type NativeRequestReceipt = { schemaVersion: 1; status: typeof NATIVE_REQUEST_STATUS; operation: NativePublicationOperation; input: Record<string, unknown> };
export type NativeRequestResult = { content: [{ type: 'text'; text: string }]; structuredContent: NativeRequestReceipt };
const invalid = () => new MurmurError('Invalid actorless coordination request. Use the advertised strict schema.', 'NATIVE_REQUEST_INPUT');

/** Reject accessors/toJSON and bound traversal before schema validation. */
function snapshot(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 16 || ++budget.nodes > 2048) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(fields).length !== value.length + 1) throw invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const field = fields[String(index)];
      if (!field || !('value' in field) || !field.enumerable) throw invalid();
      return snapshot(field.value, depth + 1, budget);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid();
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
    if (!('value' in field) || !field.enumerable) throw invalid();
    return [key, snapshot(field.value, depth + 1, budget)];
  }));
}

/** Plain data only. This module has no filesystem, environment, HTTP or actor access. */
export function formatNativeRequest(name: string, input: unknown): NativeRequestResult {
  const tool = nativeRequestTools.find(tool => tool.name === name);
  if (!tool) throw invalid();
  const parsed = tool.inputSchema.safeParse(snapshot(input));
  if (!parsed.success || Buffer.byteLength(canonicalJson(parsed.data)) > NATIVE_REQUEST_INPUT_BYTES) throw invalid();
  const receipt: NativeRequestReceipt = { schemaVersion: 1, status: NATIVE_REQUEST_STATUS, operation: tool.operation, input: parsed.data };
  const result: NativeRequestResult = { content: [{ type: 'text', text: canonicalJson(receipt) }], structuredContent: receipt };
  if (Buffer.byteLength(canonicalJson(result)) > NATIVE_REQUEST_RESULT_BYTES) throw invalid();
  return result;
}

/** A successful formatter receipt is not an authorization or evidence of publication. */
export function verifyNativeRequestResult(name: string, input: unknown, result: unknown): NativeRequestReceipt {
  const expected = formatNativeRequest(name, input);
  if (canonicalJson(snapshot(result)) !== canonicalJson(expected)) throw invalid();
  return expected.structuredContent;
}
