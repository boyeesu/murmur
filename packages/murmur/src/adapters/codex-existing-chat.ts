import { nativeChatHook, nativeConnectSyntax, nativePrivateDirectory, parseNativeConnectPrompt } from './native-chat.js';
import type { NativeChatProfile, NativeHookOptions } from './native-chat.js';

export const CODEX_EXISTING_CHAT_CAPABILITY = Object.freeze({
  tool: 'codex', enabled: true, testedVersion: '0.154.0',
  identitySource: 'UserPromptSubmit.session_id', incarnationSource: 'current thread UUID',
  identityScope: 'parent conversation including Codex subagents',
  nativeResumePreservesIdentity: true, nativeForkAndNewChangeIdentity: true,
  automaticContextRefresh: 'UserPromptSubmit after explicit activation',
  fixtureHookTrustBypass: true, fixtureProjectPretrusted: true, interactiveHookTrustVerified: false,
  hotAttachVerified: false, genericMcp: false, realModelVerified: false,
});
// Plain prompt syntax: Codex rejects unknown slash commands before hooks run.
// No skill, shell expansion, model-selected thread or environment ID is needed.
const profile: NativeChatProfile = Object.freeze({
  tool: 'codex', name: 'Codex CLI', testedVersion: CODEX_EXISTING_CHAT_CAPABILITY.testedVersion,
  command: 'murmur-connect', automaticRefresh: true,
});
export const CODEX_CONNECT_SYNTAX = nativeConnectSyntax(profile.command);
export const parseCodexConnectPrompt = (prompt: unknown) => parseNativeConnectPrompt(prompt, profile.command);
export const codexPrivateDirectory = (descriptorPath: string) => nativePrivateDirectory(descriptorPath, 'codex');
export const codexNativeHook = (descriptorPath: string, options: NativeHookOptions = {}) => nativeChatHook(profile, descriptorPath, options);
