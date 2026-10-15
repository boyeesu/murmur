# Data lifecycle and maintenance

Murmur maintenance is explicit, human-only administration. These maintenance
operations are never scheduled automatically. Inspect first, take a private
backup where appropriate, then approve the specific change. This guide describes
implemented behavior, not live/native/platform or publication verification.
[Operations](operations.md) covers daemon state locations and the separate
integration installer.

## Select the right state and protect output

Use the installed CLI in a human terminal configured for the intended daemon
state. `MURMUR_HOME` selects that state; without it, the [default location rules](operations.md#start-with-inspection)
apply. Do not run human commands from an agent's scoped environment or clear its
scope markers to bypass a refusal.

```bash
murmur maintenance --help
murmur doctor --json
murmur status --json
```

Credentials, retention, and backup use the running daemon's human API. Restore is
the exception: it is offline and does not call daemon transport. None of these
operations is a native process-control or source-workspace cleanup command.

Maintenance output paths must be absolute and canonical, with an existing owned
private parent directory (mode `0700`). New files are mode `0600`; existing files,
symlinks, hard-linked private input files, and unsafe permissions are refused.
Use a durable location outside source repositories, shared folders, and agent
workspaces. For example, create a **new** private operations directory once:

```bash
umask 077
mkdir -m 700 "$HOME/murmur-private-operations"
OPS_DIR="$(cd "$HOME/murmur-private-operations" && pwd -P)"
```

If that name already exists, inspect it and choose another new name rather than
blindly changing ownership or permissions. Keep `OPS_DIR` set to its canonical
absolute path in subsequent examples. The files below are intentionally new
names; use a new name for a new operation, not an overwrite flag. Private
permissions are not encryption or protection against your own account's access.

## Manual session credentials

### Inspect independent credential state

Set `SESSION_ID` to a manual session ID from `murmur status --json`, then inspect:

```bash
murmur maintenance credentials inspect --session "$SESSION_ID"
```

The result includes `sessionId`, `projectId`, `mode`, `revision`, `revokedAt`,
`changedAt`, and `canRotate`. **Credential revision is independent of session
heartbeat and task revisions.** Copy this inspection's `revision` into
`CREDENTIAL_REVISION`; never substitute a revision from the dashboard's task or
session record. Changing heartbeats does not implicitly authorize credential
replacement.

Only `mode: manual` can rotate/revoke through this surface. Managed launches and
external grants have separate lifecycle authority; their credential revision is
null here. These commands also do not rotate human daemon/browser credentials.
Use [grant revocation](operations.md#uninstall-does-not-revoke-grants) for external
connections and the documented managed-launch lifecycle for managed agents.

Both mutations compare-and-swap the exact credential revision. A stale inspection
fails with `STALE_REVISION`, without overwriting a newer credential. Reinspect
before approving a different change.

### Revoke deliberately

**Revocation permanently retires the old token.** This is not a dry-run command;
inspection is the review step. After deciding to end this manual credential:

```bash
murmur maintenance credentials revoke --session "$SESSION_ID" --revision "$CREDENTIAL_REVISION" --request-id manual-revoke-1
murmur maintenance credentials inspect --session "$SESSION_ID"
```

No authenticatable old token hash is left on the session, and the retired hash is
remembered to prevent reuse. Revocation does not delete the session, abandon or
hand off its tasks, stop a process, or release existing reservations. Those are
separate decisions. A revoked manual session can receive a fresh token through a
new, explicitly reviewed rotation; the old token is never re-enabled.

### Rotate with durable output before mutation

**Rotation invalidates the previous token.** Review the session/revision and the
new private output destination before proceeding:

```bash
murmur maintenance credentials rotate --session "$SESSION_ID" --revision "$CREDENTIAL_REVISION" --out "$OPS_DIR/manual-rotation-1.json" --request-id manual-rotation-1
murmur maintenance credentials inspect --session "$SESSION_ID"
```

The CLI generates a fresh token locally and writes a new private rotation/retry
record containing the token, its hash, session ID, credential revision, canonical
state directory, and request ID. It flushes the file **and parent directory** to
disk before posting only the token hash to the daemon. The daemon never receives
the raw replacement token. The command's normal output reports status and the
private filename, not the raw token. Provision the credential only through your
intended private client mechanism; do not print or paste the file into an issue,
chat, build log, or repository.

Keep this file until the operation's outcome is established and the intended
client has the credential. A failed network request can leave a valid private
retry record even when stdout did not show a successful result. After a timeout
or uncertain outcome, inspect current credential state, then retry **the original
record**, with no other rotation flags:

```bash
murmur maintenance credentials rotate --retry-file "$OPS_DIR/manual-rotation-1.json"
murmur maintenance credentials inspect --session "$SESSION_ID"
```

The retry is bound to the original state directory, token/hash, revision, and
request key. Never generate a different token or `--out` file with the same key;
that is a conflicting operation, not recovery. Do not use a new request ID just
to make an uncertain rotation run again. Successful retries can return a cached
result; inspect the current credential state before assuming it is still current.
If the operation genuinely failed before changing credentials and you decide to
make a different rotation, reinspect and use a new key and new private filename.

Request IDs are optional, but explicit keys make deliberate retries easier to
track. Reuse a key only for the exact same operation/input; do not reuse the sample
keys for unrelated sessions. There is no automatic CLI retry. Losing a successfully
rotated token requires another explicitly authorized rotation, not token retrieval
from the daemon.

## Retention: review the exact dry-run

**Retention apply irreversibly removes or redacts selected data in the current
database. There is no retention undo command.** A backup remains a separate
sensitive historical copy, not an in-place undo. Retention does not promise secure
erasure of old backups, filesystem snapshots, SQLite remnants, or other copies.

Retention is selected by explicit classes and a cutoff in **Unix epoch
milliseconds**, strictly older than the cutoff. The cutoff must not be in the
future. It applies across the selected daemon's database, not just a current
project; there is no `--project` filter.

| Class | Eligible content and preservation boundary |
| --- | --- |
| `unreviewed-drafts` | Redacts payloads of external requests in pending/expired/rejected state whose creation and expiry are both before the cutoff, with no human review, session/task binding, grant, or protected provenance/reference. Pending entries become expired. Immutable request/capability/polling hashes and a redaction digest remain. Approved, reviewed, linked, or otherwise protected requests are not age-deleted. |
| `events` | Removes old event rows, retaining per-project sequence/count/time cutoffs so missing history is reported rather than appearing complete. |
| `context-records` | Removes old coordination context-delivery records, retaining per-project cutoff/count/time metadata. This does not delete tasks or accepted decisions. |
| `mutation-payloads` | Removes eligible old generic mutation replay rows after permanently tombstoning their caller/key/digest and timestamps. Workflow replay rows and launch preparation/phase journals are excluded even when old; age alone does not establish that they are safe to remove. |

No class deletes task/session ownership, accepted decisions, source files,
workspaces, branches, installer history, or existing tombstones. None is an
automatic expired-grant cleanup or credential revocation operation.

Choose `BEFORE_EPOCH_MS` deliberately after reviewing your history and backup
needs. Select only the intended classes; for example:

```bash
murmur maintenance retention preview --before "$BEFORE_EPOCH_MS" --classes events,context-records --out "$OPS_DIR/retention-review-1.json"
```

Preview opens a read-only database snapshot and returns `before`, `classes`,
`revision`, `previewDigest`, per-class `counts`, and per-project `cutoffs`. It does
not prune or create a database mutation. The CLI saves that exact preview in a
new private file tied to the canonical state directory. Inspect both the counts
and the cutoff coverage; a zero count is not evidence that other classes contain
nothing. Preserve the reviewed file unchanged.

Only after approving those exact effects:

```bash
murmur maintenance retention apply --preview "$OPS_DIR/retention-review-1.json" --request-id retention-apply-1
```

Apply does not accept a new cutoff/class selection instead of a preview. It
recomputes the eligible rows and compares the maintenance revision **and** content
fingerprint in one mutation transaction. Changed candidates or a changed
maintenance revision cause `STALE_RETENTION_PREVIEW`; generate a new private
preview, inspect again, and approve a new operation. A partial failure rolls back
the database changes rather than pruning some classes and leaving others.

For an uncertain response, inspect current state and use the same private preview
and request ID for an exact retry. Do not change the key merely to bypass a stale
or already-applied result.

### Tombstones are permanent, not reusable request IDs

After a generic mutation's response has been retired:

- The same caller/key and original operation/input returns
  `IDEMPOTENCY_RETIRED` (HTTP 410), not its old response and not a new execution.
- The same key with different operation/input returns `IDEMPOTENCY_CONFLICT`
  (HTTP 409).
- Later retention passes do not remove the tombstone. An old retention-apply
  response may itself be retired; its key still cannot execute again.

Do not delete tombstones, lower database version markers, or invent a new key to
replay an old action. Inspect the current entity state and decide whether a
separate new operation is actually intended. Similarly, event/context history
may be incomplete after pruning; respect the returned `historyPruned`,
`prunedThrough`, counts, and context cutoff metadata rather than interpreting an
empty retained history as “nothing happened.”

## Private consistent backup

Choose a new private filename after inspecting the selected state:

```bash
murmur maintenance backup --destination "$OPS_DIR/before-maintenance-1.sqlite"
```

Backup uses SQLite's **online backup API** for a consistent database snapshot;
it is not a filesystem copy of an open `state.sqlite` and its WAL. The export is
validated, made standalone, flushed to disk, and never overwrites an existing
file. Its result includes destination, page count, `schemaVersion`, and
`sensitive: true`. The reported `schemaVersion` is the maintenance format version
(currently 1), distinct from database compatibility version 4.

**Backups contain secrets.** Stored launch credentials and historical mutation
responses can contain authority even if normal status output hides it. Keep the
backup and its parent private, use appropriate encrypted storage if required,
and never attach it to a public report. Retention or revocation in the live
database does not rewrite an older backup.

This snapshot includes database task/session/group/decision/history and workflow
bookkeeping. It does **not** copy `daemon.json`, `connection.json`, browser login
state, installation registries/bundles/snapshots, native helper files, native
history, source repositories, Git objects/refs, workspaces, or uncommitted files.
Plan separately for a stopped, private filesystem backup if you need those files;
do not advertise a database snapshot as a full project recovery image.

A refused or interrupted backup can leave its reserved destination present.
Preserve and inspect it as incomplete; do not restore it as a known-good snapshot
or overwrite it on retry. Choose a new destination after resolving the failure.
Unknown or modified schema is refused rather than assumed safe to back up/restore.

## Offline restore into a NEW directory only

**Restore is not an in-place repair and not a continuation of old authority.** It
copies a supported standalone backup into a **new directory that must not already
exist**, including when an existing directory is empty. The parent must already
be owned, private, and canonical. Do not create the target directory beforehand.
The input must be a private regular standalone backup without `-wal`, `-shm`, or
`-journal` sidecars, not a live database file.

After inspecting the backup's provenance, selected path, and recovery plan:

```bash
RESTORED_STATE="$OPS_DIR/restored-state-1"
murmur maintenance restore --backup "$OPS_DIR/before-maintenance-1.sqlite" --state-directory "$RESTORED_STATE"
```

The command is offline: no daemon API, login, native tool, PID stop, or source
checkout operation is involved. Success creates a private `state.sqlite` and
reports `restored`, `authorityInvalidated`, and `recoveryRequired` as true. It does
not modify the backup or the original daemon's state. In particular, old live
credentials in the **source** environment are not revoked by restoring a copy.

### All copied operational authority is invalidated

The restored database preserves bookkeeping but cannot safely resume old access:

- Every copied session credential is retired. Manual and managed session token
  hashes are replaced; manual credentials become revoked and their independent
  revisions advance. An external session retains its `tokenHash` **only as a
  historical reconnect binding**, not usable session-login authority.
- Every copied external grant and invitation is revoked. Active external group
  memberships transition to `left`, polling secrets are cleared, and pending
  connection requests expire. The retained external hash and provenance cannot
  authenticate a copied capability or reactivate a grant.
- All active reservations/leases are released in the copy.
- Managed agent/supervisor credentials, controller ownership, expiry and PID
  bindings are cleared. Active/preparing launch states require recovery; restore
  neither signals an old PID nor adopts its process.
- Every cached generic mutation result is removed after tombstoning its key.
  Historical registration/authorization results cannot be replayed into access.
- Workflow request journals become permanently `retired` and lose cached
  responses/errors. Unlike ordinarily interrupted requests, they cannot be
  completed by crash recovery or replayed, even if no generic mutation response
  was saved. Retrying a retired request returns `IDEMPOTENCY_RETIRED`; changing
  its input under the same key conflicts. Retained workspaces, targets, unfinished
  changesets and jobs require inspection or recovery as applicable; cached
  validations are invalidated. Existing terminal integration/bookkeeping records
  are not permission to promote a stale candidate.

Tasks and their recorded owners remain for inspection; revoked credentials, left
memberships, and released leases are not an automatic handoff or abandonment. An
eligible same-chat reconnect can preserve the retained session and task, but only
after a **fresh request, new capability, and explicit human approval** of the
reviewed `--reconnect-grant` binding. The same native/workspace identity and
nonterminal task must still pass review; copied hashes are not authentication.
There is no automatic reconnect or inherited active membership. The restore command
never imports daemon credentials, installation authority, helper capabilities,
workspaces, branches, or native chat history to make those records runnable.

### Recover manually before using the copy

When switching environments, deliberately stop the old daemon and pause relevant
agent/native writers first; restore does not do that for you. Decide which state
is authoritative so old and restored records are not treated as two independent
owners of the same external workspace. Start the new daemon only after a successful
restore, with the same explicit directory in each recovery terminal:

```bash
export MURMUR_HOME="$RESTORED_STATE"
murmur daemon start
```

In a second human terminal set `MURMUR_HOME` to that exact canonical directory,
then inspect before attempting any new work:

```bash
murmur doctor --json
murmur status --json
murmur connect grants
murmur workspace list --project "$PROJECT_ID"
murmur queue --project "$PROJECT_ID"
```

Use a fresh human dashboard sign-in if needed. Inspect retained workspace paths
and Git refs yourself; the database backup did not bring their files with it.
Re-establish manual credentials with fresh rotations, external participation with
new human-reviewed grants (using the eligible explicit reconnect flow when
preserving a retained session/task), and installer state through separately
reviewed plans. Do not retry retired workflow request keys as crash recovery.
Do not copy old credentials/registries into the target, adopt old PIDs, assume a
managed process resumed, or reuse pre-restore validation to approve integration.
A recovery-required state is a deliberate stop for inspection, not a cleanup hint.

An interrupted restore leaves a private startup barrier at `state.sqlite` and may
leave `restore-incomplete.sqlite`. It intentionally cannot be opened as a working
daemon database. Preserve that directory for private inspection and restore again
into a **different new directory**. Do not delete the barrier to let daemon
startup initialize an empty database, and do not retry into the partial target.

## Schema v4, upgrades, and downgrade refusal

The database compatibility marker is **v4**; the additive maintenance schema is
version 1. The v3-to-v4 migration creates independent credential state, retired
credential hashes, permanent mutation tombstones, redaction records, and history
cutoffs, and commits those tables and the v4 marker atomically. It preserves the
existing v3 session layout rather than rewriting session rows.

**Pre-v4 binaries refuse the upgraded database.** This protects against older
code ignoring revocation or re-executing retired mutation keys. A current binary
also refuses newer or unknown schemas. A malformed/incomplete v4 schema is not
silently repaired on startup. Never lower `user_version`, remove maintenance
tables, or edit schema fingerprints to bypass the refusal.

Before changing Murmur versions, inspect outstanding work, stop the old daemon,
and retain a private complete state backup under the old version's documented
procedure. This maintenance restore accepts only supported **v4 standalone
backups**; it does not perform an in-place downgrade or directly import v3 backup
files. Preserve older originals and use a compatible supported upgrade procedure
on a separate private copy before producing a new v4 export. Do not assume the
new backup command exists in the older binary.

Installer `rollback` restores an owned integration bundle/config entry, not a
Murmur executable, database schema, task state, or source branch. Maintenance does
not automatically delete or reconcile source checkouts, branches, worktrees,
uncommitted changes, or copied runtime authority. Those remain explicit human
recovery decisions.

## Support and reporting boundaries

Report the exact maintenance command and error code, affected area, Murmur/Node/OS
versions, credential **revision** or preview counts/digest as appropriate, and
whether the response was uncertain. Redact state paths, project names, account
and environment details. Share neither raw tokens nor rotation files, backups,
private journals, helper state, native auth data, proxy configuration, or dashboard
sign-in links. See [operations reporting](operations.md#reporting-a-problem).

No successful backup or restore asserts native trust/loading, real model use,
external platform coverage, safe hot attachment, source checkout recovery, or
public package publication. Database recovery, native activation, and live
verification remain separate gates.
