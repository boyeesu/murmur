import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { assert, canonicalJson, object } from '../protocol/index.js';
import type { HandoffDraft, ReviewedHandoffExport } from '../protocol/external.js';
import { discoverProject } from '../workspaces/identity.js';
import { checkIdentity, fingerprint, revision, status } from '../integration/git.js';
import type { Fingerprint } from '../integration/git.js';
import { cliId, cliNumber, cliText, readHumanJson, validateHandoff } from './human-input.js';
import type { request } from './client.js';

type HumanRequest = (method: string, endpoint: string, body?: unknown, options?: Parameters<typeof request>[4]) => Promise<any>;
export type ValidatedReplacement = { export: ReviewedHandoffExport; handoff: HandoffDraft; source: Fingerprint; sourceTaskRevision: number; baseSha: string; digest: string };
function only(input: Record<string, unknown>, keys: string[]): void { assert(Object.keys(input).every(key => keys.includes(key)), 'Unexpected handoff export fields.', 'HANDOFF_INVALID'); }
export async function readReviewedHandoff(filename: string): Promise<ReviewedHandoffExport> {
  const input = await readHumanJson(filename);
  only(input, ['version','kind','group','member','responsibility','handoff','briefing','warning']);
  assert(input.version === 1 && input.kind === 'reviewed_replacement_handoff', 'Use a reviewed_replacement_handoff export from murmur group export.', 'HANDOFF_INVALID');
  const group = object(input.group), member = object(input.member);
  only(group, ['id','projectId']);
  only(member, ['id','groupId','projectId','sessionId','taskId','kind','native','revision','taskRevision','sessionRevision','workspaceRoot','workspaceFingerprint','projectFingerprint']);
  for (const field of ['id','projectId']) cliId(group[field], field);
  for (const field of ['id','groupId','projectId','sessionId','taskId']) cliId(member[field], field);
  assert(member.groupId === group.id && member.projectId === group.projectId, 'Handoff member/project does not match its group.', 'HANDOFF_INVALID');
  cliText(input.responsibility, 'responsibility', 2048);
  for (const field of ['revision','taskRevision','sessionRevision']) cliNumber(member[field], field);
  cliText(member.workspaceRoot, 'source workspace', 4096);
  cliText(member.workspaceFingerprint, 'workspace fingerprint', 256); cliText(member.projectFingerprint, 'project fingerprint', 256);
  assert(typeof input.briefing === 'string' && input.briefing.length <= 8192 && typeof input.warning === 'string' && input.warning.length <= 2048, 'Handoff text exceeds its bounds.', 'HANDOFF_INVALID');
  input.handoff = validateHandoff(input.handoff);
  if (member.native !== null) { const native = object(member.native); only(native, ['tool','nativeId','incarnationId']); }
  return input as ReviewedHandoffExport;
}
export async function validateReplacement(exported: ReviewedHandoffExport, projectId: string, base: string, allowDirty: boolean, request: HumanRequest): Promise<ValidatedReplacement> {
  assert(exported.group.projectId === projectId, 'Handoff belongs to another project.', 'HANDOFF_BINDING_CHANGED');
  assert(/^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(base), 'Replacement handoff requires --base with an explicit full committed SHA, not a branch or moving ref.', 'HANDOFF_BASE_REQUIRED');
  const snapshot = await request('GET', `/v1/status?projectId=${encodeURIComponent(projectId)}`);
  const detail = await request('GET', `/v1/groups/detail?groupId=${encodeURIComponent(exported.group.id)}`);
  assert(Array.isArray(snapshot?.projects) && Array.isArray(snapshot.tasks) && Array.isArray(snapshot.sessions) && Array.isArray(detail?.members), 'Could not validate the current human project state.', 'HANDOFF_BINDING_CHANGED');
  const project = snapshot.projects.find((row: any) => row.id === projectId), sourceTask = snapshot.tasks.find((row: any) => row.id === exported.member.taskId), sourceSession = snapshot.sessions.find((row: any) => row.id === exported.member.sessionId), sourceMember = detail.members.find((row: any) => row.id === exported.member.id);
  assert(project && sourceTask && sourceSession && sourceMember && detail.group?.id === exported.group.id && detail.group?.projectId === projectId && detail.group.state === 'active', 'Handoff source group/project is unavailable or closed.', 'HANDOFF_BINDING_CHANGED');
  assert(sourceTask.projectId === projectId && sourceSession.projectId === projectId && sourceTask.ownerSessionId === sourceSession.id && sourceMember.taskId === sourceTask.id && sourceMember.sessionId === sourceSession.id && sourceMember.groupId === detail.group.id && sourceMember.projectId === projectId && sourceMember.kind === exported.member.kind && canonicalJson(sourceMember.native) === canonicalJson(exported.member.native), 'Handoff source ownership changed. Export a new reviewed handoff.', 'HANDOFF_BINDING_CHANGED');
  assert(['integrated','abandoned'].includes(sourceTask.status), 'Source Murmur task is still active. Explicitly resolve or abandon it with the existing task controls before replacement. Murmur will not free its feature claim or stop the native chat.', 'HANDOFF_SOURCE_ACTIVE');
  assert(sourceMember.revision === exported.member.revision && sourceTask.revision === exported.member.taskRevision && sourceSession.revision === exported.member.sessionRevision && sourceSession.workspaceRoot === exported.member.workspaceRoot, 'Source revision/workspace pins changed. Resolve the source task, then export a fresh reviewed handoff.', 'HANDOFF_BINDING_CHANGED');
  assert(project.mode === 'git' && typeof project.canonicalPath === 'string' && typeof sourceSession.workspaceRoot === 'string', 'Replacement work requires the recorded Git project/workspace.', 'HANDOFF_BINDING_CHANGED');
  const discovered = await discoverProject(sourceSession.workspaceRoot);
  assert(discovered.mode === 'git' && discovered.canonicalPath === project.canonicalPath && discovered.root === sourceSession.workspaceRoot, 'Handoff source workspace does not match the current project.', 'HANDOFF_BINDING_CHANGED');
  const source = await fingerprint(sourceSession.workspaceRoot, project.canonicalPath);
  const info = await stat(source.root);
  assert(`${info.dev}:${info.ino}:${info.birthtimeMs}` === exported.member.workspaceFingerprint && discovered.fingerprint === exported.member.projectFingerprint, 'Exported workspace/project directory identity changed.', 'HANDOFF_BINDING_CHANGED');
  const sourceDirty = await status(source.root);
  assert(allowDirty || sourceDirty.length === 0, 'The handoff source workspace contains uncommitted work. Commit/resolve it yourself, or explicitly use --allow-dirty-base to exclude all dirty progress. Nothing is copied or stashed.', 'HANDOFF_DIRTY_SOURCE');
  const baseSha = await revision(project.root, base);
  assert(baseSha === base.toLowerCase(), 'The explicit committed base changed or was not an exact SHA.', 'HANDOFF_BASE_REQUIRED');
  await checkIdentity(source);
  const handoff = exported.handoff;
  const digest = createHash('sha256').update(canonicalJson({ groupId: exported.group.id, sourceMemberId: exported.member.id, sourceTaskId: sourceTask.id, sourceSessionId: sourceSession.id, sourceTaskRevision: sourceTask.revision, baseSha, responsibility: exported.responsibility, handoff })).digest('hex');
  return { export: exported, handoff, source, sourceTaskRevision: sourceTask.revision, baseSha, digest };
}
export async function revalidateReplacement(validated: ValidatedReplacement, projectId: string, allowDirty: boolean, request: HumanRequest): Promise<void> {
  await checkIdentity(validated.source);
  const current = await validateReplacement(validated.export, projectId, validated.baseSha, allowDirty, request);
  assert(current.digest === validated.digest, 'Handoff source changed during preparation. The prepared workspace is retained; no native process was started.', 'HANDOFF_BINDING_CHANGED');
}
export function childRequestId(requestId: string, purpose: string, digest: string): string { return `handoff:${createHash('sha256').update(`${requestId}:${purpose}:${digest}`).digest('hex')}`; }
