# Contributing to Murmur

Murmur is an experimental local-first coordination tool. Start with the
[user guide](docs/user-guide.md), [capability matrix](docs/support-matrix.md), and
[release checklist](docs/release-checklist.md). Managed CLI launch support is not
proof of native MCP/hook integration or real model behavior.

## Development setup

Use Node 24 or later and Git. The current verified local runtime is Node 26 on
macOS; the CI matrix also exercises Node 24 and Linux.

From the repository root:

```bash
npm ci --ignore-scripts
```

```bash
npm test
```

The build strips TypeScript types, while `npm run typecheck` performs real strict
checking. Run `npm run check` before proposing changes. SDK/schema dependencies
are pinned; do not modify installed dependencies or weaken strictness to silence
diagnostics. `npm run pack` stages the runtime closure for an offline-installable
archive and verifies dependency resolution and license inclusion.

## Proposing changes

- Open a focused issue for substantial behavior or architecture changes.
- Keep pull requests scoped; describe the user problem and the tested outcome.
- Add regression tests and update the relevant documentation.
- Preserve the manual CLI/dashboard workflow when changing managed launches.
- Keep credential scopes, transactional updates, revision checks, and recovery
  behavior intact. Never discard user work as an automatic repair.
- Distinguish mocked/fake-process tests, CLI contract probes, and real model-backed
  verification. Do not mark capabilities verified without the required evidence.

Tests must use disposable state and Git fixtures, never real agent settings,
accounts, credentials, or repositories. Do not start paid model conversations as
part of the default test suite.

## Publication hygiene

Do not commit `.env` files, tokens, daemon descriptors, database/state backups,
recorded conversations, machine-local agent configuration, or generated archives.
Redact sensitive diagnostics before opening an issue or pull request. Internal
planning notes and local preview configuration are intentionally ignored by Git.

For vulnerability reports, follow [SECURITY.md](SECURITY.md), not public bug reports.

Maintainers preparing the first public repository should follow the
[publication checklist](docs/publishing.md).
