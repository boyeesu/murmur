# Local workbench protocol v1

This is the implemented local HTTP transport. Managed CLI launches are available
for Claude Code/Codex; MCP and native hook wiring remain unimplemented.
All coordination endpoints, including `/health`, require
`Authorization: Bearer <credential>`. The local static UI and the one-use browser
bootstrap exchange are the exceptions described below. Human CLI clients discover
the service through its private descriptor; session API clients must authenticate
with their issued session credential, never the human credential. Every POST
requires `Content-Type: application/json`; POSTs other than the one-use bootstrap
exchange also require an `Idempotency-Key` (1–128 ASCII
letters/digits/underscore/period/colon/hyphen).
Reuse a key only to retry the identical logical operation. Changed input is
rejected. Idempotency outcomes and events commit with the database mutation.

- `GET /health`: authenticated protocol/instance metadata; its response contains no credentials.
- `GET /v1/status?projectId=...`: projects, sessions, tasks, active reservations.
  Session credentials default to and are limited to their own project.
- `GET /v1/events?projectId=...&after=0`: at most 500 ordered events and next cursor.
  Sequences are database-global and monotonic; per-project gaps are normal.
  This endpoint returns JSON pages; `/v1/stream` provides the implemented SSE transport.
- `POST /v1/projects`: user-only `{root}`; register by canonical local identity.
- `POST /v1/sessions`: user-only `{projectId, workspaceRoot, tool, nativeId,
  instanceId}`; returns `{session, token}`. Native IDs are explicit caller
  input; Murmur does not infer a host session ID from an MCP connection.
- `POST /v1/sessions/heartbeat`: `{sessionId, revision}`; increments revision.
- `POST /v1/tasks`: `{projectId, sessionId, title, featureKey?}`; one active task
  owns an explicit case-normalized feature key. Use `/v1/tasks/update` for lifecycle
  changes and human-controlled handoff; integration alone assigns `integrated`.
- `POST /v1/reservations/acquire`: `{projectId, sessionId, taskId, taskRevision,
  resources: [{kind: "path"|"resource", value}], ttlSeconds?}`. All-or-none,
  1–64 resources, 1–300 second TTL (default 90). Returns lease ID/generation.
- `POST /v1/reservations/renew`: `{leaseId, sessionId, generation, ttlSeconds?}`.
- `POST /v1/reservations/release`: `{leaseId, sessionId, generation}`.
- `POST /v1/daemon/stop`: user-only `{}`; foreground process shuts down.

Paths reserve a logical path and its descendants across registered workspaces.
They are not filesystem locks. Symlinks outside the workspace and dangling
symlinks are refused. Case sensitivity is probed without writing into the
project; where unobservable, comparisons conservatively fold case. Named
resources use exact matching and do not conflict with the path namespace.

Leases expire by daemon time; tasks and source files are never removed on
expiry. An expired lease cannot be renewed: renewal requires
the matching live owner and fencing generation. Legacy manual-session tokens do
not yet expire automatically; their general revocation/rotation workflow is future
work. Managed-launch agent credentials expire or are revoked through supervision. Browser
sessions use separate, expiring in-memory credentials.

Browser API calls require the exact service origin and a separate browser bearer.
The user credential cannot be used from a browser Origin. `POST /v1/browser/ticket`
(user-only) issues a one-use 60-second URL; `POST /v1/browser/bootstrap` exchanges
its code for a 30-minute browser session and requires the exact browser Origin.
The static `/ui/` shell contains no project data or secrets and is public locally.
`GET /v1/stream?projectId=...&after=N` is authenticated SSE with event metadata,
replay cursors, expiry checks and bounded/backpressure-aware delivery. The full
payloads are retrieved through scoped read endpoints rather than broadcast.
The service never binds a non-loopback address or logs tokens. There is no
unauthenticated shutdown or project registration route.

## Coordination and Git workflow extensions

Mutation bodies are documented in [coordination.md](coordination.md) and
[workflow.md](workflow.md). All mutations still require scoped authentication
and idempotency keys; the services validate current authority before replay.

| HTTP route | Domain operation |
| --- | --- |
| GET /v1/context | Relevant bounded task context and event cursor |
| GET /v1/alerts | Evidence-backed current alerts |
| GET /v1/decisions | Proposed, accepted and superseded decisions |
| POST /v1/tasks/update | Lifecycle / human-only handoff |
| POST /v1/intents | Replace declared intent |
| POST /v1/check-plan | Advisory candidate comparison |
| POST /v1/decisions/propose | Propose a shared contract |
| POST /v1/decisions/accept | Human-only acceptance / supersession |
| POST /v1/alerts/dismiss | Dismiss exact evidence revision |
| GET /v1/workspaces | Workspace metadata plus current/stale observation state |
| GET /v1/observations | Bounded persisted workspace snapshots |
| POST /v1/workspaces/create | Create isolated committed-base workspace |
| POST /v1/workspaces/adopt | Adopt same-project workspace |
| POST /v1/workspaces/attach | Explicit bookkeeping attachment |
| POST /v1/workspaces/reconcile | Observe changes, with unknown attribution |
| POST /v1/submissions | Pin clean committed source |
| GET /v1/integration/jobs | Queue / candidate metadata |
| GET /v1/integration/job?jobId=... | `{job, changedPaths, result, ...}` inspection envelope |
| POST /v1/validation/config | Human approval of exact argv checks |
| POST /v1/integration/prepare | Build detached candidate |
| POST /v1/integration/validate | Run trusted candidate checks |
| POST /v1/integration/approve | Human-only exact-revision promotion |
| POST /v1/integration/cancel | Cancel current validation |
| GET /v1/adapters | User-only availability and capability diagnostics |

Project-scoped GETs accept `projectId`; a session credential defaults to its own
project and cannot cross into another. Read handlers enforce authorization even
where the domain method itself has no principal argument. Browser credentials
act as the local human; agents must use their scoped session credentials.

Project identity bindings include filesystem identity, not just a path string.
A replaced repository at the same path is rejected. Older unbound registrations
need a new explicit user init. Nested repositories and Git metadata are excluded
from parent-project source reservations. Logical path overlap is conservative
under Unicode/case normalization across worktrees on different filesystems.

## Remaining limitations

No MCP server, native hook injection, existing-session discovery, or live
four-application verification yet. Managed launches automate new-task setup and
supervisor heartbeats; subsequent intent/context access is agent-invoked through
the scoped CLI bridge. Manual CLI/dashboard workflows remain supported.
Git workspace observation runs every 10 seconds with no overlapping background
scans; explicit reconciliation can refresh it sooner. Snapshots are bounded and
marked stale after 30 seconds. Change events do not infer the author. Cross-workspace
observed overlaps clear when reconciliation no longer finds them; they cannot be
dismissed as if they were declared-intent alerts. Native filesystem notifications
are not used. Attaching a task does not relocate an existing process. No OS sandbox,
non-Git snapshot isolation, automatic source conflict repair, destructive cleanup,
remote operations, or general manual-credential revocation workflow. State retention must be managed
conservatively until a retention policy is implemented.

## Managed launch and scoped-agent routes

The human launcher uses `POST /v1/launches/prepare` to prepare a new Git-backed
task. Its private response contains independent agent and supervisor capabilities;
never expose it wholesale in logs or a prompt. `GET /v1/launches?projectId=...` is
human-only and returns sanitized records. `/v1/status` includes sanitized launch
state alongside existing manual session/task data.

Managed agent and supervisor requests require `X-Murmur-State-Id` and
`X-Murmur-Protocol-Version`, and responses carry the same identity headers.
`GET /v1/agent/identity` accepts only a valid managed agent credential and reports
its immutable launch/project/session/task binding, protocol/state/instance, and
expiry. Agent access is restricted to the launch's allowed context/intent/task,
decision-proposal, reservation and submission operations. Another task owned by
the same session does not broaden that binding.

The separate `/v1/launch-control/` namespace accepts only supervisor credentials:
GET `status`, and POST `claim`, `started`, `heartbeat`, `end`. It is not a browser
interface or a general human/agent API. Lifecycle revisions and request replay
protect the single spawn claim and 120-second deadline. Only supervision renews
that deadline; agent traffic and resource leases are independent.

Managed expiry/end revokes agent access and releases its reservations without
completing/abandoning tasks or deleting work. Manual credentials remain compatible
with their existing behavior. Database schema 2 explicitly distinguishes manual
and managed sessions; managed authentication fails closed when its required
lifecycle metadata is absent. See [launch-service.md](launch-service.md) for
transaction, recovery and terminal replay semantics.
