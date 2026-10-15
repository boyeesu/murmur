<div align="center">

<h1>Murmur</h1>

<p><strong>Parallel coding tasks. Shared context. Reviewed integration.</strong></p>

<p>A local-first workspace for coordinating coding agents across isolated Git worktrees.</p>

<p>
  <a href="https://github.com/boyeesu/murmur/actions/workflows/ci.yml"><img src="https://github.com/boyeesu/murmur/actions/workflows/ci.yml/badge.svg?branch=main" alt="Checks"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24 or later"></a>
  <a href="https://github.com/boyeesu/murmur/blob/main/CHANGELOG.md"><img src="https://img.shields.io/badge/status-0.6.0--alpha.1%20unreleased-orange" alt="Status: 0.6.0-alpha.1 unreleased"></a>
</p>

<p>
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="docs/user-guide.md"><strong>Documentation</strong></a> ·
  <a href="https://github.com/boyeesu/murmur/issues/new?template=bug_report.yml">Report a bug</a> ·
  <a href="https://github.com/boyeesu/murmur/issues/new?template=feature_request.yml">Request a feature</a>
</p>

</div>

---

Murmur helps you assign independent tasks, share decisions, spot overlapping
changes, and integrate reviewed commits while keeping your original checkout intact.
Use its local dashboard and CLI to coordinate work, with opt-in launchers for
**Claude Code**, **Codex**, and the CLI-only **OpenCode V2** fallback.

> **0.6 development alpha, not a published release:** human-reviewed groups,
> scoped MCP, automatic approved-session context, installation lifecycle, and state
> maintenance are implemented. **Claude Code 2.1.247** and **Codex CLI 0.154.0** have
> version-scoped existing-chat flows requiring explicit native activation and human
> approval. Native fixture evidence is not real-model acceptance. The historical
> Codex fixture bypassed hook trust and pretrusted its disposable project; normal
> interactive activation remains unverified. Direct hot attachment, structured
> existing-chat publication, OpenCode/Cursor attachment and the full four-tool
> release remain gated. Managed launchers are separate modes.
> See the [support matrix](docs/support-matrix.md) and [roadmap](#roadmap).

## Why Murmur?

Parallel agents can work in separate branches and still duplicate an API, disagree
on a contract, or build against an outdated decision. Murmur gives those tasks a
shared place to declare intent and surface coordination problems before integration.

- **One task, one workspace.** Create or adopt Git worktrees for independent work.
- **Project-focused groups.** Link separate responsibilities without merging chats,
  taking task ownership, or moving an existing workspace. Human approval controls
  scoped access; [native existing-chat command gates](docs/session-linking.md) stay explicit.
- **Shared intent and decisions.** Record expected reads, writes, contracts, and
  dependencies; explicitly review and accept shared decisions.
- **Evidence-backed alerts.** See duplicate producers, conflicting declared values,
  stale consumers, and overlapping paths.
- **Managed agent launches.** Start fresh Claude Code, Codex, or OpenCode V2 tasks with workspace
  preparation, startup context, and scoped coordination commands.
- **Reviewable Git integration.** Submit immutable commits, inspect candidates,
  run trusted checks, and approve an integration branch before bringing it into yours.
- **Local-first by default.** A local service, SQLite state, and a browser dashboard.
  The coordinator requires no model account or telemetry. Source builds use pinned
  SDK/schema dependencies; launched coding tools use their normal providers and billing.

## How it works

```text
Register a project → Create tasks + workspaces → Work in parallel
                                                     ↓
                                   Share decisions + review alerts
                                                     ↓
Your working branch ← Approved integration ← Submit + validate commits
```

The dashboard brings together **Tasks**, **Alerts**, **Decisions**, **Workspaces**,
**Integration**, **Connections**, **Operations**, and **Adapters**. Murmur observes Git changes every 10 seconds;
reservations are advisory and do not replace separate workspaces or code review.

## Quick start

### Requirements

- **Node.js 24+** and **Git**.
- A local Git project with **at least one commit** for workspace isolation and
  integration. Ordinary folders support coordination records only.
- For managed launches, an installed and authenticated **Claude Code**, **Codex**,
  or **OpenCode V2** CLI. OpenCode uses a private standalone server and CLI bridge.

The recorded local verification environment is macOS with Node 26.4.0 and
Git 2.54.0. The [runtime workflow](https://github.com/boyeesu/murmur/actions/workflows/ci.yml)
targets Node 24 and 26 on macOS and Linux; see the
[verification record](docs/verification.md) for the scope of testing.

### 1. Clone and build

```bash
git clone https://github.com/boyeesu/murmur.git
```

```bash
cd murmur
```

```bash
npm ci --ignore-scripts
```

```bash
npm run check
```

Installation is from source. An npm release has not been published; `npx murmur`
and `npm install -g murmur` are not installation commands for this project.
For a supplied local `.tgz` artifact, see the
[local-package instructions](docs/user-guide.md#install-from-the-local-package).

### 2. Start the service

In terminal 1, from the Murmur folder:

```bash
npm run murmur -- daemon start
```

Leave it running. In terminal 2, from the same folder:

```bash
npm run murmur -- dashboard
```

Open the printed URL within **one minute**. Select **Register project** and enter
the path to the project you want to coordinate. The browser session lasts 30 minutes;
after a reload or expiry, run the dashboard command again for a fresh URL.

### 3. Start parallel tasks

In a new terminal, from the Murmur folder:

```bash
npm run murmur -- run claude --project PROJECT_ID --title "Implement password reset"
```

In another terminal, start an independent task:

```bash
npm run murmur -- run codex --project PROJECT_ID --title "Build account settings"
```

Replace `PROJECT_ID` with the ID shown in the dashboard or returned by `init`.
Each command creates a new task and isolated worktree, then launches the selected
tool using its normal account and permissions. Keep the tool's terminal open.

These launches start new sessions; the scoped CLI bridge remains the default.
To opt into the official MCP tools and Claude advisory context hooks:

```bash
npm run murmur -- run claude --project PROJECT_ID --title "Implement password reset" --bridge mcp --context-hooks
```

For Codex, use `--bridge mcp` without `--context-hooks`. Automatic Codex hook
configuration is gated until installed merge/trust behavior is established.
OpenCode V2 currently supports `--bridge cli` only and uses `--standalone`.

Native policy still applies. Hook generation is not proof of model compliance,
and PreToolUse feedback does not guarantee replanning an already-selected call.
See [native integration limits](docs/native-integrations.md),
[managed launches](docs/managed-launch.md), and [MCP tools](docs/mcp.md).

To produce a local archive with its verified runtime dependency closure:

```bash
npm run pack
```

To stop the service, press Ctrl-C in terminal 1 or run:

```bash
npm run murmur -- daemon stop
```

## Use your existing workflow

The manual dashboard/CLI workflow supports any coding tool that can open a local folder:

1. Register your project and create a task with a manual owner record.
2. Declare expected changes, contracts, and dependencies.
3. Create or adopt a separate workspace and open that folder in your coding tool.
4. Copy the task briefing into the agent's conversation; refresh it as decisions change.
5. Commit work, submit it, and validate an integration candidate.
6. Review and approve the integration branch, then bring it into your working branch.

Attaching a workspace updates Murmur's records; it does not move an already running
agent. The [user guide](docs/user-guide.md) walks through the full workflow,
including a small example that triggers an overlap alert.

### Group existing work without taking over a chat

In **Connections**, create a project group and add an existing manual or active
managed task owner. Review each responsibility and shared handoff. Manual membership
is bookkeeping, not native attachment; managed membership keeps its existing task
and lifetime.

Human-reviewed external grants are bound to one task and current workspace, expire
in 8 hours by default (24 hours maximum), and never renew from activity. Invitations
are hashed, single-use approval requests—not access credentials. Fresh reconnect is
an explicit, reviewed choice for the same eligible session and still-owned task.
Leaving or expiring access neither finishes the task nor stops the native chat.

### Connect the original Claude conversation

For **Claude Code 2.1.247 only**, use a human terminal in the original project. Ensure
the daemon is running and the project is registered, then export a new plugin directory:

```bash
murmur connect setup --tool claude --out /absolute/new/plugin-dir
```

Setup checks the actual executable/version, public `connection.json`, and private
helper state; it does not install native configuration or connect a chat. For source-only
use, see the [absolute-CLI instructions](docs/session-linking.md#connect-an-existing-claude-conversation).
**Pause/exit the original CLI first** to avoid duplicate writers, then run the returned
absolute `resumeCommand` in the original project and select the original conversation.
It loads the bundle with `--plugin-dir` and opens Claude's `--resume` picker. Pass
`--plugin-dir` again on later resumes. Native history is preserved by Claude, not
scanned or imported into Murmur.

In the resumed conversation, use `/murmur:connect start GROUP TITLE | RESPONSIBILITY`
or `/murmur:connect join INVITE_CODE | RESPONSIBILITY` (a 43-character base64url code).
Review and approve the exact request and shared handoff in the authenticated Murmur UI,
then run `/murmur:connect refresh`. `status`, `leave`, and `help` are also supported.
Explicit refresh activates the approved connection. Subsequent ordinary prompts refresh
already-active context without enrollment, approval polling or grant renewal. Tool-boundary
advisory hooks are implemented but native post-tool delivery remains unverified.
There is no automatic intent publication or proof of model obedience.
Processes already carrying a managed/external Murmur scope must use their existing
scoped commands; the hook refuses to create a second connection. There is no universal
`/murmur` / `@murmur` alias.

**0.5 native checkpoint (2026-10-14):** the exported production plugin passed
headless start/approval, resumed scope, separate owners for two same-cwd chats,
disconnected fork/clear, explicit original resume, and own-grant leave with tasks
preserved. Tests used native-authored disposable history, empty HOME/config, a dummy
key, and an owned static loopback API responder with **no actual LLM inference**.
This is not a real-user chat/model trial or direct hot-attachment/reload verification.
The earlier denied nested OS sandbox remains historical evidence; the later runs do
not prove stronger OS isolation or absence of Keychain access.

### Connect the original Codex conversation

For **Codex CLI 0.154.0**, export reviewed hook setup from a human terminal:

```bash
murmur connect setup --tool codex --out /absolute/new/codex-export
```

Follow the exported `SETUP.md`: preserve existing hooks when adding the fixed
`UserPromptSubmit` entry, pause/exit the original process, resume its original
conversation, and review native hook trust using `/hooks`. Setup does not install
or connect anything automatically. In that chat, enter ordinary messages such as
`murmur-connect start GROUP TITLE | RESPONSIBILITY` or
`murmur-connect join INVITE_CODE | RESPONSIBILITY`. After human approval, enter
`murmur-connect refresh` to activate the connection. Later ordinary prompts fetch
fresh scoped context automatically. `status`, `leave`, and `help` are also available.

The actual CLI and generated hook passed isolated start/approval, exact-thread
resume, fresh decision delivery into developer-role input, independent same-cwd
chats, real fork isolation, and leave checks against an owned static responder.
No real model inference occurred. Interactive hook trust, desktop/web attachment,
and hot loading into an already-open process remain unverified. See the
[Codex existing-chat guide](docs/codex-existing-chat.md).

OpenCode, Cursor, and untested native versions remain gated. Use manual groups or export a reviewed handoff for
a separately launched **new** managed task instead. Handoffs retain reported files
already changed and a separate remaining-work checklist; neither is filesystem proof
or automatic completion. See [groups and approved connections](docs/session-linking.md)
and [the dated native evidence](docs/verification-existing-chats.md).

### Tool support

| Tool | Managed launch | MCP / native context |
| --- | --- | --- |
| Claude Code | Alpha | Opt-in managed MCP/hooks; 2.1.247-only existing-chat plugin + resume connector; real-model use unverified |
| Codex | Alpha | Opt-in managed MCP; 0.154.0 existing-chat reviewed hooks + resume with automatic context refresh; managed automatic hook configuration remains gated |
| OpenCode V2 | CLI-only alpha, private standalone server | MCP/plugin configuration gated |
| Cursor | Not implemented; CLI unavailable in current verification environment | Gated |
| Other folder-capable tools | Manual workspace workflow | Not integrated |

Managed launch tests exercise simulated native processes and real Murmur services.
Official SDK roundtrips and generated hook contracts are tested. Real model-driven
acceptance, arbitrary existing-session discovery, and universal native/per-turn
behavior are not verified capabilities. See the [support matrix](docs/support-matrix.md).

## Documentation

| Guide | What you'll find |
| --- | --- |
| [User guide](docs/user-guide.md) | Installation, first run, and the daily workflow |
| [Operations](docs/operations.md) | Reviewed integration install, update, removal, rollback, and recovery |
| [Data lifecycle](docs/data-lifecycle.md) | Credentials, retention, consistent private backup, and offline restore |
| [Groups and session connections](docs/session-linking.md) | Manual groups, human review, fixed-scope grants, reconnect, and replacement handoffs |
| [Codex existing chats](docs/codex-existing-chat.md) | Reviewed hook setup, same-thread resume and automatic context refresh |
| [Managed launches](docs/managed-launch.md) | Claude Code/Codex setup and lifecycle |
| [Agent bridge](docs/agent-bridge.md) | Scoped agent commands and credentials |
| [MCP](docs/mcp.md) | Official SDK server, tools and transport limits |
| [Native configuration](docs/native-integrations.md) | Launch-local configuration and verification gates |
| [Context hooks](docs/context-hooks.md) | Advisory refresh behavior and privacy |
| [OpenCode V2](docs/opencode.md) | Standalone CLI fallback and current limitations |
| [Coordination](docs/coordination.md) | Intent, decisions, dependencies, and task lifecycle |
| [Workspaces and integration](docs/workflow.md) | Git isolation, validation, and promotion |
| [HTTP protocol](docs/protocol.md) | Local service API |
| [Verification](docs/verification.md) | Tested behavior and remaining limitations |
| [Changelog](https://github.com/boyeesu/murmur/blob/main/CHANGELOG.md) | Changes by version |

### Local state

State lives in `~/Library/Application Support/Murmur` on macOS, or
`$XDG_STATE_HOME/murmur` / `~/.local/state/murmur` on Linux. `MURMUR_HOME` can select
a dedicated private directory outside the source repository; use the same value
in every terminal.

Murmur retains source work rather than auto-stashing or auto-committing it.
Validation commands run with your local-user privileges. Human, managed-agent,
and external-grant credentials have separate authority; see [SECURITY.md](https://github.com/boyeesu/murmur/blob/main/SECURITY.md).
Before upgrading an older build, stop its daemon and privately back up its complete
state directory. This increment advances SQLite compatibility to **v4**; older
binaries must refuse that database. The new maintenance command makes consistent
private database backups, but those do not include source workspaces or the installer
registry. Restore is offline, into a new private directory only, and invalidates
copied credentials. See [data lifecycle](docs/data-lifecycle.md). No downgrade,
source cleanup, or destructive repair is automatic.

## Roadmap

- [x] Local task board, shared decisions, and coordination alerts.
- [x] Git worktrees, immutable submissions, validation, and reviewed integration.
- [x] Opt-in Claude Code/Codex/OpenCode V2 CLI launchers with scoped agent commands.
- [x] Official SDK MCP transport, strict schemas and scoped authorization.
- [x] Advisory context-hook commands and launch-local Claude configuration.
- [x] Project groups, human-reviewed scoped grants, and reviewed handoff exports.
- [x] Version-scoped Claude and Codex existing-chat flows with separate native evidence limits.
- [x] Automatic context refresh for explicitly activated, human-approved participants.
- [x] Reviewed integration lifecycle, credential management, retention, and private backup/restore.
- [ ] Direct hot attachment/reload, cross-host existing-chat contracts, and automatic background publication.
- [x] Strict TypeScript checking and dependency-complete local package tests.
- [ ] Real model-driven, multi-tool acceptance testing.
- [ ] Remaining native-host hook/MCP configuration verification.
- [ ] Managed Cursor launcher and OpenCode MCP/plugin integration.
- [ ] Restricted managed resume and broader platform verification.
- [ ] Published versioned packages and smoother first-run onboarding.

See the [release checklist](docs/release-checklist.md) for detailed completion gates.
Suggestions and focused proposals are welcome in [Issues](https://github.com/boyeesu/murmur/issues).

## Contributing

Contributions are welcome: report reproducible bugs, improve the docs, or help
build the next integration. Read [CONTRIBUTING.md](https://github.com/boyeesu/murmur/blob/main/CONTRIBUTING.md) before opening a PR.

```bash
npm ci --ignore-scripts
```

```bash
npm run check
```

The test suite uses disposable repositories, local HTTP clients, temporary state,
and simulated agent processes. `npm run check` requires strict TypeScript checking
and runtime tests. The build step alone still strips types; it is not a type checker.

For vulnerability reports, use the private reporting process in [SECURITY.md](https://github.com/boyeesu/murmur/blob/main/SECURITY.md).

## License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for details.

<div align="center">
  <sub>Built for developers working on more than one thing at a time.</sub>
</div>
