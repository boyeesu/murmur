import { readFile } from 'node:fs/promises';
import { assert, object } from '../protocol/index.js';
import { request } from './client.js';

export const extensionHelp = `
  dashboard                            Print a one-time local dashboard sign-in URL
  context --project ID [--task ID]     Get relevant task/decision context
  task list --project ID
  task show --project ID --task ID
  task update --task ID --revision N --status active|blocked|ready|abandoned
  task handoff --task ID --revision N --session ID --confirm
  intent declare --task ID --revision N --file intent.json
  check-plan --project ID --file plan.json
  alerts --project ID
  alert dismiss --project ID --alert ID
  decisions --project ID
  decision propose --project ID --key KEY --value VALUE --version V --rationale TEXT
  decision accept --decision ID --revision N --expected ID|none --confirm
  workspace list --project ID
  workspace create --project ID [--base HEAD] [--allow-dirty-base]
  workspace adopt --project ID --root PATH
  workspace attach --task ID --workspace ID --revision N --confirm
  workspace reconcile --project ID
  submit --task ID --revision N
  queue --project ID
  integration inspect --job ID
  integration prepare --changeset ID
  validation configure --project ID --revision N --file checks.json --confirm
  integration validate --job ID
  integration cancel --job ID --confirm
  integration approve --job ID --candidate SHA --target SHA --confirm [--acknowledge-no-checks]

Advanced mutation payloads may use --data JSON or --file PATH. Use --request-id
for deliberate retries of exactly the same operation. Decisions, trusted
commands, handoffs, promotions, and task abandonment require explicit --confirm.
When retrying session register, supply the same --native-id and --instance as
well as --request-id; omitted identity values are generated on each invocation.
`;
export const extensionFlags = ['data', 'file', 'request-id', 'status', 'alert', 'key', 'value', 'version', 'rationale', 'decision', 'expected', 'base', 'workspace', 'job', 'changeset', 'candidate', 'target', 'confirm', 'allow-dirty-base', 'acknowledge-no-checks'];
export const extensionBooleans = ['confirm', 'allow-dirty-base', 'acknowledge-no-checks'];

export async function executeExtended(command: string, flags: Map<string, string>, directory: string): Promise<{ handled: boolean; result?: unknown }> {
  const required = (key: string) => { const value = flags.get(key); assert(value, `Missing --${key}`); return value; };
  const projectQuery = () => `?projectId=${encodeURIComponent(required('project'))}`;
  const get = (endpoint: string) => request(directory, 'GET', endpoint);
  const post = (endpoint: string, body: unknown) => request(directory, 'POST', endpoint, body, { key: flags.get('request-id'), timeoutMs: 600000 });
  const confirm = () => assert(flags.has('confirm'), 'This user-controlled action requires --confirm after reviewing its exact input.');
  const payload = async () => {
    assert(!(flags.has('data') && flags.has('file')), 'Use --data or --file, not both.');
    const contents = flags.has('file') ? await readFile(required('file'), 'utf8') : flags.get('data');
    if (!contents) return {};
    assert(Buffer.byteLength(contents) <= 65536, 'Payload exceeds 64 KiB.');
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch { assert(false, 'Payload must be valid JSON.'); }
    return object(parsed);
  };
  let result: unknown;
  if (command === 'dashboard') result = await post('/v1/browser/ticket', {});
  else if (command === 'context' || command === 'task show') result = await get(`/v1/context${projectQuery()}${flags.has('task') ? `&taskId=${encodeURIComponent(required('task'))}` : ''}`);
  else if (command === 'task list') result = (await get(`/v1/status${projectQuery()}`)).tasks;
  else if (command === 'task update' || command === 'task handoff') {
    const body: Record<string, unknown> = { ...await payload(), taskId: required('task'), revision: Number(required('revision')) };
    if (flags.has('title')) body.title = required('title');
    if (flags.has('status')) body.status = required('status');
    if (command === 'task handoff') { confirm(); body.handoffSessionId = required('session'); }
    if (body.status === 'abandoned' || body.handoffSessionId) confirm();
    result = await post('/v1/tasks/update', body);
  } else if (command === 'intent declare') result = await post('/v1/intents', { ...await payload(), taskId: required('task'), revision: Number(required('revision')) });
  else if (command === 'check-plan') result = await post('/v1/check-plan', { ...await payload(), projectId: required('project'), ...(flags.has('task') ? { taskId: required('task') } : {}) });
  else if (command === 'alerts') result = await get(`/v1/alerts${projectQuery()}`);
  else if (command === 'alert dismiss') result = await post('/v1/alerts/dismiss', { projectId: required('project'), alertId: required('alert') });
  else if (command === 'decisions') result = await get(`/v1/decisions${projectQuery()}`);
  else if (command === 'decision propose') result = await post('/v1/decisions/propose', { projectId: required('project'), key: required('key'), value: required('value'), version: required('version'), rationale: required('rationale'), ...(flags.has('task') ? { taskId: required('task') } : {}) });
  else if (command === 'decision accept') {
    confirm(); const expected = required('expected');
    result = await post('/v1/decisions/accept', { decisionId: required('decision'), revision: Number(required('revision')), expectedAcceptedId: expected === 'none' ? null : expected });
  } else if (command === 'workspace list') result = await get(`/v1/workspaces${projectQuery()}`);
  else if (command === 'workspace create') result = await post('/v1/workspaces/create', { projectId: required('project'), ...(flags.has('base') ? { baseRevision: required('base') } : {}), ...(flags.has('allow-dirty-base') ? { allowDirtyBase: true } : {}) });
  else if (command === 'workspace adopt') result = await post('/v1/workspaces/adopt', { projectId: required('project'), root: required('root') });
  else if (command === 'workspace attach') { confirm(); result = await post('/v1/workspaces/attach', { taskId: required('task'), workspaceId: required('workspace'), revision: Number(required('revision')) }); }
  else if (command === 'workspace reconcile') result = await post('/v1/workspaces/reconcile', { projectId: required('project') });
  else if (command === 'submit') result = await post('/v1/submissions', { taskId: required('task'), revision: Number(required('revision')) });
  else if (command === 'queue') result = await get(`/v1/integration/jobs${projectQuery()}`);
  else if (command === 'integration inspect') result = await get(`/v1/integration/job?jobId=${encodeURIComponent(required('job'))}`);
  else if (command === 'integration prepare') result = await post('/v1/integration/prepare', { changesetId: required('changeset') });
  else if (command === 'validation configure') { confirm(); result = await post('/v1/validation/config', { ...await payload(), projectId: required('project'), revision: Number(required('revision')) }); }
  else if (command === 'integration validate') result = await post('/v1/integration/validate', { jobId: required('job') });
  else if (command === 'integration cancel') { confirm(); result = await post('/v1/integration/cancel', { jobId: required('job') }); }
  else if (command === 'integration approve') {
    confirm(); result = await post('/v1/integration/approve', { jobId: required('job'), candidateSha: required('candidate'), targetSha: required('target'), ...(flags.has('acknowledge-no-checks') ? { acknowledgeNoChecks: true } : {}) });
  } else return { handled: false };
  return { handled: true, result };
}
