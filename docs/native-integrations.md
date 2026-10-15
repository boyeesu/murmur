# Launch-local native integrations

The official SDK MCP server and advisory context-hook commands are implemented.
Native configuration and actual model behavior are separate verification levels.
Do not read a successful SDK fixture as proof that every native application has
accepted its configuration or that a model follows the injected context.

## Explicit modes

The existing scoped CLI bridge remains the default. A managed Claude/Codex launch
can request MCP with `--bridge mcp`. There is no silent downgrade when that mode
cannot be prepared. Configuration is created in a new private temporary directory,
not in the source worktree or global user settings.

Claude receives `--mcp-config` with references to the managed environment variables.
The configuration contains `${MURMUR_AGENT_MODE}` and
`${MURMUR_AGENT_CONNECTION}`, not their values. A bounded no-input native probe
confirmed that installed Claude 2.1.247 started the bridge with valid forwarded
environment and reached the fixture's scoped identity endpoint. It did not emit
its own completed-connection status before timeout, so full native/model use is
not claimed by that probe.

Codex receives name-only `env_vars` forwarding through launch-local configuration
overrides. Its installed parser accepted those fields. Actual native stdio
forwarding and model use remain separately verifiable.

## Advisory hooks

`--context-hooks` currently enables launch-local Claude context configuration for
SessionStart, UserPromptSubmit, PreToolUse, and PostToolUse. The hook command reads
only scoped context; it cannot approve tools, change native arguments, renew the
managed lifetime, complete tasks, or merge source.

A bounded no-input probe of installed Claude 2.1.247 observed the configured
SessionStart command, valid scoped context generation, and the corresponding
native hook event. No model prompt was sent. Task UUIDs are deliberately redacted
from hook text, so successful generation was checked by the fixture title and
advisory/untrusted-data envelope, not raw IDs. This does not prove UserPromptSubmit
or tool-hook behavior, or model consumption.

The Codex hook command supports the documented envelopes, but automatic Codex
hook configuration is **gated** until installed configuration-merging and trust
behavior is established. Murmur will not risk replacing existing user hooks or
bypass native hash approval. There is no `permissionDecision: allow`, native
permission bypass, or unsupported input rewriting in generated configuration.

PreToolUse context may arrive with a tool result; it does not prove that an
already-selected call was replanned. Context delivery is not model compliance.
The hooks bound their input, runtime and output and omit unchanged tool context
where safe. Prompt/start always refresh. Missing or unsafe cache state does not
cause administrative discovery or hidden permission changes.

## Lifecycle and cleanup

Only the parent retains supervisor authority. The native child/MCP/hook process
receives the scoped agent connection. No credential values are put in argv,
configuration contents, or source files.

After the child exits, Murmur removes unchanged owned static configs only. Changed
files, unknown files, dynamic hook cache/locks, or substituted paths are retained
privately instead of being removed speculatively. Retained cache records contain
hash/cursor metadata, not raw context or credentials. Workspaces and user edits
are never cleaned up as part of this configuration lifecycle.

These controls are not an OS sandbox against other processes running as the same
user. Native application policy and normal trust/approval prompts still apply.

## Existing-chat connector — Codex 0.154.0

Codex has a separate reviewed fixed-hook export through `murmur connect setup
--tool codex --out NEW_DIRECTORY`. A human adds the generated UserPromptSubmit
entry without replacing existing policy hooks, explicitly resumes the original
conversation and reviews native hook trust. Ordinary `murmur-connect` messages
request human-approved participation. After explicit activation, ordinary prompts
refresh bounded advisory context from the existing grant without polling approval,
creating unlinked helper state or renewing authority.

The actual CLI and production export passed isolated native approval/resume,
developer-input context delivery, fresh decision refresh, separate same-cwd owners,
native fork/new-thread isolation and leave tests. This does not verify interactive
hook trust, real model use, desktop/web attachment or hot loading. Codex identity
is parent-conversation scope including subagents. See
[Codex existing-chat setup and evidence](codex-existing-chat.md). The managed Codex
automatic configuration gate remains separate and unchanged.

## Existing-chat connector — Claude 2.1.247 only

The 0.5 connector is separate from managed MCP and advisory hooks. Its enabled path
is an **explicitly loaded plugin plus native resume of the original conversation**,
not a shared-chat MCP server, automatic discovery, or direct attachment to an already-open
CLI. The 0.4 group/API/handoff behavior remains available independently. Codex
has the separate version-scoped flow above; OpenCode, Cursor, and untested Claude
versions remain gated for existing-chat commands.

The production hook receives bounded native `UserPromptSubmit` stdin with the raw
`/murmur:connect` prompt, current UUID, and cwd. It parses a fixed command grammar,
validates the canonical project/workspace, and uses private helper proof bound to
that current native identity. The skill is reporting text, not an executable argument
template: no `$ARGUMENTS` shell substitution, model-selected identity, copied helper
reference, or shared MCP client metadata selects a grant. Unrelated prompts/events
return without descriptor discovery or connection actions. For a recognized command,
any `MURMUR_AGENT_` or `MURMUR_EXTERNAL_` environment marker (even partial/empty)
causes `NATIVE_ALREADY_SCOPED` before discovery: use that process's existing scoped
agent/MCP or external commands, not a second native connection. Do not remove scope
markers to bypass this guard.

The literal actions are `start GROUP TITLE | RESPONSIBILITY`,
`join INVITE_CODE | RESPONSIBILITY`, `status`, `refresh`, `leave`, and `help`, each
following `/murmur:connect`. Join accepts exactly 43 base64url characters. Start/join
request human review; refresh activates approval and retrieves bounded advisory
context. Status may also activate approved access. Leave removes only this connection,
not the task or native process. Later ordinary prompts refresh only an already-active
connection. Claude PreToolUse/PostToolUse context hooks are bounded advisory reads,
with proof-bound deduplication; native post-tool context delivery is not verified.
Unlinked, locally pending, left and expired chats remain inert. No automatic
background intent publication or observed-write attribution is provided.

### Native evidence — 0.5 checkpoint, 2026-10-14

Actual Claude Code 2.1.247 emitted the raw command and current UUID/cwd on the fixed
hook. Ordinary resume retained the UUID; fork created a new UUID; clear emitted reset
and a new UUID. The exported **production** plugin passed start/human approval,
approved-scope resume, two same-cwd chats with distinct owners, disconnected fork/clear,
explicit original resume, and leave with tasks/other grants preserved.

These were **headless native CLI tests**, using native-authored disposable history,
isolated empty HOME/config, a dummy key, and an owned static loopback API responder
with no actual LLM inference. They are not real-user chat trials, interactive trust
acceptance, model-obedience evidence, or hot reload. The new-UUID clear behavior is
specific to 2.1.247; no same-ID clear guarantee is generalized to another version.

### Historical 0.4 evidence — 2026-10-14

Before the 0.5 checkpoint, a bare, headless, preloaded plugin expanded
`${CLAUDE_SESSION_ID}` and literal arguments into requests to a rejecting local mock.
No authorized helper action or native lifecycle was established. The additional
full-mode containment preflight was denied before its native child started, so
production native gates remained false then. That failure is not rewritten as success.
The later explicitly selected `--lifecycle` mode runs in the existing outer environment
with isolated config and dummy local transport. It **does not establish an additional
OS sandbox or prove absence of Keychain access**. Full details remain in
[the dated verification record](verification-existing-chats.md).

### Setup export is not installation

From a **human terminal in the original project**, ensure the daemon is running and
the project is registered. Read `murmur connect --help`, then export:

```bash
murmur connect setup --tool claude --out /absolute/new/plugin-dir
```

Setup checks the actual executable/version (2.1.247 only), canonical public
`connection.json`, and private helper-state directories outside the workspace. It
exports a functional three-file plugin layout to a new absolute directory under an
existing canonical parent: `.claude-plugin/plugin.json`, `skills/connect/SKILL.md`,
and `hooks/hooks.json`. These are reviewable executable integration assets, not inert
placeholders; explicit loading and human enrollment approval remain separate steps.
Native configuration locations are refused,
as are existing output targets. It does not edit settings, install globally, alter
trust/permissions, authenticate, or connect a chat; package installation does not
install native configuration either. Do not add `--force` or edit native configs to
work around a refusal.

**Pause/exit the original CLI before reopening it**, to avoid duplicate writers.
Review the files and run the returned `resumeCommand` in the original project. It
uses the resolved absolute Claude executable, `--plugin-dir` with the exported bundle,
and `--resume` for the native conversation picker. Choose the original conversation;
its history remains native, with no Murmur scan/import. Pass **`--plugin-dir` again
on each resume**. Then use `/murmur:connect`, human dashboard approval/review, and
explicit refresh. Direct already-open installation/reload is still unverified.
See the [complete same-chat walkthrough](session-linking.md#connect-an-existing-claude-conversation)
for exact terminal and chat commands.

### Keep external and human authority separate

A native helper may use only the public `connection.json` descriptor; it must not
read `daemon.json`, invoke human discovery or dashboard login, or receive a browser
bootstrap ticket. Public request references are inert. The explicit environment-scoped
external API client accepts its immutable private connection, not a model-supplied
project/session/task selector. Partial or invalid scoped configuration fails closed
rather than falling back to human credentials or another connection.

Human approval verifies the exact project/workspace binding and reviewed handoff.
Reported native tool/chat/incarnation fields remain metadata, **not authentication**.
External grants are fixed-lifetime, own-task authority; contact never extends them.
Lost, expired, or revoked authority requires fresh approval. Eligible same-task reconnect
is a separate explicit human choice with a new grant, not native-ID credential recovery.

Membership does not move the current workspace. Shared-checkout warnings and
reservations are advisory, not OS isolation. Leave, expiry, or revocation preserves
work and does not stop the native chat. For unsupported hosts, use a manual group or
reviewed replacement handoff for a separately launched **new** managed task. Keep
reported already-changed files and the remaining-work checklist separate from intended
writes; these reports are not filesystem proof. No native history, source files, original ownership, or process lifetime is imported or taken over.
See [groups and approved connections](session-linking.md).
