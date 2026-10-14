# Using Murmur

Murmur is a **local 0.6 development alpha** for coordinating parallel coding work. Managed
launchers create fresh tasks with automatic registration, workspace preparation,
startup context, and scoped commands. **Claude Code 2.1.247** also has a same-chat
connector: export a plugin, explicitly resume the original conversation, request
human approval, then refresh shared context. **Codex CLI 0.154.0** also supports
reviewed hook installation and same-conversation resume, with automatic prompt
context refresh after explicit activation. The original human-operated workflow,
project groups, and reviewed handoffs remain available in **Connections**.

**The practical distinction:** the Claude connector is verified with headless native
fixtures and native-authored history, **not a real-user chat/model trial**. It does not
discover sessions, import history, hot-install into an already-open CLI, or automatically
publish intent in the background. Codex has its separately verified CLI flow;
OpenCode, Cursor and untested native versions remain gated.
Managed MCP/advisory hooks are separate features whose native verification differs
by tool. Explicit context delivery is not a guarantee of model compliance. See
[groups and session connections](session-linking.md) and the
[support matrix](support-matrix.md), plus the [Codex existing-chat guide](codex-existing-chat.md).

## Start with the right mental model

| Term | What it means today |
| --- | --- |
| Task | A piece of work you enter into Murmur, with an objective and optional declared scope/contracts. |
| Owner/session record | Bookkeeping that associates work with an owner. It is **not** a live connection to a coding tool. |
| Workspace | The actual checkout in which files are edited. Independent editing tasks should use separate workspaces. |
| Coding agent | Claude Code, Codex, Cursor, OpenCode, or another tool that **you open in the workspace**. |
| Group | Project-focused context linking distinct responsibilities; not shared task ownership or merged chat history. |
| External grant | Human-approved access to one exact task/session/membership/workspace for a fixed lifetime, not a native-process supervisor. |

**First trial:** follow steps 1–5 to create two tasks and see a duplicate-contract
alert without changing source files. Continue with steps 6–9 when you want isolated
editing and reviewed Git integration.

- [Install and open the dashboard](#1-install-and-start)
- [Create tasks and declare intent](#3-create-a-task-and-an-owner-record)
- [Share context with a coding tool](#5-share-decisions-and-give-the-agent-its-context)
- [Connect the original Claude conversation](#optional-connect-the-original-claude-conversation)
- [Link separate responsibilities in Connections](#optional-group-related-work-in-connections)
- [Use separate workspaces](#6-give-each-independent-editing-task-its-own-workspace)
- [Submit and integrate committed work](#7-submit-committed-work)
- [Manage integrations](operations.md)
- [Maintain credentials and backups](data-lifecycle.md)
- [Common questions](#common-questions)

## What you need

- A local computer with Node.js and Git.
- The source folder or the supplied `murmur-local-0.6.0-alpha.1.tgz` package.
- A Git-backed project **with at least one commit** for workspace isolation and
  integration. An ordinary folder
  can use task/decision coordination, but not the Git workflow.

Package metadata requires Node 24+. The verified local setup is **macOS with
Node 26.4.0 and Git 2.54.0**; Node 24 and Linux are not yet release-verified.
Murmur itself needs no model API key, cloud account, or paid subscription.
Your coding tools continue to use their own accounts and billing.

This build coordinates **local folders on one machine**. Remote/cloud-agent
sandboxes and sessions on other machines are not connected.

## 1. Install and start

Choose **one** installation method.

**Upgrading:** stop the old daemon and privately back up its complete state
directory before starting a new version. The migrations preserve existing session and launch data, but older binaries
must refuse the upgraded **v4** database. Never put the backup, which can contain
credentials and private state, in a public repo. A whole-state-directory backup is
different from the new SQLite-only maintenance backup; preserve workspaces and the
installer registry separately. See [data lifecycle](data-lifecycle.md).

### Run from source

Open a terminal in the Murmur source folder—the folder containing its `package.json`.
This is not necessarily the application project you want to work on.

```bash
npm ci --ignore-scripts
```

```bash
npm run build
```

In **terminal 1**, start the service and leave it running:

```bash
npm run murmur -- daemon start
```

Open **terminal 2 in the same Murmur source folder**:

```bash
npm run murmur -- dashboard
```

Open the URL in the command's JSON output. Murmur prints it; it does not launch
a browser for you. Use the URL within **one minute**.

Keep terminal 2 in the Murmur source folder for `npm run murmur -- ...` commands.
Select your actual application project in the dashboard. Open a separate terminal
or editor for the coding agent later.

### Install from the local package

From the folder containing the downloaded `.tgz` file:

```bash
npm install --global --ignore-scripts --offline ./murmur-local-0.6.0-alpha.1.tgz
```

Use a user-managed Node installation. If global installation requires permissions
you do not have, use the source method rather than blindly changing system ownership.

In terminal 1:

```bash
murmur daemon start
```

In terminal 2:

```bash
murmur dashboard
```

The remaining CLI examples use this shorter installed form. From source, replace
`murmur ...` with `npm run murmur -- ...`, while staying in the Murmur source folder.

**There is no published npm release yet.** Do not assume `npx murmur` or
`npm install -g murmur` refers to this project.

### Browser sessions and service state

The sign-in URL is one-use. The browser session lasts 30 minutes and keeps its
credential only in memory. After refreshing the page or after expiry, run the
dashboard command again and open its new URL. Do not reuse the old one.

The service stores local state outside your project:

- macOS: `~/Library/Application Support/Murmur`
- Linux: `$XDG_STATE_HOME/murmur`, or `~/.local/state/murmur`

If you override this with `MURMUR_HOME`, use the **same value in both terminals**
and select a dedicated private directory outside your source repository.

## 2. Register the project you want to work on

In the dashboard, choose **Register project**. Enter the absolute path to an
existing local project folder and submit.

Registration does not clone a repository, create source files, or connect an agent.
It makes the folder available to Murmur's task board.

For parallel work on one repository, use its worktrees so they share the same local
Git common directory. Independent clones—even of the same remote URL—are treated
as separate local projects in this release.

## Optional: launch a managed task

After registering a Git project, you can replace manual task/owner/workspace setup
with a managed launch. Use the project ID returned by `init` or shown in the dashboard:

```bash
murmur run claude --project PROJECT_ID --title "Implement password reset"
```

In another terminal, to work concurrently:

```bash
murmur run codex --project PROJECT_ID --title "Build account settings"
```

From source, use `npm run murmur -- run ...` in the Murmur source folder. Leave the
daemon terminal running separately. The selected coding tool must already be
installed and normally authenticated; Murmur does not log in or change its permissions.
Starting a managed task starts that coding tool normally, using its own account
and billing. The daemon and version/help probes do not start model conversations.

The launcher creates a new isolated worktree, task, and managed owner, and supplies
startup context plus an absolute invocation for `murmur agent` commands. The agent
can retrieve context, declare intent, propose decisions, and submit already committed
work. It cannot accept decisions, change validation trust, hand off tasks, or approve
integration with its managed credential.

The supervisor renews session access every 30 seconds with a 120-second deadline.
An agent cannot extend its own lifetime. Exiting or losing supervision revokes
coordination access and releases its reservations, but does not mark the task done
or remove source work. An orphaned native process is not an OS-sandbox guarantee.

This increment starts **new tasks only**: no takeover, native resume, arbitrary
native flags, permission bypass, or remote sessions. For a dirty original checkout,
`--allow-dirty-base` explicitly starts from committed history only; uncommitted
changes are never copied, stashed, or committed automatically.

Keep normal user control of the tool's terminal. Use the existing decision,
submission, validation, and integration steps below. For launch failures, inspect
the printed request/task/workspace identifiers rather than repeating with a new
request ID: an ambiguous spawn is deliberately not repeated automatically.

### Opt into MCP and context hooks

The normal scoped CLI bridge remains the default. For Claude, an experimental
MCP-and-hook launch is:

```bash
murmur run claude --project PROJECT_ID --title "Implement password reset" --bridge mcp --context-hooks
```

For Codex:

```bash
murmur run codex --project PROJECT_ID --title "Build account settings" --bridge mcp
```

The launcher creates private configuration containing environment references,
not credentials. It does not install a global MCP server or rewrite project
settings. Do not manually add `murmur mcp serve` as an unscoped global server—it
requires the managed launch connection and refuses administrative discovery.

Native trust/approval rules still apply. Claude hook context is advisory;
PreToolUse feedback does not undo or guarantee replanning of the selected call.
Codex's hook command supports the documented envelope, but automatic Codex hook
configuration is disabled until safe merge/trust behavior is established.
A requested integration failing does not silently select another bridge mode.

Static configs are cleaned only when unchanged and owned by the launch. Dynamic
hook cache or modified/unknown files may be retained privately. This does not
remove the source workspace or prove native/model consumption of context.

See [MCP tools](mcp.md), [native integration limits](native-integrations.md), and
[advisory hooks](context-hooks.md). Source builds need their pinned dependencies;
local archives produced by `npm run pack` include the verified runtime closure.

See [managed launch details](managed-launch.md), [the scoped commands](agent-bridge.md),
and [verification limits](verification.md). Fake-process/contract tests are not
proof of real model behavior; the release checklist retains that gate.

OpenCode V2 can be started through the CLI-only fallback:

```bash
murmur run opencode --project PROJECT_ID --title "Add regression tests"
```

It requires V2 `--standalone`/`--prompt` support and refuses MCP or context-hook
flags before preparation. Its native session identity and descendant cleanup are
not claimed verified by CLI help or fake-process tests. See [OpenCode details](opencode.md).

## Optional: connect the original Claude conversation

The **Claude Code 2.1.247-only** same-chat connector keeps the original conversation
and native history. It is not `murmur run`, a replacement task/chat, or automatic
attachment to an already-open CLI. A process with any existing `MURMUR_AGENT_` or
`MURMUR_EXTERNAL_` environment marker is refused with `NATIVE_ALREADY_SCOPED` rather
than creating a second connection. Use its existing agent/MCP or external scoped
commands instead; do not remove scope markers to bypass this boundary.

1. From a **human terminal in the original project**, ensure the daemon is running
   and register the project if needed. Use the same `MURMUR_HOME` as the daemon.
2. Inspect `murmur connect --help`, then export a new plugin directory:

```bash
murmur connect setup --tool claude --out /absolute/new/plugin-dir
```

3. Setup checks the actual 2.1.247 executable/version, canonical public descriptor,
   and owner-private helper state. It exports files only—no native settings edits,
   global plugin installation, login, enrollment, or `--force` override. Review them.
4. **Pause/exit the original Claude CLI before opening it again** to avoid duplicate
   writers. Run the returned absolute `resumeCommand` from the original project;
   `--plugin-dir` loads the bundle and `--resume` opens the native picker. Choose the
   original conversation. **Pass `--plugin-dir` again on every resume.**
5. In that conversation, request a connection:

```text
/murmur:connect start Password reset | Own the API contract
```

Or join with the exact **43-character base64url** invite from Connections:

```text
/murmur:connect join INVITE_CODE | Own the UI flow
```

6. In the normally authenticated Murmur UI, select **Connections → Approval requests
   → Review request → Inspect workspace / fresh review**. Check the exact original
   workspace/project, responsibility, new separate task owner, sharing scope, lifetime,
   and handoff. Review/edit the reported changed files and remaining work before approval.
7. Back in the same conversation, activate approved access and retrieve context:

```text
/murmur:connect refresh
```

Use `/murmur:connect status`, `/murmur:connect leave`, and `/murmur:connect help` as
needed. Status can also activate an approved pending request; refresh adds context.
Start/join only request approval. Leave preserves the task, files, and native chat.
After explicit activation, ordinary prompts refresh only the approved active
connection. Claude tool-boundary context is advisory and its native post-tool
delivery remains unverified. There is no automatic intent publication. Explicit
refresh remains available. The namespaced command is **not** `/murmur` or `@murmur`,
and there are no model-supplied session/cwd selectors.

Ordinary resume retains the UUID/valid approved scope. Observed fork and clear create
new UUIDs and report disconnected rather than inheriting the parent grant. They need
their own review/approval. Explicit original resume still works while its grant remains
valid; clear does not revoke that original access globally. Murmur does not scan or
import native history. Read the [complete setup and lifecycle guide](session-linking.md#connect-an-existing-claude-conversation),
including absolute source-CLI commands that let you stay in the original project.

<a id="completion-checklist-what-05-does-and-does-not-establish"></a>

### Completion checklist: what 0.6 does and does not establish

- [x] Claude 2.1.247 export → explicit same-chat resume → request → human review → refresh.
- [x] Headless native production-plugin checks for separate same-cwd owners, resumed
      scope, fork/clear disconnection, explicit original resume, and own-grant leave.
- [x] Existing 0.4 manual/API groups, reviewed handoffs, fixed expiry, and separate ownership.
- [ ] Your own real-chat/model trial and confirmation that the model follows the context.
- [ ] Direct hot attachment/reload of a plugin into an already-open CLI.
- [x] Codex CLI 0.154.0 implementation for reviewed hooks, native resume and approved-session refresh. Historical native evidence used trust bypass and a pretrusted fixture.
- [ ] Normal interactive Codex project/hook activation.
- [x] Reviewed integration lifecycle and human-only credential, retention and backup controls.
- [ ] Existing-chat support for OpenCode, Cursor, or untested Claude/Codex versions.
- [ ] Automatic existing-chat intent publication and observed-write reconciliation. Approved-session context refresh is a separate implemented feature.
- [ ] Broader native MCP acceptance, restricted managed resume, and automatic four-tool coordination.

The checked native items used **native-authored disposable history**, empty HOME/config,
a dummy key, and an owned static loopback API responder—no actual LLM inference.
They do not prove interactive trust behavior, a stronger OS sandbox, or absence of
Keychain access. The earlier denied nested containment probe remains in the
[dated evidence](verification-existing-chats.md), alongside the separate 0.5 result.

The following sections describe the manual fallback, which remains useful for
unsupported hosts and workflows without a connector.

## 3. Create a task and an owner record

Open **Tasks → New task** and enter:

- **Task title:** a concrete outcome, such as “Implement password reset endpoint.”
- **Feature key:** optional exclusive active-work claim, such as `password-reset-api`.
  Murmur refuses a second active task with the same key in the project. It is **not**
  a group key; use Connections to group independently owned tasks.
- **Owner:** choose **Create a manual session** for each independent agent/task.
- **Manual session workspace:** initially use the registered project root.

Be deliberate about Owner: when manual sessions already exist, the form defaults
to an existing manual owner. Managed and external credentials are not reusable
manual task owners. Reusing one owner for several independent workspaces can prevent
later attachment. Start with one manual owner record per independent editing task.

**A manual session is bookkeeping, not a running coding agent.** It does not launch,
authenticate, or connect Claude Code, Codex, Cursor, or OpenCode. Likewise, labelling
a CLI-created session with `--tool claude` does not install a Claude integration.

## 4. Declare what the task intends to change

Click the task title. In **Overview**, choose **Edit intent**; alternatively use
**Intent & scope → Replace intent**.

Paste a declaration into **Intent JSON**, for example:

```json
{
  "acceptanceCriteria": ["Password reset requests return 202 Accepted"],
  "reads": ["src/auth"],
  "writes": ["src/auth/reset.ts"],
  "produces": [{"key": "reset-api", "version": "v1", "value": "202 Accepted"}],
  "consumes": [],
  "dependencies": []
}
```

Adapt the paths and contract to your project. Paths are literal relative filenames
or directory prefixes, **not globs** such as `src/auth/**`. Versions and values
are strings. Dependency entries are existing task IDs in the same project.

All six fields must be arrays. Saving **replaces the whole declaration**; it does
not append to the previous one. Reopen the task before editing if someone else
may have changed it. Use **Reload task** after a stale-revision error.

### Try an alert without changing source files

1. Create two tasks with separate manual owners and different or empty feature keys.
2. Give them different titles and different write paths.
3. In both intents, declare production of the same contract key, such as `reset-api`.
4. Open **Alerts**. Murmur should identify **Duplicate contract producers**, even
   though the titles and files differ.

This changes coordination records only; you do not need to edit project files.
An alert explains evidence—it does not prove that every parallel implementation
is wrong or automatically stop either agent.

## 5. Share decisions and give the agent its context

Use **Decisions → Propose decision** to record a contract or convention. For example:

- Key: `reset-api`
- Version: `v1`
- Value: `202 Accepted`
- Rationale: explain why this is the agreed response.

A proposal is not authoritative until the human uses **Review & accept**. Replacing
an accepted decision is explicit. A consumer declaring an older version can then
receive a stale-contract alert.

Before starting work, open the task's **Overview → Daemon briefing**, or inspect
**Intent & scope → Full task context**. Copy the relevant briefing into the agent's
conversation. Repeat when related decisions or work change.

The human can also retrieve context through the CLI. Replace the uppercase IDs
with values from the dashboard:

```bash
murmur context --project PROJECT_ID --task TASK_ID
```

The CLI returns JSON, including a `briefing` string. **This copy/paste step is
manual for manual members.** Managed tasks can use their scoped CLI/MCP bridge
where supported. The approved Claude 2.1.247 same-chat connector retrieves context
through explicit `/murmur:connect refresh`. Codex 0.154.0 uses `murmur-connect refresh`
for activation, then refreshes automatically on ordinary prompts. See the
[Codex guide](codex-existing-chat.md); other native existing-chat hosts remain gated.

For example, tell the agent: “Work on this task only in the workspace I opened.
Here is the current Murmur context. Treat other tasks' unmerged implementations
as pending, and flag any contract change for review.” Then supply the briefing.
This is a human handoff, not a guarantee that the model will follow every instruction.

The CLI and dashboard are human-operated. Do not give agents the daemon's human
credential or tell them to approve their own decisions/integrations. Advanced API
clients should use scoped session credentials; see [the protocol](protocol.md).

## Optional: group related work in Connections

A group shares project focus without taking over a chat or combining task owners.
The **project selector scopes groups and grants**; **Approval requests** are
human-only and workspace-wide because an unreviewed workspace hint may not resolve
to that selected project.

1. Choose **Connections → Create group** and enter its shared goal/title.
2. In the group, choose **Add existing owner** for a non-terminal manual task or
   the existing task of an active managed launch. Review the separate member
   session, assigned task, current owner, and responsibility. An external session
   cannot be added manually, even when disconnected.
3. Review the summary, **Files already changed (reported)**, **Remaining work**
   checklist, acceptance criteria, intended read/write paths, contracts, dependency
   IDs, blocker, and decision proposals before sharing. Reported changed files are
   past-change claims, not planned writes or filesystem proof. Imported
   decisions are not accepted automatically.
4. **Invite another chat** creates a locally generated public code whose hash alone
   is stored by the daemon. It is single-use, expires after 15 minutes, and only
   requests approval. Copy it before closing its result; revoke it from the group
   when no longer needed. Native use still depends on a verified host integration.

For a pending request, use **Review request → Inspect workspace / fresh review**.
Match the reported native metadata to the intended chat; it is not authentication.
Inspect the resolved project, canonical workspace, responsibility, sharing scope,
and lifetime. Shared-checkout/advisory warnings mean no isolation is being created.
Keep or edit only the handoff you want shared, then explicitly approve or reject.
A stale review or HTTP failure preserves edits and requires fresh review, not blind
approval retry. A public `#request=…` reference cannot sign a browser in.

New external grants default to **8 hours**, maximum **24 hours**, and activity never
extends them. Managed members keep their existing task and supervised lifetime
without a new external grant. An already managed task can request approval through
`murmur agent group-request` or the managed MCP tool `murmur_request_group_link`;
`group-leave` / `murmur_leave_group` leave only its own grouping. These are not
arbitrary existing-chat adoption tools. **Approved · not yet used**, bridge-contact
timestamps, and expired/revoked states are distinct: none proves native-process liveness.

Lost/revoked/expired credentials require a new request and approval. An explicit
**Task binding** selection can reconnect only a daemon-reviewed eligible same-chat
session and still-owned task; it preserves the owner, title, and exclusive feature
claim and issues new authority. The default is a new separately owned task.

**Leave group**, **Close group**, and **Revoke scoped access** do not hand off,
abandon, finish, move, or stop the original task/chat. Use **Task actions** separately
for ownership handoff or abandonment. Files and feature claims are preserved.

For unsupported native hosts, first integrate or explicitly abandon the original
Murmur task, keeping its group active and ownership unchanged. Then use **Export
reviewed handoff**, review its exact JSON, and download/copy a fresh source-revision
snapshot for an explicitly launched **new** managed task. Export again if source
revisions changed after an earlier export. No native history, credentials, or source
files are imported; merely leaving/revoking or transferring ownership is not enough. Use `run --handoff FILE`
with `--acknowledge-replacement` and an explicit **full committed SHA** in `--base`.
The source group/owner/workspace are rechecked; dirty-source consent never copies
uncommitted progress. Export itself does not launch anything. The exact human CLI
example is in [the connection guide](session-linking.md#reviewed-handoff-for-a-new-managed-task).

Claude Code **2.1.247** has the separately verified explicit plugin + same-chat
resume path described above. Other hosts and direct already-open hot attachment
remain unverified/gated. Exporting/loading the plugin is not enrollment; human
review and approval are still required. Use `/murmur:connect`, not `/murmur` or
`@murmur`. See [groups and approved connections](session-linking.md) for the boundaries.

## 6. Give each independent editing task its own workspace

Before the agent starts editing:

1. Open **Workspaces → Create workspace**. Select the committed base revision.
2. If the original checkout has uncommitted changes, decide explicitly whether to
   start from committed history only. Murmur does not silently copy, stash, or commit them.
3. Return to the task and choose **Actions → Attach workspace**.
4. Select the workspace and acknowledge that the running agent must restart there.
5. Copy the workspace root from **Workspaces**. Open that exact folder in your
   coding tool or start the tool from a terminal whose working directory is that folder.

**Attachment does not move an existing process.** Stop/restart it yourself or
open a new session in the correct folder. If the agent keeps working in the old
folder, Murmur has not isolated its edits.

If your coding tool already created a worktree of the same repository, use
**Adopt existing** rather than creating a worktree inside it. Adoption records
that checkout; it does not move files or make it disposable.

Dependencies, build output, ignored files, and environment secrets are not copied
automatically. Set up each workspace deliberately. Worktrees also do not isolate
ports, databases, or external services.

Murmur checks registered Git workspaces about every 10 seconds. It can report
changed paths and overlap, but labels the author **unknown**. Old observations
become stale rather than being presented as current evidence. Reservations are
advisory and do not prevent arbitrary filesystem writes.

## 7. Submit committed work

When the task is ready:

1. Review the diff in its actual source workspace.
2. Commit the intended changes using your normal Git workflow.
3. Ensure there are no pending tracked or untracked changes in that workspace.
4. Open the task and choose **Actions → Submit changeset**.

Murmur pins the committed source revision. It does not make the source commit for
you. Ignored/untracked work is not magically included in a submission; do not
assume local configuration or secrets will appear in the candidate.

The **Changeset submitted** result contains its ID and a **Prepare candidate**
action. Alternatively, use **Integration → Prepare candidate** and supply that ID.
Preparation combines pinned revisions in a separate workspace. It does not update
your original checkout or approve the result.

## 8. Configure checks, then validate

Open **Integration → Validation settings**.

- **Expected configuration revision:** use `0` for the first configuration. For
  subsequent changes, retain and use the revision returned by the last save.
  This is the configuration revision—not a task revision. There is not yet an
  automatic configuration-read form to recover it for you.
- **Commands (JSON array):** list executable/argument pairs you explicitly trust.

For a project whose dependencies are already available:

```json
[
  {"command": "npm", "args": ["test"], "timeoutMs": 120000}
]
```

The candidate is a fresh checkout. If it requires dependency setup, include the
appropriate trusted setup step before the test—for example `npm ci` for a suitable
npm project. Do not assume the original workspace's `node_modules` or `.env` exists
there. Only approve setup commands if you trust the repository and dependencies.

**Commands run with your local-user privileges, not in an OS sandbox.** Review
executable names, arguments, and time limits. Saving a configuration does not
run it and does not approve a candidate.

Open the candidate using **Inspect**, then **Run validation**. Failed, timed-out,
cancelled, or invalidated checks block promotion. An empty command list means
**unverified**, not passing; an unchecked candidate requires a separate explicit
acknowledgement, and that acknowledgement cannot bypass failed configured checks.

For CLI users, the corresponding input file is an **object**, unlike the UI's
bare array:

```json
{
  "commands": [
    {"command": "npm", "args": ["test"], "timeoutMs": 120000}
  ]
}
```

```bash
murmur validation configure --project PROJECT_ID --revision 0 --file checks.json --confirm
```

## 9. Review, approve, and finish the Git handoff

In the candidate inspection, choose **Review approval**. Review the exact source,
target, and candidate SHAs and the validation record. Acknowledge the confirmation
and approve only the result you intend to promote.

Murmur advances its dedicated branch:

```text
refs/heads/murmur/integration/PROJECT_ID
```

It does **not** rewrite your original branch or working copy. The task becomes
integrated after successful promotion. If the target or validation configuration
changed, the old result is stale and needs a fresh candidate/checks.

To bring the result into your working branch, first make sure the original checkout
is clean and on the intended branch. Inspect the candidate diff. Then use your
normal Git review/merge workflow; a conservative local handoff is:

```bash
git merge --ff-only refs/heads/murmur/integration/PROJECT_ID
```

Replace `PROJECT_ID` with the actual ID, or copy the complete target ref from the
candidate inspection. If fast-forward is refused, **stop and reconcile deliberately**;
do not force-reset your branch. An independently changed branch creates a different
combination that needs validation. Murmur does not push or open a PR for you.

## 10. End coordination or reopen the service

Leave the daemon running while coordinating work. Stop it with Ctrl-C in its
terminal, or:

```bash
murmur daemon stop
```

Restart using the same state directory to recover the recorded projects/tasks.
A disconnected agent or expired lease does not remove its files or complete its
task. External expiry and membership leave also do not stop a native chat.
Restarting the daemon is not native resume; lost external credentials need fresh
request approval. Do not delete live state or workspaces as a recovery shortcut.

### Retrying CLI operations safely

If a CLI mutation times out, inspect the task/project first. For a deliberate
retry, use the same `--request-id` and exactly the same arguments. A changed
payload under the same ID is rejected rather than silently creating new work.

Managed `run` requests use UUID request IDs; retain the printed UUID and inspect
any ambiguous launch rather than assuming a retry is safe.

For `session register`, also provide and reuse explicit `--native-id` and
`--instance` values; otherwise each invocation generates new IDs. Never use an
old request ID for a different task, decision, or source revision. Abandoning a
task requires `--confirm`; it is not the same as deleting its workspace or files.

## Common questions

| Question | Current answer |
| --- | --- |
| Will Murmur find or take over my existing sessions? | No automatic discovery or takeover. Claude 2.1.247 uses an exported plugin and Codex 0.154.0 uses reviewed hooks with explicit native resume of the original conversation; untested hosts remain gated. Managed launchers start new tasks. |
| Does a group share task ownership? | No. Each member has its own session/task binding; feature keys remain exclusive active-work claims. |
| Does an invite or public request link grant access? | No. Invitations only request approval; public request references require normal human browser login. |
| Does expiry stop my original chat? | No. It revokes scoped access, not native processes or task ownership. |
| Can I recover a lost external credential by native ID? | No. Use fresh approval; an explicit eligible reconnect issues new authority without transferring the task. |
| Why does Adapters say unverified? | Launcher/CLI-bridge implementation is separate from verified native MCP/hooks or model-driven use. |
| Why does a native command report `NATIVE_ADAPTER_UNVERIFIED`? | Direct `murmur native` actions/caller-selected identity are unavailable. Only the fixed exported Claude 2.1.247 hook is enabled; use `/murmur:connect` after explicit plugin/resume setup. Other hosts need the manual/managed-group or reviewed-handoff fallback. |
| Can I load it into a Claude CLI that is already open? | Direct hot attachment/reload is unverified. Pause/exit that CLI, then use setup's explicit plugin/resume command in the original project. |
| Must I pass `--plugin-dir` again? | Yes, on every resume. Setup does not persist a native plugin installation. |
| Does a fork or clear retain its parent connection? | No. The observed 2.1.247 paths create a new UUID and report disconnected. Explicit original resume can still use the original valid grant. |
| Does refresh run automatically? | No. Run `/murmur:connect refresh` explicitly after approval and when relevant context changes. Ordinary prompts do not publish intent or refresh in the background. |
| Why are there no intent alerts? | Declarations are required. In managed mode the agent must use its scoped intent command; otherwise enter the declaration manually. |
| Why does my agent still edit the original folder? | Attachment only changes records. Reopen the agent in the displayed workspace root. |
| Why did workspace attachment fail? | Check for active reservations or other tasks owned by that same session. Prefer a separate owner per independent editing task. |
| Why are tests missing dependencies? | Candidates are separate checkouts. Configure trusted dependency setup explicitly. |
| Why did a revision check fail? | Another action changed the record. Reload the task or use the latest configuration revision. |
| Why does refreshing the browser sign me out? | The bearer stays in memory only. Open a fresh dashboard URL. |
| Can all agents edit one shared folder safely? | Not guaranteed. Use separate workspaces; reservations are not file locks. |
| Can it coordinate remote/cloud agents? | Not in this single-machine alpha. |
| Is it ready to advertise as automatic four-tool coordination? | No. See the release checklist. |

See [what is left to build](release-checklist.md), [the verification record](verification.md),
and [the detailed Git workflow](workflow.md) before using the alpha on important work.
