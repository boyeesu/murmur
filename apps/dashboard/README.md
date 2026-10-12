# Murmur local dashboard

## Design direction (before implementation)

A coordination workbench, not an analytics landing page. The primary artifact is the task table: task, owner, feature, state, and revision; declared scope and next actions live in the task drawer. A right-hand detail drawer keeps inspection close to the list. Alerts, decisions, workspaces, integration, and adapter diagnostics have dedicated views.

- **Color:** cool white `#f7f9fc`, navy navigation `#243b64`, blue actions `#215ebc`, ink `#172438`, muted ink `#607087`, separators `#dce3ed`. Status marks use `#0ca30c`, `#fab219`, and `#d03b3b`, always with a distinct symbol and a normal-ink label. There are no charts or categorical series colors.
- **Type:** Avenir Next with Segoe UI and system fallbacks. A 32px main heading; compact, readable table and form text. Monospace is reserved for paths, identifiers, commands, and JSON.
- **Layout:** left-aligned content, a 220px navy sidebar, a narrow project/connection bar, and one dominant working surface. Navigation collapses below 768px. Tables scroll horizontally rather than hiding important columns.
- **Character:** a small static flock mark; restrained borders, precise spacing, and explicit state labels. No hero, gradients, KPI tile grid, or decorative all-caps labels.

```text
┌──────────┬───────────────────────────────────────────┐
│ Murmur   │ Project selector      Connection / Refresh│
│          ├───────────────────────────────────────────┤
│ Tasks    │ Tasks                         New task    │
│ Alerts   │ Search / state filter                     │
│ Decisions│ Task / owner / feature / status / revision│
│ Workspaces                                      ┌───┤
│ Integrat.│                                      │Task
│ Adapters │                                      │detail
└──────────┴──────────────────────────────────────┴───┘
```

### Brief critique

A generic SaaS card grid would emphasize counts over conflicts and ownership; reject it in favor of a table and contextual actions. Color alone would hide critical distinctions, so every state has a symbol and text. A permanently visible drawer would squeeze long paths on smaller screens; use an accessible modal drawer when a task is selected. Advanced intent and validation forms deliberately expose JSON and revisions instead of pretending these potentially destructive full-replacement operations are simple toggles. This is more technical, but appropriate for a local operations tool. No sample projects, invented telemetry, or claimed tool verification.

## Running and security

Run `npm run murmur -- dashboard` and open its printed one-use URL. The daemon serves these dependency-free static files at `/ui/` from the same loopback origin. Opening `/ui/` without a bootstrap code shows sign-in instructions.

The page removes the bootstrap fragment immediately, exchanges its code at `/v1/browser/bootstrap`, and holds the browser token only in memory. Refreshing the page requires a new dashboard URL. Authenticated requests use same-origin fetch, a bearer header, and a fresh UUID idempotency key for each write. No browser storage, external assets, third-party dependencies, session-token display, or network services are used.

## Operations

- Register a project, select it, and create a task with an existing owner or a new manual session.
- Inspect task ownership, scopes, decisions, and alerts. Update state, hand off, replace intent, attach a workspace, or submit a committed changeset.
- Propose plain-text decision values with string contract versions, then explicitly confirm the precise replacement before accepting. Serialized JSON may be used as decision text. Intent reads/writes use literal relative paths or directory prefixes, never globs.
- Dismiss alerts only with an explicit evidence-scoped confirmation.
- Create/adopt workspaces, reconcile metadata, and inspect the response. Attachment does not move a running agent.
- Prepare, inspect, validate, and explicitly approve integration candidates. Approval displays exact candidate/target SHAs and requires the validation record to match them; failed, invalidated, and unknown checks are not approvable. Unverified candidates require a separate acknowledgement.
- Configure local validation commands with an explicit local-user-privileges acknowledgement. The config revision is editable because there is no configuration read endpoint.
- Read factual adapter diagnostics without inferring that configured or connected means verified.

Streaming uses authenticated fetch/SSE, retains a per-project cursor in memory, debounces data refreshes, and reconnects with bounded backoff. While disconnected, a labeled five-second polling fallback keeps the visible page current. Dialogs are not replaced by background refreshes, preserving input; stale revision errors remain visible and require an explicit reload of the relevant detail.

Accessibility includes native modal dialogs, semantic tables and captions, labeled controls, visible focus, keyboard operation, status live regions, reduced-motion support, and non-color state labels. Project/task/API text is added using `textContent`, never interpreted as HTML.

## Verification scope

The frontend uses only browser APIs. Syntax was checked with `node --check apps/dashboard/app.js`. A local in-memory smoke check covered renderers, form construction/error preservation, same-origin authorization/idempotency headers, conservative approval gates, and the wrapped integration inspection response (`{ job, changedPaths, result, ... }`). Inspection metadata/actions use the nested job; the full wrapper remains available for safe inspection. This is not a substitute for browser testing. The integrating session is responsible for real backend/browser checks; no server, dependency installation, or full build is required to author these files.
