<div align="center">

<h1>Murmur</h1>

<p><strong>Parallel coding tasks. Shared context. Reviewed integration.</strong></p>

<p>A local-first workspace for coordinating coding agents across isolated Git worktrees.</p>

<p>
  <a href="https://github.com/boyeesu/murmur/actions/workflows/ci.yml"><img src="https://github.com/boyeesu/murmur/actions/workflows/ci.yml/badge.svg?branch=main" alt="Runtime checks"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24 or later"></a>
  <a href="https://github.com/boyeesu/murmur/blob/main/CHANGELOG.md"><img src="https://img.shields.io/badge/status-0.2.0%20alpha-orange" alt="Status: 0.2.0 alpha"></a>
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
**Claude Code** and **Codex**.

> **Alpha:** managed launches automate setup and initial context. Later updates
> depend on agents invoking Murmur's scoped commands. MCP, native hooks, and
> managed Cursor/OpenCode launchers are on the [roadmap](#roadmap).

## Why Murmur?

Parallel agents can work in separate branches and still duplicate an API, disagree
on a contract, or build against an outdated decision. Murmur gives those tasks a
shared place to declare intent and surface coordination problems before integration.

- **One task, one workspace.** Create or adopt Git worktrees for independent work.
- **Shared intent and decisions.** Record expected reads, writes, contracts, and
  dependencies; explicitly review and accept shared decisions.
- **Evidence-backed alerts.** See duplicate producers, conflicting declared values,
  stale consumers, and overlapping paths.
- **Managed agent launches.** Start fresh Claude Code or Codex tasks with workspace
  preparation, startup context, and scoped coordination commands.
- **Reviewable Git integration.** Submit immutable commits, inspect candidates,
  run trusted checks, and approve an integration branch before bringing it into yours.
- **Local-first by default.** A local service, SQLite state, and a browser dashboard.
  Murmur requires no cloud account, telemetry, model API key, or external runtime packages.

## How it works

```text
Register a project → Create tasks + workspaces → Work in parallel
                                                     ↓
                                   Share decisions + review alerts
                                                     ↓
Your working branch ← Approved integration ← Submit + validate commits
```

The dashboard brings together **Tasks**, **Alerts**, **Decisions**, **Workspaces**,
**Integration**, and **Adapters**. Murmur observes Git changes every 10 seconds;
reservations are advisory and do not replace separate workspaces or code review.

## Quick start

### Requirements

- **Node.js 24+** and **Git**.
- A local Git project with **at least one commit** for workspace isolation and
  integration. Ordinary folders support coordination records only.
- For managed launches, an installed and authenticated **Claude Code** or **Codex** CLI.

The recorded local verification environment is macOS with Node 26.4.0 and
Git 2.54.0. The [runtime workflow](https://github.com/boyeesu/murmur/actions/workflows/ci.yml)
targets Node 24 and 26 on macOS and Linux; see the
[verification record](docs/verification.md) for the scope of testing.

### 1. Clone and build

```bash
git clone https://github.com/boyeesu/murmur.git
cd murmur
npm ci --ignore-scripts --offline
npm run build
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

These launches start new sessions. Context refresh is cooperative, through the
agent's scoped CLI commands. See [managed launches](docs/managed-launch.md) for
lifecycle behavior and [the agent bridge](docs/agent-bridge.md) for available commands.

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

### Tool support

| Tool | Managed launch | Manual workspace workflow |
| --- | --- | --- |
| Claude Code | Alpha | Available |
| Codex | Alpha | Available |
| Cursor | Planned | Available |
| OpenCode | Planned | Available |
| Other folder-capable tools | — | Available |

Managed launch tests exercise simulated native processes and real Murmur services.
Real model-driven acceptance, automatic session discovery, MCP transport, and native
per-turn hooks are not verified capabilities. See the [support matrix](docs/support-matrix.md).

## Documentation

| Guide | What you'll find |
| --- | --- |
| [User guide](docs/user-guide.md) | Installation, first run, and the daily workflow |
| [Managed launches](docs/managed-launch.md) | Claude Code/Codex setup and lifecycle |
| [Agent bridge](docs/agent-bridge.md) | Scoped agent commands and credentials |
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
Validation commands run with your local-user privileges. Human credentials and
managed agent credentials have separate authority; see [SECURITY.md](https://github.com/boyeesu/murmur/blob/main/SECURITY.md).
If upgrading from 0.1, stop the old daemon and back up its complete state directory
privately before starting 0.2; older binaries cannot read database schema 2.

## Roadmap

- [x] Local task board, shared decisions, and coordination alerts.
- [x] Git worktrees, immutable submissions, validation, and reviewed integration.
- [x] Opt-in Claude Code/Codex launchers with scoped agent commands.
- [ ] Real model-driven, multi-tool acceptance testing.
- [ ] Official MCP transport and verified native hooks.
- [ ] Managed Cursor and OpenCode launchers.
- [ ] Static TypeScript checking and broader compatibility verification.
- [ ] Published versioned packages and smoother first-run onboarding.

See the [release checklist](docs/release-checklist.md) for detailed completion gates.
Suggestions and focused proposals are welcome in [Issues](https://github.com/boyeesu/murmur/issues).

## Contributing

Contributions are welcome: report reproducible bugs, improve the docs, or help
build the next integration. Read [CONTRIBUTING.md](https://github.com/boyeesu/murmur/blob/main/CONTRIBUTING.md) before opening a PR.

```bash
npm ci --ignore-scripts --offline
npm test
```

The test suite uses disposable repositories, local HTTP clients, temporary state,
and simulated agent processes. The bootstrap build strips TypeScript types;
static type checking remains a separate release gate.

For vulnerability reports, use the private reporting process in [SECURITY.md](https://github.com/boyeesu/murmur/blob/main/SECURITY.md).

## License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for details.

<div align="center">
  <sub>Built for developers working on more than one thing at a time.</sub>
</div>
