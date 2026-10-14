# Existing-chat native contract verification

## 0.5 result — Claude 2.1.247 same-chat connector, 2026-10-14

**The exported production connector passed the headless native same-chat resume
flow on Claude Code 2.1.247.** This is newer, separately scoped evidence than the
0.4 bare-plugin and denied containment checkpoint retained below. Only this Claude
version and explicit plugin/resume flow are enabled; other native hosts, generic
MCP attachment, and direct hot attachment/reload remain gated/unverified.

### Native lifecycle contract observed

The explicit `scripts/probe-existing-chat.mjs --lifecycle` experiment ran actual
Claude 2.1.247 with an empty disposable HOME/config, a dummy key, and an owned static
loopback API responder. Native-authored fixture history—not fabricated or real-user
history—was used for resume/fork/clear. It observed:

- `UserPromptSubmit` executing with the raw namespaced command and current native
  UUID/cwd, before skill text is used to report the action.
- Ordinary resume retaining the native UUID.
- Fork emitting a new native UUID.
- Clear emitting a conversation reset and a new UUID.

This explains why the production adapter uses the **current hook UUID** for both
native ID and incarnation in this supported version. It does not recover a grant
from a copied parent handle or trust a model-selected ID/cwd. The observed clear
behavior is not proof that same-ID clear is safe on a different version or host.

The lifecycle-only script still reports `productionAdapterEnabled: false` and its
`production-connector-integration-still-required` boundary: it does not exercise or
enable production authorization. The separate production test below supplies that
evidence, rather than treating lifecycle booleans as an authorization test.

### Exported production-plugin integration

`scripts/probe-claude-connector.mjs` used the real setup exporter, generated plugin,
fixed `murmur native hook` entrypoint, private helper, and fixture Murmur daemon.
Actual native CLI commands exercised the following passing checks:

| Check | Observed result |
| --- | --- |
| Native start | `/murmur:connect start …` created a pending human-approval request, not immediate access. |
| Human review and resumed refresh | Authenticated fixture-human review/approval followed by native resume and refresh retained approved scope and returned the reviewed responsibility. |
| Two native chats in the same cwd | Start and invitation join produced separate approved sessions/tasks/owners; group context included both responsibilities. |
| Fork status | New native UUID; production `status` reported disconnected instead of using the parent's grant. |
| Clear and subsequent status | Native reset/new UUID; production `status` after resuming the cleared conversation reported disconnected. |
| Explicit original resume | Original native conversation could still refresh using its own valid approved scope. |
| Leave | Native leave reported success; only its grant was revoked, the other grant remained active, and task/owner records were retained. |

This is **native CLI headless verification, not a real-user chat trial, actual LLM
inference, or model-obedience evidence**. The owned loopback responder returned
static fixture text and had no upstream model transport. Human review used the
normal authenticated API with disposable fixture state, not an interactive native
user trial. No global native installation was performed.

### Isolation and evidence limits

The earlier additional nested OS-sandbox preflight was denied, and that denial
remains unchanged below. The later **explicitly selected `--lifecycle` mode** ran
within the existing outer environment using isolated configuration and local dummy
transport. Neither it nor the production-plugin test establishes an additional
OS sandbox, independently proves no Keychain access, or proves containment against
all same-user processes. Empty HOME/config and a dummy key are test setup facts,
not substitutes for those stronger claims.

The tests do not verify direct hot installation/reload into an already-open CLI,
interactive trust behavior, automatic background intent publication, other hosts,
other Claude versions, native shared-chat MCP, or real model compliance. Production
refresh is explicit and command-driven. The 0.4 API/group/handoff workflow remains
separate and usable. Final 0.5 full-suite/package totals will be recorded in
[workbench verification](verification.md) after final checks; none is invented here.

### Reproduce the separate 0.5 checks

From a built source checkout with Node 24+ and an existing absolute `TMPDIR`, and
only when explicitly choosing to run native disposable fixtures:

```bash
node scripts/probe-existing-chat.mjs --lifecycle --claude /absolute/path/to/claude
```

```bash
node scripts/probe-claude-connector.mjs --claude /absolute/path/to/claude
```

The production integration requires the built `dist` modules and an exact supported
executable. These commands are verification drivers, **not user onboarding commands**.
They create and clean disposable fixture state and native history. For real onboarding,
use the [human export and same-chat resume guide](session-linking.md#connect-an-existing-claude-conversation).
Pause/exit the original CLI before native resume and pass `--plugin-dir` again on
future resumes. No existing user history is scanned/imported by Murmur.

---

## Historical 0.4 result — useful native subset, adapter still disabled

**Historical checkpoint, 2026-10-14, before the 0.5 work above.** The remaining
sections preserve the earlier probe's failures, unattempted cases, and then-current
release gates; they are not the current production support matrix.

The 2026-10-14 probe tested installed **Claude Code 2.1.247** on macOS
(Darwin 27), using Node **26.4.0**. It established native help/version facts and a
**bare, headless, explicit-plugin skill** subset. It did **not** establish a safe
existing-chat helper or native lifecycle contract. No production adapter/client
is changed or enabled by this probe.

Two concurrent invocations of a temporary plugin's
`/murmur-native-probe:murmur-probe` command produced different native stream-init
IDs in the same cwd. At a rejecting local mock, the expanded skill text contained
`${CLAUDE_SESSION_ID}` substituted with the ID of **its own invocation**, and
`$ARGUMENTS` preserved quotes, backticks, `$()`, semicolons, and redirections as
literal text. The native init events also reported the expected workspace.

This demonstrates **skill expansion into a request**, not deterministic helper
execution or authorization. No shell interpolation of free-form arguments was
used: the skill body is plain text, not a `!` shell command. Nothing was sent to a
real provider; the mock returned 403 to both requests and produced no model
response. The child exit code 1 in those two cases is the expected local rejection,
not a successful model turn.

A separate full-mode containment preflight failed before its native child could
start:

```text
sandbox-exec: sandbox_apply: Operation not permitted
exit code: 71
```

That additional deny-by-default profile is intended to keep full-mode execution
away from private user files, Keychain IPC, other local services, and real
providers. The enclosing environment refused the additional sandbox. This is an
**environmental blocker**, not evidence that full-mode hooks are broken. Full mode
was not retried with containment removed or through another tool/profile. The
independent bare/headless skill experiment does not stand in for the blocked hook
probe: native help explicitly says bare mode skips hooks and Keychain/OAuth reads.

The mock was closed and every disposable fixture was removed. No interactive
native chat, real-chat enrollment, full-mode hook, or native lifecycle experiment
ran. Historical SessionStart-only evidence in `verification.md` remains separate;
it cannot fill in the missing current-action or lifecycle contract.

## Observed and unverified facts

A false verification boolean means **not established**, not necessarily that the
host lacks the feature. Unreached experiments also have `attempted: false`.

| Check | Result | Exact scope / limitation |
| --- | --- | --- |
| Installed native version and help | Verified | Isolated `--version` and `--help`, both exit 0; version 2.1.247 |
| Explicit namespaced plugin skill, present before launch | Verified | `--bare --print --plugin-dir <disposable-plugin>`; no global install |
| Project `.claude/skills` in bare mode | Not loaded in tested configuration | Native reported unknown skill, including with explicit `user,project,local` sources |
| Isolated `CLAUDE_CONFIG_DIR/skills` in bare mode | Not loaded in tested configuration | Native reported unknown skill; no real user profile was tried |
| `${CLAUDE_SESSION_ID}` | **Native template substitution observed** | Expanded plugin skill text matched its own native stream-init ID; the environment variable was not supplied or assumed |
| `$ARGUMENTS` literal text | Observed in expanded plugin skill | Adversarial shell-looking text preserved; no inline shell command tested |
| Two concurrent same-cwd invocations | Distinct native stream IDs observed | Not distinct approved Murmur bindings, and not repeated actions inside already-open chats |
| Native init cwd | Matched the fixture workspace | Stream metadata, not a trusted helper action channel |
| Deterministic helper action with fresh current-chat authority | Unverified | No helper execution, private grant possession, or authentic per-action channel established |
| Already-open skill hot discovery | **Not attempted** | Separate from successful before-launch loading; no reload claim |
| Native resume / fork | **Not attempted** | Help documents flags; no history was fabricated to make resume succeed |
| Fork rejects copied parent helper reference | Unverified | A synthetic predicate test is not native fork evidence |
| Clear rejects copied pre-clear helper reference | Unverified | No actual native clear event or incarnation observed |
| Clear retains ID but invalidates old authority | Unverified; mandatory gate | Must have verified invalidation/incarnation or stay disabled |
| Full-mode hook ordering | Unverified | Containment blocked before native launch; bare mode skips hooks |
| Production existing-chat Claude adapter | **Disabled** | Native action/lifecycle/authorization gates remain false |

Important help distinctions in this exact version:

- `--bare` says it skips hooks and Keychain reads but keeps `/skill-name`
  resolution. Explicit temporary plugin loading was measured separately from
  implicit project/user skill discovery.
- `--print` and non-TTY stdout skip the workspace trust dialog. They are useful
  headless tests, **not proof of interactive trust or hot-loading behavior**.
- `--fork-session` promises a new session ID when resuming. That help text is not
  evidence that a copied helper handle loses authority in an actual fork.

A shared MCP transport, MCP `clientInfo`, or cwd cannot select a chat's grant.
Native IDs remain routing metadata rather than authentication. No Codex probe was
attempted; its known PATH-alias write denial and unresolved hook trust were not
worked around. OpenCode and Cursor also remain gated. Nothing here changes
managed-launch support claims for those hosts.

## Reproduce

Use Node 24+ and an existing absolute `TMPDIR`, from the repository root:

Synthetic fixtures only: no native executable or network.

```bash
node scripts/probe-existing-chat.mjs --self-test
```

The historical native path adds help/version, bare headless skills, and full-mode
containment preflight; it is distinct from the newer explicit lifecycle mode above.

```bash
node scripts/probe-existing-chat.mjs --native --claude /absolute/path/to/claude
```

Without `--claude`, native mode resolves an executable from PATH without starting
a login shell. No arguments means synthetic checks only. `--help` describes the
probe without running it. Invalid, duplicate, missing, or relative executable
options fail before native launch with a static diagnostic.

The JSON report separates `synthetic` from `native.bareSkill`,
`native.experiments`, and the full helper contract under `native.contract`.
`preloadedSkillInvocation` is true only for the measured bare/headless subset;
all helper identity, ordering, authorization, resume/fork/clear, and hot-discovery
gates remain false. `productionAdapterEnabled` is always false in this partial
probe. A normal report, including a blocker, exits 0: **that means the probe
reported its result, not that adapter verification passed**. Invalid options,
failed fixtures, interruption, or harness errors exit 1.

Selected final report facts:

```json
{
  "observedVersion": "2.1.247",
  "exactVersionConfirmed": true,
  "helpConfirmed": true,
  "skillExpansionObserved": true,
  "sessionTemplateSubstituted": true,
  "substitutedIdMatchesOwnInvocation": true,
  "concurrentPluginChatIdsDistinct": true,
  "adversarialArgumentsPreserved": true,
  "shellSideEffectsAbsent": true,
  "deterministicHelperActionExecuted": false,
  "currentChatAuthorizationVerified": false,
  "fullModeRuntimeStarted": false,
  "containmentPreflightPassed": false,
  "productionAdapterEnabled": false,
  "blocker": "os-denied-nested-containment-before-native-launch",
  "localMockRejectedRequests": 2,
  "localMockClosed": true
}
```

Even on a machine where full-mode containment startup succeeds, this partial
script reports `interactive-action-and-lifecycle-driver-not-yet-verified` and does
not proceed to those experiments. Passing `--version` inside a profile is not by
itself proof of every containment property. The full action/lifecycle driver still
requires implementation and empirical verification on a suitable environment.

## Fixture and safety boundaries

The synthetic checks exercise an in-memory `UserPromptSubmit` envelope parser and
scope predicate, **not a production adapter/backend/client**. Only allowlisted
fields influence a bounded UTF-8 JSON parser. Exact fixture-only
`/murmur-probe start|join|status|refresh|leave` actions are parsed without a shell.
Unknown selectors, extra fixed-arity arguments, control characters, malformed IDs
or workspaces, and oversized/invalid UTF-8 input are rejected. Unused transcript
paths and MCP names are ignored, never opened or used as identity.

Synthetic authorization requires separate private proof and matching chat,
workspace, and incarnation. Tests reject missing proof, a different same-cwd chat,
another workspace, an old **simulated** incarnation, and an unverified lifecycle.
They cannot establish native provenance: an object shaped like a hook envelope is
not necessarily a real host event. No native history file is read or fabricated.

The executable probe:

- Uses a new owner-private root only under `$TMPDIR`, with isolated HOME,
  `CLAUDE_CONFIG_DIR`, XDG paths, workspace, plugin/skill assets, and child temp
  directory. It does not spread the parent environment into children. Real
  credentials, native session variables, provider selection, Node options, hooks,
  and shell startup files are not inherited.
- Runs credential-free help/version first. For the distinct bare skill test, it
  relies on the observed native help contract that bare mode does not read
  Keychain/OAuth. Full-mode execution still requires separate containment. It does
  not read/copy real user settings, credentials, auth helpers, or histories.
- Gives bare children only a plainly **dummy** API credential and the owned local
  mock origin. HTTP(S)/all-proxy settings also point at the rejecting mock; the
  explicit provider origin is loopback. The mock has **no upstream transport**,
  rejects requests with 403 and CONNECT without tunneling, and never reads/logs
  request headers. Its bounded in-memory body scanner looks only for the known
  disposable fixture markers in message content, not auth fields or system text.
  It saves neither requests nor native transcript dumps.
- Bounds each child to 8 seconds and combined stdout/stderr to 128 KiB, with a
  45-second overall cancellation timer. Mock input is at most 512 KiB per request,
  with 8 simultaneous connections, 32 requests, and short request/socket timers.
  Only owned `ChildProcess` handles are stopped, including on SIGINT/SIGTERM. No
  process scans, unrelated PID signals, or process-group kills occur. All mock
  sockets/servers close in `finally`. OS scheduling or blocked kernel filesystem
  calls cannot be given a hard real-time guarantee.
- Uses no global installation, permission/trust bypass flags, native trust
  records, real provider/model responses, service descriptors, or persistent dev
  server. Native output and mock input are reduced to booleans/version facts,
  not printed as raw transcripts. Disposable private files are removed afterward.

Validation: JavaScript syntax check, synthetic fixtures, invalid/duplicate option
tests, installed help/version, native before-launch skill-source experiments,
per-invocation ID correlation for concurrent plugin calls, literal adversarial
argument preservation, absent shell side effects, failing full-mode containment,
and fixture cleanup. This is not real-model acceptance or the other agents'
backend/UI test suite.

## Remaining gate before a native helper can ship

1. In a separately approved isolated environment, preserve normal native trust and
   auth checks. Do not preseed trust, import user credentials, or fall back to a
   real profile. Prove the local-only provider/credential boundary before input.
2. Measure actual deterministic command/hook **helper execution** with fresh
   current metadata on every action. Determine slash expansion and hook ordering,
   encoding, workspace association, and repeated-action behavior. Passing a model
   a substituted ID or stale helper path is not that contract.
3. Separately test installation **after a chat is already open**. Report hot
   discovery and any explicit reload/resume requirement honestly. Do not advertise
   unregistered `/murmur`; only the temporary namespaced fixture syntax above was
   measured here.
4. Prove two actual same-cwd chats get distinct approved bindings, and copied
   helper references cannot select each other's grant. Private proof is separate
   from native metadata; neither shared MCP nor cwd passes this gate.
5. Use only native-authored disposable history for explicit resume/fork. Reject a
   copied parent handle in the fork without acting on parent authority. No fake
   history or native-ID-based credential recovery.
6. Exercise actual clear, including same-ID clear if applicable. A copied old
   handle must fail before the next action. Without a verified native invalidation
   event or incarnation marker, **keep the adapter disabled**. A randomly invented
   incarnation or a helper handle preserved in text is insufficient.
7. Implement the separately reviewed private helper/client only after the native
   subset it relies on is established. Its immutable native binding is
   `{ tool, nativeId, incarnationId }`; this probe establishes no native source for
   `incarnationId` yet.

A future helper must discover only **`connection.json`**, containing exactly
`{ protocolVersion, origin, stateId, instanceId }`. Never import the human client,
read `daemon.json`, invoke human discovery, or obtain browser bootstrap/login
tickets. A public review URL is inert. Manual reviewed handoff or a new managed
task is an honest fallback, not attachment to the original chat.
