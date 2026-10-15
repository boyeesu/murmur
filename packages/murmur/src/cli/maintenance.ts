import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assert, object } from '../protocol/index.js';
import { RETENTION_CLASSES, restoreBackup, writeNewPrivateJson } from '../core/maintenance.js';
import { cliId, cliKey, cliNumber, cliText, commandFailure, flagMap, humanEnvironment, humanTransport, mutationKey, publicOutput, parseHumanJson } from './human-input.js';
import type { HumanCommandDependencies } from './human-input.js';

export const maintenanceHelp = `Usage: murmur maintenance <area> <action> [options]

Human-only state lifecycle. Nothing is pruned automatically.
  credentials inspect --session ID
  credentials revoke --session ID --revision N [--request-id KEY]
  credentials rotate --session ID --revision N --out NEW_PRIVATE_FILE [--request-id KEY]
  credentials rotate --retry-file PRIVATE_FILE
  retention preview --before EPOCH_MS --classes CLASS,CLASS --out NEW_PRIVATE_FILE
  retention apply --preview PRIVATE_FILE [--request-id KEY]
  backup --destination NEW_PRIVATE_SQLITE_FILE
  restore --backup PRIVATE_SQLITE_FILE --state-directory NEW_PRIVATE_DIRECTORY

Classes: unreviewed-drafts,events,context-records,mutation-payloads.
A preview is a dry-run. Apply requires that exact preview's digest/revision.
Credential revisions are separate from session heartbeat revisions. Rotation writes
and fsyncs the NEW private credential/retry file BEFORE posting only its token hash.
No raw credential is printed. After an uncertain result use --retry-file with the
original file; never generate a different token for the same request key.
Destinations need absolute canonical paths with owned private (0700) parent
folders; files are mode 0600 and are never overwritten. Backups contain secrets.
Restore is OFFLINE into a NEW directory only; it invalidates all authority and
validation, releases leases and requires manual recovery. It does not copy daemon
credentials, installation registries, workspaces or branches, and never controls PIDs.
`;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
async function privateJson(filename: string): Promise<Record<string, unknown>> {
  cliText(filename, 'private input file', 4096);
  assert(path.isAbsolute(filename) && await realpath(path.dirname(filename)) === path.dirname(path.resolve(filename)), 'Use an absolute canonical private input path.', 'HUMAN_INPUT');
  const parent = await lstat(path.dirname(filename));
  assert(parent.isDirectory() && (parent.mode & 0o077) === 0 && (!process.getuid || parent.uid === process.getuid()), 'Private input parent must be owned and mode 0700.', 'HUMAN_INPUT_FILE');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    assert(info.isFile() && info.size <= 16 * 1024 && info.nlink === 1 && (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid()), 'Input file must be private and owned.', 'HUMAN_INPUT_FILE');
    // Read the already-verified handle, never close and reopen a secret path.
    const bytes = Buffer.alloc(16 * 1024 + 1); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await file.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; }
    assert(used <= 16 * 1024, 'Private input exceeds 16 KiB.', 'HUMAN_INPUT_FILE');
    return parseHumanJson(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, used)));
  } finally { await file.close(); }
}
function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key); assert(value, `Missing --${key}. Use --help.`, 'HUMAN_INPUT'); return value;
}
export async function maintenanceCommand(directory: string, argv: string[], dependencies: HumanCommandDependencies = {}): Promise<unknown> {
  try {
    humanEnvironment(dependencies.env);
    if (argv.length === 1 && ['--help','help'].includes(argv[0]!)) return maintenanceHelp;
    const request = humanTransport({ ...dependencies, stateDirectory: directory }), [area, ...rest] = argv;
    if (area === 'credentials') {
      const [action, ...args] = rest;
      assert(action && ['inspect','revoke','rotate'].includes(action), 'Unknown credentials action.', 'HUMAN_INPUT');
      const flags = flagMap(args, action === 'inspect' ? ['session'] : action === 'revoke' ? ['session','revision','request-id'] : ['session','revision','out','request-id','retry-file']);
      if (action === 'rotate' && flags.has('retry-file')) {
        assert(flags.size === 1, 'Use --retry-file alone; the original request must not change.', 'HUMAN_INPUT');
        const record = await privateJson(flags.get('retry-file')!);
        assert(record.version === 1 && record.kind === 'murmur_manual_credential_rotation' && record.stateDirectory === await realpath(directory), 'Rotation retry file belongs to another state directory or format.', 'HUMAN_INPUT_FILE');
        const sessionId = cliId(record.sessionId, 'sessionId'), revision = cliNumber(record.revision, 'revision'), key = cliKey(record.requestId);
        assert(typeof record.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.token) && digest(record.token) === record.tokenHash, 'Invalid credential retry record.', 'HUMAN_INPUT_FILE');
        const status = await request('POST', '/v1/maintenance/credentials/rotate', { sessionId, revision, tokenHash: record.tokenHash }, key);
        return { status: publicOutput(status), file: flags.get('retry-file'), requestId: key };
      }
      const sessionId = cliId(required(flags, 'session'), 'sessionId');
      if (action === 'inspect') return publicOutput(await request('GET', `/v1/maintenance/credentials?sessionId=${encodeURIComponent(sessionId)}`));
      const revision = cliNumber(required(flags, 'revision'), 'revision'), key = mutationKey(flags, dependencies);
      if (action === 'revoke') return publicOutput(await request('POST', '/v1/maintenance/credentials/revoke', { sessionId, revision }, key));
      const filename = required(flags, 'out'), token = randomBytes(32).toString('base64url'), tokenHash = digest(token);
      await writeNewPrivateJson(filename, { version: 1, kind: 'murmur_manual_credential_rotation', stateDirectory: await realpath(directory), sessionId, revision, requestId: key, token, tokenHash });
      const status = await request('POST', '/v1/maintenance/credentials/rotate', { sessionId, revision, tokenHash }, key);
      return { status: publicOutput(status), file: filename, requestId: key };
    }
    if (area === 'retention') {
      const [action, ...args] = rest;
      assert(action === 'preview' || action === 'apply', 'Unknown retention action.', 'HUMAN_INPUT');
      const flags = flagMap(args, action === 'preview' ? ['before','classes','out'] : ['preview','request-id']);
      if (action === 'preview') {
        const before = cliNumber(required(flags, 'before'), 'before'), classes = required(flags, 'classes').split(',');
        assert(classes.length > 0 && classes.every(value => RETENTION_CLASSES.includes(value as typeof RETENTION_CLASSES[number])) && new Set(classes).size === classes.length, 'Unknown or repeated retention class.', 'HUMAN_INPUT');
        const out = required(flags, 'out');
        const preview = await request('POST', '/v1/maintenance/retention/preview', { before, classes });
        await writeNewPrivateJson(out, { version: 1, kind: 'murmur_retention_preview', stateDirectory: await realpath(directory), preview });
        return publicOutput(preview);
      }
      const record = await privateJson(required(flags, 'preview'));
      assert(record.version === 1 && record.kind === 'murmur_retention_preview' && record.stateDirectory === await realpath(directory), 'Preview belongs to another state directory or format.', 'HUMAN_INPUT_FILE');
      const preview = object(record.preview);
      const input = { before: preview.before, classes: preview.classes, revision: preview.revision, previewDigest: preview.previewDigest };
      return publicOutput(await request('POST', '/v1/maintenance/retention/apply', input, mutationKey(flags, dependencies)));
    }
    if (area === 'backup') {
      const flags = flagMap(rest, ['destination']);
      return publicOutput(await request('POST', '/v1/maintenance/backup', { destination: required(flags, 'destination') }));
    }
    if (area === 'restore') {
      const flags = flagMap(rest, ['backup','state-directory']);
      return restoreBackup({ backupPath: required(flags, 'backup'), stateDirectory: required(flags, 'state-directory') }, { kind: 'human' });
    }
    assert(false, 'Unknown maintenance action. Use murmur maintenance --help.', 'HUMAN_INPUT');
  } catch (error) { throw commandFailure(error); }
}
