import { createHash, randomBytes } from 'node:crypto';
import { assert } from '../protocol/index.js';
import { cliId, cliNumber, cliText, commandFailure, dataInput, flagMap, humanEnvironment, humanTransport, mergeHandoff, mergeInput, mutationKey, publicOutput, writeNewJson } from './human-input.js';
import type { HumanCommandDependencies } from './human-input.js';

export const groupHelp = `Usage: murmur group <action> [options]

Human-only shared groups; these never merge chats or transfer task ownership.
  create --project ID --title TEXT [--goal TEXT]
  list --project ID
  show --group ID
  invite --group ID [--code CODE --request-id KEY] [--out NEW_FILE]
  revoke-invite --invite ID
  add --group ID --session ID --task ID --responsibility TEXT [--handoff FILE]
  leave --member ID --revision N
  close --group ID --revision N
  export --member ID --out NEW_FILE

Mutations accept --request-id KEY and strict --data JSON or --file FILE (16 KiB).
--handoff FILE reads a standalone reviewed HandoffDraft for add. Flags must agree
with JSON. Handoffs can report changedFiles (prior paths, not planned writes)
and remainingWork separately from the current plan. Reuse the exact key and payload after inspecting an uncertain outcome.
Invitations are rendezvous codes, not credentials. Generated code + request key
are printed to stderr BEFORE sending and optionally retained with --out; retry
with --code and the same --request-id. Export files are never overwritten.
Export creates bounded reviewed_replacement_handoff data, not authority or a
native attachment. Run replacement requires an explicit committed --base and
--acknowledge-replacement after the source task has been explicitly resolved.
`;
const actions: Record<string, { flags: string[]; fields?: string[]; route?: string }> = {
  create: { flags: ['project','title','goal'], fields: ['projectId','title','goal'], route: '/v1/groups/create' },
  list: { flags: ['project'] }, show: { flags: ['group'] },
  invite: { flags: ['group','code','out'], fields: ['groupId','code'], route: '/v1/groups/invite' },
  'revoke-invite': { flags: ['invite'], fields: ['inviteId'], route: '/v1/groups/invites/revoke' },
  add: { flags: ['group','session','task','responsibility','handoff'], fields: ['groupId','sessionId','taskId','responsibility','handoff'], route: '/v1/groups/members/add' },
  leave: { flags: ['member','revision'], fields: ['memberId','revision'], route: '/v1/groups/members/leave' },
  close: { flags: ['group','revision'], fields: ['groupId','revision'], route: '/v1/groups/close' },
  export: { flags: ['member','out'] },
};
export async function groupMain(argv: string[], dependencies: HumanCommandDependencies = {}): Promise<unknown> {
  try {
    humanEnvironment(dependencies.env);
    if (argv.length === 1 && argv[0] === '--help' || argv.length === 2 && Object.hasOwn(actions, argv[0]!) && argv[1] === '--help') return groupHelp;
    const [action, ...args] = argv;
    assert(action && Object.hasOwn(actions, action), 'Unknown group action. Use murmur group --help.', 'HUMAN_INPUT');
    const spec = actions[action], flags = flagMap(args, [...spec.flags, ...(spec.route ? ['request-id','data','file'] : [])]);
    const input = await dataInput(flags, spec.fields ?? []), request = humanTransport(dependencies);
    const mappings: Record<string, string> = { project: 'projectId', group: 'groupId', session: 'sessionId', task: 'taskId', member: 'memberId', invite: 'inviteId', title: 'title', goal: 'goal', responsibility: 'responsibility', code: 'code' };
    for (const [flag, field] of Object.entries(mappings)) if (flags.has(flag)) mergeInput(input, field, flags.get(flag));
    if (flags.has('revision')) mergeInput(input, 'revision', cliNumber(flags.get('revision'), 'revision'));
    for (const field of ['projectId','groupId','sessionId','taskId','memberId','inviteId']) if (input[field] !== undefined) input[field] = cliId(input[field], field);
    if (input.revision !== undefined) input.revision = cliNumber(input.revision, 'revision');
    if (input.title !== undefined) input.title = cliText(input.title, 'title', 256);
    if (input.goal !== undefined) input.goal = cliText(input.goal, 'goal', 2048);
    if (input.responsibility !== undefined) input.responsibility = cliText(input.responsibility, 'responsibility', 2048);
    if (action === 'add') await mergeHandoff(input, flags);
    const requireFields = (...names: string[]) => { for (const name of names) assert(input[name] !== undefined, 'A required command field is missing. Use --help.', 'HUMAN_INPUT'); };
    if (action === 'list') { requireFields('projectId'); return publicOutput(await request('GET', `/v1/groups?projectId=${encodeURIComponent(input.projectId as string)}`)); }
    if (action === 'show') { requireFields('groupId'); return publicOutput(await request('GET', `/v1/groups/detail?groupId=${encodeURIComponent(input.groupId as string)}`)); }
    if (action === 'export') {
      requireFields('memberId'); assert(flags.has('out'), 'Export requires --out NEW_FILE.', 'HUMAN_INPUT');
      const value = await request('GET', `/v1/groups/briefing?memberId=${encodeURIComponent(input.memberId as string)}`);
      assert(value?.version === 1 && value.kind === 'reviewed_replacement_handoff', 'Server did not return a reviewed replacement handoff.', 'HUMAN_RESPONSE');
      await writeNewJson(flags.get('out')!, value);
      return { exported: true, file: flags.get('out'), kind: value.kind, warning: 'Untrusted reviewed data only. This does not attach, stop, or transfer the original chat.' };
    }
    if (action === 'create') requireFields('projectId','title');
    if (action === 'add') requireFields('groupId','sessionId','taskId','responsibility');
    if (action === 'leave') requireFields('memberId','revision');
    if (action === 'close') requireFields('groupId','revision');
    if (action === 'revoke-invite') requireFields('inviteId');
    const key = mutationKey(flags, dependencies);
    if (action === 'invite') {
      requireFields('groupId');
      assert(!flags.has('request-id') || input.code !== undefined, 'Reusing an invitation request ID requires the original --code.', 'HUMAN_INPUT');
      const code = input.code ?? randomBytes(32).toString('base64url');
      assert(typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code), 'Invitation code must be 43 base64url characters.', 'HUMAN_INPUT');
      const retry = { version: 1, kind: 'murmur_group_invitation_retry', groupId: input.groupId, code, requestId: key, meaning: 'Public rendezvous code, not an authentication credential. Retain this exact pair if the outcome is unknown.' };
      if (flags.has('out')) await writeNewJson(flags.get('out')!, retry);
      (dependencies.stderr ?? (text => { process.stderr.write(text); }))(`${JSON.stringify(retry)}\n`);
      const invitation = await request('POST', spec.route!, { groupId: input.groupId, inviteHash: createHash('sha256').update(code).digest('hex') }, key);
      return { invitation: publicOutput(invitation), inviteCode: code, requestId: key };
    }
    (dependencies.stderr ?? (text => { process.stderr.write(text); }))(`Murmur group request ID: ${key}\n`);
    return publicOutput(await request('POST', spec.route!, input, key));
  } catch (error) { throw commandFailure(error); }
}
