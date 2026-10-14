# OpenCode V2 managed launches: CLI-only fallback

```sh
murmur run opencode --project PROJECT_ID --title "Implement the task" --bridge cli
```

`--bridge cli` is the default. This creates a **new task and daemon-managed
workspace**; it does not resume or take over an existing OpenCode session. The
fallback adds no runtime dependencies and uses Murmur's existing scoped agent CLI,
not an OpenCode MCP server or plugin. Cursor remains unsupported.

## Native contract

Murmur first runs bounded `opencode --version` and `opencode --help` probes with
inherited Murmur authority removed. It requires a reported V2 version and root
help advertising `--standalone`, `--prompt`, and the optional `[<directory>]`
argument. OpenCode V1 and unrecognized contracts fail before task preparation.
The installed CLI inspected for this integration reported **v2.0.12**; its root
help advertised this contract. A future V2 CLI must still pass these checks.

The child runs with the managed workspace as its explicit working directory and
this argument vector (not a shell command):

```text
opencode --standalone --prompt <integration instructions + bounded startup data> <managed workspace>
```

V2's ordinary background service is unsuitable because Murmur cannot assume it
inherits the launch-specific environment. `--standalone` requests the documented
private server using its own process environment. It is not a sandbox, a native
identity handshake, or proof that every descendant receives or drops an environment
variable as expected.

The initial prompt includes trusted launcher integration text followed by explicitly
marked, untrusted task/briefing data capped at 12 KiB. OpenCode receives both in the
single documented `--prompt` argument; this is not a separate native system-prompt
channel or a guarantee that a model obeys the trust boundary. Instructions direct
the agent to refresh context through the scoped CLI before substantial work.

Only the scoped `MURMUR_AGENT_MODE` and `MURMUR_AGENT_CONNECTION` variables are
passed as Murmur authority. Human/admin and supervisor credentials are not passed
to the child. Ordinary native authentication and user environment are retained;
the fallback does not authorize inspecting state files or bypassing permissions.
Murmur's prompt does not contain the scoped credential. There is no arbitrary
native option passthrough, `--auto`, external `--server`, resume/session-ID flag,
permission modification, or automatic commit/approval/merge.

## Unsupported modes fail closed

For OpenCode, **`--bridge mcp` and `--context-hooks` are rejected before native
preflight or HTTP launch preparation**. Fully isolated OpenCode V2 MCP and hook
configuration is unverified. V1 plugin/configuration assumptions are not reused.
Murmur does not edit global or project OpenCode configuration or silently fall back
from a requested MCP mode. This does not prevent OpenCode from applying the user's
own pre-existing configuration; configuration isolation is not claimed.

## Identity, supervision, and preserved work

OpenCode native identity remains `nativeSessionId: null` and
`nativeIdentitySource: "unverified"`. The base coordination session uses the
synthetic `launch:<launch-id>` identifier, just like Codex; this is not an OpenCode
session ID and cannot be used to resume it.

The existing Murmur supervisor owns the directly spawned CLI child, claims the
launch, reports startup/exit, and maintains liveness. Child exit revokes the scoped
agent authority and ends the launch without completing the task or deleting its
workspace. The source checkout and task remain available for human inspection.
Private-server/descendant cleanup, real-model behavior, and native environment
propagation inside OpenCode have **not** been verified by the fake-CLI tests.

## Stored launch schema

LaunchService's separate `murmur_launch_schema` advances from version 1 to version
2; the base store's `PRAGMA user_version` stays at 2. The transactional migration
widens only the launch tool CHECK to `claude`, `codex`, and `opencode`. It copies all
persisted launch columns and rowids, retains indexes and uniqueness, and does not
mint, restore, or repopulate credentials. Existing base session/task/mutation data
is untouched by migration. Normal constructor recovery and deadline expiry still
apply afterward; migration does not revive a claimed or expired launch.

Unknown table columns/constraints, missing or changed required indexes, launch-table
triggers, and inbound foreign-key extensions are refused rather than silently
rewritten. Migration errors roll back the entire change. Newer launch-schema
versions are rejected. Preserve the database and use a compatible Murmur version
or an explicit extension-aware migration if this validation fails.

## Verification scope

`tests/opencode-launch.test.mjs` covers fake V2 version/help preflight, unsupported
versions/flags, argument/environment/cwd capture, bounded context, early MCP/hooks
refusal, populated v1 migration preservation and rollback, reopen/newer-version
handling, and a disposable real daemon with a **fake** OpenCode CLI invoking the
existing agent CLI. It does not start a real OpenCode model conversation, install
plugins, modify native configuration, or test paid model behavior.
