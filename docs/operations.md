# Operations and integration installation

This guide describes the implemented human-operated installation lifecycle. It
is not evidence of a published release, a successful live model run, native hot
attachment, or support on an untested platform. See the [support matrix](support-matrix.md)
and [native verification record](verification-existing-chats.md) for those boundaries.
For credentials, retention, backup, restore, and database upgrades, use the
[data lifecycle guide](data-lifecycle.md).

## Start with inspection

Examples use the installed `murmur` CLI and a POSIX shell. Install a trusted local
package as described in the [user guide](user-guide.md#install-from-the-local-package);
package installation does **not** activate a native connector. Node.js 24 or later
is required. Do not assume an unrelated package named `murmur` is this project.

Run administrative commands in your own human terminal, not through a coding
agent's scoped terminal or MCP bridge. Managed/external credentials cannot install
integrations or perform maintenance. A scoped-environment refusal is a boundary,
not a reason to remove scope markers and retry as a human.

```bash
murmur integrations --help
murmur maintenance --help
murmur doctor --json
murmur status --json
```

Use the same state directory for the daemon and every administrative terminal.
`MURMUR_HOME` overrides the default. Default locations are:

| Platform | State directory |
| --- | --- |
| macOS | `$HOME/Library/Application Support/Murmur` |
| Other platforms | `$XDG_STATE_HOME/murmur`, or `$HOME/.local/state/murmur` when `XDG_STATE_HOME` is unset |

These are location rules, not cross-platform verification claims. Use an owned,
private directory outside any source checkout or agent workspace. Existing unsafe
permissions, symlinked installer paths, unknown files, and state/source overlap
are refused rather than repaired automatically. For an explicit override, set
`MURMUR_HOME` to an **existing absolute canonical private path** in each terminal.

If the daemon is not running, start it in a dedicated human terminal:

```bash
murmur daemon start
```

It runs in the foreground. In another terminal, from the original application
project (not necessarily Murmur's source checkout):

```bash
PROJECT_ROOT="$(pwd -P)"
murmur init --root "$PROJECT_ROOT"
murmur integrations inspect --root "$PROJECT_ROOT"
murmur connect grants
```

`init` registers the project; it is not an installation step. Installer inspection
reads existing installation state without creating an installation registry.
Install/update planning needs the daemon's public `connection.json` and safe
runtime paths. Daemon-backed status, grant inspection, and maintenance require
human authentication to the local daemon.

## Private installation files

Under the selected state directory, the installer uses:

| Relative location | Purpose |
| --- | --- |
| `integrations/registry.json` | Installation identity, versions, generation, consumed approvals, and pending transaction |
| `integrations/plans/` | Saved, content-bound plans; planning writes here, not to native settings |
| `integrations/objects/` | SHA-256-addressed content snapshots used for rollback and recovery |
| `integrations/bundles/` | Project/provider-specific, versioned executable integration assets |
| `integrations/transactions/` | Durable apply journals, staging/removal evidence, and preserved lock-repair bytes |
| `integrations/operation.lock` | Exclusive installation-operation lock |
| `existing-chats/claude/`, `existing-chats/codex/` | Separate private runtime helper state; not uninstallable bundle content |

Private directories are owner-only and files are mode `0600`. Keep plans,
journals, configuration snapshots, and helper files private: a saved snapshot of
an existing native config can contain sensitive user content. Do not commit them,
publish them, or move them into a project to bypass a path refusal.

`daemon.json` contains human daemon authority; it must never be passed to a native
hook or shared in a report. `connection.json` is the public, non-credential
connection descriptor used by hooks, although its file is kept inside private
state. Neither a descriptor nor an installation plan grants chat participation.
The database-only maintenance backup does **not** back up the installer registry,
these bundles, or helper files; see [backup scope](data-lifecycle.md#private-consistent-backup).

## Four distinct states

Do not compress these into a single “connected” indicator:

| State | What the current installer can establish |
| --- | --- |
| Installed bundle | `installedBundle: true` means an active registered bundle exists and its owned files match their hashes. `status: installed` alone does not establish file integrity. |
| Native configured | `nativeConfigured: true` means the exact owned Codex hook entry was found. Claude's bundle-only strategy deliberately reports false because it does not persist native configuration. |
| Native loaded | Always reported as `nativeLoaded: unverified` by installation inspection/apply. Files or config on disk do not prove a running host loaded them. |
| Chat connected | Separate native helper activation and human-approved, unexpired scoped grant. Inspect grants and the current chat's status; installation never approves or renews access. |

`integrity` distinguishes `unchanged`, `missing`, `modified`, and `not-installed`.
A recent scoped request is not a native heartbeat, proof that a model used the
context, or proof that an already-running process noticed new configuration.

## Plan, inspect, then apply

All four verbs below are **preview-only**. `install` is shorthand for
`plan --action install`; it does not silently apply the plan.

```bash
murmur integrations install --provider claude --root "$PROJECT_ROOT"
# Equivalent explicit form:
murmur integrations plan --action install --provider claude --root "$PROJECT_ROOT"
```

Run one form, then review that returned plan. Separate invocations create separate
plan IDs. Codex has its own explicit preview:

```bash
murmur integrations install --provider codex --root "$PROJECT_ROOT"
```

Review `action`, `provider`, `projectRoot`, `installationId`, `affectedPaths`,
`beforeHash`/`afterHash`, `nativeConfigurationChanges`, `backupPaths`,
`preservedPaths`, `requestedBehavior`, `activation`, and `expiresAt`. Review any
linked grants independently. A plan is not read-only in the filesystem: it saves
private review material, but does not install bundle files or change native hooks.

Plans expire after 15 minutes and bind the exact registry generation, directory
identities, observed runtime/descriptor files, and affected file contents. Apply
requires the exact **one-use** plan ID, SHA-256 plan hash, and decimal generation.
Replace the three example values with the fields from the plan you actually
reviewed; do not guess a generation or reuse values from another preview.

```bash
PLAN_ID='REPLACE_WITH_PLAN_ID'
PLAN_HASH='REPLACE_WITH_PLAN_HASH'
PLAN_GENERATION='REPLACE_WITH_GENERATION'
murmur integrations apply --plan "$PLAN_ID" --hash "$PLAN_HASH" --generation "$PLAN_GENERATION"
murmur integrations inspect --root "$PROJECT_ROOT"
```

A stale or changed plan is refused; make and review a fresh plan instead of forcing
an overwrite. There is no `--force`, automatic trust change, or native launch.
Apply consumes the approval and records a durable pending journal before modifying
files. A successful result still leaves native activation to you.

### Claude: bundle-only, explicit activation

The enabled strategy prepares a private plugin bundle for **Claude Code 2.1.247**.
It checks the actual executable/version with an isolated metadata-only `--version`
probe. It does **not** run the native plugin installer, edit Claude settings,
register a marketplace, change permissions/trust, or attach to an open chat.
Automatic native installation is disabled because the observed native installer
also changes opaque profile files and formatting outside the reviewed surface.

After apply, inspect `activation.executable`, `activation.args`, `activation.cwd`,
and `activation.instructions`. Pause or exit the original CLI yourself, then use
that exact resolved executable with `--plugin-dir` pointing at the active bundle
and `--resume`, from the original project. Select the original conversation in
the native picker. Pass `--plugin-dir` on **every** resume; no persistent native
installation has been created. Do not blindly execute a JSON string as shell code.

Inside that chat, `/murmur:connect help` describes the native entrypoint. Start/join
still needs separate human review and approval, followed by explicit refresh.
See the [Claude connection walkthrough](session-linking.md#connect-an-existing-claude-conversation).
Bundle update does not replace a plugin already loaded in a running process.

### Codex: additive project hook, explicit trust and resume

The enabled strategy targets the observed **Codex CLI 0.154.0** contract. It
prepares a private hook bundle and previews an additive edit to the original
project's `.codex/hooks.json`. The edit appends exactly one owned matcher group to
`hooks.UserPromptSubmit`. Update replaces only that owned entry; uninstall removes
only an unchanged owned entry. Existing unrelated hooks, comments, permission
rules, and native trust choices are preserved. Ambiguous, duplicate, or changed
content is refused or preserved, not overwritten wholesale.

Unlike `connect setup`, this installer does not itself preflight the Codex binary's
version: confirm that you are using the tested version. It validates the Murmur
runtime and public descriptor, not native loading. The hook config is a reviewed
project edit; it is the exception to the private-bundle-only write boundary.
Review its source-control diff before committing it anywhere: the fixed command
contains absolute machine-local paths and is not a portable repository default.

Pause/exit the original Codex process yourself. From the original project, use
the tested native resume flow with hooks enabled (`codex -c 'features.hooks=true'
resume`), choose the original conversation, and inspect/approve the exact hook
through native `/hooks` and normal project trust. Never enable
`allow-untrusted-hooks` or bypass sandbox/permission settings to make it work.
The installer does not run Codex or approve native trust for you.

Enter `murmur-connect help` as an ordinary chat message, not a terminal or slash
command. Start/join, Murmur human approval, and explicit refresh are separate
steps. Ordinary prompts refresh context only after an approved connection has
been activated; they do not enroll, poll approval, or renew access. Follow the
[Codex guide](codex-existing-chat.md) for the complete connection lifecycle.
Do not also hand-append the exported hook if the installer already owns it.

### OpenCode and Cursor: disabled

`inspect` reports their strategies and limitations, but install/update is gated
with `INSTALLATION_PROVIDER_UNVERIFIED`. Do not infer support from a provider name,
an available executable, generated metadata, or separate managed-launch support.
There is no production existing-chat installation path to enable by changing a
flag. Consult the [support matrix](support-matrix.md).

## Update, uninstall, and rollback

Inspect first, then preview one requested operation for an existing installation:

```bash
murmur integrations inspect --root "$PROJECT_ROOT" --provider codex
murmur integrations update --provider codex --root "$PROJECT_ROOT"
# Alternatives, not additional steps to run blindly:
murmur integrations uninstall --provider codex --root "$PROJECT_ROOT"
murmur integrations rollback --provider codex --root "$PROJECT_ROOT"
```

Each produces a new plan and needs its own exact `apply` approval. Optional
`--installation ID` must match the provider/project installation; it is not an
arbitrary path selector. Update creates a new version. Rollback selects the prior
active version from private snapshots, **not** an arbitrary software/database
version. If the prior active version is absent (for example, before the first
install), rollback can plan removal instead; inspect the actual plan.

Uninstall is a real file-removal operation once applied. It removes only unchanged
Murmur-owned bundle files and the exact owned Codex hook entry. Modified or
untracked content is retained and reported in `preservedPaths`; helper state,
private snapshots, registry/history, tasks, source files, workspaces, branches,
and running chats remain. A retained edited hook may still refer to Murmur.
Removal is not secure erasure, a task abandonment, or a stop command. Rollback and
update refuse edited bundle collisions rather than replacing user changes.

### Uninstall does not revoke grants

The direct CLI installation service currently reports `grantDiscovery: unavailable`;
an empty `linkedGrants` array does **not** mean there are no grants. The daemon/
dashboard installation service separately supplies grant discovery for the matching
project root and provider. Its reported grants are review metadata, not a promise
of native loading or revocation. In either surface, inspect authority separately
with the human connection commands:

```bash
murmur connect grants
# Or narrow the inspection to a known project:
murmur connect grants --project "$PROJECT_ID"
```

Installation results explicitly report `grantsRevoked: false`. A loaded helper
or another holder of a still-valid capability can retain access after uninstall.
If access should end, inspect the exact grant and revoke it as a separate,
deliberate action:

```bash
murmur connect revoke --grant "$GRANT_ID" --request-id uninstall-access-review-1
```

Use IDs from your actual inspection and a new request ID for a different action.
Revocation ends that grant, not task ownership or the native process. Reconnection
requires the separately reviewed eligible reconnect flow; uninstall/rollback
cannot restore or renew a grant.

## Interrupted apply: recover, never replay

After a timeout, crash, or uncertain apply response, inspect before doing anything
else. If `pending` is absent and the expected version is installed, the apply may
already have committed. Do not repeat its consumed approval.

```bash
murmur integrations inspect --root "$PROJECT_ROOT"
```

Review both `pending` and `lock`. A null `lock` means no operation lock was found;
otherwise its `state` is `active`, `stale`, `unreadable`, or `unsafe`.
`lock.approval` may identify the exact operation even if there is no pending
registry transaction. `lock.fingerprint` pins the inspected file identity and
contents, not just a hash of possibly empty lock bytes; copy it from inspection,
never calculate a substitute. An unsafe lock has no usable fingerprint.

When `pending` exists, use **its** `planId`, `planHash`, and `generation`, not the
new top-level registry generation:

```bash
murmur integrations recover --plan "$PLAN_ID" --hash "$PLAN_HASH" --generation "$PLAN_GENERATION"
murmur integrations inspect --root "$PROJECT_ROOT"
```

For a pending transaction, `recover` **aborts that exact transaction**. It does not
resume apply or authorize another installation. It restores pre-apply content
only where transaction evidence permits, removes unchanged newly-created content,
and removes only empty directories it created. A later user edit or deletion
causes `INSTALLATION_RECOVERY_CONFLICT`; the change is preserved and recovery
remains pending. Retain the private evidence and resolve the conflict with
human inspection, not recursive deletion or a hand-edited registry.

A stale, readable lock can also outlive an operation that committed, or one that
stopped before recording a pending transaction. With no `pending`, use the exact
approval from `lock.approval` for `recover`; do not substitute another plan.
Recovery releases that matching stale lock without replaying the requested change
or rolling back a committed installation. An unconsumed pre-transaction approval
is consumed so it cannot later execute. Inspect the resulting installation before
creating a new plan.

Recovery checks that a recorded lock owner is no longer alive; it never sends a
stop signal. A known live owner, reused PID, or uncertain permission check remains
busy conservatively. An unreadable lock cannot establish a trustworthy owner and
requires the separate repair procedure below. An unknown registry, missing
snapshot, unsafe lock, or unresolved content conflict remains a support/inspection
case, not permission to delete state.

### Repair an unreadable or orphan lock

`repair-lock` is an explicit filesystem mutation, **not** a process-stop command
or a substitute for transaction recovery. First stop **all installer processes
yourself**, including the service owning an installation operation if applicable.
Do not assert `--owner-stopped` while an installer can still write. A malformed
record cannot prove its owner is stopped; that confirmation is the human's
responsibility. A known live owner is refused even with the flag.

After stopping those processes, inspect again and review the lock state, exact
`lock.fingerprint`, and **top-level registry `generation`**. For a repairable
lock, replace these example values with that fresh inspection:

```bash
murmur integrations inspect --root "$PROJECT_ROOT"
LOCK_FINGERPRINT='REPLACE_WITH_LOCK_FINGERPRINT'
REGISTRY_GENERATION='REPLACE_WITH_REGISTRY_GENERATION'
murmur integrations repair-lock --fingerprint "$LOCK_FINGERPRINT" --generation "$REGISTRY_GENERATION" --owner-stopped
murmur integrations inspect --root "$PROJECT_ROOT"
```

Repair refuses a changed fingerprint/generation, a known live owner, or unsafe
filesystem authority. It preserves the original lock bytes in a private
`integrations/transactions/lock-repair-….json` file before removing the operation
lock, and returns that `preservedPath`. The preserved bytes may be malformed JSON;
keep them for private inspection rather than executing or publishing them.

Repair leaves the registry generation, consumed approvals, and any pending
transaction unchanged. If `pending` remains afterward, perform a separate
`recover` with its exact approval. Repair neither applies a plan nor repairs a
bundle/configuration conflict. For `state: unsafe` with a null fingerprint, do not
guess a hash or remove the file manually; investigate the unsafe path/ownership
with appropriate human support. After recovery, create and review a **new** plan
if the change is still wanted. Consumed approvals remain consumed.

## Reporting a problem

Start with redacted `doctor --json`, installation inspection, and the specific
command/error code. Report Murmur/Node/native-tool versions, OS, provider, action,
plan expiry/generation, `pending` presence, `lock.state`, integrity/configuration/loading fields,
and whether failure happened at preview, apply, activation, or chat approval.
Replace private paths, project names, account details, and environment values
before sharing even nominally public JSON. A hash-only field is not a credential,
but a config snapshot or retry file may be.

Never attach `daemon.json`, database backups, credential/retry files, helper
capabilities, invitation/polling secrets, browser sign-in URLs, native auth files,
or full private installation journals to a public issue. Do not publish proxy or
account configuration. Preserve originals locally when investigating.

A passing installer test or intact bundle does not establish interactive native
trust, desktop/web parity, hot attachment, platform coverage, real model behavior,
or public package publication. Report those gates as unverified unless the
specific [verification evidence](verification-existing-chats.md) establishes them.
