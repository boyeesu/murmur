# Managed launch service

`LaunchService` prepares **new** Claude or Codex tasks on behalf of the local human. It does not spawn processes, adopt an existing native session, or depend on MCP. The native launcher owns its child process and the supervisor credential; the child receives only the separate scoped agent connection.

## Preparation and recovery

Preparation accepts `projectId`, `tool` (`claude` or `codex`), `title` (1–512 characters), and optional `featureKey`, `baseRevision`, and boolean `allowDirtyBase`. Unknown fields and existing-task arguments are rejected. Feature keys are normalized like ordinary task creation. Only registered Git projects are supported.

A durable request journal records the launch before Git work starts. Stable phase keys drive the existing workspace creation, session registration, task creation, and workspace attachment operations. Active feature ownership is checked before expensive work and again atomically by core task creation. Same-key concurrent requests join the same preparation; different input with that key conflicts. The journal retains partial IDs and phases when work fails. The service never commits, stashes, deletes, or resets the original checkout, and never deletes retained workspaces. Dirty-base consent means use committed history, not copy dirty files.

The new session is registered at its managed worktree root. Claude receives a requested native session UUID; this is a request, not evidence that Claude actually adopted it. Codex has no verified native ID: the public native ID is null and the internal session ID is explicitly synthetic (`launch:<launch-id>`).

Binding atomically replaces the interim registration token with a fresh 32-byte agent credential, marks the session `managed`, and completes the lifecycle record. A separate independently generated 32-byte supervisor credential is issued. The interim token is never delivered to a child and stops authenticating. Startup briefing is the bounded `CoordinationService.context(projectId, taskId).briefing`; its contents are untrusted project data, not proof that a model read or complied with them.

The preparation response contains exactly `launch`, `agent`, `supervisor`, and `briefing`. Only a still-prepared, unexpired launch can replay a runnable preparation response. The private launch table temporarily retains credentials for this replay; claim or termination clears those plaintext copies. Public status and events explicitly select safe fields. The outer mutation cache stores only the launch ID. The existing internal session-registration cache may retain its now-invalid interim token; the database remains private local service state, not a public export.

On a new daemon instance, the constructor synchronously marks interrupted `preparing` and ambiguous `claimed` records `recovery_required`, reconciles IDs already committed by core/workflow, revokes agent access, and releases only the launch's own reservations. It never replays a Git or OS side effect to guess what happened. Already-running launches can continue with their original controller if still within their deadline; prepared launches can still be claimed until their original deadline. A new runtime `instanceId` must be supplied on every daemon restart. No separate asynchronous launch initialization is needed.

## Supervisor protocol

Supervisor control does **not** accept an ordinary human/session principal or an agent token. Every call needs the credential bound to its `launchId`. Mutation cache callers are isolated as `supervisor:<launchId>`.

| Action | Body | Effect |
| --- | --- | --- |
| `status` | `launchId` | Read public status; no key or renewal required |
| `claim` | `launchId`, `controllerId`, `revision` | One compare-and-swap from prepared to claimed |
| `started` | common mutation fields plus diagnostic `pid` | Claimed to running; no process control |
| `heartbeat` | common mutation fields | Renew deadline and increment lifecycle revision |
| `end` | common mutation fields plus `reason`, nullable integer `exitCode` | Revoke and release own reservations; preserve task and work |

All mutations require an idempotency key and the current **launch lifecycle** revision, not a session or task revision. End reasons are `exited`, `interrupted`, `spawn_failed`, and `lease_lost`. Only the claiming controller can renew, mark started, or end the launch.

The hard deadline is 120 seconds after binding or an accepted heartbeat. Launchers heartbeat every 30 seconds. Claim, started, status, agent use, and replay of an old heartbeat do not extend the deadline. Agents are authorized in claimed state to avoid the child-start race. Expired and ended launches cannot revive; an exact previously successful end request may replay its original terminal result.

SQLite and OS process creation cannot be one atomic operation. The contract chooses **at most one automatic spawn attempt**: a fresh claim key or controller cannot claim twice. A lost claim response can replay with the original key and body while active, but a launcher must never spawn twice for that replay in the same process. A crash after claim is ambiguous and requires recovery or expiry, not automatic replacement. Stored PIDs are diagnostic only and must never be used to kill a process.

## Agent authorization

Managed session authentication fails closed without matching active, unexpired launch metadata. `authorizeAgent` additionally verifies current bound task ownership, managed credential binding, project and workspace. The HTTP layer must perform this authorization **before any cached response**, and recheck after asynchronous preparation work where applicable. The transport also validates the expected persistent service identity and protocol headers.

Permitted reads are `GET /health`, `/v1/agent/identity`, and `/v1/context`. Context requires explicit `projectId`; `taskId` is optional for shared project context, but another task cannot be the focus. Duplicate or unknown query fields are rejected.

Permitted writes are:

- `/v1/intents` — bound `taskId` and ordinary declaration fields.
- `/v1/check-plan` — bound `projectId` and `taskId`, plus candidate fields.
- `/v1/tasks/update` — only bound `taskId`, `revision`, and `status` (`active`, `blocked`, or `ready`). No title changes, handoff, or abandonment.
- `/v1/decisions/propose` — bound project and task; proposals do not accept decisions.
- `/v1/reservations/acquire` — bound project, session and task.
- `/v1/reservations/release` — `leaseId`, bound `sessionId`, and `generation`; the lease must also belong to the bound task.
- `/v1/submissions` — bound `taskId` and `revision`.

Unknown body fields are rejected. Generic session heartbeat, reservation renewal, administrative routes, arbitrary task creation and writes to another task—even another task owned by the same session—are forbidden. Human handoff immediately removes the old agent's rights, including replay rights.

The first authorized bridge request is recorded once; the most recent bridge time is tracked separately from supervisor liveness. This records authenticated bridge use only. It neither renews the launch nor proves agent compliance. Local model processes still have the user's OS privileges; this scoped API is not an operating-system sandbox.

## Lifecycle maintenance

`start()` installs an unreferenced five-second expiry timer. Each sweep processes at most 100 due launches transactionally, revokes their agent credentials, releases reservations for the exact project/session/task binding, and emits the terminal event once. Request authorization independently checks the deadline even if maintenance has not run. End and expiry do not change task status, ownership, revisions or retained files. `close()` stops the timer and waits for in-flight preparations; it does not terminate external processes.

Launch schema versioning lives in `murmur_launch_schema`, independent of the core SQLite `user_version`. Core schema version 2 supplies `sessions.credentialMode`; manual sessions retain their existing behavior.
