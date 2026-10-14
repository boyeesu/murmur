# Workbench verification

Environment: macOS, Node 26.4.0, npm 11.17.0, Git 2.54.0.

The sections below record dated local checkpoints; older failures and test totals
are retained as history, not current capability claims. For current remote runtime
results, see [GitHub Actions](https://github.com/boyeesu/murmur/actions/workflows/ci.yml).

## Claude connector — 0.5 checkpoint (2026-10-14)

Actual **Claude Code 2.1.247** passed the explicit native lifecycle experiment and
the **exported production-plugin** test in `scripts/probe-claude-connector.mjs`.
The native fixed `UserPromptSubmit` hook carried raw namespaced command text and
current UUID/cwd. Ordinary resume retained the UUID, fork created a new UUID, and
clear emitted a reset plus a new UUID.

With native-authored disposable history and the real fixture daemon, production
start requested human approval; authenticated review/approval and native resumed
refresh retained scoped access. Two same-cwd chats had distinct task owners. Fork
and clear reported disconnected instead of inheriting the parent grant; explicit
original resume still worked. Leave revoked only its own grant, preserving tasks
and the other chat's grant.

These are **headless native CLI checks, not a real-user chat or model trial**. They
used empty disposable HOME/config, a dummy key, and an owned static loopback API
responder with no actual LLM inference. No global native installation occurred.
The earlier denied nested OS-sandbox attempt remains in the historical record.
Later explicitly selected `--lifecycle` runs used the existing outer environment
with isolated config/local dummy transport; no stronger OS isolation or absence
of Keychain access was proved.

Only the Claude 2.1.247 explicit plugin + same-chat resume flow is enabled. Direct
hot attachment/reload into an already-open CLI, other hosts/Claude versions, generic
native MCP attachment, and automatic background publication remain unverified/gated.
Refresh is command-driven, not proof of model obedience. The original conversation
history remains native; Murmur does not scan/import it. The 0.4 API/groups/reviewed
handoff features remain intact. See [the full native evidence and history](verification-existing-chats.md).

**Final 0.5 check/package acceptance:** pending the final consolidated run and local
packaging checkpoint. No aggregate test count or package publication is asserted yet.

## Historical consolidated automated results — 0.3 (2026-10-13)

At this checkpoint, `npm run check` passed strict TypeScript checking and **236 tests,
0 failures**. This is a recorded local run, not a substitute for rerunning after changes.

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

## Historical blocked release gates — before 0.3

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

## Scoped MCP integration verification (2026-10-13)

The new consolidated `npm run check` passes strict TypeScript 7.0.2 checking with
Node 24.19.2 declarations, then **236 runtime/SDK tests** on Node 26.4.0/macOS.
The SDK is 1.32.1 and zod is 4.6.7; all are pinned. Earlier missing-compiler and
missing-SDK notes above describe historical checkpoints, not current local state.

New evidence includes official SDK initialization/tool discovery/mappings against
a real fixture daemon, strict unknown-field rejection, credential-safe validation
and protocol errors, cancellation, bounded startup/stdio, and EOF/signal cleanup.
A production managed launch test uses fake Claude/Codex hosts, actual generated
configuration, real SDK clients and the real hook command. It is not a model trial.

Advisory hook tests cover all supported envelopes, workspace/native identity
checks, private bounded cache state, stdout-before-cache ordering, deduplication,
malformed/oversized/stalled input and safe failure without permission fields.
OpenCode V2 tests cover CLI-only standalone invocation and a transactional launch
schema migration preserving live/terminal credentials, deadlines, indexes and
revocations. MCP/plugin support for OpenCode remains gated.

Packaging initially exposed npm workspace bundling omissions. The dedicated pack
script now physically stages npm's installed runtime graph, preserves and verifies
its dependency/peer edges, then lets npm create the archive. Offline installation
validated 95 runtime package locations and their licenses, SDK transitive loads,
and the actual installed MCP module with an SDK handshake. No dependency/vendor
files or the installed tree were modified to make the test pass.

The installed native contract probes passed without model conversations. Claude
consumed the generated MCP config far enough for authenticated scoped identity
access, but no native completed-connection status was confirmed in the no-input
window. The final SessionStart probe observed command invocation, valid scoped context
generation and the corresponding native hook event. Its corrected criterion used
the fixture title/envelope rather than UUIDs deliberately removed by the privacy filter.
No user prompts, permission bypasses, global configuration changes, or real model
trials were used. Remaining native evidence is reported conservatively.

The Cursor CLI is still absent. Codex automatic hook configuration is intentionally
disabled while merge/trust preservation is unverified. OpenCode configuration
isolation/V2 plugins and managed resume remain incomplete. Linux/Node24 CI is
configured but has not been remotely verified in this session. Git metadata writes
remain blocked here; working-tree changes have not been committed or pushed.

### Native SessionStart probe result

The final corrected Claude 2.1.247 probe observed all three independently:
command fired, valid scoped advisory context generated, and the matching native
hook event. No model input was sent, normal guards/permissions remained intact,
and all owned processes/configs/fixture state were cleaned. Model consumption was
not tested. The production redactor and binding checks were not weakened to make
this pass; only the probe's impossible raw-UUID expectation was corrected.

## Historical 0.4 session linking verification (2026-10-14)

This checkpoint predates the 0.5 native connector work recorded at the top. Its
native-disabled conclusions and package/test evidence are retained as history.

Version 0.4.0 passes strict TypeScript checking and **346 runtime, SDK, HTTP,
UI-component, helper, migration and package tests** on Node 26.4.0/macOS. The
complete suite was rerun after review fixes and the browser correction. Node 24
and Linux CI, and real model-driven native adoption, were not run.

Independent review verified fixes for legacy human-credential fallback under
external environment markers, late polling of an already approved request, and
fresh enrollment after early revocation. Shared guards reject complete/partial
external markers before discovery. Ambiguous helper failures preserve proofs;
new enrollment requires fresh proofs and human approval. This is not a
comprehensive security audit.

Browser verification used a synthetic disposable project, not native chats:

- Authenticated inspection showed the exact workspace and shared-checkout warning.
- Expired requests blocked approval while preserving edited fields.
- Approval published reviewed content and created a separately owned task in the group.
- A scoped fixture client read both task summaries without another task's authority.
- Export preserved immutable source pins and edited summary, reported changed files and remaining work.
- Browser revocation produced HTTP 401 for the old capability while preserving task status, owner, feature claim and uncommitted file.
- Desktop inspection and a 375px mobile viewport showed no document-wide horizontal overflow.
- A stray null in the inspection panel was corrected; UI and full-suite checks passed afterward.

The preview initially opened localhost, which the exact Host guard correctly
refused. Verification used 127.0.0.1. A fixture-only entry server minted normal
one-use login tickets at navigation time to avoid tool delays; production
authentication and lifetimes were unchanged. No browser credential entered a
native connector.

Offline package installation verified 95 runtime dependency locations/licenses,
new CLI entrypoints, review-only native assets, and rejection of native actions.
No global native settings were installed.

**The complete existing-chat adoption checklist is not yet done.** Groups,
human-approved external protocol, reviewed handoffs and replacement launch are
implemented. Native in-place activation, authenticated current-action identity,
and safe native resume/fork/clear remain unverified, so native actions stay
disabled. See [native probe evidence](verification-existing-chats.md) and
[session linking](session-linking.md).

### Final 0.5 acceptance results

The final strict check and complete runtime suite pass: **368 tests, zero failures**
on Node 26.4.0/macOS. The exported production-plugin test was rerun after the
recovery fixes and passed all native start/approval, resumed refresh, two-chat
ownership, fork/clear separation, original-session resume and leave checks.
It used actual Claude Code 2.1.247 with native-authored disposable history and an
owned static local responder, not real model inference or real-user histories.

Native review findings were fixed and regression-tested:

- Encoded-byte section budgets keep accepted decisions and alerts represented
  even when preceding task/group text is multibyte and oversized.
- Failed hook input pipes are destroyed with late-error handling.
- A dedicated, credential-free SQLite mutex releases its process-owned lock on
  normal exit or SIGKILL. Tests cover child/process contention, initialization,
  private-mode/symlink/inode checks, and preserved proofs after crash recovery.
  Legacy regular-file markers are refused, not guessed stale or deleted.

The dashboard's adapter API was checked through the preview: Claude reports the
version-scoped explicit-resume connector; the other native hosts remain gated,
and configured/connected state stays unknown rather than inferred from a binary.
No global native installation, live-user chat connection, commit or push occurred.
