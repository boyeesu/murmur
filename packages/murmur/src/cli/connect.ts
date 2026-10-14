import { realpath } from 'node:fs/promises';
import { assert } from '../protocol/index.js';
import { defaultStateDirectory } from '../daemon/config.js';
import { cliId, cliNumber, cliText, commandFailure, dataInput, flagMap, humanEnvironment, humanTransport, mergeHandoff, mergeInput, mutationKey, publicOutput } from './human-input.js';
import type { HumanCommandDependencies } from './human-input.js';

export const connectHelp = `Usage: murmur connect <action> [options]

Human review of connection requests; never run these inside an agent chat.
  requests
  review --request ID --revision N
  approve --request ID --revision N --digest SHA256 --responsibility TEXT
          [--title TEXT] [--feature KEY] [--handoff FILE] [--expires SECONDS]
          [--reconnect-grant ID]
  reject --request ID --revision N
  grants [--project ID]
  revoke --grant ID
  setup --tool claude --out NEW_DIRECTORY

Mutations accept --request-id KEY and strict --data JSON or --file FILE (16 KiB).
--handoff FILE reads a standalone reviewed HandoffDraft for approval. Flags must
agree with JSON. Handoffs may include changedFiles (reported prior paths, not
planned writes) and remainingWork. Approve requires the exact revision/digest from human review;
reconnect explicitly reuses only an eligible expired/revoked same-chat binding.
Requests contain untrusted metadata, not proof of native identity. Decisions in
approved handoffs remain proposals. No capability, polling secret, human token,
or native login ticket is returned. No automatic retries or credential renewal.
Setup exports a Claude Code 2.1.247 plugin into a new directory after metadata-only
version preflight; it never installs or connects it. A human must explicitly
resume the original chat with the returned plugin-dir command. Hot attachment
and other native hosts are unverified.
`;
const actions: Record<string, { flags: string[]; fields?: string[]; route?: string }> = {
  requests: { flags: [] }, grants: { flags: ['project'] }, setup: { flags: ['tool','out'] },
  review: { flags: ['request','revision'], fields: ['requestId','revision'], route: '/v1/connections/review' },
  approve: { flags: ['request','revision','digest','responsibility','title','feature','handoff','expires','reconnect-grant'], fields: ['requestId','revision','reviewDigest','responsibility','title','featureKey','handoff','expiresInSeconds','reconnectGrantId'], route: '/v1/connections/approve' },
  reject: { flags: ['request','revision'], fields: ['requestId','revision'], route: '/v1/connections/reject' },
  revoke: { flags: ['grant'], fields: ['grantId'], route: '/v1/connections/revoke' },
};
export async function connectMain(argv: string[], dependencies: HumanCommandDependencies = {}): Promise<unknown> {
  try {
    humanEnvironment(dependencies.env);
    if (argv.length === 1 && argv[0] === '--help' || argv.length === 2 && Object.hasOwn(actions, argv[0]!) && argv[1] === '--help') return connectHelp;
    const [action, ...args] = argv;
    assert(action && Object.hasOwn(actions, action), 'Unknown connect action. Use murmur connect --help.', 'HUMAN_INPUT');
    const spec = actions[action], flags = flagMap(args, [...spec.flags, ...(spec.route ? ['request-id','data','file'] : [])]);
    if (action === 'setup') {
      assert(flags.has('tool') && flags.has('out'), 'Setup export requires --tool claude --out NEW_DIRECTORY.', 'HUMAN_INPUT');
      const { exportExistingChatSetup } = await import('../adapters/existing-chat.js');
      return publicOutput(await exportExistingChatSetup({ tool: flags.get('tool')!, outputDirectory: flags.get('out')!,
        stateDirectory: await realpath(dependencies.stateDirectory ?? defaultStateDirectory()), env: dependencies.env ?? process.env }));
    }
    const input = await dataInput(flags, spec.fields ?? []), request = humanTransport(dependencies);
    const mappings: Record<string, string> = { request: 'requestId', grant: 'grantId', digest: 'reviewDigest', responsibility: 'responsibility', title: 'title', feature: 'featureKey', 'reconnect-grant': 'reconnectGrantId' };
    for (const [flag, field] of Object.entries(mappings)) if (flags.has(flag)) mergeInput(input, field, flags.get(flag));
    if (flags.has('revision')) mergeInput(input, 'revision', cliNumber(flags.get('revision'), 'revision'));
    if (flags.has('expires')) mergeInput(input, 'expiresInSeconds', cliNumber(flags.get('expires'), 'expires', 86400));
    for (const field of ['requestId','grantId','reconnectGrantId']) if (input[field] !== undefined) input[field] = cliId(input[field], field);
    if (input.revision !== undefined) input.revision = cliNumber(input.revision, 'revision');
    if (input.expiresInSeconds !== undefined) input.expiresInSeconds = cliNumber(input.expiresInSeconds, 'expires', 86400);
    if (input.reviewDigest !== undefined) assert(typeof input.reviewDigest === 'string' && /^[a-f0-9]{64}$/.test(input.reviewDigest), 'Review digest must be SHA-256 hex.', 'HUMAN_INPUT');
    if (input.responsibility !== undefined) input.responsibility = cliText(input.responsibility, 'responsibility', 2048);
    if (input.title !== undefined) input.title = cliText(input.title, 'title', 512);
    if (input.featureKey !== undefined && input.featureKey !== null) input.featureKey = cliText(input.featureKey, 'feature', 128);
    if (action === 'approve') await mergeHandoff(input, flags);
    if (action === 'requests') return publicOutput(await request('GET', '/v1/connections/requests'));
    if (action === 'grants') {
      const project = flags.has('project') ? cliId(flags.get('project'), 'project') : undefined;
      return publicOutput(await request('GET', `/v1/connections/grants${project ? `?projectId=${encodeURIComponent(project)}` : ''}`));
    }
    for (const field of action === 'revoke' ? ['grantId'] : action === 'approve' ? ['requestId','revision','reviewDigest','responsibility'] : ['requestId','revision']) assert(input[field] !== undefined, 'A required command field is missing. Use --help.', 'HUMAN_INPUT');
    const key = mutationKey(flags, dependencies);
    (dependencies.stderr ?? (text => { process.stderr.write(text); }))(`Murmur connection request ID: ${key}\n`);
    return publicOutput(await request('POST', spec.route!, input, key));
  } catch (error) { throw commandFailure(error); }
}
