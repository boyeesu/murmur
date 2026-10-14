# Capability matrix — 0.5 development alpha

Implementation, generated configuration, native-host evidence, and model behavior
are separate states. The enabled same-chat connector is **Claude Code 2.1.247 only**,
using explicit plugin loading and native resume. No row claims all four native hosts
are enabled, universal conflict prevention, direct hot attachment, or native-process
control from a group connection.

## Group and connection support

| Surface | Implemented behavior | Boundary |
| --- | --- | --- |
| Connections dashboard / human API | Project groups; add existing manual/active-managed owners; review/approve/reject; hash-only invitations; grant inspection/revocation; reviewed export | Human authentication required. Each task keeps its owner and current workspace. |
| Managed group requests | `agent group-request` / `group-leave`, or `murmur_request_group_link` / `murmur_leave_group` on the managed MCP bridge | No new external credential, ownership takeover, or lifetime extension. |
| External enrollment and scoped API | Human-reviewed fixed task/session/membership/workspace grants; explicit eligible same-task reconnect | API availability alone does not verify a native action channel. Native IDs are reported metadata, not authentication. |
| Environment-scoped external client | Explicit immutable connection; own-task operations; no human discovery or binding selectors | Missing/partial/expired authority fails closed. Not a generic native adapter. |
| Claude setup export | Actual executable/version preflight; public descriptor and private helper-state checks; reviewable plugin and explicit resume command | Export is not installation or enrollment; new directory only, no native settings edits. |
| Reviewed replacement handoff | Editable bounded coordination export, reported already-changed paths, and remaining-work checklist for a separately launched new managed task | No chat history/credential/file import; no original-chat stop, native resume, or automatic task disposition. |

External access defaults to 8 hours and is capped at 24 hours; contact/refresh cannot
renew it. Approved-but-unused, recently contacted, expired, and revoked are different
states. A successful bridge request is not a native heartbeat or model acknowledgement.
Manual membership is bookkeeping; managed members keep their separate supervised
lifetime. Shared workspaces and reservations remain advisory, not isolated.

## Managed native launch support

| Application | Managed CLI | MCP configuration | Automatic context configuration | Real model use |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.247 | Implemented; installed contract probe passes | Opt-in launch-local config; native environment forwarding observed | Advisory config implemented; native SessionStart command/context/event observed without a model prompt | Not tested |
| Codex CLI 0.154.0 | Implemented; installed contract probe passes | Opt-in overrides; `env_vars` parser accepted | Hook command supports envelopes; automatic configuration gated on merge/trust verification | Not tested |
| OpenCode v2.0.12 | CLI-only `--standalone` implementation and installed contract probe | Gated: safe V2 launch-local configuration unverified | V2 plugin contracts/configuration remain gated | Not tested |
| Cursor | Not implemented; `agent` CLI absent from current PATH | Gated | CLI/editor parity unverified | Not tested |

The official SDK MCP server is implemented independently of each host, with SDK
clients, strict schemas, fixture-daemon calls, and managed fake-native hosts. That
does not prove a native host accepted its configuration or a model used it correctly.
`doctor` distinguishes implementation/executable availability from verified behavior;
uninspected configured/connected values must not be inferred from other signals.
The Claude same-chat connector below is a fixed native hook, **not shared-chat MCP**.

## Existing-chat native support — 0.5 checkpoint, 2026-10-14

| Application / flow | Evidence | Production existing-chat status |
| --- | --- | --- |
| Claude Code 2.1.247, explicit `--plugin-dir` and native resume | Exported production plugin exercised with native-authored disposable history and real fixture daemon | **Enabled for this version and flow only** |
| Current-action identity and command | Fixed `UserPromptSubmit` hook receives raw namespaced prompt, current UUID, and cwd; no free-form shell expansion or model-selected identity | Enabled hook entrypoint; private proof remains separate from native metadata |
| Start/join → human approval → refresh | Production plugin submits requests; authenticated human review approves; refresh activates scoped access and supplies context | Verified headless fixture flow; no real-user/model trial |
| Two same-cwd native chats | Separate approved Murmur sessions/tasks/owners and shared group context | Neither owns the other's task/grant |
| Ordinary native resume | Retains UUID and approved scope; explicit original resume still works after fork/clear | Pass `--plugin-dir` again; pause/exit the original CLI first |
| Native fork and clear | Fork creates a new UUID; clear emits reset and a new UUID; production `status` reports disconnected for both | No inherited parent grant; own new request/approval required |
| Membership leave | Only the caller's grant is revoked; tasks and the other chat's grant remain | Does not complete tasks or stop native chats |
| Direct hot attachment/reload in an already-open chat | Not verified; loading before resume is a different flow | **Unverified** |
| Codex, OpenCode, Cursor; other Claude versions | No complete verified existing-chat action/lifecycle contract | **Gated** |
| Generic/shared-chat MCP attachment or automatic background publication | Not implemented as the existing-chat connector | **Gated / not claimed** |
| Process already carrying `MURMUR_AGENT_` / `MURMUR_EXTERNAL_` environment markers | Hook rejects with `NATIVE_ALREADY_SCOPED` before discovery, even for partial/empty markers | Use the existing scoped commands; no second connection or scope-marker bypass. |

The command is `/murmur:connect`, not an unconditional `/murmur` or `@murmur` alias.
Refresh is explicit and command-driven, not automatic background synchronization,
intent publication, or proof the model obeyed context. Native conversation history
stays with Claude; Murmur does not scan or import it. IDs/cwd alone are not credentials.
The observed new-UUID clear behavior is version-specific, not proof of safe same-ID
clear on a different host/version.

The native checks used isolated empty HOME/config, a dummy key, and an owned static
loopback API responder; **no actual LLM inference**. Later explicit lifecycle runs
used the existing outer environment. The additional nested OS sandbox was not
established, and no absence-of-Keychain-access proof is claimed. See the
[dated native record](verification-existing-chats.md) for the precise boundaries.

### Historical 0.4 native subset — 2026-10-14

Before the 0.5 checkpoint, Claude 2.1.247 help/version and a bare, headless,
explicitly preloaded plugin showed skill expansion and per-invocation
`${CLAUDE_SESSION_ID}` substitution in two requests to a rejecting local mock.
No model response or approved helper action was established. The additional
full-mode containment preflight was denied before its native child started.
Production native actions, lifecycle, and hot-discovery gates were therefore false
at that checkpoint. That failure is retained, not reclassified as a pass by the
later, separately scoped runs.

## Separate managed-launch evidence

- Installed version/help contract probes passed for Claude, Codex, and OpenCode V2;
  they did not start model conversations.
- Codex accepted name-only `env_vars` configuration in a parser-only probe. No global
  configuration was written or unrelated server queried.
- A bounded Claude no-input managed probe caused the native-launched bridge to reach
  the fixture's authenticated identity endpoint, establishing environment forwarding.
  Native completed-connection status was not emitted within its probe window.
- Separate no-input SessionStart evidence observed command invocation, scoped context,
  and a native hook event without a model prompt. It was not evidence for the later
  existing-chat action/clear/resume contract; 0.5 has its own record above.

OpenCode V2 is not the V1 plugin API. Its private server uses its process environment,
but that alone does not establish native configuration isolation or descendant cleanup.
No approval bypass, global native installation, or unsafe takeover is a verification
substitute. Native trust policy still applies.

See [groups and approved connections](session-linking.md), [MCP](mcp.md),
[native configuration](native-integrations.md), [context hooks](context-hooks.md),
[OpenCode](opencode.md), and [verification](verification.md). Final 0.5 full-suite and
package acceptance, supported platforms, restricted managed resume, and real model
trials remain separate release checks; no new aggregate test total is asserted here.
