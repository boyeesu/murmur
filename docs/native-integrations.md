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
