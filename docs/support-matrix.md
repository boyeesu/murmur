# Agent capability matrix — 0.2 launch increment

Capabilities are intentionally separate: an implemented launcher, an installed
CLI contract, an authenticated bridge call, and verified model behavior are not
the same thing.

| Application | Managed CLI launcher | Installed version/help probe | Real model-driven use | MCP/native hooks |
| --- | --- | --- | --- | --- |
| Claude Code | Implemented | Passed locally (2.1.247) | Not run/verified | Not implemented |
| Codex CLI | Implemented | Passed locally (0.154.0) | Not run/verified | Not implemented |
| Cursor | Not implemented | No managed launch probe | Not run/verified | Not implemented |
| OpenCode | Not implemented | Earlier version probe blocked on external log access | Not run/verified | Not implemented |

`murmur run claude` and `murmur run codex` opt into new-task/worktree setup,
startup context, and the scoped CLI bridge. They do not discover or take over
already running sessions. Normal native authentication and permissions remain
in effect. Current request IDs for `run` are UUIDs.

`doctor` still treats binary detection as availability only. Its `implementation`
fields identify the launch/CLI-bridge code; its native `capabilities`, configured,
connected, and verified flags are not promoted from a heartbeat or mere spawn.
Per-launch status records supervised state and whether an authenticated bridge
request was actually observed. None proves that a model understood the briefing.

The full automated suite, including two fake native executables using the actual
CLI, daemon, scoped commands, and Git workspaces, passes. The real installed
Claude/Codex preflight called only --version and --help, with no conversation or
model API use. A Codex configuration-parser probe also accepted a stdio MCP
configuration; no MCP server was started and no configuration was saved.

The official MCP SDK and native hook work remain blocked on approved dependency
and documentation access. No alternative-host or permission-bypass workaround
was used. See [managed launches](managed-launch.md), [the scoped bridge](agent-bridge.md),
and [verification](verification.md) for exact limits.
