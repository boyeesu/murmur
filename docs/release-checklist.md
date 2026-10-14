# Murmur release checklist

The 0.6.0-alpha.1 development increment is **not release-ready**. Implemented source,
local fixtures, native runtime evidence, real-model behavior and publication are
separate gates. A built archive does not make the automatic four-tool workflow done.

## Implemented locally

- [x] Task ownership, shared decisions, advisory reservations, isolated worktrees and reviewed Git integration.
- [x] Human-reviewed groups, fixed-lifetime scoped grants, native resume and reviewed handoffs without chat import or source relocation.
- [x] Version-scoped Claude and Codex existing-chat implementations. Their native evidence and trust limitations differ.
- [x] Approved-only ongoing context with bounded hooks, proof checks, throttling and deduplication.
- [x] Strict actorless request formatting. This is not publication and is not registered in native exports.
- [x] Reviewed integration lifecycle and Operations UI, preserving unrelated native settings and separating installed/configured/loaded/connected.
- [x] Manual credential revocation/rotation, explicit metadata retention, permanent replay tombstones, and retention-gap reporting.
- [x] Consistent private SQLite backup, offline restore into new directories, copied-authority invalidation and v4 downgrade refusal.
- [x] Local dependency/license inventory, npm-backed CycloneDX tooling and exact-archive offline installation checks.
- [x] Manual GitHub prerelease automation with external readiness input, exact commit/artifact binding and narrow privileges. Activation remains disabled.

The final integrated run passed all 590 tests with strict checking, and Operations
browser flows passed on a synthetic project. See [the dated verification record](verification.md).
The exact distributable still requires its own offline installation and checksum
verification; a focused test pass is not an aggregate or publication gate.

## Gates still required

- [ ] Successful trusted native structured-publication callbacks and observed-event handling. Current permission-denied probes are not positive evidence.
- [ ] Native tool-context delivery and candidate pre-write plan checking. Advisory context alone does not establish either replanning or enforcement.
- [ ] Normal interactive Codex project/hook activation. Historical bypass-assisted static fixtures do not satisfy this gate.
- [ ] OpenCode incarnation invalidation through committed rewind and plugin restart. ID plus creation time is insufficient.
- [ ] Cursor runtime, CLI/editor contracts and lifecycle verification.
- [ ] Additional supported native versions and actual already-open hot attachment. Explicit resume is a separate capability.
- [ ] Purposeful real-model acceptance, including the five-session cross-tool workflow, normal permissions, separate ownership and explicit completion.
- [ ] Unfamiliar-user onboarding evidence. Developer automation is not a usability study.
- [ ] Node 24/26 on Linux/macOS from real CI runs. Current local evidence is Node 26/macOS; local Docker API access is denied.
- [ ] Current upstream/advisory/security review. Unavailable registry/GitHub data must not be reported as zero vulnerabilities.
- [x] Local security-focused review and regressions for restore, replay, installers, native identity, parser and release boundaries. This does not replace current remote advisory review.
- [ ] Verified immutable action pins and protected release environment with required review, followed by explicit workflow activation.
- [ ] Commit/push/PR and a GitHub prerelease of the exact verified commit and assets, only after all publication gates pass.

There is no npm publication or auto-merge authorization. The current GitHub network
restriction is not evidence of invalid credentials and must not be bypassed.

## Release procedure

Use [release notes](release-notes.md) as the proposed notes, and retain the honest
[capability matrix](support-matrix.md). The workflow is deliberately disabled by a
literal activation guard until action SHAs and protected release review are ready.

After activation, a manual dry run checks the matrix, packages and offline-tests the
exact archive, generates a software bill of materials, and uploads an external
readiness template. Review that run and its assets. Fill the template only with
actual evidence. Do not commit a readiness record that tries to attest to its own
containing commit.

A second manual dispatch must target the same exact commit and prior candidate run.
It validates repository/workflow/run/artifact provenance before downloading, then
rechecks every artifact hash/size, package identity, external approval and gate before
publishing. Existing tags, moved branches, dirty checkouts, altered artifacts and
incomplete gates are refused. Only the archive, checksum and SBOM are published.

See [operations](operations.md) for native installation and [data lifecycle](data-lifecycle.md)
for upgrade, credential, retention, backup and recovery rules.
