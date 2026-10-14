# What is left before releasing Murmur?

The **0.5 development alpha** adds a version-scoped **Claude Code 2.1.247 same-chat
connector** to the existing managed launchers, scoped MCP, advisory hooks, and 0.4
human-reviewed groups/API/handoffs. The exported production plugin passed headless
native fixture verification through explicit plugin loading and native resume.
Direct hot attachment, other native hosts/versions, automatic background publication,
real-user/model acceptance, and broader native MCP remain separate gates. This is
**not the automatic four-tool release**.

## 1. Automatic participation — highest priority

- [x] Implement a descriptor-free scoped CLI client and isolated supervisor authority.
- [x] Implement opt-in new-task/workspace launchers for Claude Code and Codex.
- [x] Add managed expiry/end semantics that preserve task intent and source work.
- [ ] Verify the managed flow with real model-driven sessions, not only fake executables.
- [x] Implement the official MCP bridge with an explicit project/session identity.
      It must not fall back to the human/admin credential.
- [x] Enable Claude 2.1.247's fixed-hook existing-chat connector for the observed
      explicit plugin + native resume flow only.
- [ ] Establish versioned existing-chat contracts for Codex, OpenCode, Cursor, and
      other Claude versions. Binary detection is not connection or verification.
- [x] Add human-reviewed external grants with fixed own-task scope and explicit
      eligible same-task reconnect; expiry/leave preserve task ownership and files.
- [ ] Deliver automatic ongoing context/decision updates and intent publication at
      verified interaction points. Claude 0.5 refresh is explicit, command-driven.
- [ ] Verify direct hot attachment/reload into an already-open native CLI. Attaching
      a workspace record never relocates an existing process.
- [ ] Add verified native installation/update/removal that preserves existing agent
      configuration. Preview changes and distinguish configured/connected/verified.
      The current Claude setup is export plus explicit `--plugin-dir`, not installation.
- [ ] Implement/test any supported pre-write checks and clearly disclose fail-open,
      timeout, shell-write, and unsupported-version limitations.

**Done when:** a new user can connect the four supported tools and run five related
local sessions, with relevant coordination reaching them through tested integration
points rather than the user copying context manually. Differences in capabilities
must remain visible; no universal enforcement claim.

## 2. Engineering and compatibility gates

- [x] Install/pin the TypeScript compiler, Node declarations, and chosen SDK dependencies.
- [x] Establish strict type checking and dependency/license-complete local packaging
      in prior checkpoints; retain these as required checks for every increment.
- [ ] Record final 0.5 consolidated tests and local package acceptance after rerunning.
- [ ] Complete a dependency security/advisory review for release.
- [ ] Run CI on the declared Node/platform matrix. Current local evidence is macOS
      with Node 26; Node 24 and Linux are not yet release-verified.
- [ ] Run real-user/model application acceptance, beyond native CLI static-response
      fixtures, JSON fixtures, and simulated clients.
- [ ] Exercise changed tool versions, duplicate/out-of-order events, disconnected
      adapters, long-running sessions, daemon restart, and stale agent context.
- [ ] Verify package installation/upgrade and adapter onboarding outside the author's setup.
- [ ] Define retention, credential revocation/rotation, backup, and support policies
      appropriate to the released scope. Never remove uncommitted work automatically.
- [x] Enable and verify GitHub private vulnerability reporting for the public repository.

**Done when:** published claims match observed capabilities and supported versions,
and failures preserve work and explain how to recover.

Automated runtime and SDK tests are meaningful evidence for local coordination and
Git workflows; native headless checks add evidence for the exact host contract they
exercise. Neither proves model compliance. Static type safety has its own required
compiler check. Moving the browser-native UI to React is not itself a release gate.

## 3. User onboarding and open-source distribution

- [x] Add a dashboard-first user guide with source and local-package installation.
- [x] Distinguish manual/API groups, managed launch/group requests, MCP/hooks, the
      Claude-only native resume connector, and gated other-host/hot-attachment paths.
- [x] Document Connections review, hash-only invitations, fixed grant expiry, explicit
      reconnect, and reviewed replacement handoffs without chat import or takeover.
- [x] Preserve reported already-changed paths and a distinct remaining-work checklist
      in human handoff review/export, without presenting them as filesystem evidence.
- [x] Document human-terminal Claude setup in the original project, actual version
      preflight, new output directory, pause/exit before resume, and repeated
      `--plugin-dir` use. No `--force`, automatic native config edit, or global install.
- [x] Explain workspace attachment, context sharing, validation setup, and final Git handoff.
- [ ] Test the guide with someone who has not seen the project before, including an
      explicitly approved real-chat/model trial.
- [ ] Reduce onboarding friction while retaining human review and native trust choices.
- [ ] Add exact setup/walkthroughs for other hosts only after their contracts are verified.
- [x] Verify and create the public source repository at [boyeesu/murmur](https://github.com/boyeesu/murmur) with explicit authorization.
- [ ] Verify the package name/namespace before reserving it.
- [ ] Publish a versioned package **only with explicit authorization**.
- [ ] Add release automation, checksums, supported-version documentation, and an upgrade path.

**Done when:** a first-time user can go from public installation instructions to one
real coordinated workflow without guessing the folder, terminal, credential, or native
configuration. A local 0.5 package is not an npm publication or global native install.

## 4. Existing-chat linking release gates

- [x] Add project-scoped groups without reusing the exclusive active-work feature key.
- [x] Require authenticated human workspace inspection and exact revision/digest
      approval; never promote an unreviewed workspace hint to a verified project.
- [x] Store only hashes of single-use public invitation codes; keep browser login
      tickets, candidate capabilities, and polling proof out of shared output.
- [x] Distinguish pending, approved-but-unused, bridge contact, expired, and revoked.
      Activity does not renew the default 8-hour / maximum 24-hour external grant.
- [x] Keep external authority separate from managed supervision and human authority.
      Neither a shared MCP server nor native IDs/cwd alone can choose another chat's grant.
- [x] Refuse native-hook commands in processes with any `MURMUR_AGENT_` or
      `MURMUR_EXTERNAL_` environment marker. Existing scoped processes use their
      current agent/MCP or external commands, not a second connection.
- [x] Keep existing workspaces/tasks intact; fresh reconnect and replacement launch
      are explicit choices, never automatic ownership transfer, file copy, or stop.
- [x] Verify Claude 2.1.247's fixed `UserPromptSubmit` raw command/current UUID/cwd path
      with actual native CLI execution, not just synthetic envelope objects.
- [x] Exercise the **exported production plugin** with human approval and native resume,
      two same-cwd chats with separate approved owners, and scoped context refresh.
- [x] Observe native resume retaining UUID, fork creating a new UUID, and clear
      emitting reset/new UUID; production fork/clear status reports disconnected.
- [x] Verify explicit original resume still works with valid authority, and leave
      revokes only that grant while retaining tasks and the other chat's grant.
- [ ] Verify direct already-open hot discovery/reload separately; pre-resume plugin
      loading is not evidence for this capability.
- [ ] Establish safe same-ID clear/invalidation if a future supported host/version
      uses it. Do not generalize the observed 2.1.247 new-UUID behavior.
- [ ] Verify native installation/update/removal only through explicit opt-in while
      preserving unrelated settings and normal trust/permission choices.
- [ ] Run real-user/model acceptance; verify model use of context, not just its delivery.

### Native evidence checkpoints

**Historical 0.4 — 2026-10-14:** Claude 2.1.247 help/version and a bare, headless,
explicitly preloaded plugin subset were observed. Session-ID substitution reached a
rejecting local mock without model response or approved helper action. Additional
full-mode containment was denied before native launch. Action, clear/resume/fork,
and hot-discovery gates were false then; that failure remains in the record.

**New 0.5 — 2026-10-14:** the explicit lifecycle experiment and production-plugin
integration passed with native-authored disposable history, empty HOME/config, dummy
credentials, and an owned static loopback responder with **no actual LLM inference**.
These were headless CLI checks, not real-user chats or hot-reload trials. Later
explicit `--lifecycle` runs used the existing outer environment; no additional OS
sandbox or absence-of-Keychain-access proof was established.

**Ship rule:** enable only the observed Claude 2.1.247 explicit plugin/resume path.
Keep other native hosts, generic MCP attachment, and direct hot-attachment claims
gated. Use `/murmur:connect`, never an invented universal `/murmur` or `@murmur` alias.
Export is not installation or enrollment; refresh is command-driven, not automatic
background publication or proof of model obedience. Manual/API groups and managed
group requests remain usable independently; reviewed new-task handoffs remain the
fallback for unsupported hosts.

See [the user's completion checklist](user-guide.md#completion-checklist-what-05-does-and-does-not-establish),
[groups and approved connections](session-linking.md), [support matrix](support-matrix.md),
and [native evidence](verification-existing-chats.md). No new aggregate test count,
real-model acceptance, package publication, or multiuser-hosting claim is made here.
