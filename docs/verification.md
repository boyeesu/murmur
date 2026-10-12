# Workbench verification

Environment: macOS, Node 26.4.0, npm 11.17.0, Git 2.54.0.

The sections below record local verification before GitHub publication. For
current remote runtime results, see [GitHub Actions](https://github.com/boyeesu/murmur/actions/workflows/ci.yml).

## Automated results

The consolidated `npm test` suite passes **152 tests, 0 failures**. This is a
recorded local run, not a substitute for rerunning after changes.

Verified with real SQLite, HTTP, child CLI processes and disposable Git repos:

- Transactional/idempotent coordination, five competing clients, leases/fencing,
  all-or-none acquisition, revision checks, scope authorization and crash recovery.
- Intent/decision rules, explicit duplicate producers, value contradictions,
  stale consumers, dependencies/cycles, handoffs, dismissal revisions and context bounds.
- Managed/adopted workspaces, committed-base choices, identity replacement detection,
  immutable source submissions and retained conflict candidates.
- Combined validation failure, config/target/candidate invalidation, checked-out
  target refusal, exact ref promotion and interrupted-operation recovery.
- Symbolic-ref and hidden-index-flag guards; bounded trusted-command execution,
  cancellation, filtered environment and output privacy.
- Same-origin one-use browser sign-in, separate expiring browser bearer,
  authenticated SSE history and subsequent new events, Host/origin validation.
- Continuous workspace snapshots, change-only events, observed overlap without
  inferred authorship, bounded results and stale-state handling.
- Complete HTTP/CLI journey from task through tested integration promotion;
  the original source branch and checkout remain unchanged.
- Offline packing and installation into a temporary folder; the installed CLI
  runs outside the source checkout and contains the dashboard assets and license.

The first combined run found two workflow bugs (SQLite row prototype mismatch
on replay and asymmetric case comparison in reconciliation). Both were fixed;
strict assertions were retained. A stream test was corrected to parse subsequent
messages without assuming TCP read boundaries.

The package check originally hit a restricted global npm cache. A task-local
cache resolved the local packing/install check without changing global ownership
or permissions. Registry downloads remain blocked independently.

## Dashboard

All six views and form workflows are implemented. The frontend received syntax,
DOM-shim/contract, security-sink and contrast checks. Real browser checks against
a running daemon additionally exercised one-use sign-in, live task/alert views,
project registration/switching, candidate inspection and a browser-driven fixture
promotion. The promoted target matched the displayed candidate; the original
fixture branch HEAD remained unchanged. The fixture task became integrated.

The mobile registration dialog measured 341px within a 375px viewport without
page overflow. Desktop layout metrics were checked at 1440px; viewport emulation
was cleared afterward. Initial browser requests included rejected localhost-host
requests and an expired one-use token; reopening a fresh 127.0.0.1 sign-in URL
succeeded. No real agent sessions or user source repositories were used.

A real API integration review exposed a frontend inspection-envelope mismatch;
it was corrected to unwrap `inspection.job` while preserving bounded inspection
metadata. Mobile navigation labels and compact project labels were also polished.
The local preview used disposable fixture state and was stopped after verification.

## Blocked release gates

- Static type checking: `tsc` is not installed. Offline install failed because
  dependencies were uncached; an explicitly authorized download still received
  `403 Forbidden` / sandbox denial for `registry.npmjs.org`. No typecheck pass.
- Official MCP SDK and native hook integrations are not implemented or verified.
  Managed CLI launchers for Claude Code/Codex are implemented; real model-driven
  verification and Cursor/OpenCode launchers remain incomplete. Vendor documentation
  retrieval remains blocked.
- Node 24 baseline and Linux CI jobs are defined but not run on this machine or
  remotely. Local evidence is Node 26 on macOS only.
- The bootstrap build uses experimental Node type stripping (not static checking)
  and a dependency-free browser UI instead of the planned external UI stack.
- Four real application sessions, live hook denial/context injection, automatic
  native hook-driven task capture remain outside tested behavior. Workspace observation uses bounded
  periodic Git reconciliation, not native filesystem notifications.

No project Git commit, push, package publication, global permission change, or
agent-hook/settings installation was made. Disposable test repositories have
local fixture commits; the app itself creates candidate commits only inside its
managed integration workflow when the user requests that workflow.

## Onboarding verification (2026-10-12)

At this onboarding checkpoint, **69 tests passed**. The packaged user guide and release checklist
are included in an offline-installed package, and their relative documentation
links resolve there. JSON examples in the guide parse; the intent example is
accepted by the actual coordination service.

CLI base mutations now forward the documented `--request-id`, matching extended
commands. Tests repeat registration with explicit stable native/instance IDs and
repeat task creation without creating duplicate records; a changed payload under
the same request ID is rejected. Help text explicitly says native adapters are not
implemented and documents confirmation for task abandonment.

These checks validate the existing manual-alpha instructions, not automatic
agent integration or a first-time-user usability study. No new native connector,
public publication, or static type-check pass is claimed.

## Managed launch verification (2026-10-12)

The consolidated suite now passes **152 tests, 0 failures** on Node 26.4.0/macOS.
This includes the original manual workbench plus scoped-client, lifecycle, launch,
migration, real HTTP composition, and fake-native process tests.

- Two fake native CLI processes were automatically registered, given separate
  worktrees, and supplied only managed credentials. They invoked the real Murmur
  agent CLI, declared the same contract, and both received the duplicate-producer
  alert. Human CLI access from those environments failed closed.
- Supervisor and agent credentials cannot substitute for one another. Expiry,
  revocation, lost-response replay, duplicate claims, ambiguous spawn, signals,
  owned-child termination, and same-state daemon restart are covered.
- Exiting the native process preserved task intent, source work, and the original
  checkout. Managed credentials were revoked rather than marking tasks complete.
- A schema-v1 fixture migrated to schema 2 with its manual credential intact;
  missing managed lifecycle metadata failed closed.
- The assembled run first exposed a missing shared header import in HTTP wiring.
  It was corrected; the complete manual and managed regression suites then passed.
- The installed Claude Code and Codex executables passed the implemented bounded
  version/help preflight. These probes did not start model conversations.

**Not claimed:** real Claude/Codex model-driven coordination, native hooks, MCP
transport, Cursor/OpenCode launchers, static TypeScript checking, Node 24/Linux
execution, or a public release. Package/doc access restrictions were not bypassed.
