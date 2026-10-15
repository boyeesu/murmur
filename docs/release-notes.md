# Murmur 0.6.0-alpha.1 development notes

**Unreleased and not release-ready.** This local increment adds operational controls
and approved-session automation; it does not complete the automatic four-tool promise.

## Changes

- Claude approved-session prompt and advisory tool-boundary refresh, without automatic enrollment, renewal or task completion.
- Codex version-scoped existing-chat implementation with explicit activation, human approval and ongoing prompt context.
- Reviewed integration install/update/removal/rollback/recovery, with Claude private bundles and additive Codex project hooks.
- Operations dashboard for exact installation reviews, manual credential revocation, explicit retention and private backups.
- Manual credential rotation through a durable private CLI file, and independent credential revision checks.
- Permanent idempotency tombstones and explicit retention gaps in event streams, scoped updates and briefings.
- Consistent SQLite backup and offline new-directory restore with copied credentials invalidated and source bookkeeping preserved.
- Dependency-complete offline packaging, CycloneDX inventory and guarded exact-commit/artifact prerelease tooling.

## Upgrade and recovery

Back up old private state with its daemon stopped before upgrading. SQLite compatibility
advances to **v4**. Older binaries must refuse the upgraded database. Do not downgrade
in place or repair the schema manually. Current SQLite maintenance backups do not
include source workspaces, branches or the installer registry. Restore into a new
private directory only; credentials require fresh issuance/approval and interrupted
work requires review. See [data lifecycle](data-lifecycle.md).

Installation does not imply native loading, trust or a connected chat. Claude still
requires explicit plugin loading/resume. Codex requires native hook and project trust.
Removing an integration does not silently revoke grants, abandon tasks or stop native
processes. See [operations](operations.md).

## Unresolved release gates

Structured existing-chat publication, post-tool observation and hot attachment remain
gated. The standalone actorless formatter cannot publish and is not installed as a
native tool. OpenCode committed-rewind identity is insufficient; Cursor is unavailable.
The historical Codex native fixture bypassed trust and pretrusted its disposable
project, so normal activation remains unverified. Current probes no longer do so.

No real-model cross-tool acceptance completed. Native login/network permissions,
current advisories, Node 24/Linux CI and GitHub publication remain blocked. Local
fixtures, context generation and successful config writes are not evidence of model
obedience, native loading or platform support. See the [support matrix](support-matrix.md)
and [release checklist](release-checklist.md).
