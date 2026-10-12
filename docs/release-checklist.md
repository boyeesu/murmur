# What is left before releasing Murmur?

The local workbench now includes a **managed CLI launch increment for Claude Code
and Codex**. It automates new-session setup and initial context with scoped commands.
Official MCP/native hooks, the other two launchers, and live four-tool verification
are still missing, so this is not yet the four-tool release.

## 1. Automatic participation — highest priority

- [x] Implement a descriptor-free scoped CLI client and isolated supervisor authority.
- [x] Implement opt-in new-task/workspace launchers for Claude Code and Codex.
- [x] Add managed expiry/end semantics that preserve task intent and source work.
- [ ] Verify the managed flow with real model-driven sessions, not only fake executables.

- [ ] Implement the official MCP bridge with an explicit project/session identity.
      It must not fall back to the human/admin credential.
- [ ] Implement Claude Code, Codex, Cursor, and OpenCode adapters against verified,
      versioned integration contracts. Binary detection is not connection or verification.
- [ ] Register/reconnect/end sessions reliably. A stopped response is not a finished task.
- [ ] Deliver relevant context and decision updates at supported interaction points;
      capture/update intent without expecting the user to relay every message.
- [ ] Add verified launch/attach flows. Never imply that attaching a record relocates
      an existing process or that every shell write can be intercepted.
- [ ] Add installation, update, removal, and diagnostics that preserve existing agent
      configuration. Preview changes and distinguish configured/connected/verified.
- [ ] Implement/test any supported pre-write checks and clearly disclose fail-open,
      timeout, shell-write, and unsupported-version limitations.

**Done when:** a new user can connect the four supported tools and run five related
local sessions, with relevant coordination reaching them through tested integration
points rather than the user copying context manually. Differences in capabilities
must remain visible; no universal enforcement claim.

## 2. Engineering and compatibility gates

- [ ] Install/pin the TypeScript compiler, Node declarations, and chosen SDK dependencies.
- [ ] Pass real static type checking and review dependency licenses/security.
- [ ] Run CI on the declared Node/platform matrix. Current local evidence is macOS
      with Node 26; Node 24 and Linux are not yet release-verified.
- [ ] Run real application tests, not only JSON fixtures or simulated clients.
- [ ] Exercise changed tool versions, duplicate/out-of-order events, disconnected
      adapters, long-running sessions, daemon restart, and stale agent context.
- [ ] Verify package installation/upgrade and adapter onboarding outside the author's setup.
- [ ] Define retention, credential revocation/rotation, backup, and support policies
      appropriate to the released scope. Never remove uncommitted work automatically.
- [x] Enable and verify GitHub private vulnerability reporting for the public repository.

**Done when:** published claims match observed capabilities and supported versions,
and failures preserve work and explain how to recover.

The existing 152 runtime tests are meaningful evidence for the local coordination
and Git workflow. They do not establish native integration correctness or static
type safety. Moving the working browser-native UI to React is not itself a release
gate; delivering reliable behavior and maintainable checks is.

## 3. User onboarding and open-source distribution

- [x] Add a dashboard-first user guide with source and local-package installation.
- [x] Distinguish manual participation from managed CLI launches and unimplemented native MCP/hooks.
- [x] Explain workspace attachment, context sharing, validation setup, and final Git handoff.
- [ ] Test the guide with someone who has not seen the project before.
- [ ] Reduce onboarding friction: guided tool connection, clearer owner/workspace
      setup, and forms that do not require users to manage raw JSON/configuration
      revisions for routine tasks. Keep advanced inputs available when useful.
- [ ] Once adapters exist, add exact per-tool setup and a short end-to-end walkthrough.
- [x] Verify and create the public source repository at [boyeesu/murmur](https://github.com/boyeesu/murmur) with explicit authorization.
- [ ] Verify the package name/namespace before reserving it.
- [ ] Publish a versioned package **only with explicit authorization**.
- [ ] Add release automation, checksums, supported-version documentation, and an upgrade path.

**Done when:** a first-time user can go from the public installation instructions to
one real coordinated workflow without guessing which folder, terminal, credential,
or agent configuration to use.

## Current access blocker

The development environment rejected npm downloads with `403 Forbidden`, and
direct vendor-documentation retrieval also failed. Authorization in chat did not
change that network policy. The environment must permit the required package and
official documentation access before the planned SDK/toolchain work can be completed
and checked. Tool availability and any application-specific permissions must then
be verified separately.

Removing that blocker does **not** automatically implement the missing adapters.
The next development focus should be real-model validation of managed launches,
then the official MCP/native hook layers and Cursor/OpenCode—not more dashboard features.
