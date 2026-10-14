import { assert, MurmurError } from '../protocol/index.js';
import type { InstallationStrategy } from '../integrations/types.js';
import { nativeConnectSyntax, parseNativeConnectPrompt } from './native-chat.js';
import type { NativeConnectAction } from './native-chat.js';

const limitation = 'Cursor native CLI is unavailable and its official runtime download was denied by network policy. CLI hook parity, current-chat lifecycle, transient context, and structured intent have not been verified. No Cursor chat can connect through this adapter.';
export const CURSOR_EXISTING_CHAT_CAPABILITY = Object.freeze({
  tool: 'cursor' as const, enabled: false as const, testedVersion: null,
  identitySource: 'documented hook conversation_id (not verified on installed CLI)',
  incarnationSource: null,
  nativeResumePreservesIdentity: false, nativeForkAndClearChangeIdentity: false,
  automaticContextVerified: false, structuredIntentVerified: false,
  cliHookParityVerified: false, hotAttachVerified: false, genericMcp: false,
  limitation,
  evidence: Object.freeze({
    runtimePresent: false, officialDownload: 'blocked-network-policy',
    documentedFieldsAreNativeEvidence: false,
    generationIdIsIncarnation: false,
  }),
});
export const CURSOR_CONNECT_COMMAND = '/murmur:connect';
export const CURSOR_CONNECT_SYNTAX = nativeConnectSyntax(CURSOR_CONNECT_COMMAND);

/** Parses documented raw user command text, not model output or tool parameters.
 * Parsing is not provenance or authority; no handler is enabled on that basis. */
export function parseCursorConnectPrompt(prompt: unknown): NativeConnectAction | null {
  return parseNativeConnectPrompt(prompt, CURSOR_CONNECT_COMMAND);
}

export type CursorHookMetadata = Readonly<{
  conversationId: string;
  workspaceRoots: readonly string[];
  incarnationVerified: false;
}>;
const controls = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;

/** Shape inspection only. Never turn generation_id, sessionStart env, copied
 * metadata, a model-supplied workspace, or a history path into helper authority.
 * Full CLI/lifecycle parity is unproven; this return type CANNOT be passed as
 * ExistingChatHelper's TrustedNativeContext. It retains no prompt/tool output. */
export function inspectCursorHookMetadata(raw: unknown): CursorHookMetadata {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'Cursor hook metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
  const event = raw as Record<string, unknown>;
  const id = event.conversation_id, roots = event.workspace_roots;
  assert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id), 'Cursor hook metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
  assert(Array.isArray(roots) && roots.length >= 1 && roots.length <= 16
    && roots.every(root => typeof root === 'string' && root.length >= 1 && root.length <= 4096 && !controls.test(root)), 'Cursor hook metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
  return Object.freeze({ conversationId: id, workspaceRoots: Object.freeze([...roots] as string[]), incarnationVerified: false });
}

function unavailable(): never {
  throw new MurmurError(limitation, 'NATIVE_ADAPTER_UNVERIFIED', 403);
}

/** Deliberate refusal, not a placeholder hook config. No downloaded executable,
 * global native configuration, credentials, or model-selectable identity. */
export function createCursorExistingChatBundle(_options?: unknown): never { return unavailable(); }

/** Registering this strategy lets the installer explain the precise gate while
 * refusing plan/apply before any native asset or configuration is written. */
export function createCursorExistingChatStrategy(): InstallationStrategy & {
  enabled: false; limitation: string; capability: typeof CURSOR_EXISTING_CHAT_CAPABILITY;
} {
  return Object.freeze({
    provider: 'cursor', version: 'cursor-unverified-v1', description: 'Unavailable Cursor existing-chat native integration.',
    enabled: false, limitation, capability: CURSOR_EXISTING_CHAT_CAPABILITY,
    build: unavailable,
  });
}
