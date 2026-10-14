# Changelog

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
