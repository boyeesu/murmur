# Intent and decision coordination

`CoordinationService` is a synchronous, deterministic domain service layered on `CoordinationStore`. It does not inspect or write workspaces, call a model, merge code, or treat similar text as proof of duplicate work. Its mutation methods authorize the authenticated principal before an idempotent response can be returned, and check ownership again inside the transaction. The HTTP/MCP layer must authorize project access before invoking read methods, which intentionally have no principal argument.

## API

All mutation methods take `(input, principal, mutation)`. A mutation key is scoped to the authenticated caller; `mutation.caller` must equal `human` or `session:<sessionId>`. The service binds idempotency to its own method name and validated input, not the caller-supplied operation/input metadata. Repeating a successful key returns the original response, but never bypasses current authorization. A different validated payload under the same key is a conflict.

- `updateTask({taskId, revision, title?, status?, handoffSessionId?}, ...)` returns the updated **Task**. `revision` is the current task revision; each successful update increments it. At least one change is required. Only the owner or human can edit. Handoff is human-only, must target another session in the same project, defaults to `planned`, and cannot mark work ready. Abandonment and handoff atomically release live reservations. Abandonment makes the feature claim reusable through the base store's existing partial unique index.
- `declareIntent({taskId, revision, acceptanceCriteria?, reads?, writes?, produces?, consumes?, dependencies?}, ...)` returns **`{task, intent}`**. This is a complete replacement, not a patch; omitted arrays become empty. It increments the task revision and the intent's independent revision. `intent.taskRevision` records the task revision when declared; `intent.objective` is always the current task title. Dependencies must reference tasks in the same project and cannot form a direct or transitive cycle. Existing intent identity is preserved on replacement.
- `checkPlan(projectId, {title?, taskId?, writes?, produces?, consumes?})` returns **`{candidate, alerts, advisory:true}`** and performs no writes. A `taskId` supplies its stored title and intent scope; explicitly supplied fields override those defaults. Without a task, title is required. The task is never compared against itself. Only the candidate's relevant comparisons are returned. Candidate overrides have their own content fingerprint, so an old dismissal cannot silently suppress changed hypothetical evidence.
- `proposeDecision({projectId, key, value, version, rationale, taskId?}, ...)` returns a **Decision** in `proposed` state, revision 1. A session can propose within its project; an attached task must belong to it. Proposals do not establish authority or make consumers stale.
- `acceptDecision({decisionId, revision, expectedAcceptedId}, ...)` is human-only and returns the accepted **Decision**. `expectedAcceptedId` must explicitly be the currently accepted ID for this key, or `null` if there is none. Both proposal revision and accepted ID are checked atomically. Acceptance increments the proposal revision; any prior accepted record becomes `superseded`, increments its revision, and names its replacement in `supersededBy`. There is exactly one accepted decision per project/key, enforced by a partial unique index.
- `listDecisions(projectId)` returns **Decision[]**, including proposals and superseded history, ordered by creation time and ID.
- `getAlerts(projectId)` returns **Alert[]**, ordered deterministically by severity, kind, and ID, excluding exact dismissed evidence revisions.
- `dismissAlert({projectId, alertId}, ...)` returns **`{projectId, alertId, dismissed:true}`**. The human or an owner of an affected task may dismiss a current alert. Stored affected task IDs support replay authorization after evidence changes; losing ownership revokes replay access too. An old successful dismissal may replay, but a new mutation cannot dismiss an obsolete evidence revision. Dismissal does not reserve files or waive any safety checks.
- `context(projectId, taskId?, after=0)` returns **`{projectId, task, tasks, decisions, alerts, briefing, events, nextCursor, truncated, delivery}`**. `task` is the focused task with its intent or `null`; `tasks` contain intent summaries, with the focus first, then dependencies/alert-related work, then other active work. Decisions are accepted only, prioritizing keys the focused task produces or consumes. A focused context includes only alerts affecting that task. See bounds and delivery semantics below.

### Records

A contract is `{key, version, value?}`. Keys are case-sensitive identities independent of paths and title wording. Versions are opaque strings: a different accepted version is a mismatch, not a claim about semantic-version ordering. An omitted value is unknown, not agreement or disagreement.

An intent contains `id, projectId, taskId, objective, revision, taskRevision, acceptanceCriteria, reads, writes, produces, consumes, dependencies, createdAt, updatedAt`.

A decision contains `id, projectId, key, value, version, rationale, taskId, status, revision, proposedBy, createdAt, acceptedAt, supersededBy`. The last two fields are nullable. `proposedBy` is a caller identifier, never a credential.

Every alert contains `id, projectId, kind, severity, evidence, taskIds, message, suggestedAction`. Evidence identifies affected task and intent revisions and, when applicable, the exact accepted decision ID and revision. Alert IDs hash this evidence. A task update, redeclaration, or accepted decision replacement therefore produces fresh applicable alerts rather than inheriting a stale dismissal. A hypothetical candidate also includes its content fingerprint; its nonexistent task ID is not added to `taskIds`.

## Task lifecycle

Normal transitions are:

- `planned` → `active`, `blocked`, or `abandoned`
- `active` → `blocked`, `ready`, or `abandoned`
- `blocked` → `active` or `abandoned`
- `ready` → `active`, `blocked`, or `abandoned`

Same-state updates are permitted. Integrated and abandoned tasks are terminal and cannot be renamed, redeclared, handed off, or reopened here. `integrated` cannot be assigned by this API; integration is a separate service. Handoff can move any nonterminal task to `planned`, `active`, or `blocked`. It changes ownership and revision without rewriting files or transferring old lease fencing tokens. Declaring intent does not itself prove acceptance criteria or integration readiness; integration must check its own preconditions.

The base store's low-level lease APIs are not changed by this extension. The outer service must still reject acquiring/renewing reservations for terminal tasks.

## Evidence rules

- **`duplicate_contract_producers` / warning:** two nonterminal task intents explicitly produce the same key, even with disjoint files or entirely different wording. Versions and values are included as evidence. This is a coordination prompt, not proof that parallel implementations are invalid.
- **`contract_value_conflict` / error:** declarations state different explicit values for the same key/version, or a declared value differs from the currently accepted decision for that key. No value is invented when one is omitted.
- **`stale_consumed_version` / warning:** a consumed version differs from the currently accepted version. Unaccepted producer proposals are not authority.
- **`overlapping_writes` / warning:** literal write paths are equal or have a parent/child prefix relationship. Evidence includes up to eight path pairs and the total overlap count. `src/api` does not overlap `src/api-old`. Overlap alone is never labeled duplicate work.
- **`similar_title_scope` / info:** titles share at least two nontrivial tokens, token Jaccard similarity is at least 0.6, and write scope or a contract key overlaps. Common action words are ignored. This explicitly low-confidence hint is omitted when a duplicate-producer alert already supplies stronger evidence.

No advisory alert silently blocks declarations, task updates, or independent work. File reservations and integration safety remain separate mechanisms.

## Bounds and path semantics

Inputs reject unknown fields. IDs and contract keys are at most 128 characters; title is at most 512, version 64, and decision value/rationale 2,048. Idempotency keys are at most 200 characters. Text fields reject control characters. A declaration accepts at most 32 acceptance criteria (512 characters each), 64 reads and 64 writes (1,024 characters each), 32 produced and 32 consumed contracts, and 32 dependencies. Repeated contract keys within one produce/consume list are rejected; ordinary string/path arrays are deduplicated. The normalized mutation or candidate payload is capped at 128 KiB of UTF-8 JSON.

Intent paths are lexical project-relative literal prefixes, not globs or leases. Duplicate separators and `.` are normalized; `a/../b` becomes `b`. Traversal above the root, absolute/drive paths, backslashes, control characters, and glob syntax are rejected. `.` denotes the project root. Case is folded only for projects marked case-insensitive. There is deliberately no filesystem or symlink lookup: the reservation layer provides physical-path safety before edits.

Context gives tasks, decisions, and alerts separate briefing budgets so a large task list cannot erase all accepted decisions or alerts. It caps its briefing at 6,000 characters, task summaries at 24, accepted decisions at 32, alerts at 24, and event metadata at 100. Within a task summary, acceptance criteria are capped at eight and each other intent array at twelve. `truncated` exposes `tasks`, `taskDetails`, `decisions`, `alerts`, `events`, and `briefing` flags; structured arrays retain their ordinary per-field input bounds. The briefing labels project declarations as untrusted data, not instructions. It contains no session credentials, workspace roots, event payloads, or raw transcripts.

## Cursor and generation records

`events` contains only `{sequence,type,createdAt}` for this project after `after`. `nextCursor` is the last event metadata entry actually returned, or the supplied cursor when there are no new entries; it does **not** jump to the latest unreturned event. `truncated.events` says another page exists. Context snapshots can show current state newer than the historical metadata page; pagination describes metadata delivery, not replay of all historical state.

Each context generation atomically stores the returned task/intent revisions, decision revisions, alert IDs, cursor bounds, event count, and generation timestamp. It does not add a new project event (which would create endless self-generated cursor traffic). The returned `delivery` contains `id, generatedAt, after, nextCursor, eventCount, meaning:'generated_context_event_metadata_only'`. This records server-side generation, not network receipt, model attention, acknowledgement, compliance, or proof that an agent followed instructions. The database record contains no raw briefing/transcript.

## Persistence

Extension tables are `coordination_intents`, `coordination_decisions`, `coordination_alert_dismissals`, and `coordination_context_deliveries`. Initialization creates them transactionally and records version 1 in `murmur_coordination_schema`. Existing unsupported versions, missing extension tables, or unversioned collisions fail closed. The extension never changes SQLite `PRAGMA user_version`; the base store handles its own credential-mode migration from version 1 to version 2.

Transactions are synchronous and contain no network or filesystem work. Mutation events, revision changes, lease releases, and idempotent responses commit together. Context uses one consistent database snapshot plus a generation record. Alert computation is deterministic pairwise comparison of active intents; it is suitable for local project coordination, not an unbounded remote analytics workload.
