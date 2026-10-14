import { nativeChatHook, nativeConnectSyntax, nativePrivateDirectory, parseNativeConnectPrompt } from './native-chat.js';
import type { NativeChatProfile, NativeHookOptions } from './native-chat.js';

export const CLAUDE_NATIVE_PUBLICATION_CAPABILITY = Object.freeze({
  enabled: false, reason: 'successful-native-PostToolUse-contract-unverified',
  observedToolPrefix: 'mcp__plugin_murmur_murmur_requests__',
  formatterHasAuthority: false, registeredInExport: false,
});

export const CLAUDE_EXISTING_CHAT_CAPABILITY = Object.freeze({
  tool: 'claude', enabled: true, testedVersion: '2.1.247',
  identitySource: 'UserPromptSubmit.session_id', incarnationSource: 'current UUID',
  nativeResumePreservesIdentity: true, nativeForkAndClearChangeIdentity: true,
  automaticContextRefresh: 'UserPromptSubmit/PreToolUse/PostToolUse after explicit activation',
  toolContextRuntimeVerified: false, structuredPublicationEnabled: false,
  hotAttachVerified: false, genericMcp: false,
});
const profile: NativeChatProfile = Object.freeze({
  tool: 'claude', name: 'Claude Code', testedVersion: CLAUDE_EXISTING_CHAT_CAPABILITY.testedVersion,
  command: '/murmur:connect', automaticRefresh: true, toolBoundaries: true,
});
export const CLAUDE_CONNECT_SYNTAX = nativeConnectSyntax(profile.command);
export const parseClaudeConnectPrompt = (prompt: unknown) => parseNativeConnectPrompt(prompt, profile.command);
export const claudePrivateDirectory = (descriptorPath: string) => nativePrivateDirectory(descriptorPath, 'claude');
export const claudeNativeHook = (descriptorPath: string, options: NativeHookOptions = {}) => nativeChatHook(profile, descriptorPath, options);
export {
  NATIVE_HOOK_INPUT_BYTES as CLAUDE_HOOK_INPUT_BYTES, NATIVE_HOOK_OUTPUT_BYTES as CLAUDE_HOOK_OUTPUT_BYTES,
  nativeProjectRoot as claudeProjectRoot, readNativeHookInput as readClaudeHookInput,
  nativeHookOutput as claudeHookOutput, nativeRefreshOutput as claudeRefreshOutput,
} from './native-chat.js';
export type {
  NativeConnectAction as ClaudeConnectAction, NativeHookOutput as ClaudeHookOutput,
  NativeChatHelper as ClaudeExistingChatHelper, NativeHookOptions as ClaudeNativeHookOptions,
} from './native-chat.js';
