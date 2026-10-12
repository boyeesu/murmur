# Managed agent bridge

`murmur agent` is the narrow command surface for a **managed launch**. It uses the
launch's scoped agent credential and immutable project, session, and task binding.
It does not register arbitrary tasks or sessions, attach workspaces, accept decisions,
configure validation, promote changes, stop the service, or change a task's owner/title.
A supervisor credential or an ordinary human/manual-session identity is not an agent
bridge credential.

## Connection and trust boundary

The launch supplies both environment variables:

- `MURMUR_AGENT_MODE=1`
- `MURMUR_AGENT_CONNECTION`: one JSON object with `protocolVersion`, `origin`,
  `stateId`, `launchId`, `projectId`, `sessionId`, `taskId`, and `agentToken`.

Do not print, copy into a task, or commit the connection JSON. `agentToken` is a
secret capability. Protocol version is `1`; the origin is an explicit
`http://127.0.0.1:<port>` origin, without credentials, path, query, or fragment.
The persistent state ID is 64 lowercase hex characters. Missing, extra, or invalid
connection fields fail closed. `--help` needs no connection; every other command does.

The bridge does **not** read a daemon descriptor, a default state directory, or human
credentials. `MURMUR_HOME` and `HOME` do not select a server. There is no discovery,
registration, human-credential fallback, or environment repair after a failure.
`--file` is the only file-input feature, and reads only the explicitly supplied regular
JSON file; it is not a credential/configuration discovery mechanism.

The first operation verifies `GET /v1/agent/identity`: role must be `agent`, every
binding must match, and the credential must have a valid future expiry. Every request
sends only the agent bearer credential plus `X-Murmur-State-Id` and
`X-Murmur-Protocol-Version`; every response, including errors, must return the same
state/protocol headers. Process `instanceId` may change on restart, but state,
protocol, and bindings may not. A restart does not cause re-registration or discovery.
If cached identity expiry passes, a long-lived client refreshes only the scoped
identity using the original token: a supervisor may have extended its lifetime.
The service independently enforces current launch lifetime and domain ownership.

This is a restricted client interface, **not an OS sandbox** for the spawned process.
An agent with other filesystem/process permissions still has those permissions.
Reservations are coordination signals, not filesystem write prevention.

## Commands

All results are JSON. `agentMain(argv, env)` returns the result and throws
`MurmurError` on failure; the main CLI owns output and sanitized error printing.

```sh
murmur agent --help
murmur agent identity
murmur agent context
murmur agent updates --after 42
murmur agent intent --revision 7 --data '{"writes":["src/api"],"acceptanceCriteria":["Tests pass"]}' --request-id intent-7
murmur agent update --revision 8 --status blocked --request-id blocked-8
murmur agent check-plan --data '{"writes":["src/api"],"produces":[{"key":"api","version":"1"}]}'
murmur agent propose-decision --key api --value v1 --version 1 --rationale 'Compatible with consumers' --request-id proposal-api-1
murmur agent reserve --revision 9 --path src/api --ttl 60 --request-id reserve-9
murmur agent release --lease LEASE_ID --generation 1 --request-id release-1
murmur agent submit --revision 9 --request-id submit-9
```

The revisions above are illustrative, **not** a sequence to run blindly. Refresh
context and use the current task revision before each revision-sensitive operation.
`intent`, `update`, and `submit` accept `revision`; `reserve` accepts `taskRevision`
in JSON or `--revision` on the CLI. `release` uses the lease's `generation`, not a
task revision. Decision proposals use a contract `version`; `check-plan` is advisory
and has no revision argument. Submission pins the existing task's changes through
the service; it is not a merge or promotion command.

POST commands accept `--data JSON` **or** `--file PATH`, at most 64 KiB of UTF-8 JSON.
Explicit flags may supplement JSON but must not conflict with an existing field.
Unknown fields and options are errors, not silently ignored. No `--project`,
`--session`, or `--task` override exists. A differing binding explicitly supplied in
JSON is rejected before any request. `update` permits only `active`, `blocked`, and
`ready`; title changes, handoffs, abandonment, and administrative fields are rejected.
A `check-plan` candidate title is advisory only and does not rename the task.

Reservation JSON uses the existing resource shape:

```json
{
  "taskRevision": 9,
  "resources": [
    { "kind": "path", "value": "src/api" },
    { "kind": "resource", "value": "api" }
  ],
  "ttlSeconds": 60
}
```

TTL is 1–300 seconds (the service default applies when omitted). Paths must be
relative, literal, and without parent traversal; the server additionally checks
workspace identity and symlink boundaries.

`context` always includes the bound project and task in its query. `updates` reads
that same scoped context endpoint and returns event metadata, its cursor, truncation
indicator, and delivery metadata—not a general event feed. Delivery means context
was generated, **not** that a model read, understood, or complied with it. Context,
intent, and proposal text remains untrusted project data rather than instructions;
only accepted decisions have project authority.

## Retries and failures

- There are **no automatic retries** of reads or mutations and no automatic revision
  increments. A stale-revision error tells the caller to refresh context.
- Every POST has an idempotency key. `--request-id` supplies it unchanged; when omitted,
  a fresh UUID is generated for that one invocation. For an explicit replay after an
  ambiguous outcome, retain the original request ID and payload. Reusing a key with
  changed input is an idempotency conflict, not a way to update the original request.
- An unreachable server, redirect, mismatched/missing identity headers, invalid JSON,
  invalid UTF-8, or oversized response fails closed. Responses are streamed with a
  256 KiB limit and a 10-second timeout covering both transport and body reading.
- Errors retain valid structured service error codes but do not echo arbitrary
  service messages/details, raw transport exceptions, file contents, or credentials.
  The agent token and credential-shaped fields are redacted from successful output.
- A denied or expired credential needs human/supervisor attention; the agent must not
  create a replacement task/session, discover another server, or switch credentials.

## Programmatic API and verification

`AgentClient(connection, transport?)` exposes only `identity`, `context`, `updates`,
`intent`, `update`, `checkPlan`, `proposeDecision`, `reserve`, `release`, and `submit`.
Payload methods accept an optional request ID as their second argument. It has no
public generic HTTP method. `transport` is either a fetch-compatible function or
`{ fetch?, timeoutMs? }` (bounded to 1–30,000 ms), for component tests. Bindings and
payloads are copied before asynchronous work; repeated supplied keys and equivalent
JSON payloads produce stable request bodies.

Run the focused component tests without building:

```sh
node --test tests/agent-client.test.mjs
```

They type-strip only the bridge/protocol sources in memory and use stub fetch
responses. They exercise binding isolation, allowlists, identity and header checks,
retry safety, secret redaction, payload/response bounds, and explicit file input.
They do not launch a daemon or native tool. Passing these tests is **not** evidence
of live Claude/Codex launch supervision, native model participation, or end-to-end
coordination; those require separate combined-service and live-native verification.
