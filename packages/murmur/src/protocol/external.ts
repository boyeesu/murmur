import { assert, integer, object, PROTOCOL_VERSION, text } from './index.js';
import type { Tool, Resource } from './index.js';
import type { Contract } from '../core/coordination.js';

export const EXTERNAL_MODE_ENV = 'MURMUR_EXTERNAL_MODE';
export const EXTERNAL_CONNECTION_ENV = 'MURMUR_EXTERNAL_CONNECTION';
export const ENROLLMENT_MAX_BYTES = 16 * 1024;
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const INVITE_TTL_MS = 15 * 60 * 1000;
export const EXTERNAL_TTL_MS = 8 * 60 * 60 * 1000;
export const EXTERNAL_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export type PublicConnectionDescriptor = { protocolVersion: number; origin: string; stateId: string; instanceId: string };
export type NativeBinding = { tool: Tool; nativeId: string; incarnationId: string };
export type HandoffDraft = {
  summary: string; changedFiles?: string[]; remainingWork?: string[]; acceptanceCriteria?: string[]; reads?: string[]; writes?: string[]; produces?: Contract[]; consumes?: Contract[]; dependencies?: string[]; blocker?: string | null;
  decisions?: { key: string; value: string; version: string; rationale: string }[];
};
export type GroupTarget = { groupTitle: string; groupGoal?: string; inviteHash?: never } | { inviteHash: string; groupTitle?: never; groupGoal?: never };
export type CreateEnrollmentInput = GroupTarget & {
  capabilityHash: string; pollSecretHash: string; workspaceRoot: string; native: NativeBinding;
  responsibility: string; handoff?: HandoffDraft;
};
export type ManagedGroupRequestInput = GroupTarget & { responsibility: string; handoff?: HandoffDraft };
export type EnrollmentState = 'pending' | 'approved' | 'rejected' | 'expired';
/** No credentials, project briefing, or private draft is returned by pre-approval endpoints. */
export type EnrollmentReceipt = { requestId: string; state: EnrollmentState; revision: number; expiresAt: number; decidedAt: number | null };
export type Group = { id: string; projectId: string; title: string; goal: string; revision: number; state: 'active' | 'closed'; createdAt: number; createdBy: string; closedAt: number | null };
export type GroupMember = {
  id: string; groupId: string; projectId: string; sessionId: string; taskId: string;
  kind: 'manual' | 'managed' | 'external'; responsibility: string; summary: string; handoff: HandoffDraft | null;
  native: NativeBinding | null; revision: number; state: 'active' | 'left'; createdAt: number; leftAt: number | null;
};
export type GroupDetail = { group: Group; members: GroupMember[]; invitations: GroupInvitation[]; invitationsTruncated: boolean };
export type GroupInvitation = { id: string; groupId: string; expiresAt: number; createdAt: number; consumedAt: number | null; revokedAt: number | null };
export type ConnectionRequest = EnrollmentReceipt & {
  kind: 'external' | 'managed'; workspaceRoot: string; native: NativeBinding; responsibility: string;
  handoff: HandoffDraft | null; groupTitle: string | null; groupGoal: string | null;
  sessionId: string | null; taskId: string | null; requestDigest: string;
  review: EnrollmentReview | null;
};
export type WorkspaceInspection = {
  projectId: string; workspaceRoot: string; workspaceFingerprint: string; canonicalPath: string;
  projectFingerprint: string; gitMarkerFingerprint: string | null; mode: 'git' | 'advisory'; sharedCheckout: boolean;
};
export type EnrollmentReview = {
  requestId: string; revision: number; requestDigest: string; reviewDigest: string;
  inspection: WorkspaceInspection; group: Group | null; reconnectGrantIds: string[]; nativeIdentitySource: 'request_metadata_not_authentication';
};
export type ApproveEnrollmentInput = {
  requestId: string; revision: number; reviewDigest: string; responsibility: string;
  title?: string; featureKey?: string | null; handoff?: HandoffDraft; expiresInSeconds?: number; reconnectGrantId?: string;
};
export type ExternalGrant = {
  id: string; requestId: string; projectId: string; sessionId: string; taskId: string; memberId: string; groupId: string;
  workspaceRoot: string; workspaceFingerprint: string; projectFingerprint: string;
  createdAt: number; expiresAt: number; revokedAt: number | null; revokeReason: string | null;
  bridgeFirstSeenAt: number | null; bridgeLastSeenAt: number | null;
};
export type EnrollmentApproval = { receipt: EnrollmentReceipt; group: Group; member: GroupMember; grant: ExternalGrant | null };
export type ExternalIdentity = {
  role: 'external'; protocolVersion: number; stateId: string; instanceId: string;
  grantId: string; projectId: string; sessionId: string; taskId: string; memberId: string; groupId: string;
  workspaceRoot: string; expiresAt: number; membershipRevision: number;
};
/** Private client-side configuration. Never include in events, prompts, or API status responses. */
export type ExternalConnection = Omit<ExternalIdentity, 'role' | 'instanceId' | 'membershipRevision'> & { origin: string; capability: string };
export type ExternalOperation = 'identity' | 'context' | 'intent' | 'task-status' | 'check-plan' | 'propose-decision' | 'reserve' | 'release' | 'member-status' | 'leave';
export type ExternalOperationInputs = {
  identity: Record<string, never>; context: { after?: number };
  intent: { revision: number; acceptanceCriteria?: string[]; reads?: string[]; writes?: string[]; produces?: Contract[]; consumes?: Contract[]; dependencies?: string[] };
  'task-status': { revision: number; status: 'active' | 'blocked' | 'ready'; blocker?: string | null };
  'check-plan': { title?: string; writes?: string[]; produces?: Contract[]; consumes?: Contract[] };
  'propose-decision': { key: string; value: string; version: string; rationale: string };
  reserve: { revision: number; resources: Resource[]; ttlSeconds?: number };
  release: { leaseId: string; generation: number };
  'member-status': Record<string, never>; leave: Record<string, never>;
};
export type ReviewedHandoffExport = {
  version: 1; kind: 'reviewed_replacement_handoff'; group: Pick<Group, 'id' | 'projectId'>;
  member: Pick<GroupMember, 'id' | 'groupId' | 'projectId' | 'sessionId' | 'taskId' | 'kind' | 'native' | 'revision'> & { taskRevision: number; sessionRevision: number; workspaceRoot: string; workspaceFingerprint: string; projectFingerprint: string };
  responsibility: string; handoff: HandoffDraft; briefing: string;
  warning: string; // A replacement task, never an attachment or transfer of native process ownership.
};
function strict(raw: unknown, keys: string[]): Record<string, unknown> {
  const value = object(raw);
  assert(keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key)), 'Incomplete or unexpected external connection fields.', 'EXTERNAL_CONFIGURATION');
  return value;
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 128);
  assert(/^[A-Za-z0-9_-]+$/.test(result), `Invalid ${name}.`, 'EXTERNAL_CONFIGURATION');
  return result;
}
export function validatePublicConnectionDescriptor(raw: unknown): PublicConnectionDescriptor {
  const value = strict(raw, ['protocolVersion', 'origin', 'stateId', 'instanceId']);
  assert(value.protocolVersion === PROTOCOL_VERSION, 'Unsupported external protocol.', 'EXTERNAL_CONFIGURATION');
  const origin = text(value.origin, 'origin', 128);
  let url: URL;
  try { url = new URL(origin); } catch { assert(false, 'Invalid external origin.', 'EXTERNAL_CONFIGURATION'); }
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.origin === origin && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use the canonical explicit loopback origin.', 'EXTERNAL_CONFIGURATION');
  integer(Number(url.port), 'port', 1, 65535);
  const stateId = text(value.stateId, 'stateId', 64);
  assert(/^[a-f0-9]{64}$/.test(stateId), 'Invalid state identity.', 'EXTERNAL_CONFIGURATION');
  return { protocolVersion: PROTOCOL_VERSION, origin, stateId, instanceId: id(value.instanceId, 'instanceId') };
}
export function validateExternalConnection(raw: unknown): ExternalConnection {
  const value = strict(raw, ['protocolVersion', 'origin', 'stateId', 'grantId', 'projectId', 'sessionId', 'taskId', 'memberId', 'groupId', 'workspaceRoot', 'expiresAt', 'capability']);
  const descriptor = validatePublicConnectionDescriptor({ protocolVersion: value.protocolVersion, origin: value.origin, stateId: value.stateId, instanceId: 'validation' });
  assert(typeof value.capability === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.capability), 'Invalid external capability.', 'EXTERNAL_CONFIGURATION');
  const { instanceId: _, ...base } = descriptor;
  return { ...base, grantId: id(value.grantId, 'grantId'), projectId: id(value.projectId, 'projectId'), sessionId: id(value.sessionId, 'sessionId'), taskId: id(value.taskId, 'taskId'), memberId: id(value.memberId, 'memberId'), groupId: id(value.groupId, 'groupId'), workspaceRoot: text(value.workspaceRoot, 'workspaceRoot', 4096), expiresAt: integer(value.expiresAt, 'expiresAt', 1, Number.MAX_SAFE_INTEGER), capability: value.capability };
}
export function externalEnvironmentPresent(env: NodeJS.ProcessEnv = process.env): boolean { return Object.keys(env).some(key => key.startsWith('MURMUR_EXTERNAL_')); }
export function readExternalConnection(env: NodeJS.ProcessEnv = process.env): ExternalConnection {
  assert(env[EXTERNAL_MODE_ENV] === '1' && typeof env[EXTERNAL_CONNECTION_ENV] === 'string' && env[EXTERNAL_CONNECTION_ENV]!.length <= 8192, 'A complete external connection is required.', 'EXTERNAL_CONFIGURATION');
  let value: unknown;
  try { value = JSON.parse(env[EXTERNAL_CONNECTION_ENV]!); } catch { assert(false, 'Invalid external connection JSON.', 'EXTERNAL_CONFIGURATION'); }
  return validateExternalConnection(value);
}
