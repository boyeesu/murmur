# Managed native launches

`murmur run` starts a **new** Claude Code or Codex task in a workspace created by
the local Murmur daemon. It does not attach to an existing native session, resume
a task, recover a stored PID, or take ownership away from another launcher.

```sh
murmur run claude --project PROJECT_ID --title "Implement the login form"
murmur run codex --project PROJECT_ID --title "Add parser tests" --feature parser-tests
murmur run --help
```

Start the daemon and register a Git project first. Install and authenticate the
chosen native CLI yourself; its executable must be on `PATH`. Murmur probes only
`--version` and `--help` before requesting any workspace. These probes have time
and output limits and do not invoke a model. Native CLI help must advertise the
supported contract; availability alone is not a compatibility guarantee.

## Command boundary

The first argument is `claude` or `codex`. `--project ID` and `--title TEXT` are
required. Optional arguments are:

- `--feature KEY`: explicit duplicate-feature protection, not a takeover request.
- `--base REVISION`: source revision for the new workspace.
- `--allow-dirty-base`: allow a dirty source checkout explicitly. Its uncommitted
  edits are **not** copied into the new workspace or committed automatically.
- `--request-id UUID`: identify the exact preparation request for a safe retry.
- `--help`: print command help without preflight or launch.

No passthrough arguments, executable override, cwd override, resume option,
additional tool, or permission-bypass flag is accepted by the public command.
Executable and transport injection exist only in the library's test interfaces.

The request UUID is printed to **stderr before preflight or preparation**. Keep
it if a request times out. A retry must use the same UUID and the same arguments;
changing the request, choosing an already-owned feature, or reusing a launch that
has already been claimed is rejected. A failed/partial preparation can retain a
workspace and records: inspect human status rather than inventing another request
ID and assuming nothing happened. Credentials and preparation objects are never
printed. Launcher diagnostics and the preserved workspace use stderr; the child
inherits interactive stdin/stdout/stderr.

## Native startup

Claude starts in the managed workspace with the launch-owned native session UUID,
trusted integration instructions in `--append-system-prompt`, and a separate
initial prompt containing dynamic task/context data. Codex starts with `--cd`
pointing to the same workspace and a combined initial prompt with an explicit
trusted-instructions / untrusted-data separation. **Codex's native thread ID is
unknown**, not the Murmur session ID and not an invented verified identifier.

Dynamic startup context is bounded to 12 KiB, includes the objective, workspace,
base, and briefing, and is explicitly marked **untrusted data**. Excess context has
an explicit truncation marker. Project text is not promoted into Claude's system
prompt. Native processes are spawned using an argument array, `shell: false`, and
the daemon-selected cwd, not a shell command assembled from project text.

The integration gives the agent shell-safe, absolute commands using the current
Node executable and this installation's compiled Murmur CLI for `agent context`
and `agent --help`. A global Murmur install is not necessary. The agent should
refresh before planning, before substantial edits, after a conflict, and before
submission. This is **not** a guarantee of automatic context delivery every turn.
Submission accepts already-committed work; the launcher neither makes commits nor
authorizes automatic commits, approvals, merges, or task completion.

## Credentials and permissions

Ordinary native-tool authentication environment is preserved. Every inherited
`MURMUR_*` variable is removed from the child's environment, including the human
state-directory pointer and administrator/supervisor credentials. The only added
Murmur variables are `MURMUR_AGENT_MODE=1` and `MURMUR_AGENT_CONNECTION`, holding the
scoped agent connection. The supervisor token stays in the launcher, not in child
argv, prompts, or environment. Do not print or paste the agent connection.

This is a scoped coordination integration, **not an operating-system sandbox**.
It does not change the native CLI's existing permissions or global configuration.
There are currently no installed MCP servers or hooks; those integrations remain
behind a separate dependency/verification gate.

## Lifecycle and interrupted work

The launcher must claim the prepared launch before attempting to spawn. One
launcher execution makes at most one spawn attempt. Concurrent claims conflict;
an unresolved/ambiguous claim is never treated as permission to spawn. There is
no PID-based recovery or takeover.

Control traffic authenticates only with the launch-scoped supervisor token and
checks the persistent state identity, protocol headers, and bound launch ID.
Claim, started, heartbeat, and end mutations carry UUID idempotency keys and
lifecycle revisions. Retries of a lost response use the **same key and body**.
Start, heartbeat, and end are serialized. Heartbeats run every 30 seconds, extend
a 120-second supervision deadline, and **do not renew resource reservations**.

Ctrl-C / SIGINT and SIGTERM stop only the child this launcher spawned, then try
to record an interrupted end. Child exit codes are returned; signal exits use
conventional `128 + signal` codes (130 for SIGINT, 143 for SIGTERM). A failed spawn
is recorded as `spawn_failed` where control is available. If supervision cannot
be confirmed by its last known deadline, the launcher stops its owned child best
effort (TERM, then KILL after a grace period); it never kills a saved PID or an
entire process group. Abrupt launcher death cannot perform this best-effort stop.

If a prior control mutation remains ambiguous, the launcher does not guess a new
revision or send a fresh-key replacement. Server expiry is the revocation fallback
when a safe end cannot be confirmed. End/expiry do not complete or abandon the
task, delete a workspace, discard edits, or create source commits. The preserved
workspace is printed so the user can inspect work and choose recovery explicitly.

## Verification scope

The launcher tests use local fake executables, temporary fixtures, and injected
loopback transport; they never start Claude/Codex model sessions. They check
argument boundaries, startup context, credential isolation, idempotent control,
serialization, signals, spawn failure, and deadline behavior. They establish the
launcher contract, not end-to-end native-model compliance or hook/MCP support.
