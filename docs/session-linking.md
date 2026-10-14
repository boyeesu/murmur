# Groups and approved session connections

Murmur groups bring related tasks into project-focused context. They do **not**
merge conversations, share task ownership, import chat history, or take over a
native process. Each member keeps its own session, assigned task, responsibility,
and workspace.

## What works, and what is still gated

| Participation | Current behavior |
| --- | --- |
| Human-operated dashboard / API | Create groups, add existing manual or active managed owners, review requests, issue/revoke invitations, inspect/revoke scoped grants, and export reviewed handoffs. |
| Existing managed session | Group requests use its existing managed identity and assigned task. Human approval adds grouping; it does not create an external credential or extend its managed lifetime. |
| External scoped API client | An approved grant authorizes one exact session/task/membership/workspace. The environment-scoped client does not discover human credentials or choose another chat's identity. |
| Claude Code 2.1.247 same-chat connector | Enabled through an explicitly loaded plugin and native resume of the original conversation. Fixed-hook start/join, human approval, refresh, status, and leave are verified with headless native fixtures. |
| Direct hot attachment or other native hosts | Unverified/gated. Existing-open reload, other Claude versions, Codex, OpenCode, and Cursor do not inherit Claude 2.1.247's support. |
| Unsupported native host fallback | Use a manual group or reviewed handoff for a separately launched **new** managed task. The original chat is not attached, moved, or stopped. |

**0.5 checkpoint, 2026-10-14:** actual Claude 2.1.247 and the exported production
plugin passed the same-chat resume/approval flow with native-authored disposable
history, empty HOME/config, a dummy key, and an owned static loopback API responder.
No actual LLM inference or real-user chat trial occurred. The earlier 0.4 bare-plugin
subset and denied nested OS-sandbox preflight remain recorded in
[the native verification history](verification-existing-chats.md); later explicit
lifecycle runs do not establish stronger OS isolation or absence of Keychain access.
There is no universal `/murmur` or `@murmur` alias, or shared-chat MCP attachment.

## Connect an existing Claude conversation

This is **native resume of the same conversation**, not a replacement Murmur-managed
chat. Claude retains its own history; Murmur does not scan or import that history.
Only Claude Code **2.1.247** has the observed contract. Native trust/permissions and
your normal account/billing still apply when you use your real chat.

This path is for a conversation **not already running with a Murmur scoped
environment**. Any `MURMUR_AGENT_` or `MURMUR_EXTERNAL_` environment marker, including
partial/empty configuration, makes the hook return `NATIVE_ALREADY_SCOPED` before
connection discovery. Do not strip markers to bypass it. An already managed process
uses its existing `murmur agent`/managed MCP commands (including group-request); an
already externally scoped process uses its existing `murmur external` commands.

### 1. Prepare from a human terminal

Use a terminal you control, **in the original project's directory**, not an agent
chat. Ensure Murmur is built/installed. Keep its daemon running in a separate terminal;
start it if needed:

```bash
murmur daemon start
```

Register the original project if needed:

```bash
murmur init --root /absolute/path/to/original-project
```

Inspect current setup help:

```bash
murmur connect --help
```

Export a new, separate plugin directory:

```bash
murmur connect setup --tool claude --out /absolute/new/plugin-dir
```

For a source build without an installed `murmur`, invoke the built CLI by its absolute
path from that same original-project terminal. For example:

```bash
node /absolute/path/to/murmur/packages/murmur/dist/cli/index.js connect setup --tool claude --out /absolute/new/plugin-dir
```

Use that absolute CLI form for the other Murmur commands here too. Do not change into
the Murmur source checkout for this setup step. Use the daemon's same `MURMUR_HOME`
if you selected custom state; it must be outside the original project.

Setup resolves the actual Claude executable from the human terminal's PATH and
requires its metadata-only version check to report **2.1.247**. It validates canonical
public `connection.json`, prepares owner-private helper state outside the workspace,
and exports reviewable plugin/skill/fixed-hook files. The destination must be new,
absolute, under an existing canonical parent, and outside native configuration
locations such as `.claude` or `.codex`. Existing output is refused, not overwritten.
No `--force`, automatic native config edit, global plugin installation, login, or
chat enrollment is performed. On a refusal, inspect the reported cause; do not bypass it.

### 2. Resume the original conversation with the plugin

**Pause/exit the original Claude CLI before reopening the conversation**, so two
processes do not write to the same native history or workspace. Review the exported
files and run setup's returned **`resumeCommand`** in the original project. It uses
the resolved absolute Claude executable and the absolute plugin directory, followed
by `--resume` to open Claude's native picker. Select the **original conversation**.
Its shape is:

```bash
/absolute/path/to/claude --plugin-dir /absolute/new/plugin-dir --resume
```

Use the actual quoted command returned by setup, especially for paths with spaces.
Pass **`--plugin-dir` again on every subsequent resume**; export does not persist an
installation in native settings. Loading a plugin before this explicit resume is the
verified flow. Installing/reloading into a CLI that is already open is **not verified**.

### 3. Request, review, and refresh

Inside that resumed Claude conversation, enter the literal namespaced command:

```text
/murmur:connect start Password reset | Own the API contract
```

Or join an existing group using its invitation code:

```text
/murmur:connect join INVITE_CODE | Own the UI flow
```

Replace `INVITE_CODE` with the **43-character base64url** code copied from **Connections
→ Invite another chat**. Do not include quotes, angle brackets, flags, or identity/path
selectors. The exact grammar is `start GROUP TITLE | RESPONSIBILITY` or
`join INVITE_CODE | RESPONSIBILITY`, with one spaced ` | ` separator. Start title and
responsibility are literal text, not shell syntax; control characters, extra separators,
shell metacharacters, and flag-like selectors are rejected.

Start/join submit a **pending request, not access**. From your human terminal, open
the normal authenticated dashboard if needed:

```bash
murmur dashboard
```

In **Connections → Approval requests**, select the matching public request, **Inspect
workspace / fresh review**, and check the exact project, workspace, separate task owner,
responsibility, shared-checkout warnings, lifetime, and handoff. Review/edit what will
be shared, including reported changed files and remaining work, then approve or reject.
The native command's public review reference is inert: it cannot log the browser in.
Never give the chat a human token or browser login ticket.

After approval, return to the original conversation:

```text
/murmur:connect refresh
```

Refresh activates the approved connection and retrieves bounded advisory group/task
context. `status` can also activate a newly approved pending request while checking
state, but use `refresh` when you want the context. The fixed native hook performs the
action; the skill only reports its result. Normal prompts do not automatically publish
intent, fetch context, or update coordination. Refresh again explicitly when relevant
work/decisions change; context delivery is **not model-obedience evidence**.

### Commands and lifecycle

| Exact command | Effect |
| --- | --- |
| `/murmur:connect start GROUP TITLE \| RESPONSIBILITY` | Request a new group connection for this chat; human review still required. |
| `/murmur:connect join INVITE_CODE \| RESPONSIBILITY` | Request to join the invited group; the 43-character code is not authority. |
| `/murmur:connect status` | Check the current chat's request/connection state; may activate approved access. |
| `/murmur:connect refresh` | Activate approved access and retrieve bounded advisory context. |
| `/murmur:connect leave` | Leave this membership and revoke its grant, preserving task, files, and native chat. |
| `/murmur:connect help` | Show the current syntax and limits. |

Ordinary resume on 2.1.247 retains the native UUID and valid approved scope. Native
fork creates a new UUID. Native clear emits a reset and a new UUID. Fork/clear therefore
report **disconnected**, rather than inheriting the parent's grant, and need their own
request and human approval. Explicitly resuming the original conversation can still
use its original unexpired/unrevoked grant; clear is not global revocation. To end that
access, leave or revoke it deliberately. Neither lifecycle path transfers task ownership.
The connector ignores copied parent handles and native-ID/cwd selectors; private
proof and authenticated human review remain separate from reported native metadata.

## Use Connections without a native adapter

1. Open the dashboard through the normal **human** login flow, from your own
   terminal. Choose the registered project.
2. Open **Connections → Create group**. Give the group a title and optional shared
   goal. The project selector scopes groups and grants, not pending requests.
3. Open the group and select **Add existing owner**. Choose a non-terminal task
   owned by a manual session or an active managed launch. The task, session, and
   project must match; a session can have only one active membership.
4. Review its responsibility and optional summary, files already changed, remaining
   work checklist, acceptance criteria, intended read/write paths, contracts, dependency
   task IDs, decision proposals, and blocker. Confirm
   what you intend to share.
5. Inspect **Members and ownership** to see the member session, assigned task, and
   current task owner separately. Reload the detail before retrying a stale action.

A manual member is coordination bookkeeping, not a connected or verified native
chat. A managed member retains its existing supervised task and lifetime. An
external session, even if disconnected, cannot be added manually: it requires a
fresh reviewed request.

A `featureKey` is an **exclusive active-work claim within the project**, not a
shared group key. Separate group members normally use different or empty feature
keys. Membership never transfers another session's task or resolves a duplicate
feature claim by taking it over.

## Invitations request approval, not access

Select **Invite another chat** in an active group. Invitations are single-use and
expire after **15 minutes**. The dashboard generates the public rendezvous code
locally and submits only its SHA-256 hash. The daemon stores no recoverable code.
The code is displayed only after successful creation; copy it before closing the
result dialog. An interrupted request retains its local code and retry identity
while that form remains open.

An invitation does not authenticate a chat or reveal project context. In the
explicitly resumed Claude 2.1.247 conversation, use `/murmur:connect join INVITE_CODE | RESPONSIBILITY`
with its exact 43-character code. This still submits a separate request and requires
human approval. Other native hosts remain gated; do not paste an invitation into an
invented alias or treat a setup bundle as activation.

Use **Revoke invitation** in the result or group detail to block unused invitations.
Revoking an invitation does not revoke already-approved memberships: inspect their
scoped grants separately. Closing a group also closes its invitations.

## Review a connection request

**Approval requests** are human-only and workspace-wide. A pending request may not
yet resolve to any registered project. Its workspace, group suggestion, native tool,
chat ID, and incarnation are **reported metadata**, not verified identity or native
authentication. Requests expire after **10 minutes**.

1. Select **Review request**, then **Inspect workspace / fresh review**. Only this
   authenticated human action performs workspace/project discovery. Register the
   project first if inspection says it is unknown.
2. Review the exact public request and revision, reported native metadata, resolved
   project, canonical project path, exact workspace, group, and existing or proposed
   session/task binding. Do not assume the currently selected project or raw request
   hint was the verified target.
3. Check shared-checkout and advisory-mode warnings. Linking preserves the current
   workspace; it does not create a worktree, move a process, or enforce write isolation.
4. Edit the **approved responsibility** and exact handoff to share. Structured JSON
   must use the documented fields; malformed or unknown fields are rejected. Read/write
   paths are literal relative paths, not globs. **Files already changed (reported)**
   is a separate past-change list, not intended `writes` or filesystem proof.
   **Remaining work** preserves the distinct unfinished checklist. Imported decisions
   remain **proposals**;
   accepting a project decision is a separate human action.
5. Review the sharing scope and deadline. A new external connection gets its own task
   by default. A managed request keeps its existing task and supervised lifetime.
6. Confirm the identity/binding, workspace/scope/lifetime, and reviewed shared content,
   then select **Approve reviewed connection**, or explicitly reject the request.

Approval pins the request revision and the authenticated review digest. The daemon
rechecks request state, workspace identity, invitation, deadline, and ownership. A
stale review or HTTP failure is not permission to retry blindly: the dashboard keeps
your edits and requires another inspection before approval. Background refresh does
not replace the open form or its focused field.

### Public review references are not login links

A public dashboard reference such as `#request=PUBLIC_REQUEST_ID` can select a
request **only after normal human login**. It grants no browser session or project
access. A chat/helper must never run the human dashboard/login command, receive a
browser bootstrap ticket, read `daemon.json`, or use the human bearer. Browser
credentials stay in the authenticated tab's memory, not local storage or exports.

The public connection descriptor is `connection.json`, with only protocol version,
loopback origin, state identity, and daemon-instance identity. It is not a credential.
The external client requires its complete private scoped environment and fails
closed instead of falling back to administrative discovery.

## Scope, contact, and expiry

An external grant is bound to exactly one project, session, task, membership, group,
workspace identity, and deadline. It permits task-focused context, that task's intent,
status/blocker, plan checks, decision proposals, reservations, and membership leave.
It does not permit general status/event streams, another task's mutation, accepted
decisions, ownership handoff, workspace operations, submission/integration, or native
launch control. Another task owned by the same session is still outside this grant.

External access defaults to **8 hours**, with a human-selected maximum of **24 hours**.
Activity and refresh never renew it; reservations cannot outlive it. Managed membership
instead uses its existing supervised lifetime and does not receive an external grant.

| Dashboard state | What it means |
| --- | --- |
| Pending | Awaiting a human decision; no external access yet. |
| Approved · not yet used | Approval exists, but no successful scoped bridge contact was recorded. |
| Recent bridge contact | A recent authenticated bridge request succeeded; not proof that a native process is running. |
| No recent bridge contact | Contact was observed previously, not recently; not proof that the native chat stopped. |
| Expired / revoked | The grant no longer authorizes access, regardless of a historical approval receipt. |

Contact timestamps are not heartbeats, model-comprehension evidence, or native
process-liveness checks. Expiry, revocation, or leaving a group does **not** end,
resume, or stop the native chat.

## Explicit fresh reconnect

Lost, expired, or revoked credentials cannot be recovered from a native ID or
reactivated manually. A new request must carry new private proof and receive fresh
human review.

During authenticated review, the daemon can list eligible expired/revoked grants
for the **same exact external chat, incarnation, workspace/project identity, session,
and still-owned non-terminal task**. An active grant, different owner, mismatched
workspace, or another active membership is not a reconnect candidate. Reported native
metadata alone does not authenticate recovery.

The default remains a new separately owned task. To reconnect, explicitly select
an eligible **Task binding**, inspect the preserved session/task/title/feature claim,
and acknowledge replacing the old access with a new grant. It is not an ownership
transfer. The old credential never becomes valid again. If the desired binding is
not eligible, inspect the existing task rather than reassigning it implicitly.

## Leave, close, or revoke without losing work

- **Leave group:** removes membership. For an external member it also revokes the
  grant and releases only its reservations. A managed member keeps its separate
  managed task authority and reservations.
- **Close group:** closes grouping and invitations and revokes its external grants.
- **Revoke scoped access:** invalidates that external grant without completing its task.

These actions preserve tasks, feature claims, workspaces, files, and native processes.
Use **Task actions** separately for explicit ownership handoff or abandonment. Do not
assume a disconnected task is complete, or delete state/workspaces as a recovery step.

## Reviewed handoff for a new managed task

For a runnable replacement, first integrate the original Murmur task through the
normal workflow, or explicitly abandon it through **Task actions**. Keep its source
group active and ownership unchanged. Then open its member detail and choose
**Export reviewed handoff** to capture the current source revisions. If you exported
before resolving the task, export again afterward; the earlier snapshot is stale.

Review and edit only the responsibility, summary, reported files already changed,
remaining-work checklist, acceptance criteria, intended reads/writes, contracts,
dependencies, blocker, decision proposals, and bounded project briefing. Remove credentials, private history,
and anything the replacement should not receive. Review the resulting JSON, then
choose **Download JSON** or **Copy JSON**. Treat the briefing as untrusted coordination
data, not authority to run commands.

The export contains reviewed coordination data—not credential files, native transcripts,
or source-file contents. It can seed a separately requested **new** managed task; it
does not attach to the original chat or resume its native process. The original task's
ownership is not reused automatically.

Before launching a replacement, the original Murmur task must already be **integrated
or explicitly abandoned** through the existing workflow/task controls. An active,
blocked, or ready task is refused; leaving a group, revoking access, or handing the
task to someone else is not a replacement shortcut. The source group must still be
active, with the same member/session/task ownership and existing workspace.

Use the full reviewed replacement-envelope JSON, not the standalone `HandoffDraft`
used by group-add or approval. The entire input must fit within **16 KiB**, with
at most **8192 characters** in its briefing. Source identity fields are binding
metadata, not editable selectors for another project, group, session, task, or owner.
The member, task, and session revision pins, exact workspace, and filesystem-identity
stamps must still match the live source records. The minimal `group` / `member`
snapshot is immutable; editable content lives in top-level `responsibility` and
`handoff` (including `handoff.summary`), not duplicated member text.
Human-reviewed responsibility and structured handoff edits remain
separate from those protected bindings; decision entries remain proposals.
Run this only from a human terminal, after inspecting `murmur run --help` and the
exact committed base you want:

```bash
murmur run claude --project PROJECT_ID --title "Continue the reviewed API work" --handoff REVIEWED_HANDOFF.json --acknowledge-replacement --base FULL_COMMIT_SHA
```

`--handoff` and `--acknowledge-replacement` must be supplied together. For this
workflow, `--base` must be a **full committed SHA**, not `HEAD`, a branch, or another
moving ref. The command creates a new managed task/workspace; it never resumes or
takes ownership of the original native chat. The source owner, group, and workspace
are checked again before spawn. The reviewed structured handoff is attached to the
new task. Fresh task-focused daemon context comes first; the human-reviewed briefing
is appended as explicitly **untrusted data**, not executable instructions. Any claims
of acceptance in those notes are proposals, not accepted project-decision authority.

The original source workspace is checked even when it is a separate worktree. If
it is dirty, commit/resolve the intended work yourself, or deliberately add
`--allow-dirty-base` to **exclude all dirty progress**. No uncommitted files are
copied, stashed, or committed; nothing stops the original chat. Normal managed
launch preparation and native trust/permissions still apply. Retain the request ID
and inspect ambiguous outcomes before deliberately retrying the identical request.
Export alone performs no launch.

## CLI equivalents and authority boundaries

The following `group` and `connect` commands are for a **human terminal**, not an
agent chat. From a source checkout, use `npm run murmur --` in place of `murmur`.
Replace uppercase IDs with records you have inspected. Read `murmur group --help`
and `murmur connect --help` for the complete current options.

```bash
murmur group create --project PROJECT_ID --title "Password reset" --goal "Keep API and UI responsibilities separate"
```

```bash
murmur group list --project PROJECT_ID
```

```bash
murmur group show --group GROUP_ID
```

```bash
murmur group add --group GROUP_ID --session SESSION_ID --task TASK_ID --responsibility "Own the API contract"
```

The task must already belong to that eligible manual/active-managed session. To
share a reviewed draft, `group add` accepts `--handoff HANDOFF_DRAFT.json`, a standalone
`HandoffDraft`, not the full replacement-export envelope. Responsibility and task
ownership remain separate from a group's title or feature claims. For example:

```json
{
  "summary": "Own the password-reset API contract and its regression test",
  "changedFiles": ["src/auth/reset.ts"],
  "remainingWork": ["Finish expiry edge-case regression coverage", "Review the response contract with the UI owner"],
  "acceptanceCriteria": ["Valid requests return 202 Accepted"],
  "reads": ["src/auth"],
  "writes": ["tests/reset-expiry.test.ts"],
  "produces": [{"key": "reset-api", "version": "1", "value": "202 Accepted"}],
  "consumes": [],
  "dependencies": [],
  "decisions": [],
  "blocker": null
}
```

`changedFiles` records **reported past changes**, with at most 64 literal relative
paths. It is distinct from planned `writes` and does not prove those files changed
or copy their contents. `remainingWork` preserves up to 16 unfinished checklist
items, at most 512 characters each; it is not a completion status or acceptance claim.
Keep these lists explicit rather than burying them in the summary. Summary and
blocker are short text, not transcripts. Any `decisions` entries use
`key`, `version`, `value`, and `rationale`; they remain proposals. Review this file
before supplying it to `group add` or `connect approve`.

```bash
murmur group invite --group GROUP_ID --out NEW_INVITATION_RETRY.json
```

Unlike the dashboard's display-after-success flow, the human CLI prints its generated
public code and request key to stderr **before** sending; `--out` optionally retains
that retry pair in a new file. The code is not proof the server created the invitation.
After inspecting an uncertain outcome, retry with the original `--code CODE` and
`--request-id KEY`, not a fresh pair. The daemon receives only `inviteHash`; it cannot
recover the original code. Output files are never overwritten.

Review and approve requests as separate human operations:

```bash
murmur connect requests
```

```bash
murmur connect review --request REQUEST_ID --revision REQUEST_REVISION
```

Inspect the returned request binding, canonical workspace, group, scope, and review
before approving. Use the **new review revision and reviewDigest**, not the prior
request revision. The review digest is a concurrency pin, not an access credential.
For a reviewed new external task:

```bash
murmur connect approve --request REQUEST_ID --revision REVIEW_REVISION --digest REVIEW_DIGEST --responsibility "Own the API contract" --handoff HANDOFF_DRAFT.json --expires 28800
```

`--expires` is seconds, at most 86400; omitting it gives 28800 seconds (8 hours).
Managed requests retain their existing task/lifetime: do not send new task title,
feature, or external-lifetime overrides for them. The dashboard exposes that distinction
without requiring you to assemble the payload.

Optional `--reconnect-grant GRANT_ID` is an **explicit fresh reconnect**, not an
approval shortcut. Use only an eligible ID returned by the authenticated review,
inspect the existing owner/task, and preserve its title and feature claim. Never
retry a stale approval blindly; review again and inspect its current outcome.

```bash
murmur connect reject --request REQUEST_ID --revision CURRENT_REVISION
```

```bash
murmur connect grants --project PROJECT_ID
```

```bash
murmur connect revoke --grant GRANT_ID
```

```bash
murmur group revoke-invite --invite INVITATION_ID
```

```bash
murmur group leave --member MEMBER_ID --revision MEMBER_REVISION
```

```bash
murmur group close --group GROUP_ID --revision GROUP_REVISION
```

```bash
murmur group export --member MEMBER_ID --out NEW_REVIEWED_HANDOFF.json
```

These operations do not hand off, abandon, or stop the member's task. `group export`
writes a reviewed replacement envelope to a new file; inspect it before launching
anything. Mutations accept `--request-id KEY`; strict JSON can be supplied with
`--data` or `--file`, and explicit flags must agree with it. Keep the exact request
key and payload when deliberately retrying an uncertain mutation.

### Already managed sessions

An already managed agent may use its supplied scoped command interface, not the
human commands above:

```bash
murmur agent group-request --group "Password reset" --goal "Coordinate separate responsibilities" --responsibility "Own the API contract"
```

Or request an invitation target instead of creating a group:

```bash
murmur agent group-request --invite INVITE_CODE --responsibility "Own the UI flow"
```

```bash
murmur agent group-leave --member OWN_MEMBER_ID --revision MEMBER_REVISION
```

These commands require the complete managed environment from its existing launch.
They cannot choose another session/task, approve enrollment, create human credentials,
or change the managed lifetime. Group requests still await human review. A managed
group leave removes grouping only, not its task/supervisor authority.

For an already managed launch using the supported MCP bridge, the corresponding
scoped tools are:

- `murmur_request_group_link`: choose `groupTitle` (optional `groupGoal`) **or** a
  public `inviteCode`; supply `responsibility` and optionally a reviewed `handoff`.
  This requests human approval for the existing bound task, never another owner.
- `murmur_leave_group`: supply this task's `memberId` and membership `revision`.
  This leaves grouping without stopping supervision, releasing managed task
  reservations, completing work, or transferring ownership.

A working managed MCP transport does not adopt an arbitrary already-open chat.
These tools operate only on the task that was already launched and bound by Murmur;
they cannot authenticate a native chat from shared MCP metadata or a copied ID.

### External scoped client and native setup

With an already approved, privately supplied immutable external connection, the
separate environment-scoped client supports `murmur external identity`, `context`,
`member-status`, own-task mutations, and `leave`; see `murmur external --help`.
`MURMUR_EXTERNAL_MODE=1` and a complete private `MURMUR_EXTERNAL_CONNECTION` are
required. Do not invent, copy into chat, or derive that private connection from a
native ID or the human descriptor. This CLI is not native enrollment or permission
to bypass a gated host. `murmur native --help` reports the version-scoped capability
and fixed-hook contract. Only `native hook --descriptor ABSOLUTE_CONNECTION_JSON`
accepts the native hook envelope; direct actions and caller-supplied identity are
rejected with `NATIVE_ADAPTER_UNVERIFIED`. Do not invoke the hook manually from a chat.

For Claude **2.1.247 only**, use the human export and explicit original-chat resume
workflow [above](#connect-an-existing-claude-conversation). Setup validates the actual
executable/version, public descriptor, and private helper directories. It exports
reviewable files, not native settings, installation, or approval. Other hosts and
direct hot attachment remain gated/unverified; manual/API and managed-group surfaces
remain available independently.

## Local-only boundaries

This is coordination on one machine under the local user's authority, not remote
chat discovery, multiuser hosting, or an OS security sandbox against other same-user
processes. Shared-checkout warnings, declarations, and reservations are advisory.
Native permissions and trust prompts remain the native application's responsibility.
Installing Murmur or exporting setup assets does not change native settings, install
plugins, authenticate a chat, or enroll one automatically.

See the [user guide](user-guide.md), [support matrix](support-matrix.md),
[native integration limits](native-integrations.md), and
[release checklist](release-checklist.md) for the surrounding workflow and remaining gates.

### Private helper locking and legacy markers

New helper calls use a private SQLite mutex whose OS lock is released when its
process closes or crashes. The mutex contains no credentials, and recovering it
does not renew a grant or release task reservations. Its directory is retained.

An older regular-file `.lock` marker is refused, not guessed stale or deleted.
Let a known older helper finish and clean up normally. If deliberate manual
migration is needed, first stop the known old workers, human-revoke or reject
their old authority, and archive the owned binding state together with its legacy
marker before requesting fresh approval. Do not mix old and new helper versions
on the same private binding. No released 0.4 native bindings require this migration.
