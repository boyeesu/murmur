# Capability matrix — 0.3 integration alpha

Implementation, generated configuration, native-host evidence, and model behavior
are separate states. No row below claims universal conflict prevention.

| Application | Managed CLI | MCP configuration | Automatic context configuration | Real model use |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.247 | Implemented; installed contract probe passes | Opt-in launch-local config; native environment forwarding observed | Advisory config implemented; native SessionStart command/context/event observed without a model prompt | Not tested |
| Codex CLI 0.154.0 | Implemented; installed contract probe passes | Opt-in overrides; `env_vars` parser accepted | Hook command supports envelopes; automatic configuration gated on merge/trust verification | Not tested |
| OpenCode v2.0.12 | CLI-only `--standalone` implementation and installed contract probe | Gated: safe V2 launch-local configuration unverified | V2 plugin contracts/configuration remain gated | Not tested |
| Cursor | Not implemented; `agent` CLI absent from current PATH | Gated | CLI/editor parity unverified | Not tested |

The official SDK MCP server is implemented and tested independently with SDK
clients, strict schemas, real fixture-daemon calls, and managed fake-native hosts.
That does not prove each native host accepted its configuration or that a model
used the tools correctly.

`doctor` reports implementation availability and executable discovery. Its global
configured/connected values are unknown when not inspected; it does not infer
connection from a heartbeat. The dashboard's per-launch bridge activity means an
authenticated scoped request occurred, not model comprehension.

## Native probe evidence

- Installed version/help contract probes passed for Claude, Codex, and OpenCode V2.
  They did not start model conversations.
- Codex accepted name-only `env_vars` configuration in a parser-only probe; no global
  configuration was written or other configured server queried.
- In a bounded Claude no-input run, the generated MCP configuration caused the
  native-launched bridge to reach the fixture's authenticated identity endpoint.
  This establishes scoped environment forwarding. Native completed-connection
  status was not emitted within the probe window.
- The final no-input SessionStart probe observed command invocation, valid scoped
  context generation and its native hook event. No model prompt was sent. A prior
  false-negative criterion expected UUIDs that the privacy filter intentionally
  redacts; the corrected criterion checked the fixture title and valid envelope.

OpenCode V2 is not the V1 plugin API. Its private server uses its process environment,
but that alone does not prove configuration isolation or descendant cleanup. No
V1 environment-variable assumptions, native config installation, approval bypass,
or unsafe takeover was used to make a probe pass.

See [MCP](mcp.md), [native configuration](native-integrations.md),
[context hooks](context-hooks.md), [OpenCode](opencode.md), and
[verification](verification.md). Cursor installation, remaining native contracts,
restricted resume and real model trials remain release gates.
