import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { assert, MurmurError } from '../protocol/index.js';
import type { InstallationStrategy } from '../integrations/types.js';
import { nativeConnectSyntax, parseNativeConnectPrompt } from './native-chat.js';
import type { NativeConnectAction } from './native-chat.js';

const limitation = 'OpenCode 2.0.12 native metadata is available, but native CLI resume, current-chat reset/rewind invalidation, transient context and structured intent are not fully verified. No OpenCode chat can connect through this adapter.';
export const OPENCODE_EXISTING_CHAT_CAPABILITY = Object.freeze({
  tool: 'opencode' as const, enabled: false as const, testedVersion: '2.0.12',
  identitySource: 'V2 callback sessionID plus session.get({sessionID})',
  incarnationSource: null,
  nativeResumePreservesIdentity: false, nativeForkAndClearChangeIdentity: false,
  automaticContextVerified: false, structuredIntentVerified: false,
  hotAttachVerified: false, genericMcp: false,
  limitation,
  evidence: Object.freeze({
    runtimeVersionObserved: true, isolatedNativePathsObserved: true,
    configKey: 'plugins', configTargetKind: 'directory',
    v2PluginCallbackObserved: true,
    commandCallbackFields: Object.freeze(['delivery', 'prompt', 'sessionID']),
    promptCallbackFields: Object.freeze(['delivery', 'messageID', 'metadata', 'prompt', 'sessionID']),
    sameWorkspaceNativeCommandIdsDistinct: true,
    commandReentryPreservesMetadata: true,
    nativeApiForkCreatesFreshId: true,
    nativeCommittedRewindPreservesIdAndCreation: true,
    nativeCommittedRewindClearsMarker: true,
    probePlatform: 'darwin',
    probeMode: 'native-api-isolated-profile-no-provider-inference',
    nativeSessionCreatedAtIsResetProof: false,
    sharedServerEnvironmentIsCurrentChatIdentity: false,
  }),
});
export const OPENCODE_CONNECT_COMMAND = '/murmur:connect';
export const OPENCODE_CONNECT_SYNTAX = nativeConnectSyntax(OPENCODE_CONNECT_COMMAND);

/** V2 command callbacks receive an argument prompt object, not V1 arguments.
 * The callback's sessionID is separate and can never be supplied in these args. */
export function parseOpenCodeConnectArguments(prompt: unknown): NativeConnectAction {
  assert(prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt), 'OpenCode command arguments are invalid.', 'NATIVE_COMMAND_INPUT');
  const value = (prompt as Record<string, unknown>).text;
  assert(typeof value === 'string', 'OpenCode command arguments are invalid.', 'NATIVE_COMMAND_INPUT');
  const action = parseNativeConnectPrompt(value === '' ? OPENCODE_CONNECT_COMMAND : `${OPENCODE_CONNECT_COMMAND} ${value}`, OPENCODE_CONNECT_COMMAND);
  assert(action, 'OpenCode command arguments are invalid.', 'NATIVE_COMMAND_INPUT');
  return action;
}

export type OpenCodeCurrentObservation = Readonly<{
  nativeId: string; workspaceRoot: string; createdAt: number; incarnationVerified: false;
}>;
export type OpenCodeV2SessionReader = {
  get(input: { sessionID: string }): Promise<unknown>;
};
const controls = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
function record(raw: unknown): Record<string, unknown> {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'OpenCode host metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
  return raw as Record<string, unknown>;
}

/** Fresh per-callback metadata only, not an authorization provider. The V2
 * promise API unwraps {data}; get() returns Session.Info directly. Never read
 * native history, parent/fork metadata, process.cwd(), or shared-server env IDs.
 * Creation time does NOT prove a same-ID rewind/reset did not occur; callers
 * cannot use this result as ExistingChatHelper's TrustedNativeContext. */
export async function inspectOpenCodeCurrentContext(event: unknown, session: OpenCodeV2SessionReader): Promise<OpenCodeCurrentObservation> {
  try {
    const current = record(event), id = current.sessionID;
    assert(typeof id === 'string' && /^ses_[A-Za-z0-9]{1,128}$/.test(id), 'OpenCode host metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
    const info = record(await session.get({ sessionID: id }));
    assert(info.id === id, 'OpenCode current session changed.', 'NATIVE_CONTEXT_INVALID');
    const location = record(info.location), time = record(info.time), directory = location.directory;
    assert(typeof directory === 'string' && directory.length <= 4096 && path.isAbsolute(directory) && path.normalize(directory) === directory && !controls.test(directory), 'OpenCode workspace metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
    const stat = await lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === directory, 'OpenCode workspace metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
    assert(Number.isSafeInteger(time.created) && (time.created as number) > 0, 'OpenCode creation metadata is invalid.', 'NATIVE_CONTEXT_INVALID');
    // A staged rewind is already enough to refuse; absence is not evidence that
    // no committed rewind happened before this plugin was loaded.
    assert(info.revert === undefined, 'OpenCode rewind metadata prevents identity verification.', 'NATIVE_CONTEXT_INVALID');
    return Object.freeze({ nativeId: id, workspaceRoot: directory, createdAt: time.created as number, incarnationVerified: false });
  } catch {
    throw new MurmurError('The current OpenCode callback metadata could not be verified. No authority was selected.', 'NATIVE_CONTEXT_INVALID', 403);
  }
}

function unavailable(): never { throw new MurmurError(limitation, 'NATIVE_ADAPTER_UNVERIFIED', 403); }

/** No executable export is produced until the complete native contract is
 * proven. In particular, no V1 plugin or model-facing shared MCP substitute. */
export function createOpenCodeExistingChatBundle(_options?: unknown): never { return unavailable(); }

export function createOpenCodeExistingChatStrategy(): InstallationStrategy & {
  enabled: false; limitation: string; capability: typeof OPENCODE_EXISTING_CHAT_CAPABILITY;
} {
  return Object.freeze({
    provider: 'opencode', version: 'opencode-v2.0.12-unverified-v1', description: 'Gated OpenCode V2 existing-chat native integration.',
    enabled: false, limitation, capability: OPENCODE_EXISTING_CHAT_CAPABILITY,
    build: unavailable,
  });
}
