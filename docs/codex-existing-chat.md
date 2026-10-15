# Connect an existing Codex chat

Murmur can connect an existing **Codex CLI 0.154.0 conversation**, rather than
starting a replacement conversation. Setup exports a fixed `UserPromptSubmit`
hook. A human installs and trusts that hook, resumes the original conversation,
and approves its Murmur participation. After explicit activation, ordinary user
prompts receive fresh advisory coordination context automatically.

This is **explicit resume of the existing conversation**, not hot attachment to
an already-running process. Codex desktop/web attachment, hot hook discovery,
and real model use have not been verified. Managed launches and their separately
gated `--context-hooks` option are unchanged.

## Setup and connect

In a human terminal, with Murmur already initialized and its daemon running:

```bash
murmur connect setup --tool codex --out /absolute/path/to/new-codex-export
```

The destination must not exist. Export refuses native settings directories and
never changes `.codex`, user configuration, existing hooks, workspace files,
conversation history, or native permission settings. It prepares owner-only
helper state outside the source workspace and exports:

- `hooks.json`, containing only the fixed Murmur hook command with absolute paths.
- `SETUP.md`, containing the reviewed installation and chat-message instructions.

Review the export. Append its entry to the `hooks.UserPromptSubmit` array in the
original project's `.codex/hooks.json`. If that file is absent, create it using
the export. **Do not overwrite an existing file or event array.** Keep every
existing permission/policy hook. Install the entry once, not in both project and
user configuration. Murmur deliberately does not use a command-line hook-array
override, which could shadow existing configuration.

Pause or exit the original Codex process. Run the export's `resumeCommand` from
the original project. It enables the documented hooks feature for that launch
and opens Codex's native resume picker. Select the original conversation, not a
fork. Review/trust the project and the exact hook definition using Codex `/hooks`.
Do not bypass hook trust or native approvals. If the hook has not been trusted,
Murmur cannot claim the chat is connected.

Enter these as **ordinary messages inside that Codex conversation**, not terminal
commands and not slash commands:

```text
murmur-connect help
murmur-connect start Password reset | Implement the reset API
```

Or join an existing group using its human-issued invitation:

```text
murmur-connect join INVITE_CODE | Implement the reset UI
```

The invitation is exactly 43 base64url characters. Start and join create only a
pending request. A human reviews and approves that request through the Murmur
dashboard or human connection commands. Approval never comes from the hook or
model. Then enter:

```text
murmur-connect refresh
```

This activates the approved grant and returns current tasks, accepted decisions,
and alerts. Other available messages are:

```text
murmur-connect status
murmur-connect leave
```

Leave revokes participation but preserves the task, source files and conversation.
An expired or revoked connection requires an explicit new request and fresh human
approval. Murmur does not silently renew it.

## Automatic context and identity boundaries

After activation, each ordinary `UserPromptSubmit` asks the existing scoped
connection for fresh context. It does not enroll, poll pending requests, activate
approval, publish decisions or renew grants. Unconnected, pending and left chats
are silent. A connected service failure reports an advisory warning rather than
replaying stale context or changing native tool permissions.

Only the native hook's current `session_id` and canonical `cwd` bind the helper.
Command-line IDs, environment thread IDs, parent/fork selectors, copied handles
and transcript paths cannot select another connection. Resume keeps the original
thread binding. Fork/new conversations with new IDs need independent approval.
Codex documents that subagent hooks use the parent session ID, so this capability
is **parent-conversation scope including its subagents**, not independent subagent
identity or proof that a command was human-authored. Human approval remains a
separate authority boundary.

Murmur creates independent private proofs and task scopes for separate chats in
the same directory. It does not merge their histories or transfer task ownership.
Managed/external-scoped processes cannot create a second connection; their
ordinary prompts skip this existing-chat hook.

Hook input is bounded to 16 KiB, output to 6,000 encoded bytes. Briefings label
project content as advisory data. Accepted decisions and alerts retain separate
budgets. Private capabilities and polling secrets stay in private helper state
and are not printed into the chat.

## Verification scope

The installed Codex CLI 0.154.0 accepts the documented UserPromptSubmit command
hook schema and rejects an invalid timeout in that same event. This was checked
using metadata-only feature listing in a disposable HOME and CODEX_HOME, without
credentials or model calls. Parser acceptance alone is not native turn evidence.

The production connector was also exercised with the actual Codex CLI 0.154.0
against a disposable Murmur daemon and an owned local static Responses responder.
The native fixture verified:

- The hook's current UUID matches the CLI-issued thread ID and creates a pending request.
- Human approval followed by exact-thread resume injects the scoped briefing into
  developer-role model input.
- A newly accepted decision arrives on the next ordinary prompt without manual refresh.
- Separate chats in the same directory keep distinct grants, task owners and tasks.
- A real native fork does not inherit the parent grant, and a new thread does not enroll.
- Leave preserves both tasks and the other chat's grant and automatic refresh.

Run the opt-in native fixture from a built source checkout:

```bash
node scripts/probe-codex-connector.mjs --codex /absolute/path/to/codex
```

The historical fixture used disposable configuration, native-authored fixture
history and dummy credentials, but also **bypassed hook trust and pretrusted its
project**. The native results above are conditional on those settings. It made no
model tool calls; absence of sandbox-bypass flags does not prove runtime permission
enforcement. No successful normal-trust lifecycle trial or real-model inference
was recorded. Interactive `/hooks` and project trust remain unverified.

The current probe no longer bypasses hook trust or writes a pretrusted project.
It must stop at native trust requirements rather than force activation. Exported
user setup has never included those bypass settings. The fixture does not read user
conversations. Each headless turn resumes its original native thread; this is not
proof of same-process hot loading or desktop/web attachment.

Synthetic host-envelope, scoped-helper and setup/export regression tests also
cover parser boundaries, private proof isolation, unlinked prompts creating no
helper files, approved-but-unactivated leave, and literal dollar-sign paths.
Setup preflights the exact version rather than guessing compatibility. None of
these checks proves that a real model read or followed the supplied context.

Authoritative host references:

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)

See [session linking](session-linking.md) for human review, grant scopes and
reconnection, and the [support matrix](support-matrix.md) for other providers.
