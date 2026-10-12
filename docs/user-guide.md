# Using Murmur

Murmur is a **local alpha with opt-in managed CLI launches** for coordinating
parallel coding work. Claude Code and Codex can be launched with automatic
registration, workspace preparation, startup context, and scoped coordination
commands. The original human-operated workflow remains available.

**The practical distinction:** managed launchers supply initial context and a
scoped command interface, but agents must invoke it for later updates. Murmur does
not discover existing sessions or guarantee per-turn injection. MCP and native
hooks are still absent; Cursor/OpenCode use the manual workflow for now.

## Start with the right mental model

| Term | What it means today |
| --- | --- |
| Task | A piece of work you enter into Murmur, with an objective and optional declared scope/contracts. |
| Owner/session record | Bookkeeping that associates work with an owner. It is **not** a live connection to a coding tool. |
| Workspace | The actual checkout in which files are edited. Independent editing tasks should use separate workspaces. |
| Coding agent | Claude Code, Codex, Cursor, OpenCode, or another tool that **you open in the workspace**. |

**First trial:** follow steps 1–5 to create two tasks and see a duplicate-contract
alert without changing source files. Continue with steps 6–9 when you want isolated
editing and reviewed Git integration.

- [Install and open the dashboard](#1-install-and-start)
- [Create tasks and declare intent](#3-create-a-task-and-an-owner-record)
- [Share context with a coding tool](#5-share-decisions-and-give-the-agent-its-context)
- [Use separate workspaces](#6-give-each-independent-editing-task-its-own-workspace)
- [Submit and integrate committed work](#7-submit-committed-work)
- [Common questions](#common-questions)

## What you need

- A local computer with Node.js and Git.
- The source folder or the supplied `murmur-local-0.2.0.tgz` package.
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

**Upgrading from 0.1:** stop the old daemon and privately back up its complete state
directory before starting 0.2. The new credential-mode migration preserves manual
sessions, but older binaries cannot open the upgraded database. Never put the
backup, which can contain credentials and uncommitted workspaces, in a public repo.

### Run from source

Open a terminal in the Murmur source folder—the folder containing its `package.json`.
This is not necessarily the application project you want to work on.

```bash
npm install --ignore-scripts --offline
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
npm install --global --ignore-scripts --offline ./murmur-local-0.2.0.tgz
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

## Optional: launch a new Claude Code or Codex task

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

See [managed launch details](managed-launch.md), [the scoped commands](agent-bridge.md),
and [verification limits](verification.md). Fake-process/contract tests are not
proof of real model behavior; the release checklist retains that gate.

The following sections describe the manual fallback, which remains useful for
existing sessions and tools without a managed launcher.

## 3. Create a task and an owner record

Open **Tasks → New task** and enter:

- **Task title:** a concrete outcome, such as “Implement password reset endpoint.”
- **Feature key:** optional shared identity, such as `password-reset-api`. Murmur
  refuses a second active owner of the same feature key.
- **Owner:** choose **Create a manual session** for each independent agent/task.
- **Manual session workspace:** initially use the registered project root.

Be deliberate about Owner: when sessions already exist, the form defaults to an
existing one. Reusing one owner for several independent workspaces can prevent
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
currently manual.** The future MCP/native adapters are intended to remove it.

For example, tell the agent: “Work on this task only in the workspace I opened.
Here is the current Murmur context. Treat other tasks' unmerged implementations
as pending, and flag any contract change for review.” Then supply the briefing.
This is a human handoff, not a guarantee that the model will follow every instruction.

The CLI and dashboard are human-operated. Do not give agents the daemon's human
credential or tell them to approve their own decisions/integrations. Advanced API
clients should use scoped session credentials; see [the protocol](protocol.md).

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

## 10. End or resume a session

Leave the daemon running while coordinating work. Stop it with Ctrl-C in its
terminal, or:

```bash
murmur daemon stop
```

Restart using the same state directory to recover the recorded projects/tasks.
A disconnected agent or expired lease does not remove its files or complete its
task. Do not delete live state or workspaces as a recovery shortcut.

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
| Will Murmur find my existing sessions? | No. Managed launchers register only new Claude/Codex tasks started through Murmur. |
| Why does Adapters say unverified? | Launcher/CLI-bridge implementation is separate from verified native MCP/hooks or model-driven use. |
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
