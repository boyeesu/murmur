import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath, stat, lstat, readFile } from 'node:fs/promises';
import { realpathSync, statSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assert, authenticatedExternalPrincipal, authorizeExternal, callerId, canonicalJson, integer, MurmurError, PROTOCOL_VERSION, requireHuman, text, withAuthorization } from '../protocol/index.js';
import type { ExternalPrincipal, Mutation, Principal } from '../protocol/index.js';
import { ENROLLMENT_MAX_BYTES, ENROLLMENT_TTL_MS, EXTERNAL_MAX_TTL_MS, EXTERNAL_TTL_MS } from '../protocol/external.js';
import type { EnrollmentApproval, EnrollmentReceipt, EnrollmentReview, ExternalGrant, ExternalIdentity, ExternalOperation, Group, WorkspaceInspection } from '../protocol/external.js';
import type { CoordinationStore } from '../storage/store.js';
import { discoverProject, normalizeResources } from '../workspaces/identity.js';
import type { CoordinationService } from './coordination.js';
import { bounded, digest, fields, GroupsService, handoffDraft, identifier, nativeBinding, publicRequest, receipt, secretHash, target } from './groups.js';
import type { RequestPayload, RequestRow } from './groups.js';

type Runtime = { origin: string; stateId: string; instanceId: string };
type GrantRow = ExternalGrant & { capabilityHash: string; canonicalPath: string; gitMarkerFingerprint: string | null; projectMode: 'git' | 'advisory'; sessionRevision: number; nativeKey: string };
const grantColumns = 'id,requestId,projectId,sessionId,taskId,memberId,groupId,workspaceRoot,workspaceFingerprint,projectFingerprint,createdAt,expiresAt,revokedAt,revokeReason,bridgeFirstSeenAt,bridgeLastSeenAt';
const fingerprint = (info: { dev: number; ino: number; birthtimeMs: number }): string => `${info.dev}:${info.ino}:${info.birthtimeMs}`;
function markerSync(workspace: string): string {
  const marker = path.join(workspace, '.git'), info = lstatSync(marker);
  if (info.isFile()) {
    assert(info.size <= 16 * 1024, 'Git worktree marker is too large.', 'WORKSPACE_CHANGED', 409);
    return `${fingerprint(info)}:${digest(readFileSync(marker, 'utf8'))}`;
  }
  assert(info.isDirectory() || info.isSymbolicLink(), 'Invalid Git worktree marker.', 'WORKSPACE_CHANGED', 409);
  return `${fingerprint(info)}:${realpathSync(marker)}:${fingerprint(statSync(marker))}`;
}
async function markerAsync(workspace: string): Promise<string> {
  const marker = path.join(workspace, '.git'), info = await lstat(marker);
  if (info.isFile()) {
    assert(info.size <= 16 * 1024, 'Git worktree marker is too large.', 'WORKSPACE_CHANGED', 409);
    return `${fingerprint(info)}:${digest(await readFile(marker, 'utf8'))}`;
  }
  assert(info.isDirectory() || info.isSymbolicLink(), 'Invalid Git worktree marker.', 'WORKSPACE_CHANGED', 409);
  return `${fingerprint(info)}:${await realpath(marker)}:${fingerprint(await stat(marker))}`;
}
const immutableGrant = (grant: GrantRow): string => digest(canonicalJson({ id: grant.id, requestId: grant.requestId, projectId: grant.projectId, sessionId: grant.sessionId, taskId: grant.taskId, memberId: grant.memberId, groupId: grant.groupId, capabilityHash: grant.capabilityHash, workspaceRoot: grant.workspaceRoot, workspaceFingerprint: grant.workspaceFingerprint, canonicalPath: grant.canonicalPath, projectFingerprint: grant.projectFingerprint, gitMarkerFingerprint: grant.gitMarkerFingerprint, projectMode: grant.projectMode, sessionRevision: grant.sessionRevision, nativeKey: grant.nativeKey, createdAt: grant.createdAt, expiresAt: grant.expiresAt }));
const credentialMatches = (secret: unknown, expected: string): boolean => {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(expected, 'hex'));
};
/** Public enrollment is deliberately separate from authenticated, immutable external authority. */
export class ExternalGrantService {
  readonly store: CoordinationStore;
  readonly coordination: CoordinationService;
  readonly groups: GroupsService;
  readonly runtime: Runtime;
  constructor(store: CoordinationStore, coordination: CoordinationService, groups: GroupsService, runtime: Runtime) { this.store = store; this.coordination = coordination; this.groups = groups; this.runtime = { ...runtime }; }
  private key(value: unknown): string {
    const key = text(value, 'idempotency key', 200);
    assert(/^[A-Za-z0-9_.:-]+$/.test(key), 'Invalid idempotency key.'); return key;
  }
  private humanMeta(input: unknown, principal: Principal, mutation: Mutation, operation: string): Mutation {
    requireHuman(principal);
    assert(mutation.caller === 'human', 'Mutation caller must be human.', 'FORBIDDEN', 403);
    return { key: this.key(mutation.key), caller: 'human', operation: `external.${operation}`, input };
  }
  createEnrollment(raw: unknown, key: string): EnrollmentReceipt {
    assert(Buffer.byteLength(canonicalJson(raw)) <= ENROLLMENT_MAX_BYTES, 'Enrollment payload exceeds 16 KiB.', 'BODY_TOO_LARGE', 413);
    const input = fields(raw, ['capabilityHash', 'pollSecretHash', 'workspaceRoot', 'native', 'responsibility', 'handoff', 'groupTitle', 'groupGoal', 'inviteHash']);
    const capabilityHash = secretHash(input.capabilityHash, 'capabilityHash'), pollSecretHash = secretHash(input.pollSecretHash, 'pollSecretHash');
    assert(capabilityHash !== pollSecretHash, 'Use distinct candidate and polling credentials.');
    const workspaceRoot = bounded(input.workspaceRoot, 'workspaceRoot', 4096);
    assert(path.isAbsolute(workspaceRoot), 'workspaceRoot must be an absolute path.');
    const payload: RequestPayload = { ...target(input), workspaceRoot, native: nativeBinding(input.native), responsibility: bounded(input.responsibility, 'responsibility', 2048), handoff: handoffDraft(input.handoff) };
    const requestDigest = digest(canonicalJson({ payload, capabilityHash, pollSecretHash }));
    const mutation = { caller: `enrollment:${pollSecretHash}`, key: this.key(key), operation: 'external.enrollment', input: { requestDigest } };
    return this.store.mutate(mutation, () => {
      this.groups.admitRequest();
      assert(!this.store.db.prepare('SELECT 1 FROM connection_requests WHERE capabilityHash=?').get(capabilityHash), 'Candidate was already submitted; retain the original request receipt.', 'ENROLLMENT_EXISTS', 409);
      const id = randomUUID(), now = this.store.now();
      // No filesystem, project, or invitation lookup occurs before human review.
      this.store.db.prepare("INSERT INTO connection_requests VALUES (?,'external',?,?,?,?,?,?,NULL,NULL,'pending',1,?,?,NULL,NULL)").run(id, mutation.caller, mutation.key, requestDigest, JSON.stringify(payload), capabilityHash, pollSecretHash, now + ENROLLMENT_TTL_MS, now);
      return receipt(this.groups.requestRow(id), now);
    });
  }
  pollStatus(raw: unknown): EnrollmentReceipt {
    const input = fields(raw, ['requestId', 'pollSecret']);
    const requestId = identifier(input.requestId, 'requestId');
    const row = this.store.db.prepare('SELECT * FROM connection_requests WHERE id=?').get(requestId) as RequestRow | undefined;
    assert(row?.kind === 'external' && row.pollSecretHash && credentialMatches(input.pollSecret, row.pollSecretHash), 'Invalid connection status proof.', 'ENROLLMENT_UNAUTHORIZED', 401);
    return receipt(row, this.store.now());
  }
  listRequests(principal: Principal) {
    requireHuman(principal);
    return (this.store.db.prepare('SELECT * FROM connection_requests ORDER BY createdAt DESC,id LIMIT 100').all() as RequestRow[]).map(row => publicRequest(row, this.store.now()));
  }
  private pending(row: RequestRow, revision: number): void {
    const payload = JSON.parse(row.payload) as RequestPayload;
    const actualDigest = digest(canonicalJson(row.kind === 'managed' ? payload : { payload, capabilityHash: row.capabilityHash, pollSecretHash: row.pollSecretHash }));
    assert(row.requestDigest === actualDigest, 'Immutable request content changed.', 'STALE_REVIEW', 409);
    assert(row.state === 'pending' && row.expiresAt > this.store.now(), 'Connection request is no longer pending.', 'ENROLLMENT_INACTIVE', 409);
    assert(row.revision === revision, 'Connection review revision changed.', 'STALE_REVISION', 409);
  }
  private requestBinding(row: RequestRow): void {
    if (row.kind !== 'managed') return;
    assert(row.sessionId && row.taskId, 'Managed request lost its binding.', 'AGENT_UNAUTHORIZED', 401);
    const session = this.store.session(row.sessionId);
    const binding = this.groups.managedBinding({ kind: 'session', sessionId: row.sessionId, projectId: session.projectId });
    const payload = JSON.parse(row.payload) as RequestPayload;
    assert(binding.task.id === row.taskId && binding.session.workspaceRoot === payload.workspaceRoot && canonicalJson(payload.native) === canonicalJson({ tool: session.tool, nativeId: session.nativeId, incarnationId: session.instanceId }), 'Managed request binding changed.', 'AGENT_UNAUTHORIZED', 401);
  }
  private invitation(payload: RequestPayload, projectId: string): { group: Group; invitationId: string } | null {
    if (!payload.inviteHash) return null;
    const invitation = this.store.db.prepare('SELECT * FROM group_invitations WHERE inviteHash=?').get(payload.inviteHash);
    assert(invitation && invitation.consumedAt === null && invitation.revokedAt === null && Number(invitation.expiresAt) > this.store.now(), 'Invitation is unavailable or expired.', 'INVITATION_INACTIVE', 409);
    const group = this.groups.groupRow(invitation.groupId as string);
    assert(group.state === 'active' && group.projectId === projectId, 'Invitation does not match this active project.', 'INVITATION_INACTIVE', 409);
    return { group, invitationId: invitation.id as string };
  }
  /** Read-only discovery; never creates a worktree, adopts source, or reads native histories. */
  private async inspectWorkspace(workspace: string): Promise<WorkspaceInspection> {
    const identity = await discoverProject(workspace);
    const project = this.store.db.prepare('SELECT id FROM projects WHERE canonicalPath=?').get(identity.canonicalPath);
    assert(project && identity.fingerprint, 'Initialize this project explicitly before connecting an existing chat.', 'PROJECT_NOT_REGISTERED', 409);
    const projectId = project.id as string;
    this.store.verifyProjectIdentity(projectId, identity.fingerprint);
    const workspaceRoot = await realpath(identity.root), info = await stat(workspaceRoot);
    assert(info.isDirectory(), 'Workspace root is not a directory.', 'WORKSPACE_CHANGED', 409);
    const gitMarkerFingerprint = identity.mode === 'git' ? await markerAsync(workspaceRoot) : null;
    const sharedCheckout = !!this.store.db.prepare('SELECT 1 FROM sessions WHERE projectId=? AND workspaceRoot=?').get(projectId, workspaceRoot);
    return { projectId, workspaceRoot, workspaceFingerprint: fingerprint(info), canonicalPath: identity.canonicalPath, projectFingerprint: identity.fingerprint, gitMarkerFingerprint, mode: identity.mode, sharedCheckout };
  }
  private inspectSync(inspection: WorkspaceInspection): void {
    try {
      const workspace = realpathSync(inspection.workspaceRoot), canonical = realpathSync(inspection.canonicalPath);
      assert(workspace === inspection.workspaceRoot && canonical === inspection.canonicalPath && fingerprint(statSync(workspace)) === inspection.workspaceFingerprint && fingerprint(statSync(canonical)) === inspection.projectFingerprint, 'Workspace identity changed.', 'WORKSPACE_CHANGED', 409);
      assert(inspection.mode !== 'git' || markerSync(workspace) === inspection.gitMarkerFingerprint, 'Git workspace mapping changed.', 'WORKSPACE_CHANGED', 409);
      const project = this.store.project(inspection.projectId);
      assert(project.canonicalPath === inspection.canonicalPath && project.mode === inspection.mode, 'Project binding changed.', 'WORKSPACE_CHANGED', 409);
      this.store.verifyProjectIdentity(inspection.projectId, inspection.projectFingerprint);
    } catch (error) {
      if (error instanceof MurmurError) throw error;
      throw new MurmurError('Workspace identity could not be verified.', 'WORKSPACE_CHANGED', 409);
    }
  }
  async review(raw: unknown, principal: Principal, mutation: Mutation): Promise<EnrollmentReview> {
    requireHuman(principal);
    const input = fields(raw, ['requestId', 'revision']);
    const requestId = identifier(input.requestId, 'requestId'), revision = integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER - 1);
    const before = this.groups.requestRow(requestId); this.pending(before, before.revision); this.requestBinding(before);
    const meta = this.humanMeta({ requestId, revision, requestDigest: before.requestDigest }, principal, mutation, 'review');
    let cached = this.store.replay<EnrollmentReview>(meta);
    if (!cached.found) assert(before.revision === revision, 'Connection review revision changed.', 'STALE_REVISION', 409);
    const payload = JSON.parse(before.payload) as RequestPayload;
    const inspection = await this.inspectWorkspace(payload.workspaceRoot);
    // All asynchronous inspection is done before BEGIN; pins are checked again under the write lock.
    const current = this.groups.requestRow(requestId); this.pending(current, current.revision); this.requestBinding(current);
    cached = this.store.replay<EnrollmentReview>(meta);
    if (cached.found) {
      assert(current.review && current.revision === cached.response.revision && JSON.parse(current.review).reviewDigest === cached.response.reviewDigest && this.sameInspection(inspection, cached.response.inspection), 'Pinned review no longer matches current workspace.', 'STALE_REVIEW', 409);
      this.invitation(payload, inspection.projectId); this.inspectSync(cached.response.inspection);
      return cached.response;
    }
    assert(current.revision === revision, 'Connection review revision changed.', 'STALE_REVISION', 409);
    const invited = this.invitation(payload, inspection.projectId);
    const reconnectGrantIds = before.kind === 'external' ? (this.store.db.prepare('SELECT id FROM external_grants WHERE projectId=? AND (revokedAt IS NOT NULL OR expiresAt<=?) ORDER BY createdAt DESC,id').all(inspection.projectId, this.store.now()) as { id: string }[]).filter(candidate => { try { this.reconnectBinding(candidate.id, payload, inspection); return true; } catch { return false; } }).map(candidate => candidate.id) : [];
    const immutable = { requestId, requestDigest: before.requestDigest, inspection, group: invited?.group ?? null, reconnectGrantIds, nativeIdentitySource: 'request_metadata_not_authentication' as const };
    const reviewDigest = digest(canonicalJson(immutable));
    return this.store.mutate(meta, () => {
      const row = this.groups.requestRow(requestId); this.pending(row, revision); this.requestBinding(row); this.inspectSync(inspection);
      assert(row.requestDigest === before.requestDigest, 'Request content changed.', 'STALE_REVIEW', 409);
      this.invitation(payload, inspection.projectId);
      const result: EnrollmentReview = { ...immutable, revision: revision + 1, reviewDigest };
      const changed = this.store.db.prepare('UPDATE connection_requests SET review=?,revision=revision+1 WHERE id=? AND revision=? AND state=\'pending\'').run(JSON.stringify(result), requestId, revision);
      assert(Number(changed.changes) === 1, 'Review changed concurrently.', 'STALE_REVISION', 409);
      return result;
    });
  }
  async approve(raw: unknown, principal: Principal, mutation: Mutation): Promise<EnrollmentApproval> {
    requireHuman(principal);
    const input = fields(raw, ['requestId', 'revision', 'reviewDigest', 'responsibility', 'title', 'featureKey', 'handoff', 'expiresInSeconds', 'reconnectGrantId']);
    const data = { reconnectGrantId: input.reconnectGrantId === undefined ? null : identifier(input.reconnectGrantId, 'reconnectGrantId'), requestId: identifier(input.requestId, 'requestId'), revision: integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER - 1), reviewDigest: secretHash(input.reviewDigest, 'reviewDigest'), responsibility: bounded(input.responsibility, 'responsibility', 2048), title: input.title === undefined ? null : bounded(input.title, 'title', 512), featureKey: input.featureKey === undefined || input.featureKey === null ? null : bounded(input.featureKey, 'featureKey', 128).toLowerCase(), handoff: handoffDraft(input.handoff), expiresInSeconds: input.expiresInSeconds === undefined ? EXTERNAL_TTL_MS / 1000 : integer(input.expiresInSeconds, 'expiresInSeconds', 1, EXTERNAL_MAX_TTL_MS / 1000) };
    assert(Buffer.byteLength(canonicalJson(data)) <= ENROLLMENT_MAX_BYTES, 'Approval payload exceeds 16 KiB.');
    const before = this.groups.requestRow(data.requestId);
    const meta = this.humanMeta(data, principal, mutation, 'approve');
    if (before.state === 'approved') {
      const cached = this.store.replay<EnrollmentApproval>(meta);
      assert(cached.found, 'Connection request already decided.', 'ENROLLMENT_INACTIVE', 409);
      // Return historical human receipt, never make revoked authority live again.
      const grant = cached.response.grant ? this.grant(cached.response.grant.id) : null;
      return { ...cached.response, grant, member: this.groups.memberRow(cached.response.member.id), group: this.groups.groupRow(cached.response.group.id) };
    }
    this.pending(before, data.revision); this.requestBinding(before);
    assert(before.review, 'Review this request before approval.', 'REVIEW_REQUIRED', 409);
    const review = JSON.parse(before.review) as EnrollmentReview;
    assert(review.revision === data.revision && review.reviewDigest === data.reviewDigest && review.requestDigest === before.requestDigest, 'Approval does not match the reviewed request.', 'STALE_REVIEW', 409);
    const payload = JSON.parse(before.payload) as RequestPayload;
    assert(data.reconnectGrantId === null || before.kind === 'external', 'Only an external request can reconnect external authority.', 'RECONNECT_FORBIDDEN', 403);
    const reconnect = data.reconnectGrantId ? this.reconnectBinding(data.reconnectGrantId, payload, review.inspection) : null;
    assert(data.reconnectGrantId === null || review.reconnectGrantIds.includes(data.reconnectGrantId), 'Reconnect target was not eligible in this human review.', 'RECONNECT_CHANGED', 409);
    const inspection = await this.inspectWorkspace(payload.workspaceRoot);
    assert(this.sameInspection(inspection, review.inspection), 'Workspace changed since review.', 'STALE_REVIEW', 409);
    return this.store.mutate(meta, () => {
      const row = this.groups.requestRow(data.requestId); this.pending(row, data.revision); this.requestBinding(row); this.inspectSync(review.inspection);
      assert(row.requestDigest === before.requestDigest && row.review === before.review, 'Reviewed request changed during inspection.', 'STALE_REVIEW', 409);
      const invited = this.invitation(payload, inspection.projectId);
      assert((invited?.group.id ?? null) === (review.group?.id ?? null), 'Invitation changed since review.', 'STALE_REVIEW', 409);
      const group = invited?.group ?? this.groups.createGroupRow({ projectId: inspection.projectId, title: payload.groupTitle!, goal: payload.groupGoal ?? '' }, 'human');
      let session, task;
      if (row.kind === 'managed') {
        assert(data.featureKey === null && data.title === null, 'Managed membership reuses its existing task; it cannot rename or replace ownership.', 'FORBIDDEN', 403);
        session = this.store.session(row.sessionId!); task = this.store.task(row.taskId!);
      } else if (reconnect) {
        const current = this.reconnectBinding(data.reconnectGrantId!, payload, inspection);
        assert(current.session.revision === reconnect.session.revision && immutableGrant(current.grant) === immutableGrant(reconnect.grant), 'Reconnect binding changed during inspection.', 'RECONNECT_CHANGED', 409);
        assert((data.featureKey === null || data.featureKey === current.task.featureKey) && (data.title === null || data.title === current.task.title), 'Reconnect preserves the existing task title and exclusive feature claim.', 'RECONNECT_CHANGED', 409);
        assert(row.capabilityHash, 'Candidate capability is missing.', 'ENROLLMENT_INACTIVE', 409);
        this.groups.leaveMemberRow(current.grant.memberId, 'reconnected');
        const changed = this.store.db.prepare("UPDATE sessions SET tokenHash=?,instanceId=?,revision=revision+1 WHERE id=? AND revision=? AND credentialMode='external'").run(row.capabilityHash, row.id, current.session.id, current.session.revision);
        assert(Number(changed.changes) === 1, 'Reconnect session changed.', 'RECONNECT_CHANGED', 409);
        session = this.store.session(current.session.id); task = this.store.task(current.task.id);
      } else {
        assert(row.capabilityHash, 'Candidate capability is missing.', 'ENROLLMENT_INACTIVE', 409);
        session = this.store.createSessionRow({ projectId: inspection.projectId, tool: payload.native.tool, nativeId: payload.native.nativeId, instanceId: row.id, workspaceRoot: inspection.workspaceRoot, tokenHash: row.capabilityHash, credentialMode: 'external' });
        task = this.store.createTaskRow({ projectId: inspection.projectId, sessionId: session.id, title: data.title ?? data.responsibility.slice(0, 512), featureKey: data.featureKey });
      }
      const member = this.groups.addMemberRow(group.id, session, task, data.responsibility, data.handoff, payload.native, 'human', row.id);
      let grant: ExternalGrant | null = null;
      if (row.kind === 'external') {
        const id = randomUUID(), now = this.store.now();
        this.store.db.prepare('INSERT INTO external_grants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)').run(id, row.id, inspection.projectId, session.id, task.id, member.id, group.id, row.capabilityHash!, inspection.workspaceRoot, inspection.workspaceFingerprint, inspection.canonicalPath, inspection.projectFingerprint, inspection.gitMarkerFingerprint, inspection.mode, session.revision, digest(canonicalJson(payload.native)), now, now + data.expiresInSeconds * 1000);
        grant = this.grant(id);
        this.groups.provenanceRow(group.id, member.id, row.id, id, 'grant', id, 'human');
        if (reconnect) this.groups.provenanceRow(group.id, member.id, row.id, id, 'reconnect', reconnect.grant.id, 'human');
        this.store.db.prepare('UPDATE group_provenance SET grantId=? WHERE requestId=? AND grantId IS NULL').run(id, row.id);
      }
      if (invited) {
        const consumed = this.store.db.prepare('UPDATE group_invitations SET consumedAt=? WHERE id=? AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt>?').run(this.store.now(), invited.invitationId, this.store.now());
        assert(Number(consumed.changes) === 1, 'Invitation was consumed concurrently.', 'INVITATION_INACTIVE', 409);
      }
      const changed = this.store.db.prepare("UPDATE connection_requests SET state='approved',revision=revision+1,decidedAt=? WHERE id=? AND revision=? AND state='pending' AND expiresAt>?").run(this.store.now(), row.id, data.revision, this.store.now());
      assert(Number(changed.changes) === 1, 'Connection request changed concurrently.', 'STALE_REVISION', 409);
      this.store.event(inspection.projectId, 'external.approved', { requestId: row.id, memberId: member.id, grantId: grant?.id ?? null, taskId: task.id });
      return { receipt: receipt(this.groups.requestRow(row.id), this.store.now()), group: this.groups.groupRow(group.id), member, grant };
    });
  }
  private reconnectBinding(id: string, payload: RequestPayload, inspection: WorkspaceInspection) {
    const grant = this.store.db.prepare('SELECT * FROM external_grants WHERE id=?').get(id) as GrantRow | undefined;
    assert(grant && (grant.revokedAt !== null || grant.expiresAt <= this.store.now()), 'Reconnect requires an expired or revoked external grant, never an active takeover.', 'RECONNECT_FORBIDDEN', 409);
    const session = this.store.session(grant.sessionId), task = this.store.task(grant.taskId), member = this.groups.memberRow(grant.memberId);
    const token = this.store.db.prepare('SELECT tokenHash FROM sessions WHERE id=?').get(session.id);
    assert(session.credentialMode === 'external' && session.projectId === inspection.projectId && task.projectId === inspection.projectId && task.ownerSessionId === session.id && session.workspaceRoot === inspection.workspaceRoot && session.revision === grant.sessionRevision && session.instanceId === grant.requestId && token?.tokenHash === grant.capabilityHash && session.nativeId === payload.native.nativeId && session.tool === payload.native.tool && member.kind === 'external' && member.native && canonicalJson(member.native) === canonicalJson(payload.native) && grant.nativeKey === digest(canonicalJson(payload.native)), 'Reconnect binding no longer matches this exact external chat and owner.', 'RECONNECT_CHANGED', 409);
    assert(!['integrated','abandoned'].includes(task.status), 'Terminal tasks cannot be reconnected.', 'TASK_TERMINAL', 409);
    assert(grant.projectId === inspection.projectId && grant.workspaceRoot === inspection.workspaceRoot && grant.workspaceFingerprint === inspection.workspaceFingerprint && grant.canonicalPath === inspection.canonicalPath && grant.projectFingerprint === inspection.projectFingerprint && grant.gitMarkerFingerprint === inspection.gitMarkerFingerprint && grant.projectMode === inspection.mode, 'Reconnect workspace/project identity changed.', 'RECONNECT_CHANGED', 409);
    assert(!this.store.db.prepare('SELECT 1 FROM external_grants WHERE sessionId=? AND revokedAt IS NULL AND expiresAt>?').get(session.id, this.store.now()), 'This session already has an active external capability.', 'RECONNECT_FORBIDDEN', 409);
    assert(!this.store.db.prepare("SELECT 1 FROM group_members WHERE sessionId=? AND state='active' AND id!=?").get(session.id, member.id), 'This session already has another membership.', 'MEMBERSHIP_EXISTS', 409);
    return { grant, session, task };
  }
  private sameInspection(a: WorkspaceInspection, b: WorkspaceInspection): boolean {
    // Shared-checkout warnings may change as another approved chat joins; physical identity may not.
    const { sharedCheckout: _a, ...left } = a, { sharedCheckout: _b, ...right } = b;
    return canonicalJson(left) === canonicalJson(right);
  }
  reject(raw: unknown, principal: Principal, mutation: Mutation): EnrollmentReceipt {
    const input = fields(raw, ['requestId', 'revision']);
    const requestId = identifier(input.requestId, 'requestId'), revision = integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER - 1);
    return this.store.mutate(this.humanMeta({ requestId, revision }, principal, mutation, 'reject'), () => {
      const row = this.groups.requestRow(requestId); this.pending(row, revision);
      this.store.db.prepare("UPDATE connection_requests SET state='rejected',revision=revision+1,decidedAt=? WHERE id=? AND revision=?").run(this.store.now(), requestId, revision);
      return receipt(this.groups.requestRow(requestId), this.store.now());
    });
  }
  grant(id: string): ExternalGrant {
    const row = this.store.db.prepare(`SELECT ${grantColumns} FROM external_grants WHERE id=?`).get(id) as ExternalGrant | undefined;
    assert(row, 'Unknown external grant.', 'NOT_FOUND', 404); return { ...row };
  }
  listGrants(principal: Principal, projectId?: string): ExternalGrant[] {
    requireHuman(principal); this.sweep();
    if (projectId) this.store.project(identifier(projectId, 'projectId'));
    return this.store.db.prepare(`SELECT ${grantColumns} FROM external_grants${projectId ? ' WHERE projectId=?' : ''} ORDER BY createdAt,id`).all(...(projectId ? [projectId] : [])) as ExternalGrant[];
  }
  revoke(raw: unknown, principal: Principal, mutation: Mutation): ExternalGrant {
    const grantId = identifier(fields(raw, ['grantId']).grantId, 'grantId');
    return this.store.mutate(this.humanMeta({ grantId }, principal, mutation, 'revoke'), () => {
      const grant = this.grant(grantId); this.groups.leaveMemberRow(grant.memberId, 'human_revoked'); return this.grant(grantId);
    });
  }
  private current(id: string): GrantRow {
    const grant = this.store.db.prepare('SELECT * FROM external_grants WHERE id=?').get(id) as GrantRow | undefined;
    assert(grant && grant.revokedAt === null && grant.expiresAt > this.store.now(), 'External capability is inactive.', 'EXTERNAL_UNAUTHORIZED', 401);
    const session = this.store.session(grant.sessionId), task = this.store.task(grant.taskId), member = this.groups.memberRow(grant.memberId), group = this.groups.groupRow(grant.groupId);
    const token = this.store.db.prepare('SELECT tokenHash FROM sessions WHERE id=?').get(grant.sessionId);
    assert(session.credentialMode === 'external' && session.projectId === grant.projectId && session.workspaceRoot === grant.workspaceRoot && session.revision === grant.sessionRevision && token?.tokenHash === grant.capabilityHash && task.projectId === grant.projectId && task.ownerSessionId === grant.sessionId && member.kind === 'external' && member.state === 'active' && member.sessionId === grant.sessionId && member.taskId === grant.taskId && member.projectId === grant.projectId && member.groupId === grant.groupId && member.native && session.tool === member.native.tool && session.nativeId === member.native.nativeId && session.instanceId === grant.requestId && digest(canonicalJson(member.native)) === grant.nativeKey && group.state === 'active' && group.projectId === grant.projectId, 'External binding no longer owns its approved membership and workspace.', 'EXTERNAL_UNAUTHORIZED', 401);
    this.inspectSync({ projectId: grant.projectId, workspaceRoot: grant.workspaceRoot, workspaceFingerprint: grant.workspaceFingerprint, canonicalPath: grant.canonicalPath, projectFingerprint: grant.projectFingerprint, gitMarkerFingerprint: grant.gitMarkerFingerprint, mode: grant.projectMode, sharedCheckout: false });
    return grant;
  }
  private retire(id: string, reason: string): void {
    const row = this.store.db.prepare('SELECT memberId,revokedAt FROM external_grants WHERE id=?').get(id);
    if (!row || row.revokedAt !== null) return;
    this.store.mutate({ caller: 'system:external', key: `retire:${id}`, operation: 'external.retire', input: { id, reason } }, () => { this.groups.leaveMemberRow(row.memberId as string, reason); return { grantId: id, revoked: true }; });
  }
  private async preflight(id: string): Promise<GrantRow> {
    let grant: GrantRow;
    try {
      grant = this.current(id);
      const inspection = await this.inspectWorkspace(grant.workspaceRoot);
      this.current(id);
      assert(inspection.workspaceRoot === grant.workspaceRoot && inspection.canonicalPath === grant.canonicalPath && inspection.projectId === grant.projectId && inspection.workspaceFingerprint === grant.workspaceFingerprint && inspection.projectFingerprint === grant.projectFingerprint && inspection.gitMarkerFingerprint === grant.gitMarkerFingerprint && inspection.mode === grant.projectMode, 'External workspace binding changed.', 'EXTERNAL_UNAUTHORIZED', 401);
      return grant;
    } catch (error) {
      this.retire(id, 'binding_invalid_or_expired');
      throw error;
    }
  }
  async authenticateExternal(capability: string): Promise<ExternalPrincipal | undefined> {
    if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) return undefined;
    const row = this.store.db.prepare('SELECT id,capabilityHash FROM external_grants WHERE capabilityHash=?').get(digest(capability));
    if (!row || !credentialMatches(capability, row.capabilityHash as string)) return undefined;
    try {
      const grant = await this.preflight(row.id as string);
      const scope = immutableGrant(grant);
      return authenticatedExternalPrincipal({ kind: 'external', grantId: grant.id, projectId: grant.projectId, sessionId: grant.sessionId, taskId: grant.taskId, memberId: grant.memberId, groupId: grant.groupId, workspaceRoot: grant.workspaceRoot, expiresAt: grant.expiresAt }, () => { assert(immutableGrant(this.current(grant.id)) === scope, 'External capability binding changed.', 'EXTERNAL_UNAUTHORIZED', 401); });
    } catch { return undefined; }
  }
  identity(principal: ExternalPrincipal): ExternalIdentity {
    authorizeExternal(principal);
    return { role: 'external', protocolVersion: PROTOCOL_VERSION, stateId: this.runtime.stateId, instanceId: this.runtime.instanceId, grantId: principal.grantId, projectId: principal.projectId, sessionId: principal.sessionId, taskId: principal.taskId, memberId: principal.memberId, groupId: principal.groupId, workspaceRoot: principal.workspaceRoot, expiresAt: principal.expiresAt, membershipRevision: this.groups.memberRow(principal.memberId).revision };
  }
  private used(principal: ExternalPrincipal): void {
    this.store.mutate(withAuthorization(principal, { caller: callerId(principal), key: `bridge:${randomUUID()}`, operation: 'external.bridge-use', input: {} }), () => {
      const grant = this.current(principal.grantId), now = this.store.now();
      if (grant.bridgeFirstSeenAt === null) this.store.event(grant.projectId, 'external.bridge_used', { grantId: grant.id, memberId: grant.memberId });
      this.store.db.prepare('UPDATE external_grants SET bridgeFirstSeenAt=COALESCE(bridgeFirstSeenAt,?),bridgeLastSeenAt=? WHERE id=?').run(now, now, grant.id);
      return { grantId: grant.id, observedAt: now };
    });
  }
  async dispatch(operation: ExternalOperation, raw: unknown, principal: ExternalPrincipal, key?: string): Promise<unknown> {
    authorizeExternal(principal);
    await this.preflight(principal.grantId);
    authorizeExternal(principal);
    const allowed: Record<ExternalOperation, string[]> = {
      identity: [], context: ['after'], intent: ['revision','acceptanceCriteria','reads','writes','produces','consumes','dependencies'],
      'task-status': ['revision','status','blocker'], 'check-plan': ['title','writes','produces','consumes'],
      'propose-decision': ['key','value','version','rationale'], reserve: ['revision','resources','ttlSeconds'], release: ['leaseId','generation'], 'member-status': [], leave: [],
    };
    assert(Object.hasOwn(allowed, operation), 'External operation is not permitted.', 'EXTERNAL_FORBIDDEN', 403);
    const input = fields(raw, allowed[operation]);
    const read = ['identity','context','check-plan','member-status'].includes(operation);
    const mutation = read ? undefined : withAuthorization(principal, { caller: callerId(principal), key: this.key(key), operation: `external.${operation}`, input });
    let result: unknown;
    try {
      switch (operation) {
        case 'identity': result = this.identity(principal); break;
        case 'context': result = this.coordination.context(principal.projectId, principal.taskId, input.after === undefined ? 0 : integer(input.after, 'after', 0, Number.MAX_SAFE_INTEGER), principal); break;
        case 'intent': result = this.coordination.declareIntent({ ...input, taskId: principal.taskId }, principal, mutation!); break;
        case 'task-status': {
          assert(['active','blocked','ready'].includes(input.status as string), 'Unsupported external task status.', 'EXTERNAL_FORBIDDEN', 403);
          result = this.coordination.updateTask({ ...input, taskId: principal.taskId }, principal, mutation!); break;
        }
        case 'check-plan': result = this.coordination.checkPlan(principal.projectId, { ...input, taskId: principal.taskId }); break;
        case 'propose-decision': result = this.coordination.proposeDecision({ ...input, projectId: principal.projectId, taskId: principal.taskId }, principal, mutation!); break;
        case 'reserve': {
          const resources = await normalizeResources(input.resources, principal.workspaceRoot, Boolean(this.store.project(principal.projectId).caseSensitive));
          await this.preflight(principal.grantId); authorizeExternal(principal);
          result = this.store.acquire({ projectId: principal.projectId, sessionId: principal.sessionId, taskId: principal.taskId, taskRevision: integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER), resources, ttlSeconds: input.ttlSeconds === undefined ? 300 : integer(input.ttlSeconds, 'ttlSeconds', 1, 3600), grantId: principal.grantId, deadline: principal.expiresAt }, mutation!); break;
        }
        case 'release': {
          const id = identifier(input.leaseId, 'leaseId'), generation = integer(input.generation, 'generation', 1, Number.MAX_SAFE_INTEGER);
          assert(this.store.db.prepare('SELECT 1 FROM external_grant_leases WHERE grantId=? AND leaseId=? AND generation=?').get(principal.grantId, id, generation), 'External capability did not acquire this lease generation.', 'EXTERNAL_FORBIDDEN', 403);
          result = this.store.changeLease({ id, sessionId: principal.sessionId, generation }, mutation!); break;
        }
        case 'member-status': result = { ...this.groups.get(principal.groupId, principal), member: this.groups.memberRow(principal.memberId), grant: this.grant(principal.grantId), task: this.store.task(principal.taskId), blocker: this.store.db.prepare('SELECT blocker,taskRevision,updatedAt FROM task_blocker_notes WHERE taskId=?').get(principal.taskId) ?? null }; break;
        case 'leave': result = this.groups.leave({ memberId: principal.memberId, revision: this.groups.memberRow(principal.memberId).revision }, principal, mutation!); break;
      }
      if (operation !== 'leave') { authorizeExternal(principal); this.used(principal); }
      return result;
    } catch (error) {
      try { this.current(principal.grantId); } catch { this.retire(principal.grantId, 'binding_invalid_or_expired'); }
      throw error;
    }
  }
  sweep(): void {
    const rows = this.store.db.prepare('SELECT id FROM external_grants WHERE revokedAt IS NULL').all();
    for (const row of rows) { try { this.current(row.id as string); } catch { this.retire(row.id as string, 'binding_invalid_or_expired'); } }
  }
}
