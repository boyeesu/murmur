import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { assert, authorizeExternal, authorizeProject, callerId, canonicalJson, integer, object, requireHuman, text, TOOLS, withAuthorization } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';
import { ENROLLMENT_MAX_BYTES, ENROLLMENT_TTL_MS, INVITE_TTL_MS } from '../protocol/external.js';
import type { ConnectionRequest, EnrollmentReceipt, EnrollmentReview, Group, GroupDetail, GroupInvitation, GroupMember, HandoffDraft, NativeBinding, ReviewedHandoffExport } from '../protocol/external.js';
import type { CoordinationStore, Session, Task } from '../storage/store.js';
import { initializeGroupsSchema } from '../storage/groups-schema.js';
import { validateIntentDeclaration } from './coordination.js';
import type { CoordinationService } from './coordination.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function fields(raw: unknown, allowed: string[]): Record<string, unknown> {
  const input = object(raw);
  assert(Object.keys(input).every(key => allowed.includes(key)), 'Unexpected connection/group fields.');
  return input;
}
export function bounded(value: unknown, name: string, limit: number): string {
  const result = text(value, name, limit).trim();
  assert(!/[\u0000-\u001f\u007f]/.test(result), `${name} must not contain control characters.`);
  return result;
}
export function identifier(value: unknown, name: string): string {
  const result = text(value, name, 128);
  assert(/^[A-Za-z0-9_-]+$/.test(result), `Invalid ${name}.`);
  return result;
}
export function secretHash(value: unknown, name: string): string {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${name} must be a SHA-256 hex digest.`);
  return value;
}
export function nativeBinding(raw: unknown): NativeBinding {
  const input = fields(raw, ['tool', 'nativeId', 'incarnationId']);
  assert(TOOLS.includes(input.tool as NativeBinding['tool']), 'Unsupported native tool.');
  return { tool: input.tool as NativeBinding['tool'], nativeId: bounded(input.nativeId, 'nativeId', 256), incarnationId: bounded(input.incarnationId, 'incarnationId', 256) };
}
export function handoffDraft(raw: unknown): HandoffDraft | null {
  if (raw === undefined || raw === null) return null;
  const input = fields(raw, ['summary', 'changedFiles', 'remainingWork', 'acceptanceCriteria', 'decisions', 'reads', 'writes', 'produces', 'consumes', 'dependencies', 'blocker']);
  const summary = bounded(input.summary, 'handoff summary', 4096);
  assert(input.acceptanceCriteria === undefined || Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length <= 16, 'Use at most 16 acceptance criteria.');
  assert(input.decisions === undefined || Array.isArray(input.decisions) && input.decisions.length <= 8, 'Use at most 8 proposed decisions.');
  const acceptanceCriteria = (input.acceptanceCriteria as unknown[] | undefined)?.map(value => bounded(value, 'acceptance criterion', 512));
  const decisions = (input.decisions as unknown[] | undefined)?.map(raw => {
    const item = fields(raw, ['key', 'value', 'version', 'rationale']);
    const key = bounded(item.key, 'decision key', 128);
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(key), 'Invalid decision key.');
    return { key, value: bounded(item.value, 'decision value', 2048), version: bounded(item.version, 'decision version', 64), rationale: bounded(item.rationale, 'decision rationale', 2048) };
  });
  const changedFiles = input.changedFiles === undefined ? undefined : validateIntentDeclaration({ reads: input.changedFiles }, true).reads;
  assert(input.remainingWork === undefined || Array.isArray(input.remainingWork) && input.remainingWork.length <= 16, 'Use at most 16 remaining-work items.');
  const remainingWork = (input.remainingWork as unknown[] | undefined)?.map(value => bounded(value, 'remaining work', 512));
  const declaration = validateIntentDeclaration(input, true);
  const intent = Object.fromEntries(Object.entries(declaration).filter(([key]) => Object.hasOwn(input, key)));
  const blocker = input.blocker === undefined ? undefined : input.blocker === null ? null : bounded(input.blocker, 'blocker', 2048);
  return { summary, ...(changedFiles ? { changedFiles } : {}), ...(remainingWork ? { remainingWork } : {}), ...intent, ...(acceptanceCriteria ? { acceptanceCriteria } : {}), ...(decisions ? { decisions } : {}), ...(blocker !== undefined ? { blocker } : {}) };
}
export type RequestPayload = { workspaceRoot: string; native: NativeBinding; responsibility: string; handoff: HandoffDraft | null; groupTitle: string | null; groupGoal: string | null; inviteHash: string | null };
export type RequestRow = { id: string; kind: 'external' | 'managed'; caller: string; requestKey: string; requestDigest: string; payload: string; capabilityHash: string | null; pollSecretHash: string | null; sessionId: string | null; taskId: string | null; state: EnrollmentReceipt['state']; revision: number; expiresAt: number; createdAt: number; decidedAt: number | null; review: string | null };
export function target(input: Record<string, unknown>): Pick<RequestPayload, 'groupTitle' | 'groupGoal' | 'inviteHash'> {
  if (input.inviteHash !== undefined) {
    assert(input.groupTitle === undefined && input.groupGoal === undefined, 'Choose either a new group or an invitation.');
    return { inviteHash: secretHash(input.inviteHash, 'inviteHash'), groupTitle: null, groupGoal: null };
  }
  return { inviteHash: null, groupTitle: bounded(input.groupTitle, 'groupTitle', 256), groupGoal: input.groupGoal === undefined ? '' : bounded(input.groupGoal, 'groupGoal', 2048) };
}
export function receipt(row: RequestRow, now: number): EnrollmentReceipt {
  return { requestId: row.id, state: row.state === 'pending' && row.expiresAt <= now ? 'expired' : row.state, revision: row.revision, expiresAt: row.expiresAt, decidedAt: row.decidedAt };
}
export function publicRequest(row: RequestRow, now: number): ConnectionRequest {
  const payload = JSON.parse(row.payload) as RequestPayload;
  return { ...receipt(row, now), kind: row.kind, workspaceRoot: payload.workspaceRoot, native: payload.native, responsibility: payload.responsibility, handoff: payload.handoff, groupTitle: payload.groupTitle, groupGoal: payload.groupGoal, sessionId: row.sessionId, taskId: row.taskId, requestDigest: row.requestDigest, review: row.review ? JSON.parse(row.review) as EnrollmentReview : null };
}
/** Shared grouping, never exclusive feature ownership or native process control. */
export class GroupsService {
  readonly store: CoordinationStore;
  readonly coordination: CoordinationService;
  constructor(store: CoordinationStore, coordination: CoordinationService) { this.store = store; this.coordination = coordination; initializeGroupsSchema(store); }
  private meta(raw: unknown, principal: Principal, mutation: Mutation, operation: string): Mutation {
    assert(mutation.caller === callerId(principal), 'Mutation caller must match authenticated authority.', 'FORBIDDEN', 403);
    const key = text(mutation.key, 'idempotency key', 200);
    assert(/^[A-Za-z0-9_.:-]+$/.test(key), 'Invalid idempotency key.');
    return withAuthorization(principal, { key, caller: callerId(principal), operation: `groups.${operation}`, input: raw });
  }
  groupRow(id: string): Group {
    const row = this.store.db.prepare('SELECT * FROM work_groups WHERE id=?').get(id) as Group | undefined;
    assert(row, 'Unknown group.', 'NOT_FOUND', 404);
    return { ...row };
  }
  memberRow(id: string): GroupMember {
    const row = this.store.db.prepare('SELECT id,groupId,projectId,sessionId,taskId,kind,responsibility,summary,handoff,native,revision,state,createdAt,leftAt FROM group_members WHERE id=?').get(id);
    assert(row, 'Unknown group member.', 'NOT_FOUND', 404);
    return { ...row, native: row.native ? JSON.parse(row.native as string) : null, handoff: row.handoff ? JSON.parse(row.handoff as string) : null } as GroupMember;
  }
  private access(group: Group, principal: Principal): void {
    authorizeProject(principal, group.projectId);
    if (principal.kind === 'external') assert(principal.groupId === group.id, 'External grant belongs to another group.', 'EXTERNAL_FORBIDDEN', 403);
    if (principal.kind === 'session') {
      this.managedBinding(principal);
      assert(this.store.db.prepare("SELECT 1 FROM group_members WHERE groupId=? AND sessionId=? AND state='active'").get(group.id, principal.sessionId), 'Managed session is not a member of this group.', 'FORBIDDEN', 403);
    }
  }
  list(projectId: string, principal: Principal): GroupDetail[] {
    authorizeProject(principal, projectId); this.store.project(projectId);
    if (principal.kind !== 'human') {
      if (principal.kind === 'session') this.managedBinding(principal); else authorizeExternal(principal);
      const member = this.store.db.prepare("SELECT groupId FROM group_members WHERE sessionId=? AND state='active'").get(principal.sessionId);
      return member ? [this.get(member.groupId as string, principal)] : [];
    }
    return (this.store.db.prepare('SELECT id FROM work_groups WHERE projectId=? ORDER BY createdAt,id').all(projectId) as { id: string }[]).map(row => this.get(row.id, principal));
  }
  get(groupId: string, principal: Principal): GroupDetail {
    const group = this.groupRow(identifier(groupId, 'groupId')); this.access(group, principal);
    const members = (this.store.db.prepare('SELECT id FROM group_members WHERE groupId=? ORDER BY createdAt,id').all(group.id) as { id: string }[]).map(row => this.memberRow(row.id));
    const invitations = principal.kind === 'human' ? this.store.db.prepare('SELECT id,groupId,expiresAt,createdAt,consumedAt,revokedAt FROM group_invitations WHERE groupId=? ORDER BY (consumedAt IS NULL AND revokedAt IS NULL AND expiresAt>?) DESC,createdAt DESC,id LIMIT 101').all(group.id, this.store.now()) as GroupInvitation[] : [];
    return { group, members, invitations: invitations.slice(0, 100), invitationsTruncated: invitations.length > 100 };
  }
  create(raw: unknown, principal: Principal, mutation: Mutation): Group {
    requireHuman(principal);
    const input = fields(raw, ['projectId', 'title', 'goal']);
    const data = { projectId: identifier(input.projectId, 'projectId'), title: bounded(input.title, 'title', 256), goal: input.goal === undefined ? '' : bounded(input.goal, 'goal', 2048) };
    return this.store.mutate(this.meta(data, principal, mutation, 'create'), () => this.createGroupRow(data, callerId(principal)));
  }
  /** Transaction-local helpers compose approval without nested mutate calls. */
  createGroupRow(data: { projectId: string; title: string; goal: string }, actor: string): Group {
    this.store.project(data.projectId);
    const id = randomUUID();
    this.store.db.prepare("INSERT INTO work_groups VALUES (?,?,?,?,1,'active',?,?,NULL)").run(id, data.projectId, data.title, data.goal, this.store.now(), actor);
    this.store.event(data.projectId, 'group.created', { id, title: data.title });
    return this.groupRow(id);
  }
  invite(raw: unknown, principal: Principal, mutation: Mutation): GroupInvitation {
    const input = fields(raw, ['groupId', 'inviteHash']);
    const groupId = identifier(input.groupId, 'groupId'), inviteHash = secretHash(input.inviteHash, 'inviteHash');
    assert(principal.kind !== 'external', 'External grants cannot issue invitations.', 'EXTERNAL_FORBIDDEN', 403);
    this.access(this.groupRow(groupId), principal);
    return this.store.mutate(this.meta({ groupId, inviteHash }, principal, mutation, 'invite'), () => {
      const group = this.groupRow(groupId); this.access(group, principal);
      assert(group.state === 'active', 'Group is closed.', 'GROUP_CLOSED', 409);
      const id = randomUUID(), now = this.store.now();
      this.store.db.prepare('INSERT INTO group_invitations VALUES (?,?,?,?,?,NULL,NULL)').run(id, groupId, inviteHash, now + INVITE_TTL_MS, now);
      this.store.event(group.projectId, 'group.invited', { groupId, invitationId: id, expiresAt: now + INVITE_TTL_MS });
      return this.invitationRow(id);
    });
  }
  invitationRow(id: string): GroupInvitation {
    const row = this.store.db.prepare('SELECT id,groupId,expiresAt,createdAt,consumedAt,revokedAt FROM group_invitations WHERE id=?').get(id) as GroupInvitation | undefined;
    assert(row, 'Unknown invitation.', 'NOT_FOUND', 404); return { ...row };
  }
  revokeInvite(raw: unknown, principal: Principal, mutation: Mutation): GroupInvitation {
    requireHuman(principal);
    const inviteId = identifier(fields(raw, ['inviteId']).inviteId, 'inviteId');
    return this.store.mutate(this.meta({ inviteId }, principal, mutation, 'invite.revoke'), () => {
      const invitation = this.invitationRow(inviteId);
      this.store.db.prepare('UPDATE group_invitations SET revokedAt=COALESCE(revokedAt,?) WHERE id=?').run(this.store.now(), inviteId);
      this.store.event(this.groupRow(invitation.groupId).projectId, 'group.invitation_revoked', { invitationId: inviteId });
      return this.invitationRow(inviteId);
    });
  }
  managedBinding(principal: Principal, allowPrepared = false): { session: Session; task: Task } {
    assert(principal.kind === 'session', 'Existing managed scope is required.', 'FORBIDDEN', 403);
    const session = this.store.session(principal.sessionId);
    assert(session.credentialMode === 'managed' && session.projectId === principal.projectId && this.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='murmur_launches'").get(), 'Manual credentials cannot self-enroll.', 'FORBIDDEN', 403);
    const launch = this.store.db.prepare('SELECT taskId,state,expiresAt,projectId,workspaceRoot,agentHash FROM murmur_launches WHERE sessionId=?').get(session.id);
    const token = this.store.db.prepare('SELECT tokenHash FROM sessions WHERE id=?').get(session.id);
    assert(launch && (allowPrepared ? ['prepared', 'claimed', 'running'] : ['claimed', 'running']).includes(String(launch.state)) && typeof launch.expiresAt === 'number' && launch.expiresAt > this.store.now() && launch.projectId === session.projectId && launch.workspaceRoot === session.workspaceRoot && token?.tokenHash === launch.agentHash, 'Managed binding is no longer active.', 'AGENT_UNAUTHORIZED', 401);
    const task = this.store.task(launch.taskId as string);
    assert(task.ownerSessionId === session.id && task.projectId === session.projectId, 'Managed task ownership changed.', 'AGENT_UNAUTHORIZED', 401);
    return { session, task };
  }
  addExisting(raw: unknown, principal: Principal, mutation: Mutation): GroupMember {
    requireHuman(principal);
    const input = fields(raw, ['groupId', 'sessionId', 'taskId', 'responsibility', 'handoff', 'sourceMemberId']);
    const data = { groupId: identifier(input.groupId, 'groupId'), sessionId: identifier(input.sessionId, 'sessionId'), taskId: identifier(input.taskId, 'taskId'), responsibility: bounded(input.responsibility, 'responsibility', 2048), handoff: handoffDraft(input.handoff), sourceMemberId: input.sourceMemberId === undefined ? null : identifier(input.sourceMemberId, 'sourceMemberId') };
    return this.store.mutate(this.meta(data, principal, mutation, 'add-existing'), () => {
      const session = this.store.session(data.sessionId), task = this.store.task(data.taskId);
      assert(session.credentialMode === 'manual' || session.credentialMode === 'managed', 'External memberships require fresh human approval.', 'FORBIDDEN', 403);
      if (session.credentialMode === 'managed') assert(this.managedBinding({ kind: 'session', sessionId: session.id, projectId: session.projectId }, true).task.id === task.id, 'Managed membership must reuse its assigned task.', 'FORBIDDEN', 403);
      if (data.sourceMemberId) {
        const source = this.memberRow(data.sourceMemberId), sourceTask = this.store.task(source.taskId);
        const launch = this.store.db.prepare("SELECT state FROM murmur_launches WHERE sessionId=? AND taskId=?").get(session.id, task.id);
        assert(session.credentialMode === 'managed' && launch?.state === 'prepared' && source.groupId === data.groupId && source.projectId === session.projectId && source.sessionId === sourceTask.ownerSessionId && sourceTask.id !== task.id, 'Replacement handoff must target a new prepared managed task in the reviewed source group.', 'HANDOFF_BINDING_CHANGED', 409);
        assert(['integrated','abandoned'].includes(sourceTask.status), 'Source task is still active. Explicitly resolve or abandon it before creating replacement work; no ownership was transferred.', 'HANDOFF_SOURCE_ACTIVE', 409);
      }
      const member = this.addMemberRow(data.groupId, session, task, data.responsibility, data.handoff, null, callerId(principal));
      if (data.sourceMemberId) this.provenanceRow(data.groupId, member.id, null, null, 'replacement_source_member', data.sourceMemberId, callerId(principal));
      return member;
    });
  }
  addMemberRow(groupId: string, session: Session, task: Task, responsibility: string, handoff: HandoffDraft | null, native: NativeBinding | null, actor: string, requestId: string | null = null): GroupMember {
    const group = this.groupRow(groupId);
    assert(group.state === 'active', 'Group is closed.', 'GROUP_CLOSED', 409);
    assert(group.projectId === session.projectId && task.projectId === group.projectId && task.ownerSessionId === session.id, 'Membership cannot take another task or project.', 'FORBIDDEN', 403);
    assert(!['integrated', 'abandoned'].includes(task.status), 'Terminal tasks cannot join groups.', 'TASK_TERMINAL', 409);
    const nativeKey = native ? digest(canonicalJson(native)) : null;
    assert(!this.store.db.prepare("SELECT 1 FROM group_members WHERE state='active' AND (sessionId=? OR nativeKey=?)").get(session.id, nativeKey), 'This chat already has an active group.', 'MEMBERSHIP_EXISTS', 409);
    const id = randomUUID();
    this.store.db.prepare("INSERT INTO group_members VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'active',?,NULL)").run(id, groupId, group.projectId, session.id, task.id, session.credentialMode, responsibility, handoff?.summary ?? '', handoff ? JSON.stringify(handoff) : null, native ? JSON.stringify(native) : null, nativeKey, this.store.now());
    this.store.db.prepare('UPDATE work_groups SET revision=revision+1 WHERE id=?').run(groupId);
    this.provenanceRow(groupId, id, requestId, null, 'member', id, actor);
    if (handoff?.changedFiles) this.provenanceRow(groupId, id, requestId, null, 'reported_changed_files', id, actor);
    if (handoff?.remainingWork) this.provenanceRow(groupId, id, requestId, null, 'remaining_work', id, actor);
    if (handoff) this.coordination.publishReviewedHandoffRow(task.id, handoff, actor, (type, entityId) => this.provenanceRow(groupId, id, requestId, null, type, entityId, actor));
    this.store.event(group.projectId, 'group.member_joined', { groupId, memberId: id, sessionId: session.id, taskId: task.id, responsibility, summary: handoff?.summary ?? '' });
    return this.memberRow(id);
  }
  provenanceRow(groupId: string, memberId: string | null, requestId: string | null, grantId: string | null, entityType: string, entityId: string, actor: string): void {
    this.store.db.prepare('INSERT INTO group_provenance VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), this.groupRow(groupId).projectId, groupId, memberId, requestId, grantId, entityType, entityId, actor, this.store.now());
  }
  leave(raw: unknown, principal: Principal, mutation: Mutation): GroupMember {
    const input = fields(raw, ['memberId', 'revision']);
    const memberId = identifier(input.memberId, 'memberId'), revision = integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER - 1);
    const authorize = () => {
      const member = this.memberRow(memberId);
      if (principal.kind !== 'human') {
        this.access(this.groupRow(member.groupId), principal);
        assert(principal.sessionId === member.sessionId && (principal.kind !== 'external' || principal.memberId === memberId), 'Cannot leave another member.', 'FORBIDDEN', 403);
      }
      return member;
    };
    authorize();
    return this.store.mutate(this.meta({ memberId, revision }, principal, mutation, 'leave'), () => {
      const member = authorize();
      assert(member.revision === revision && member.state === 'active', 'Membership changed.', 'STALE_REVISION', 409);
      this.leaveMemberRow(memberId, 'left'); return this.memberRow(memberId);
    });
  }
  leaveMemberRow(memberId: string, reason: string): void {
    const member = this.memberRow(memberId);
    for (const grant of this.store.db.prepare('SELECT id FROM external_grants WHERE memberId=? AND revokedAt IS NULL').all(memberId)) this.revokeGrantRow(grant.id as string, reason);
    if (member.state === 'active') {
      this.store.db.prepare("UPDATE group_members SET state='left',leftAt=?,revision=revision+1 WHERE id=?").run(this.store.now(), memberId);
      this.store.db.prepare('UPDATE work_groups SET revision=revision+1 WHERE id=?').run(member.groupId);
      this.store.event(member.projectId, 'group.member_left', { groupId: member.groupId, memberId, reason });
    }
  }
  revokeGrantRow(grantId: string, reason: string): void {
    const grant = this.store.db.prepare('SELECT * FROM external_grants WHERE id=?').get(grantId);
    assert(grant, 'Unknown external grant.', 'NOT_FOUND', 404);
    if (grant.revokedAt !== null) return;
    const now = this.store.now();
    this.store.db.prepare('UPDATE external_grants SET revokedAt=?,revokeReason=? WHERE id=? AND revokedAt IS NULL').run(now, reason, grantId);
    const leases = this.store.db.prepare('SELECT l.id FROM leases l JOIN external_grant_leases p ON p.leaseId=l.id AND p.generation=l.generation WHERE p.grantId=? AND l.releasedAt IS NULL').all(grantId);
    for (const row of leases) {
      this.store.db.prepare('UPDATE leases SET releasedAt=? WHERE id=?').run(now, row.id as string);
      this.store.event(grant.projectId as string, 'reservation.released', { ...this.store.lease(row.id as string), reason: 'external_grant_revoked' });
    }
    this.store.event(grant.projectId as string, 'external.revoked', { grantId, memberId: grant.memberId, reason });
  }
  close(raw: unknown, principal: Principal, mutation: Mutation): Group {
    requireHuman(principal);
    const input = fields(raw, ['groupId', 'revision']);
    const groupId = identifier(input.groupId, 'groupId'), revision = integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER - 1);
    return this.store.mutate(this.meta({ groupId, revision }, principal, mutation, 'close'), () => {
      const group = this.groupRow(groupId);
      assert(group.revision === revision && group.state === 'active', 'Group changed.', 'STALE_REVISION', 409);
      for (const row of this.store.db.prepare("SELECT id FROM group_members WHERE groupId=? AND state='active'").all(groupId)) this.leaveMemberRow(row.id as string, 'group_closed');
      this.store.db.prepare("UPDATE work_groups SET state='closed',closedAt=?,revision=revision+1 WHERE id=?").run(this.store.now(), groupId);
      this.store.db.prepare('UPDATE group_invitations SET revokedAt=COALESCE(revokedAt,?) WHERE groupId=?').run(this.store.now(), groupId);
      this.store.event(group.projectId, 'group.closed', { groupId }); return this.groupRow(groupId);
    });
  }
  requestRow(id: string): RequestRow {
    const row = this.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(id) as RequestRow | undefined;
    assert(row, 'Unknown connection request.', 'NOT_FOUND', 404); return row;
  }
  requestManaged(raw: unknown, principal: Principal, mutation: Mutation): EnrollmentReceipt {
    const binding = this.managedBinding(principal);
    const input = fields(raw, ['groupTitle', 'groupGoal', 'inviteHash', 'responsibility', 'handoff']);
    const payload: RequestPayload = { ...target(input), workspaceRoot: binding.session.workspaceRoot, native: { tool: binding.session.tool, nativeId: binding.session.nativeId, incarnationId: binding.session.instanceId }, responsibility: bounded(input.responsibility, 'responsibility', 2048), handoff: handoffDraft(input.handoff) };
    assert(Buffer.byteLength(canonicalJson(payload)) <= ENROLLMENT_MAX_BYTES, 'Enrollment payload exceeds 16 KiB.');
    return this.store.mutate(this.meta(payload, principal, mutation, 'request-managed'), () => {
      this.managedBinding(principal); this.admitRequest();
      const id = randomUUID(), now = this.store.now();
      this.store.db.prepare("INSERT INTO connection_requests VALUES (?,'managed',?,?,?,?,NULL,NULL,?,?,'pending',1,?,?,NULL,NULL)").run(id, callerId(principal), mutation.key, digest(canonicalJson(payload)), JSON.stringify(payload), binding.session.id, binding.task.id, now + ENROLLMENT_TTL_MS, now);
      return receipt(this.requestRow(id), now);
    });
  }
  admitRequest(): void {
    const now = this.store.now();
    assert(Number(this.store.db.prepare("SELECT COUNT(*) AS count FROM connection_requests WHERE state='pending' AND expiresAt>?").get(now)!.count) < 32, 'Too many pending connection requests.', 'ENROLLMENT_LIMIT', 429);
    assert(Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM connection_requests WHERE createdAt>?').get(now - 60_000)!.count) < 10, 'Connection request admission limit reached.', 'ENROLLMENT_LIMIT', 429);
  }
  briefing(raw: unknown, principal: Principal): ReviewedHandoffExport {
    requireHuman(principal);
    const member = this.memberRow(identifier(fields(raw, ['memberId']).memberId, 'memberId'));
    const group = this.groupRow(member.groupId), task = this.store.task(member.taskId), session = this.store.session(member.sessionId);
    assert(task.ownerSessionId === session.id && task.projectId === group.projectId, 'Source ownership changed; review its current owner before exporting.', 'HANDOFF_BINDING_CHANGED', 409);
    const project = this.store.project(group.projectId);
    const stamp = (location: string) => { const info = statSync(location); return `${info.dev}:${info.ino}:${info.birthtimeMs}`; };
    assert(realpathSync(session.workspaceRoot) === session.workspaceRoot && realpathSync(project.canonicalPath) === project.canonicalPath, 'Source workspace or project path changed.', 'WORKSPACE_CHANGED', 409);
    const workspaceFingerprint = stamp(session.workspaceRoot), projectFingerprint = stamp(project.canonicalPath);
    this.store.verifyProjectIdentity(group.projectId, projectFingerprint);
    const context = this.coordination.context(group.projectId, member.taskId);
    return { version: 1, kind: 'reviewed_replacement_handoff', group: { id: group.id, projectId: group.projectId },
      member: { id: member.id, groupId: member.groupId, projectId: member.projectId, sessionId: member.sessionId, taskId: member.taskId, kind: member.kind, native: member.native, revision: member.revision, taskRevision: task.revision, sessionRevision: session.revision, workspaceRoot: session.workspaceRoot, workspaceFingerprint, projectFingerprint },
      responsibility: member.responsibility, handoff: member.handoff ?? { summary: member.summary || member.responsibility }, briefing: context.briefing,
      warning: 'This reviewed handoff can seed a NEW managed task. It does not attach to, stop, transfer, or copy files from the original chat. Existing workspace preparation and dirty-base consent still apply.' };
  }
}
