# Safe local workspaces and integration

Murmur's `GitWorkflow` provides a local Git workflow on top of the coordination store. Plain folders remain **advisory only**: they cannot create isolated Git workspaces, submit Git changesets, or integrate changes. Nothing pushes to a remote.

## Human-controlled lifecycle

1. **Create or adopt a workspace.** `createWorkspace({projectId, baseRevision?, allowDirtyBase?})` creates a new branch and worktree under the configured state directory. It resolves the selected revision to a commit SHA and pins that commit in a private ref before creating the worktree. By default the original checkout must be clean. `allowDirtyBase: true` explicitly selects committed history only (HEAD if `baseRevision` is omitted); it does **not** copy dirty or ignored files, stash changes, or commit the original checkout.

   `adoptWorkspace({projectId, root})` accepts an existing, nonnested worktree of the same Git common directory, including the original checkout. The path must be the actual worktree root, not a subdirectory. Its current HEAD becomes its recorded committed base. Adopt before making the commits you want to submit. Adopted workspaces are **never disposable**. Managed workspaces are marked disposable, but this implementation never deletes them automatically either.

2. **Attach a task.** `attachWorkspace({taskId, workspaceId, revision})` is human-only and uses the current task revision. It updates the session's workspace bookkeeping and increments both session and task revisions. It refuses live reservations or other active tasks assigned to another workspace. The result always includes `restartRequired: true`: **restart or launch the actual agent/tool process in the new workspace yourself**. A running process is not moved.

3. **Commit source work yourself, then submit.** `submit({taskId, revision})` accepts the assigned session or the human. The attached, identity-verified source must have no tracked or untracked changes. Ignored files are not submitted. Submission pins the committed source SHA, records its base and workspace, and increments the task revision with the core lifecycle status `ready`. It does not switch branches, commit, reset, stash, or modify source files. Subsequent source commits do not change the submitted changeset. Replaying a successful submission returns its immutable result even if the source advances or becomes dirty.

4. **Prepare a candidate.** `prepare({changesetId})` is human-only and serialized per project. The dedicated target is `refs/heads/murmur/integration/<project-id>`, initialized from the first changeset's recorded committed base. Murmur never adopts an existing, unrecorded integration target and never substitutes `main` or the current checkout. Source and target commits get per-job recovery refs. A separate detached candidate worktree under the state directory receives the merge. An internal candidate commit is created without touching the source branch.

   Conflicts remain in the candidate worktree, with source and target pins retained. The job is `conflicted`, not validated. Inspect it locally, make a reviewed resolution in a source workspace, commit yourself, submit a new changeset with the task's current revision, and prepare a new job. Murmur performs no AI conflict resolution, automatic reset, cleanup, or source overwrite.

5. **Configure and run trusted validation.** `configureValidation({projectId, revision, commands})` is human-only. The initial configuration revision is **0**; each change uses compare-and-swap and creates a new revision/hash. Each command is `{command, args, timeoutMs?}`: an executable plus an argument array, not a shell command string. Shell interpreters are rejected. Interpreters such as Node remain executable code: approving `node` with `-e` explicitly trusts that exact program. Configuration changes invalidate existing validation, even if the same commands are later restored.

   `validate({jobId})` runs only those previously approved argv commands inside the detached candidate worktree. Candidate HEAD, its pinned commit, cleanliness, target, task assignment, and configuration are checked before and after execution. Every configured command must pass; a failure, timeout, cancellation, truncated output, changed target, changed configuration, or dirty/changed candidate prevents successful approval. Commands execute sequentially and stop on failure. A validation result records candidate SHA, target SHA, config hash/revision, per-command exit status, byte counts, and output hashes.

   An empty command list is **unverified**, never green. `prepare` records an unverified result for an empty configuration; `validate` also reports unverified if no checks exist.

6. **Approve exactly what was displayed.** `approve({jobId, candidateSha, targetSha, acknowledgeNoChecks?})` is human-only. It requires the exact recorded candidate/target pair, matching current validation configuration, a clean detached candidate, unchanged source pins, and the submitted task assignment. When no checks exist, the human must explicitly pass `acknowledgeNoChecks: true`. Failed configured checks cannot be bypassed by this flag.

   Approval refuses a target branch checked out in any worktree, then promotes with atomic `git update-ref <target> <candidate> <old-target>` compare-and-swap. A moved target is not overwritten: prepare a new candidate. The original checkout and branch stay unchanged. A promoted event and `integrated` task status/revision are committed after the Git update, with a durable recovery journal bridging the two operations.

## Observation and privacy

- `listWorkspaces(projectId)`, `listJobs(projectId)`, and `getJob(jobId)` return metadata. The embedding server must enforce project scope before exposing these read methods.
- `reconcile(projectId)` inspects NUL-delimited Git status, including untracked filenames and both rename paths. It reports changed paths and overlap evidence against live reservations. **Actor is always unknown**; overlap does not prove which session changed a file. Ignored paths and common private paths are omitted. Identity/inspection failures are explicit, never treated as a clean worktree.
- `inspectJob(jobId)` returns a bounded filename-level diff or conflict status and validation results. It does not expose raw file hunks, command argv, or command output. Common credential/private filenames are filtered. File contents are never loaded into the response. Arbitrarily named sensitive files cannot be identified perfectly; their filenames may still appear.
- Validation stdout and stderr are bounded in memory, then discarded. Only exit/limit metadata, byte counts, and hashes are stored. Full logs must be reproduced/inspected locally by the human. There are no raw validation logs in API metadata to accidentally reveal printed secrets.

## Limits and trust boundaries

Validation is **not OS isolation**. Approved commands run with the local user's filesystem and process privileges, can read files outside the candidate, and may deliberately change repository refs or other files. A minimal environment avoids inheriting Murmur/admin tokens, cloud credentials, `GIT_*` overrides, loader options, or `HOME`; this does not stop a trusted program from discovering credentials elsewhere. Repository code, executable paths, interpreters, and build tools must be trusted before approval. This feature does not run network commands itself or install dependencies; a user-approved validation executable can still access the network under the user's normal permissions.

At most eight commands are accepted, with at most 64 bounded argv entries per command. Each command defaults to 30 seconds, is capped at 120 seconds, and total configured time is capped at five minutes. Stdout/stderr each cap at 128 KiB; exceeding the cap terminates the command and fails validation. Timeouts and `cancelValidation(jobId, humanPrincipal)` terminate the validation process group on POSIX with a short kill escalation. `close()` requests cancellation during daemon shutdown. Detached/escaping descendants are not an OS-sandbox guarantee; Windows cancellation is limited to the spawned process.

Git runs asynchronously with argument arrays, no shell interpolation, disabled hooks/signing/fsmonitor, no external diffs/text conversion, no replacement objects, no global/system config, and no protocol access. Symbolic workflow refs, assume-unchanged/skip-worktree index flags, custom checkout filters/merge drivers, shallow/partial/grafted histories, sparse configurations, and submodule changesets are conservatively rejected. Recorded bases must remain ancestors of both source and target; rebased or incompatible bases require manual handling. Large Git output fails closed instead of assuming clean state.

Worktree root, common Git directory, and per-worktree Git-directory identities are recorded and rechecked. Moved, replaced, nested, or unavailable workspaces are rejected rather than repaired. State directories should be private and outside source worktrees. Only one daemon should own a database/state directory. In-process operations are queued per project; durable request stages cover interruptions, not distributed locking between independent daemons. Concurrent external Git commands and untrusted programs are outside that serialization. In particular, the checked-out-target check and ref CAS cannot atomically prevent a separate user process from checking out the target between them. Avoid external checkout/ref changes during approval.

## Recovery and idempotency

The workflow owns versioned `workflow_*` extension tables and does not change the coordination schema's `PRAGMA user_version`. Every mutation authorizes its caller and checks its idempotency journal/cache **before mutable filesystem preflight**. Keys are bound to caller, method, operation, and canonical input. Replays return immutable recorded responses; different input using the same key is refused. Pending/failed requests do not silently rerun side effects.

`initialize()` conservatively reconciles interrupted stages:

- Incomplete workspace creation and source pinning become `recovery_required`; no uncertain path, source work, branch, or ref is removed.
- Interrupted preparation preserves the candidate worktree and refs for inspection.
- Interrupted validation becomes invalidated, never passed.
- Interrupted promotion only completes the database/event half when the target is **exactly** the recorded candidate, candidate/source pins and identity remain valid, and the submitted task revision/attachment still matches. It never retries the Git update or treats an arbitrary descendant as proof of promotion. Ambiguity becomes `recovery_required`.

There is intentionally no automatic destructive repair or cleanup endpoint. Inspect the recorded paths, refs, job metadata, and current task revision locally. Use a new idempotency key only for a deliberate new operation, not to guess whether interrupted work succeeded. New preparation can supersede a retained failed/conflicted candidate; an ambiguous target initialization/promotion needs human reconciliation before further promotion.
