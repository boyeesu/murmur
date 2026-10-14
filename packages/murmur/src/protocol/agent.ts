import { assert, integer, object, text, PROTOCOL_VERSION } from './index.js';

export const AGENT_MODE_ENV = 'MURMUR_AGENT_MODE';
export const AGENT_CONNECTION_ENV = 'MURMUR_AGENT_CONNECTION';
export const STATE_HEADER = 'X-Murmur-State-Id';
export const PROTOCOL_HEADER = 'X-Murmur-Protocol-Version';
export const HEARTBEAT_MS = 30000;
export const MANAGED_TTL_MS = 120000;
export type LaunchTool = 'claude' | 'codex' | 'opencode';
export type LaunchState = 'preparing' | 'prepared' | 'claimed' | 'running' | 'ended' | 'failed' | 'expired' | 'recovery_required';
export type AgentConnection = {
  protocolVersion: number; origin: string; stateId: string; launchId: string;
  projectId: string; sessionId: string; taskId: string; agentToken: string;
};
export type SupervisorConnection = {
  protocolVersion: number; origin: string; stateId: string; launchId: string; supervisorToken: string;
};
export type LaunchStatus = {
  id: string; projectId: string; tool: LaunchTool; title: string; featureKey: string | null; state: LaunchState;
  sessionId: string | null; taskId: string | null; workspaceId: string | null; workspaceRoot: string | null; baseSha: string | null;
  nativeSessionId: string | null; nativeIdentitySource: 'requested' | 'unverified';
  lifecycleRevision: number; expiresAt: number | null; controllerId: string | null; pid: number | null;
  createdAt: number; startedAt: number | null; endedAt: number | null; exitCode: number | null;
  errorCode: string | null; bridgeLastSeenAt: number | null;
};
export type LaunchPreparation = { launch: LaunchStatus; agent: AgentConnection; supervisor: SupervisorConnection; briefing: string };
export type AgentIdentity = {
  role: 'agent'; protocolVersion: number; stateId: string; instanceId: string;
  launchId: string; projectId: string; sessionId: string; taskId: string; expiresAt: number;
};

export function managedEnvironmentPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some(key => key.startsWith('MURMUR_AGENT_'));
}
export function requireHumanEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  assert(!managedEnvironmentPresent(env), 'Human commands are unavailable in a managed agent session. Use murmur agent commands.', 'HUMAN_COMMAND_FORBIDDEN', 403);
}
function origin(value: unknown): string {
  const source = text(value, 'origin', 128);
  let parsed: URL;
  try { parsed = new URL(source); } catch { assert(false, 'Invalid agent service origin.', 'AGENT_CONFIGURATION'); }
  assert(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '' && parsed.username === '' && parsed.password === '' && parsed.pathname === '/' && !parsed.search && !parsed.hash, 'Agent service must be an explicit loopback origin without credentials or extra URL components.', 'AGENT_CONFIGURATION');
  assert(source === parsed.origin, 'Use the exact canonical loopback origin without alternate spellings or paths.', 'AGENT_CONFIGURATION');
  integer(Number(parsed.port), 'port', 1, 65535);
  return parsed.origin;
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 128);
  assert(/^[A-Za-z0-9_-]+$/.test(result), `Invalid ${name}.`, 'AGENT_CONFIGURATION');
  return result;
}
function token(value: unknown): string {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value), 'Invalid scoped credential.', 'AGENT_CONFIGURATION');
  return value;
}
export function validateAgentConnection(value: unknown): AgentConnection {
  const input = object(value);
  const keys = ['protocolVersion','origin','stateId','launchId','projectId','sessionId','taskId','agentToken'];
  assert(Object.keys(input).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(input, key)), 'Incomplete or unexpected managed connection fields.', 'AGENT_CONFIGURATION');
  assert(input.protocolVersion === PROTOCOL_VERSION, 'Unsupported managed connection protocol.', 'AGENT_CONFIGURATION');
  const stateId = text(input.stateId, 'stateId', 64);
  assert(/^[a-f0-9]{64}$/.test(stateId), 'Invalid persistent service identity.', 'AGENT_CONFIGURATION');
  return { protocolVersion: PROTOCOL_VERSION, origin: origin(input.origin), stateId, launchId: id(input.launchId,'launchId'), projectId: id(input.projectId,'projectId'), sessionId: id(input.sessionId,'sessionId'), taskId: id(input.taskId,'taskId'), agentToken: token(input.agentToken) };
}
export function readAgentConnection(env: NodeJS.ProcessEnv = process.env): AgentConnection {
  assert(env[AGENT_MODE_ENV] === '1' && typeof env[AGENT_CONNECTION_ENV] === 'string' && env[AGENT_CONNECTION_ENV]!.length <= 8192, 'A complete managed agent connection is required.', 'AGENT_CONFIGURATION');
  let value: unknown;
  try { value = JSON.parse(env[AGENT_CONNECTION_ENV]!); } catch { assert(false, 'Invalid managed connection JSON.', 'AGENT_CONFIGURATION'); }
  return validateAgentConnection(value);
}
export function validateSupervisorConnection(value: unknown): SupervisorConnection {
  const input = object(value);
  const keys = ['protocolVersion','origin','stateId','launchId','supervisorToken'];
  assert(Object.keys(input).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(input,key)), 'Incomplete supervisor connection.', 'SUPERVISOR_CONFIGURATION');
  assert(input.protocolVersion === PROTOCOL_VERSION, 'Unsupported supervisor protocol.', 'SUPERVISOR_CONFIGURATION');
  const stateId = text(input.stateId,'stateId',64);
  assert(/^[a-f0-9]{64}$/.test(stateId), 'Invalid supervisor service identity.', 'SUPERVISOR_CONFIGURATION');
  return { protocolVersion: PROTOCOL_VERSION, origin: origin(input.origin), stateId, launchId: id(input.launchId,'launchId'), supervisorToken: token(input.supervisorToken) };
}
