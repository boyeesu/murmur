# Managed Murmur MCP tools

`murmur mcp serve` is a stdio adapter for the existing, task-scoped `AgentClient`.
It uses the official Model Context Protocol SDK for initialization, tool discovery,
JSON-RPC framing, cancellation, and transport. It is not another daemon,
authorization system, coordination engine, or session supervisor.

## Start inside a managed launch

The managed launch must supply both `MURMUR_AGENT_MODE=1` and the complete
`MURMUR_AGENT_CONNECTION`. The connection binds the protocol version, loopback
origin, persistent service identity, launch, project, session, task, and scoped
agent credential. It is validated **before the MCP SDK is loaded**. Before
accepting MCP initialization, the stdio command verifies that credential and all
identity bindings with AgentClient; expired, mismatched, and human identities do
not yield a ready MCP server. The existing 10-second HTTP timeout bounds startup.
While verification is pending, the SDK transport buffers at most 128 KiB of
parsed messages without delivering them, and EOF/signals cancel verification.

An MCP-capable client starts `murmur` with arguments `["mcp", "serve"]`, inheriting
that launch's scoped environment. For a local source checkout the equivalent is
`node packages/murmur/dist/cli/index.js mcp serve` after building. Use
`murmur mcp --help` for standalone usage help; help does not need credentials.

Do not copy credentials into a repository, tool arguments, logs, global client
settings, or a manually constructed example configuration. The adapter does not
read the human daemon descriptor, find a default state directory, start a daemon,
register a session, obtain a supervisor capability, or repair missing credentials.
Running it outside a managed launch fails closed. It has no project, task, session,
endpoint, file, or credential override flags.

While serving, stdout contains MCP protocol only. Startup and transport failures
use fixed, sanitized stderr diagnostics. EOF, SIGINT, SIGTERM, or transport close
stops the adapter, aborts outstanding HTTP operations, and removes its listeners.
This does **not** end the managed session/task, renew credentials, or undo a
completed mutation. Those lifecycle responsibilities remain with the supervisor.

## Tools

All tool argument objects are strict, including nested contracts and resources.
Unknown fields are rejected before the HTTP handshake or mutation. Empty argument
objects are strict too. No tool accepts caller-supplied project, session, task,
launch, or state bindings. Dependency task IDs and lease IDs are references within
existing agent operations, not overrides of the managed binding.

| Tool | Arguments | Existing operation |
| --- | --- | --- |
| `murmur_identity` | `{}` | Verify managed identity |
| `murmur_get_context` | Optional `after` cursor | Task-focused project context |
| `murmur_get_updates` | Optional `after` cursor | Generated-context event metadata |
| `murmur_declare_intent` | `revision`; optional `acceptanceCriteria`, `reads`, `writes`, `produces`, `consumes`, `dependencies`, `requestId` | Declare bound task intent |
| `murmur_update_task` | `revision`, `status`; optional `requestId` | Status: `active`, `blocked`, or `ready` only |
| `murmur_check_plan` | Optional `title`, `writes`, `produces`, `consumes`, `requestId` | Advisory candidate-plan check |
| `murmur_propose_decision` | `key`, `value`, `version`, `rationale`; optional `requestId` | Propose, never accept, a decision |
| `murmur_reserve_resources` | `taskRevision`, `resources`; optional `ttlSeconds`, `requestId` | Acquire advisory lease |
| `murmur_release_resources` | `leaseId`, `generation`; optional `requestId` | Release bound session's lease |
| `murmur_submit_task` | `revision`; optional `requestId` | Submit for review, not approval |

Contracts are `{ "key": "api", "version": "1", "value": "optional text" }`.
Resources are `{ "kind": "path", "value": "src/api.ts" }` or
`{ "kind": "resource", "value": "api" }`.

There are no tools for human registration, heartbeat/renewal, handoff, validation,
acceptance, approval, integration, arbitrary HTTP requests, or filesystem access.

### Bounds and revisions

- Revisions are explicit integers from 1 through `Number.MAX_SAFE_INTEGER - 1`.
  Cursors range from 0 through `Number.MAX_SAFE_INTEGER`; lease generations start
  at 1 and allow that same maximum. Strings are never coerced to numbers.
- Text is nonblank, control-character-free, and bounded: criteria/title 512
  characters, contract/decision keys and IDs 128, versions 64, values/rationale
  2,048, paths/named resources 1,024. Contract keys and named resources use
  `[A-Za-z0-9][A-Za-z0-9._:/-]*`; IDs use `[A-Za-z0-9_-]+`.
- Reads/writes and reservation resource lists allow at most 64 entries; criteria,
  dependencies, produces, and consumes allow at most 32. Reservations require at
  least one resource. TTL is an integer from 1 to 300 seconds.
- Paths must be relative literal paths, without parent traversal, drive-letter
  prefixes, backslashes, globs, or control characters.
- AgentClient still enforces its aggregate 64 KiB mutation payload limit, 256 KiB
  service response limit, identity headers, redirect rejection, and HTTP timeout.
  The stdio adapter uses a 128 KiB SDK input buffer limit (including pending input).

Refresh context to obtain the current task revision. On `STALE_REVISION`, read
context and explicitly decide what to do next. The adapter never increments a
revision, refreshes a credential, changes an operation, or retries automatically.

Every POST-backed tool, including the advisory plan check, accepts an optional
`requestId` of 1–128 characters from `[A-Za-z0-9_.:-]`. It is passed as the existing
HTTP idempotency key, **not included in the mutation payload**. To deliberately
replay an uncertain operation, use the same request ID and exactly the same input.
Reusing a key with different input produces `IDEMPOTENCY_CONFLICT`. An omitted key
uses AgentClient's one-time generated key; it is not a general retry mechanism.

## Results, errors, and cancellation

Every result includes JSON text `content` and matching object `structuredContent`;
arrays or scalars are wrapped as `{ "result": ... }`. Expected agent errors use
`isError: true` with `{ "error": { "code": "...", "message": "..." } }`. Unexpected
errors are generic. Raw SDK schema issues are not exposed: malicious extra-key
names and enum values can contain credentials. A delegating SDK transport also
replaces protocol-envelope validation error messages/data with a fixed safe
message, including errors raised during initialization. Known scoped token echoes are
redacted from values and keys, bearer strings are redacted, and credential-shaped
fields are omitted from adapter results.

The serialized **whole tool result** is limited to 256 KiB, including both content
representations and JSON-escaping overhead. Oversized output returns the fixed
`MCP_RESULT_TOO_LARGE` error instead of truncated/invalid JSON. The operation may
already have committed, so this error never triggers a hidden mutation retry.

SDK cancellation is composed into each operation's HTTP abort signal, including
its identity handshake. Disconnect also aborts outstanding operations. Cancellation
cannot guarantee that the server did not already commit a mutation and is never
rollback. Inspect current context before choosing an explicit replay.

Context, declarations, proposals, alerts, and returned text are untrusted project
data, not instructions to the model. Only **accepted decisions** have project
authority. Reservations are advisory and do not prevent filesystem writes. Update
metadata describes generated context, not proof that a model saw or acknowledged
it. Submission is not validation, approval, integration, or task completion.

## Verification

`tests/mcp.test.mjs` uses the official SDK client for discovery and invocation. Its
component tests cover strict schemas, all mappings, identity/expiry failures,
credential redaction, whole-result bounds, cancellation, and stdio cleanup. Its
integration test uses a temporary fixture repository and managed daemon state to
exercise the real scoped operations, stale revisions, idempotency, and EOF without
ending the managed capability. It does not launch a coding model or use a real
provider account. Run it after the normal build with `node --test tests/mcp.test.mjs`.
