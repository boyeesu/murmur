import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request } from './client.js';
import { defaultStateDirectory } from '../daemon/config.js';
import { assert, canonicalJson, integer, MurmurError, object, text } from '../protocol/index.js';
import { requireHumanEnvironment } from '../protocol/agent.js';
import { externalEnvironmentPresent } from '../protocol/external.js';
import { handoffDraft } from '../core/groups.js';
import type { HandoffDraft } from '../protocol/external.js';

export const HUMAN_INPUT_BYTES = 16 * 1024;
export type HumanCommandDependencies = { request?: typeof request; stateDirectory?: string; env?: NodeJS.ProcessEnv; uuid?: () => string; stderr?: (text: string) => void };
export function humanEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  requireHumanEnvironment(env);
  assert(!externalEnvironmentPresent(env), 'Human commands are unavailable with external connection configuration.', 'HUMAN_COMMAND_FORBIDDEN', 403);
}
export function flagMap(args: string[], allowed: string[], booleans: string[] = []): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    assert(flag.startsWith('--') && allowed.includes(flag.slice(2)), 'Unknown option or extra positional argument. Use --help.', 'HUMAN_INPUT');
    const name = flag.slice(2);
    assert(!flags.has(name), 'Duplicate option. Use each option at most once.', 'HUMAN_INPUT');
    if (booleans.includes(name)) flags.set(name, 'true');
    else {
      const value = args[++i];
      assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--') && !value.includes('\0'), 'Missing or invalid option value.', 'HUMAN_INPUT');
      flags.set(name, value);
    }
  }
  return flags;
}
function safeJson(value: unknown, depth = 0): void {
  assert(depth <= 16, 'JSON input is nested too deeply.', 'HUMAN_INPUT');
  if (Array.isArray(value)) { assert(value.length <= 256, 'JSON array is too large.', 'HUMAN_INPUT'); for (const item of value) safeJson(item, depth + 1); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe JSON property.', 'HUMAN_INPUT');
      safeJson(item, depth + 1);
    }
  }
}
export function parseHumanJson(source: string): Record<string, unknown> {
  assert(Buffer.byteLength(source) <= HUMAN_INPUT_BYTES, 'Human JSON input exceeds 16 KiB.', 'HUMAN_INPUT_TOO_LARGE', 413);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new MurmurError('Input must be valid JSON.', 'HUMAN_INPUT'); }
  safeJson(value); return object(value);
}
export async function readHumanJson(filename: string): Promise<Record<string, unknown>> {
  cliText(filename, 'input file path', 4096);
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await file.stat();
    assert(info.isFile() && info.size <= HUMAN_INPUT_BYTES, 'Input must be a regular file of at most 16 KiB.', 'HUMAN_INPUT_FILE');
    const bytes = Buffer.alloc(HUMAN_INPUT_BYTES + 1); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await file.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; }
    assert(used <= HUMAN_INPUT_BYTES, 'Human JSON input exceeds 16 KiB.', 'HUMAN_INPUT_TOO_LARGE', 413);
    let source: string;
    try { source = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, used)); } catch { throw new MurmurError('Input must be valid UTF-8 JSON.', 'HUMAN_INPUT'); }
    return parseHumanJson(source);
  } catch (error) {
    if (error instanceof MurmurError) throw error;
    throw new MurmurError('Could not safely read the explicit JSON file.', 'HUMAN_INPUT_FILE');
  } finally { await file?.close(); }
}
export async function dataInput(flags: Map<string, string>, allowed: string[]): Promise<Record<string, unknown>> {
  assert(!(flags.has('data') && flags.has('file')), 'Use either --data or --file, never both.', 'HUMAN_INPUT');
  const input = flags.has('file') ? await readHumanJson(flags.get('file')!) : flags.has('data') ? parseHumanJson(flags.get('data')!) : {};
  assert(Object.keys(input).every(key => allowed.includes(key)), 'Unexpected input fields.', 'HUMAN_INPUT');
  return input;
}
export function mergeInput(input: Record<string, unknown>, key: string, value: unknown): void {
  assert(!Object.hasOwn(input, key) || canonicalJson(input[key]) === canonicalJson(value), 'Options conflict with JSON input.', 'HUMAN_INPUT'); input[key] = value;
}
export function cliId(value: unknown, name: string): string {
  const id = text(value, name, 128); assert(/^[A-Za-z0-9_-]+$/.test(id), `Invalid ${name}.`, 'HUMAN_INPUT'); return id;
}
export function cliText(value: unknown, name: string, limit: number): string {
  const result = text(value, name, limit); assert(!/[\u0000-\u001f\u007f]/.test(result), `${name} contains control characters.`, 'HUMAN_INPUT'); return result;
}
export function cliNumber(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  assert(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value), `${name} must be a decimal integer.`, 'HUMAN_INPUT');
  return integer(Number(value), name, 1, maximum);
}
export function cliKey(value: unknown): string {
  const key = text(value, 'request ID', 200); assert(/^[A-Za-z0-9_.:-]+$/.test(key), 'Invalid request ID.', 'HUMAN_INPUT'); return key;
}
export async function mergeHandoff(input: Record<string, unknown>, flags: Map<string, string>): Promise<void> {
  if (flags.has('handoff')) mergeInput(input, 'handoff', await readHumanJson(flags.get('handoff')!));
  if (input.handoff !== undefined) input.handoff = validateHandoff(input.handoff);
}
export function validateHandoff(value: unknown): HandoffDraft {
  const result = handoffDraft(value); assert(result, 'Handoff must be a bounded structured object.', 'HUMAN_INPUT'); return result;
}
const sensitiveKey = /(?:token|secret|capability|credential|inviteHash|agentHash|supervisorHash)/i;
export function publicOutput(value: unknown, depth = 0): unknown {
  assert(depth <= 24, 'Server response is nested too deeply.', 'HUMAN_RESPONSE');
  if (Array.isArray(value)) return value.map(item => publicOutput(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey.test(key)).map(([key, item]) => [key, publicOutput(item, depth + 1)]));
  return value;
}
export async function writeNewJson(filename: string, value: unknown): Promise<void> {
  cliText(filename, 'export file path', 4096);
  const source = JSON.stringify(publicOutput(value), null, 2) + '\n';
  assert(Buffer.byteLength(source) <= HUMAN_INPUT_BYTES, 'Export exceeds 16 KiB; reduce the reviewed handoff before exporting.', 'HUMAN_INPUT_TOO_LARGE', 413);
  let file;
  try { file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.writeFile(source); await file.sync(); }
  catch { throw new MurmurError('Could not create the export; existing files are never overwritten.', 'HUMAN_EXPORT'); }
  finally { await file?.close(); }
}
export function humanTransport(dependencies: HumanCommandDependencies) {
  return (method: string, endpoint: string, body?: unknown, key?: string) => (dependencies.request ?? request)(dependencies.stateDirectory ?? defaultStateDirectory(), method, endpoint, body, key ? { key } : {});
}
export function mutationKey(flags: Map<string, string>, dependencies: HumanCommandDependencies): string { return cliKey(flags.get('request-id') ?? (dependencies.uuid ?? randomUUID)()); }
export function commandFailure(error: unknown): MurmurError {
  if (error instanceof MurmurError && ['HUMAN_INPUT', 'HUMAN_INPUT_FILE', 'HUMAN_INPUT_TOO_LARGE', 'HUMAN_EXPORT', 'HUMAN_COMMAND_FORBIDDEN'].includes(error.code)) return error;
  const code = error instanceof MurmurError && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'HUMAN_REQUEST_FAILED';
  return new MurmurError('Human command failed. Inspect current state before retrying the exact request; no automatic retry or cleanup occurred.', code, error instanceof MurmurError ? error.status : 400);
}
