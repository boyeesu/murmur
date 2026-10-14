# Changelog

## 0.5.0 — Claude same-chat connector (unreleased)

- Enabled a version-scoped existing-chat connector for **Claude Code 2.1.247 only**.
  A fixed `UserPromptSubmit` hook reads the raw `/murmur:connect` command and current
  native UUID/cwd; skill text, copied handles, shared MCP metadata, and caller-supplied
  identity selectors do not select authority. Processes carrying any `MURMUR_AGENT_`
  or `MURMUR_EXTERNAL_` environment marker are refused with `NATIVE_ALREADY_SCOPED`;
  they must use their existing scoped commands, not create a second connection.
- Added human-terminal setup export with actual executable/version preflight,
  canonical public `connection.json` validation, private helper-state preparation,
  and an explicit absolute `--plugin-dir ... --resume` command. Export is not native
  installation or enrollment. Pause/exit the original CLI before resuming that same
  conversation to avoid duplicate writers; pass `--plugin-dir` again on each resume.
- Added namespaced `start GROUP TITLE | RESPONSIBILITY`, `join INVITE_CODE | RESPONSIBILITY`,
  `status`, `refresh`, `leave`, and `help`. Start/join request human review; refresh
  activates approval and retrieves bounded advisory context. Leave revokes only that
  connection while preserving its task and original chat.
- Preserved native conversation history through native resume, without Murmur scanning
  or importing it. Ordinary resume retains the UUID; observed fork and clear create
  new UUIDs and cannot inherit the original grant. Explicit original resume remains
  possible while its approved authority is valid.
- Retained the 0.4 group/API/handoff workflow and its human-only approval, fixed scope,
  separate ownership, and explicit replacement-task boundaries.

### Verification and limits — 2026-10-14

The native lifecycle probe and **exported production-plugin integration** passed on
Claude Code 2.1.247. Native-authored disposable history, empty HOME/config, a dummy key,
and an owned static loopback API responder exercised start/approval, resumed scope,
two same-cwd chats with separate owners, disconnected fork/clear, explicit original
resume, and leave with tasks/other grants preserved. This is headless native CLI
verification, **not a real-user chat trial, model inference, or model-obedience proof**.

The earlier 0.4 nested OS-sandbox preflight denial below remains historical evidence.
The later explicit `--lifecycle` run used the existing outer environment and isolated
configuration/local dummy transport; it did not establish an additional OS sandbox
or prove absence of Keychain access. Direct hot attachment/reload in an already-open
chat, other native hosts, broader native MCP behavior, and automatic background
publication remain unverified/gated. No universal `/murmur` or `@murmur` alias exists.

The 0.5 aggregate test count and package acceptance will be recorded after final
verification; this checkpoint does not assert them or a published release. See
[the native evidence](docs/verification-existing-chats.md) and
[the same-chat walkthrough](docs/session-linking.md#connect-an-existing-claude-conversation).

## 0.4.0 — approved session linking (unreleased, historical checkpoint)

The following verification limits describe the **2026-10-14 0.4 checkpoint**, before
0.5's separately recorded native lifecycle and production-connector work.

- Added project-scoped groups with separate member sessions, assigned tasks, reviewed
  responsibilities, and context prioritization. Group membership is not the exclusive
  active-work `featureKey` and never transfers task ownership.
- Added the Connections dashboard for manual/active-managed membership, authenticated
  enrollment review, approval/rejection, invitation management, scoped-grant inspection
  and revocation, and reviewed replacement-handoff export.
- Added hash-only, single-use, 15-minute invitations and bounded pending requests.
  Public review references are inert; chats never receive browser login tickets.
- Added fixed external task/workspace grants, defaulting to 8 hours and capped at
  24 hours. Explicit fresh reconnect can retain only an eligible same-chat session
  and still-owned task, with a new grant; old credentials are not revived.
- Preserved current workspaces and kept membership leave, credential expiry, task
  disposition, and native-process lifecycle separate. Imported decisions remain
  proposals. Reviewed exports do not copy files or import native histories.
- Kept reported already-changed files (`changedFiles`) distinct from intended writes,
  with a separate bounded unfinished-work checklist (`remainingWork`) in human review
  and replacement handoffs; these are reports, not filesystem or completion proof.
- Added explicit `run --handoff --acknowledge-replacement` for a new managed task
  from a reviewed export, requiring a full committed `--base` SHA and an already
  integrated/explicitly abandoned source task; no automatic disposition or copying.
- Added a fail-closed environment-scoped external API client and gated native setup
  assets. Asset export is not installation, enrollment, or native verification.
- Added group/external-session storage migration while retaining existing manual and
  managed records. Back up private state before upgrading; no downgrade is automatic.

### Verification and limits

The native existing-chat adapter remains disabled/unverified. A Claude Code 2.1.247
bare, explicitly preloaded plugin probe observed skill expansion and per-invocation
session-ID substitution against a rejecting local mock. It did not establish safe
helper execution, current-chat authorization, already-open hot discovery, or
clear/resume/fork invalidation. Full native action/lifecycle gates remain false.
Manual/API coordination and managed group requests are separate from those gates.
No unconditional `/murmur` or `@murmur` support is claimed.

Current full-suite, browser, package, and platform acceptance remain release checks;
this entry does not assert a new test total, publication, or real-model acceptance.
See [groups and approved connections](docs/session-linking.md).

## 0.3.0 — integration alpha (unreleased)

- Added the official MCP SDK stdio server with strict, task-scoped tools,
  authenticated startup, bounded results, cancellation, and safe EOF handling.
- Added opt-in launch-local MCP configuration and advisory Claude context hooks.
  Configuration contains environment references, not credential values.
- Added OpenCode V2 CLI-only standalone launches and a transactional launch-schema
  migration preserving existing session/launch records and credentials.
- Required real strict TypeScript checking alongside runtime tests and updated CI
  to install pinned dependencies rather than assuming an empty offline tree.
- Added a staging packer that verifies npm's complete runtime graph, nested/peer
  resolution, and license inclusion before producing an offline-installable archive.
- Preserved the default CLI bridge and all human-only approval boundaries.

### Verification and limits

The local check passes strict types and 236 tests. A bounded no-input Claude probe
observed SessionStart command execution, scoped context generation, and its native
hook event. This did not test model consumption. MCP SDK fixtures, fake native
hosts, and CLI contract probes are reported separately from actual model trials.

Cursor, restricted resume, real model acceptance, automatic Codex hook configuration,
and OpenCode MCP/plugin configuration remain gated. Back up private state before
upgrading; older binaries may reject the newer launch schema. No npm release or
Git push is implied by this local version.

## 0.2.0 — local alpha

- Added opt-in managed CLI launches for Claude Code and Codex.
- Added scoped agent commands, separate supervisor authority, expiring access,
  at-most-one spawn claims, and conservative failure recovery.
- Retained the task/decision board, evidence-backed alerts, workspace observation,
  immutable submissions, validation, and reviewed integration workflow.
- Added user guides and runtime, authorization, migration, fake-native-process,
  and offline package-installation tests.

### Known limitations

Official MCP transport, native hook injection, Cursor/OpenCode launchers, and
real model-backed acceptance remain incomplete. Static type checking and broader
platform verification are separate release gates. This is not a production
security or universal conflict-prevention guarantee.
