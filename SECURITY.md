# Security policy

Murmur is an experimental alpha. No security response SLA or production-hardening
claim is made. The [release checklist](docs/release-checklist.md) records unfinished
verification and security work.

## Reporting a vulnerability

Do not put credentials, raw transcripts, private source, state databases, or
exploit details in a public issue.

Use GitHub's private reporting flow:
**[Report a vulnerability](https://github.com/boyeesu/murmur/security/advisories/new)**.
You can also find it under **Security → Report a vulnerability**. Private
vulnerability reporting is enabled for this repository.

If you cannot access that flow, open an issue asking maintainers for a private
reporting channel **without including vulnerability details**.

## Security boundaries

- The service binds to loopback, authenticates callers, and keeps its local state
  private. Managed agent and supervisor capabilities are separate from human authority.
- A process running as the same OS user is **not** isolated from that user's files.
  Reservations coordinate work; they are not operating-system file locks.
- An explicit managed run creates a worktree/branch and starts the selected coding
  tool using its normal account and permissions. Installation does not install
  native hooks, modify native permissions, or start model conversations.
- Only supervision renews managed API access. End/expiry does not remove files or
  complete the task, and cannot guarantee that an orphaned process stops writing.
- Validation commands run with the local user's privileges, not in an OS sandbox.
  Review exactly which executable and arguments are being approved.
- Unknown spawn outcomes are not repeated automatically. Stored PIDs are never
  used to seize or kill unrelated processes. Uncertain source work is retained.

MCP/native hooks, broader lifecycle controls, real model-driven verification,
static type checking, and additional platform validation remain separate release
gates. Please avoid claims of universal conflict prevention or guaranteed isolation.
