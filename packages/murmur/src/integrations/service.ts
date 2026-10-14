import { lstat, mkdir, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assert, canonicalJson, MurmurError } from '../protocol/index.js';
import { humanEnvironment } from '../cli/human-input.js';
import { createClaudeInstallationStrategy } from './claude.js';
import { createCodexInstallationStrategy } from './codex.js';
import { createOpenCodeExistingChatStrategy } from '../adapters/opencode-existing-chat.js';
import { createCursorExistingChatStrategy } from '../adapters/cursor-existing-chat.js';
import { atomicReplace, decode, digest, directoryInfo, directoryStamp, DirectoryGuard, encode, exists, inside, literalPath, matches, normalizeStaging, publishNew, readSafe, relativePath, replaceCompared, sameDirectory, snapshot, syncDirectory } from './filesystem.js';
import type { DirectoryStamp, FileStamp } from './filesystem.js';
import type { InstallationActivation, InstallationApproval, InstallationBundle, InstallationInspection, InstallationLockInspection, InstallationLockRepair, InstallationLockRepairResult, InstallationPlan, InstallationPlanRequest, InstallationProjectHook, InstallationProvider, InstallationResult, InstallationStrategy, InstallationSummary, LinkedInstallationGrant } from './types.js';
import { appendInstallationJsoncArrayItem, parseInstallationJsonc, removeInstallationJsoncArrayItem } from './jsonc.js';

const warning = 'Bundle or hook-file installation is not proof of native loading or a chat connection. Only previewed owned hook entries may change; native permissions/trust, tasks, workspaces and running processes are untouched. Linked grants are not revoked; review them separately before any explicit revocation.';
const idPattern = /^ins_[a-f0-9]{24}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const providers = ['claude', 'codex', 'opencode', 'cursor'];
const hashPattern = /^[a-f0-9]{64}$/;
const maxFiles = 128, maxBytes = 1024 * 1024;
type Asset = { path: string; hash: string };
type Version = { id: string; strategyVersion: string; files: Asset[]; activation: InstallationActivation; runtimeDirectories: string[]; present: boolean; projectHook?: InstallationProjectHook };
type RecordEntry = { installationId: string; provider: InstallationProvider; projectRoot: string; activeVersion: string | null; previousActiveVersion: string | null; versions: Version[]; preservedPaths: string[] };
type Operation = { path: string; before: FileStamp | null; after: string | null; nativeConfig?: boolean };
type Observation = { path: string; dev: number; ino: number; birthtimeMs: number; mtimeMs: number; ctimeMs: number; size: number; mode: number; uid: number; gid: number; nlink: number };
type InputFile = { path: string; stamp: FileStamp | null; nativeConfig: boolean };
type PlanFile = { schemaVersion: 1; preview: Omit<InstallationPlan, 'planHash'>; before: RecordEntry | null; after: RecordEntry; operations: Operation[]; directories: string[]; directoryPins: Array<{ path: string; stamp: DirectoryStamp; privateOnly: boolean }>; observations: Observation[]; inputFiles: InputFile[]; objects: Array<{ hash: string; content: string }> };
type Pending = InstallationApproval & { journalHash: string };
type LockRecord = { schemaVersion: 1; pid: number; nonce: string; approval?: InstallationApproval | null };
type LockFile = { content: string; stamp: FileStamp; record: LockRecord | null; staging: string | null };
type Registry = { schemaVersion: 1; generation: number; installations: RecordEntry[]; consumed: string[]; pending: Pending | null };
export type InstallationServiceOptions = {
  stateDirectory: string;
  strategies?: InstallationStrategy[];
  env?: NodeJS.ProcessEnv;
  linkedGrants?: (query: { provider: InstallationProvider; projectRoot: string; installationId: string }) => Promise<LinkedInstallationGrant[]>;
  /** Test-only crash seam. Never exposed through CLI, HTTP or native input. */
  checkpoint?: (phase: 'prepared' | 'operation' | 'committed', index: number) => void | Promise<void>;
  now?: () => number;
};
export type InstallationServiceAPI = Pick<InstallationService, 'inspect' | 'plan' | 'apply' | 'recover' | 'repairLock'>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function schema(condition: unknown): asserts condition { assert(condition, 'Unknown or invalid installation registry schema.', 'INSTALLATION_SCHEMA'); }
function validActivation(value: InstallationActivation, projectRoot: string): void {
  schema(value && ['explicit-command', 'manual'].includes(value.kind) && value.cwd === projectRoot && value.nativeLoaded === 'unverified' && typeof value.instructions === 'string' && value.instructions.length <= 8192 && typeof value.testedVersion === 'string');
  if (value.kind === 'explicit-command') schema(typeof value.executable === 'string' && path.isAbsolute(value.executable) && Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')));
}
function validateProjectHook(hook: InstallationProjectHook, provider: InstallationProvider): void {
  schema(provider === 'codex' && hook.path === '.codex/hooks.json' && canonicalJson(hook.keys) === canonicalJson(['hooks', 'UserPromptSubmit']) && hook.entry && Object.keys(hook.entry).length === 1 && Array.isArray(hook.entry.hooks) && hook.entry.hooks.length === 1);
  const command = hook.entry.hooks[0]!;
  schema(Object.keys(command).length === 3 && command.type === 'command' && command.timeout === 30 && typeof command.command === 'string' && command.command.length <= 16384 && command.command.includes(' native codex-hook --descriptor ') && !/[\u0000-\u001f\u007f]/.test(command.command));
}
function validateEntry(entry: RecordEntry): void {
  schema(entry && idPattern.test(entry.installationId) && providers.includes(entry.provider) && typeof entry.projectRoot === 'string' && Array.isArray(entry.versions) && entry.versions.length <= 128 && Array.isArray(entry.preservedPaths)); literalPath(entry.projectRoot);
  const ids = new Set<string>();
  for (const version of entry.versions) {
    schema(version && uuidPattern.test(version.id) && !ids.has(version.id) && typeof version.strategyVersion === 'string' && typeof version.present === 'boolean' && Array.isArray(version.files) && version.files.length <= maxFiles && Array.isArray(version.runtimeDirectories)); ids.add(version.id);
    validActivation(version.activation, entry.projectRoot); const paths = new Set<string>();
    for (const file of version.files) { schema(file && hashPattern.test(file.hash) && !paths.has(file.path)); relativePath(file.path); paths.add(file.path); }
    for (const directory of version.runtimeDirectories) relativePath(directory);
    if (version.projectHook) validateProjectHook(version.projectHook, entry.provider);
  }
  schema(entry.activeVersion === null || ids.has(entry.activeVersion)); schema(entry.previousActiveVersion === null || ids.has(entry.previousActiveVersion));
  for (const filename of entry.preservedPaths) literalPath(filename);
}
function validateRegistry(registry: Registry): void {
  schema(registry && registry.schemaVersion === 1 && Number.isSafeInteger(registry.generation) && registry.generation >= 0 && Array.isArray(registry.installations) && registry.installations.length <= 1024 && Array.isArray(registry.consumed) && registry.consumed.every(id => typeof id === 'string' && uuidPattern.test(id)));
  const ids = new Set<string>(); for (const entry of registry.installations) { validateEntry(entry); schema(!ids.has(entry.installationId)); ids.add(entry.installationId); }
  if (registry.pending !== null) { validateApproval(registry.pending); schema(hashPattern.test(registry.pending.journalHash) && registry.consumed.includes(registry.pending.planId) && registry.pending.generation + 1 === registry.generation); }
}
function validateApproval(value: InstallationApproval): void {
  assert(value && uuidPattern.test(value.planId) && hashPattern.test(value.planHash) && Number.isSafeInteger(value.generation) && value.generation >= 0, 'An exact plan ID, SHA-256 plan hash and generation are required.', 'INSTALLATION_APPROVAL');
}
function observation(filename: string, info: Stats): Observation {
  return { path: filename, ...directoryStamp(info), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, mode: info.mode, uid: info.uid, gid: info.gid, nlink: info.nlink };
}

/** Filesystem lifecycle authority only, independent of task/grant DB authority.
 * All mutation requires a human environment and an exact previously reviewed
 * generation/hash/one-use nonce. Native code is never started by this engine.
 */
export class InstallationService {
  readonly stateDirectory: string;
  readonly directory: string;
  private readonly options: InstallationServiceOptions;
  private readonly strategies: InstallationStrategy[];
  constructor(options: InstallationServiceOptions) {
    this.options = options; this.stateDirectory = literalPath(options.stateDirectory); this.directory = path.join(this.stateDirectory, 'integrations');
    this.strategies = options.strategies ?? [createClaudeInstallationStrategy({ env: options.env }), createCodexInstallationStrategy(), createOpenCodeExistingChatStrategy(), createCursorExistingChatStrategy()];
    assert(this.strategies.every(strategy => providers.includes(strategy.provider)) && new Set(this.strategies.map(strategy => strategy.provider)).size === this.strategies.length, 'Installation provider strategies must be unique.', 'INSTALLATION_PROVIDER');
  }
  private human(): void { humanEnvironment(this.options.env); }
  private async initialize(create: boolean): Promise<DirectoryGuard | null> {
    const guard = new DirectoryGuard(); await guard.pin(this.stateDirectory);
    if (!await exists(this.directory)) {
      if (!create) return null;
      await guard.check();
      // Exclusive bootstrap: another initializer or unknown directory wins; do
      // not overwrite it even if it appeared between the existence check/mkdir.
      await mkdir(this.directory, { mode: 0o700 }); await syncDirectory(this.stateDirectory); await guard.pin(this.directory);
      for (const name of ['plans', 'transactions', 'objects', 'bundles']) await guard.ensure(path.join(this.directory, name));
      await atomicReplace(path.join(this.directory, 'registry.json'), encode({ schemaVersion: 1, generation: 0, installations: [], consumed: [], pending: null }), guard);
    } else {
      await guard.pin(this.directory);
      assert(await exists(path.join(this.directory, 'registry.json')), 'Unrecognized installation directory; preserve it for human inspection.', 'INSTALLATION_COLLISION');
      for (const name of ['plans', 'transactions', 'objects', 'bundles']) await guard.pin(path.join(this.directory, name));
    }
    return guard;
  }
  private async registry(): Promise<Registry> { const value = decode<Registry>((await readSafe(path.join(this.directory, 'registry.json'))).content); validateRegistry(value); return value; }
  private async save(registry: Registry, guard: DirectoryGuard): Promise<void> { validateRegistry(registry); await atomicReplace(path.join(this.directory, 'registry.json'), encode(registry), guard); }
  private ownerAlive(pid: number): boolean {
    // Signal 0 checks existence only. PID reuse and permission errors remain busy.
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private async lockFile(): Promise<LockFile> {
    const filename = path.join(this.directory, 'operation.lock'), file = await readSafe(filename, 16 * 1024, true, 2);
    let record: LockRecord | null = null;
    try {
      const value = decode<LockRecord>(file.content);
      schema(value && value.schemaVersion === 1 && Number.isInteger(value.pid) && value.pid > 0 && uuidPattern.test(value.nonce) && Object.keys(value).every(key => ['schemaVersion', 'pid', 'nonce', 'approval'].includes(key)));
      if (value.approval != null) validateApproval(value.approval);
      record = value;
    } catch { /* Partial/unknown lock bytes never supply a guessed owner PID. */ }
    let staging: string | null = null;
    if (file.stamp.nlink === 2) {
      assert(record, 'Unknown linked lock content must be preserved for manual inspection.', 'INSTALLATION_LOCK_UNSAFE');
      staging = path.join(this.directory, `.murmur-lock-${record.nonce}.stage`);
      const info = await lstat(staging);
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 2 && sameDirectory(info, file.stamp), 'Unknown lock hardlink must be preserved.', 'INSTALLATION_LOCK_UNSAFE');
    }
    return { ...file, record, staging };
  }
  private async lockInspection(): Promise<InstallationLockInspection | null> {
    if (!await exists(path.join(this.directory, 'operation.lock'))) return null;
    try {
      const lock = await this.lockFile();
      return { state: lock.record ? this.ownerAlive(lock.record.pid) ? 'active' : 'stale' : 'unreadable', fingerprint: digest(canonicalJson(lock.stamp)), approval: lock.record?.approval ?? null, repairRequiresStoppedOwner: true };
    } catch { return { state: 'unsafe', fingerprint: null, approval: null, repairRequiresStoppedOwner: true }; }
  }
  private async checkLockAuthority(guard: DirectoryGuard): Promise<void> {
    // A rejected project replacement must not strand this process's live lock.
    for (const directory of [this.stateDirectory, this.directory]) {
      const pin = guard.pins.get(directory)!;
      assert(sameDirectory(pin.stamp, await directoryInfo(directory)), 'Installation lock authority changed.', 'INSTALLATION_BUSY');
    }
  }
  private async normalizeLock(lock: LockFile, guard: DirectoryGuard): Promise<LockFile> {
    await this.checkLockAuthority(guard);
    assert(matches((await this.lockFile()).stamp, lock.stamp), 'Installation lock changed.', 'INSTALLATION_BUSY');
    if (lock.staging) {
      const info = await lstat(lock.staging);
      assert(info.isFile() && info.nlink === 2 && sameDirectory(info, lock.stamp), 'Installation lock staging changed.', 'INSTALLATION_BUSY');
      await unlink(lock.staging); await syncDirectory(this.directory);
      const normalized = await this.lockFile();
      assert(normalized.content === lock.content && sameDirectory(normalized.stamp, lock.stamp), 'Installation lock changed during normalization.', 'INSTALLATION_BUSY');
      return normalized;
    }
    return lock;
  }
  private async releaseLock(content: string, guard: DirectoryGuard): Promise<void> {
    const filename = path.join(this.directory, 'operation.lock'); await this.checkLockAuthority(guard);
    if (!await exists(filename)) return;
    let lock = await this.lockFile(); assert(lock.content === content, 'Installation lock ownership changed.', 'INSTALLATION_BUSY');
    lock = await this.normalizeLock(lock, guard);
    assert(matches(await snapshot(filename), lock.stamp), 'Installation lock changed before release.', 'INSTALLATION_BUSY');
    await unlink(filename); await syncDirectory(this.directory);
  }
  private async locked<T>(guard: DirectoryGuard, recovery: boolean, action: (recovered: LockRecord | null) => Promise<T>, approval?: InstallationApproval): Promise<T> {
    const filename = path.join(this.directory, 'operation.lock'); await guard.check(); let recovered: LockRecord | null = null;
    if (recovery && await exists(filename)) {
      const previous = await this.lockFile();
      assert(previous.record, 'Unreadable lock preserved. Inspect its fingerprint and explicitly repair only after all installer processes are stopped.', 'INSTALLATION_LOCK_REPAIR_REQUIRED');
      assert(!this.ownerAlive(previous.record.pid), 'An installation operation is still active. No lock was removed.', 'INSTALLATION_BUSY');
      // Validate approval before changing even a stale lock. Completed operations
      // can leave a lock without a pending registry transaction.
      assert(approval, 'Explicit recovery approval is required.', 'INSTALLATION_APPROVAL'); await this.readPlan(approval);
      const registry = await this.registry();
      assert(registry.pending ? registry.pending.planId === approval.planId && registry.pending.planHash === approval.planHash && registry.pending.generation === approval.generation
        : previous.record.approval && canonicalJson(previous.record.approval) === canonicalJson(approval), 'Recovery must match the interrupted lock or pending transaction.', 'INSTALLATION_APPROVAL');
      recovered = previous.record; await this.releaseLock(previous.content, guard);
    }
    const nonce = randomUUID(), content = encode({ schemaVersion: 1, pid: process.pid, nonce, approval: approval ?? null });
    const staging = path.join(this.directory, `.murmur-lock-${nonce}.stage`);
    // Before publication, staging is non-authoritative. After link, the complete
    // nonce/inode pair is recoverable; a partial authoritative lock is never visible.
    try { await publishNew(filename, content, staging, guard); }
    catch (error) {
      if (await exists(staging)) await normalizeStaging(staging, filename, digest(content), guard, true, content);
      if (await exists(filename) && (await this.lockFile()).content === content) await this.releaseLock(content, guard);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MurmurError('Installation operation or interrupted lock exists; inspect and explicitly recover.', 'INSTALLATION_BUSY');
      throw error;
    }
    try { return await action(recovered); }
    finally { await this.releaseLock(content, guard); }
  }
  /** A human-reviewed repair quarantines, never discards, an uncertain lock. A
   * malformed record cannot establish process identity, so stopped-owner confirmation
   * is required. A safe complete record with a known live owner still wins.
   */
  async repairLock(input: InstallationLockRepair): Promise<InstallationLockRepairResult> {
    this.human(); assert(input && hashPattern.test(input.fingerprint) && Number.isSafeInteger(input.generation) && input.generation >= 0 && input.ownerStopped === true, 'Repair requires the inspected fingerprint/generation and confirmation that all installer processes are stopped.', 'INSTALLATION_APPROVAL');
    const guard = await this.initialize(false); assert(guard, 'No installation lock exists.', 'INSTALLATION_APPROVAL');
    let previous = await this.lockFile(); const registry = await this.registry();
    assert(registry.generation === input.generation && digest(canonicalJson(previous.stamp)) === input.fingerprint, 'Reviewed lock or registry changed; inspect again.', 'INSTALLATION_STALE_PLAN');
    assert(!previous.record || !this.ownerAlive(previous.record.pid), 'The known lock owner is still active; repair refused.', 'INSTALLATION_BUSY');
    previous = await this.normalizeLock(previous, guard);
    const nonce = randomUUID(), preservedPath = path.join(this.directory, 'transactions', `lock-repair-${nonce}.json`);
    await publishNew(preservedPath, previous.content, path.join(this.directory, 'transactions', `lock-repair-${nonce}.stage`), guard);
    await guard.check(); assert(matches(await snapshot(path.join(this.directory, 'operation.lock')), previous.stamp) && canonicalJson(await this.registry()) === canonicalJson(registry), 'Lock or registry changed before repair; preserved backup retained.', 'INSTALLATION_STALE_PLAN');
    const content = encode({ schemaVersion: 1, pid: process.pid, nonce, approval: null });
    await atomicReplace(path.join(this.directory, 'operation.lock'), content, guard);
    try { return { repaired: true, generation: registry.generation, preservedPath }; }
    finally { await this.releaseLock(content, guard); }
  }
  private bundleDirectory(entry: RecordEntry, version: Version): string { return path.join(this.directory, 'bundles', entry.installationId, version.id); }
  private async pinParents(filename: string, guard: DirectoryGuard): Promise<void> {
    assert(inside(this.stateDirectory, filename), 'Installation writes must remain in private state.', 'INSTALLATION_PATH');
    const parts = path.relative(this.stateDirectory, path.dirname(filename)).split(path.sep).filter(Boolean); let directory = this.stateDirectory;
    for (const part of parts) { directory = path.join(directory, part); if (!await exists(directory)) break; await guard.pin(directory); }
  }
  private async pinConfigurationParents(projectRoot: string, guard: DirectoryGuard): Promise<void> {
    await guard.pin(projectRoot, false);
    const directory = path.join(projectRoot, '.codex');
    if (await exists(directory)) { const info = await directoryInfo(directory, false); assert((info.mode & 0o022) === 0, 'Native configuration parent is writable by another user.', 'INSTALLATION_PATH'); await guard.pin(directory, false); }
  }
  private async operationSnapshot(operation: Operation): Promise<FileStamp | null> { return snapshot(operation.path, !operation.nativeConfig); }
  private async project(projectRoot: string, guard: DirectoryGuard): Promise<void> {
    literalPath(projectRoot); await guard.pin(projectRoot, false);
    assert(!inside(projectRoot, this.stateDirectory) && !inside(this.stateDirectory, projectRoot), 'Private installation state must be outside source and workspace directories.', 'INSTALLATION_PATH');
    // A subdirectory cannot be used to hide private state inside its Git source.
    let candidate = projectRoot;
    for (let depth = 0; depth < 256; depth++) {
      if (await exists(path.join(candidate, '.git'))) { const marker = await lstat(path.join(candidate, '.git')); assert(!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile()) && !inside(candidate, this.stateDirectory), 'Private installation state must be outside the Git source root.', 'INSTALLATION_PATH'); break; }
      const parent = path.dirname(candidate); if (parent === candidate) break; candidate = parent;
    }
  }
  private async summary(entry: RecordEntry): Promise<InstallationSummary> {
    const active = entry.versions.find(version => version.id === entry.activeVersion); let integrity: InstallationSummary['integrity'] = active ? 'unchanged' : 'not-installed';
    if (active) for (const asset of active.files) {
      try { const actual = await snapshot(path.join(this.bundleDirectory(entry, active), asset.path)); if (!actual) { if (integrity === 'unchanged') integrity = 'missing'; } else if (actual.hash !== asset.hash) integrity = 'modified'; }
      catch { integrity = 'modified'; }
    }
    let nativeConfigured = false;
    if (active?.projectHook) try {
      const source = (await readSafe(path.join(entry.projectRoot, active.projectHook.path), maxBytes, false)).content;
      // Exact owned item only; permission-hook changes and native trust are not inferred.
      removeInstallationJsoncArrayItem(source, active.projectHook.keys, active.projectHook.entry); nativeConfigured = true;
    } catch { /* Missing/edited native config is not reported as configured. */ }
    return { installationId: entry.installationId, provider: entry.provider, projectRoot: entry.projectRoot, scope: 'project', status: active ? 'installed' : 'removed', activeVersion: entry.activeVersion, bundleDirectory: active ? this.bundleDirectory(entry, active) : null, installedBundle: !!active && integrity === 'unchanged', nativeConfigured, nativeLoaded: 'unverified', integrity, activation: active?.activation ?? null, preservedPaths: entry.preservedPaths };
  }
  async inspect(query: { projectRoot?: string; provider?: InstallationProvider } = {}): Promise<InstallationInspection> {
    this.human(); if (query.projectRoot !== undefined) literalPath(query.projectRoot); if (query.provider !== undefined) assert(providers.includes(query.provider), 'Unknown installation provider.', 'INSTALLATION_PROVIDER');
    const guard = await this.initialize(false), registry = guard ? await this.registry() : { generation: 0, installations: [], pending: null };
    const installations: InstallationSummary[] = [];
    for (const entry of registry.installations) if ((!query.projectRoot || query.projectRoot === entry.projectRoot) && (!query.provider || query.provider === entry.provider)) installations.push(await this.summary(entry));
    await guard?.check();
    return { schemaVersion: 1, generation: registry.generation, stateDirectory: this.directory, installations, providers: this.strategies.map(strategy => ({ provider: strategy.provider, strategyVersion: strategy.version, description: strategy.description, enabled: strategy.enabled !== false, limitation: strategy.limitation ?? null })), pending: registry.pending ? { planId: registry.pending.planId, planHash: registry.pending.planHash, generation: registry.pending.generation } : null, lock: guard ? await this.lockInspection() : null, nativeConfigurationChanges: [], warning };
  }
  async plan(request: InstallationPlanRequest): Promise<InstallationPlan> {
    this.human(); assert(request && ['install', 'update', 'uninstall', 'rollback'].includes(request.action) && providers.includes(request.provider), 'Unknown installation action or provider.', 'INSTALLATION_INPUT'); literalPath(request.projectRoot);
    // Validate source/state separation before creating even the private registry.
    const initialGuard = new DirectoryGuard(); await initialGuard.pin(this.stateDirectory); await this.project(request.projectRoot, initialGuard);
    const guard = (await this.initialize(true))!; await this.project(request.projectRoot, guard);
    return this.locked(guard, false, async () => {
      const registry = await this.registry(); assert(!registry.pending, 'An interrupted installation requires explicit recovery first.', 'INSTALLATION_RECOVERY_REQUIRED');
      const installationId = `ins_${digest(`${request.provider}\0${request.projectRoot}`).slice(0, 24)}`;
      assert(!request.installationId || request.installationId === installationId, 'Installation ID does not match provider and project.', 'INSTALLATION_INPUT');
      const before = registry.installations.find(entry => entry.installationId === installationId) ?? null;
      assert(request.action === 'install' ? !before || before.activeVersion === null : before !== null && (request.action === 'rollback' || before.activeVersion !== null), 'Installation action does not match current state.', 'INSTALLATION_STATE');
      const after: RecordEntry = before ? clone(before) : { installationId, provider: request.provider, projectRoot: request.projectRoot, activeVersion: null, previousActiveVersion: null, versions: [], preservedPaths: [] };
      const operations: Operation[] = [], directories = new Set<string>(), objects = new Map<string, string>(), observations: Observation[] = [], inputFiles: InputFile[] = [], preservedPaths: string[] = [];
      const addDirectory = async (directory: string) => { const missing: string[] = []; for (let current = directory; !await exists(current); current = path.dirname(current)) { assert(inside(this.stateDirectory, current) && current !== this.stateDirectory, 'Installation directory escaped private state.', 'INSTALLATION_PATH'); missing.unshift(current); } await this.pinParents(path.join(directory, '_'), guard); for (const missingDirectory of missing) directories.add(missingDirectory); };
      const active = before?.versions.find(version => version.id === before.activeVersion);
      if ((request.action === 'update' || request.action === 'rollback') && active) {
        for (const asset of active.files) {
          const filename = path.join(this.bundleDirectory(before!, active), asset.path); await this.pinParents(filename, guard);
          const stamp = await snapshot(filename); assert(stamp?.hash === asset.hash, 'Murmur-owned bundle was edited or replaced; preserve it and inspect before changing versions.', 'INSTALLATION_COLLISION');
          inputFiles.push({ path: filename, stamp, nativeConfig: false });
        }
      }
      let activation: InstallationActivation | null = null, behavior: string[] = [], runtimeDirectories: string[] = [];
      if (request.action === 'install' || request.action === 'update') {
        const strategy = this.strategies.find(candidate => candidate.provider === request.provider); assert(strategy && strategy.enabled !== false, 'No verified installation strategy is registered for this provider.', 'INSTALLATION_PROVIDER_UNVERIFIED');
        assert(after.versions.length < 128, 'Installation version history is full; preserve it for inspection.', 'INSTALLATION_LIMIT');
        const versionId = randomUUID(), bundleDirectory = path.join(this.directory, 'bundles', installationId, versionId);
        assert(!await exists(bundleDirectory) && (before || !await exists(path.dirname(bundleDirectory))), 'Unrecognized bundle directory collision.', 'INSTALLATION_COLLISION');
        const bundle: InstallationBundle = await strategy.build({ stateDirectory: this.stateDirectory, projectRoot: request.projectRoot, installationId, bundleDirectory });
        validActivation(bundle.activation, request.projectRoot); schema(Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= maxFiles && Array.isArray(bundle.requestedBehavior));
        let bytes = 0; const files: Asset[] = [], paths = new Set<string>();
        for (const asset of bundle.files) {
          relativePath(asset.path); schema(typeof asset.content === 'string' && !paths.has(asset.path)); paths.add(asset.path); bytes += Buffer.byteLength(asset.content); schema(bytes <= maxBytes);
          const hash = digest(asset.content), filename = path.join(bundleDirectory, asset.path); objects.set(hash, asset.content); files.push({ path: asset.path, hash }); await addDirectory(path.dirname(filename)); operations.push({ path: filename, before: null, after: hash });
        }
        runtimeDirectories = bundle.runtimeDirectories ?? [];
        for (const directory of runtimeDirectories) { relativePath(directory); assert(!inside(this.directory, path.join(this.stateDirectory, directory)), 'Runtime state must not overlap installation authority.', 'INSTALLATION_PATH'); await addDirectory(path.join(this.stateDirectory, directory)); }
        for (const filename of bundle.observedFiles ?? []) {
          literalPath(filename); const info = await lstat(filename); assert(await realpath(filename) === filename && info.isFile() && !info.isSymbolicLink() && (info.mode & 0o022) === 0, 'Observed descriptor/executable changed or is unsafe.', 'INSTALLATION_PATH'); observations.push(observation(filename, info));
        }
        activation = bundle.activation; behavior = bundle.requestedBehavior;
        after.previousActiveVersion = after.activeVersion; after.activeVersion = versionId; after.versions.push({ id: versionId, strategyVersion: strategy.version, files, activation, runtimeDirectories, present: true, ...(bundle.projectHook ? { projectHook: bundle.projectHook } : {}) }); after.preservedPaths = [];
      } else {
        const target = request.action === 'rollback' ? before!.previousActiveVersion : null;
        after.previousActiveVersion = before!.activeVersion; after.activeVersion = target;
        if (target === null) {
          for (const version of after.versions) {
            const directory = this.bundleDirectory(after, version);
            if (await exists(directory)) {
              await this.pinParents(path.join(directory, '_'), guard);
              for (const asset of version.files) {
                const filename = path.join(directory, asset.path);
                try {
                  await this.pinParents(filename, guard); const actual = await snapshot(filename);
                  if (actual?.hash === asset.hash) { const content = (await readSafe(filename)).content; objects.set(asset.hash, content); operations.push({ path: filename, before: actual, after: null }); }
                  else if (actual) preservedPaths.push(filename);
                } catch { preservedPaths.push(filename); }
              }
              // Untracked content is retained and shown, never recursively removed.
              const expected = new Set(version.files.map(asset => asset.path));
              const scan = async (current: string): Promise<void> => { for (const child of await readdir(current, { withFileTypes: true })) { const filename = path.join(current, child.name); if (child.isDirectory()) { await guard.pin(filename); await scan(filename); } else if (!expected.has(path.relative(directory, filename))) preservedPaths.push(filename); } };
              await scan(directory);
            }
            version.present = false;
          }
          behavior = ['Remove only unchanged Murmur-owned bundle files; preserve edited/untracked files and all runtime helper state.', 'Do not revoke linked grants or modify/stop native sessions.'];
        } else {
          const version = after.versions.find(candidate => candidate.id === target)!; activation = version.activation; runtimeDirectories = version.runtimeDirectories;
          const directory = this.bundleDirectory(after, version);
          for (const asset of version.files) {
            const filename = path.join(directory, asset.path); await this.pinParents(filename, guard); const actual = await snapshot(filename);
            assert(!actual || actual.hash === asset.hash, 'Rollback target was edited; no user content will be replaced.', 'INSTALLATION_COLLISION');
            if (actual) inputFiles.push({ path: filename, stamp: actual, nativeConfig: false });
            if (!actual) { const stored = await readSafe(path.join(this.directory, 'objects', asset.hash)); assert(stored.stamp.hash === asset.hash, 'Rollback backup integrity mismatch.', 'INSTALLATION_SCHEMA'); objects.set(asset.hash, stored.content); await addDirectory(path.dirname(filename)); operations.push({ path: filename, before: null, after: asset.hash }); }
          }
          for (const relative of runtimeDirectories) await addDirectory(path.join(this.stateDirectory, relative));
          version.present = true; behavior = ['Restore the prior approved bundle version from private hashed snapshots. Native activation remains an explicit human action.', 'Never replace edited files, modify native trust, revoke grants, or affect task/native process ownership.'];
        }
        after.preservedPaths = [...new Set(preservedPaths)].sort();
      }
      const beforeHook = active?.projectHook, afterHook = after.versions.find(version => version.id === after.activeVersion)?.projectHook;
      const nativeConfigurationChanges: InstallationPlan['nativeConfigurationChanges'] = [];
      if (beforeHook || afterHook) {
        if (beforeHook) validateProjectHook(beforeHook, request.provider); if (afterHook) validateProjectHook(afterHook, request.provider);
        const hook = afterHook ?? beforeHook!, filename = path.join(request.projectRoot, hook.path);
        await this.pinConfigurationParents(request.projectRoot, guard);
        const prior = await snapshot(filename, false), original = prior ? (await readSafe(filename, maxBytes, false)).content : '{}\n';
        inputFiles.push({ path: filename, stamp: prior, nativeConfig: true });
        let source = original, preserve = false;
        if (beforeHook) {
          try { source = removeInstallationJsoncArrayItem(source, beforeHook.keys, beforeHook.entry); }
          catch (error) { if (request.action !== 'uninstall') throw error; preserve = true; after.preservedPaths = [...new Set([...after.preservedPaths, filename])].sort(); }
        }
        if (!preserve && afterHook) {
          const parsed = parseInstallationJsonc(source) as { hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> } };
          const command = afterHook.entry.hooks[0]!.command;
          assert(!parsed.hooks?.UserPromptSubmit?.some(group => group?.hooks?.some(item => item?.command === command)), 'A native hook with the same full command already exists without ownership.', 'INSTALLATION_COLLISION');
          source = appendInstallationJsoncArrayItem(source, afterHook.keys, afterHook.entry);
        }
        if (!preserve && canonicalJson(beforeHook ?? null) !== canonicalJson(afterHook ?? null) && source !== original) {
          if (!prior && !await exists(path.dirname(filename))) directories.add(path.dirname(filename));
          if (prior) objects.set(prior.hash, original);
          const hash = digest(source); objects.set(hash, source); operations.push({ path: filename, before: prior, after: hash, nativeConfig: true });
          nativeConfigurationChanges.push({ path: filename, keys: ['hooks.UserPromptSubmit'], operation: beforeHook ? afterHook ? 'replace-owned-hook' : 'remove-owned-hook' : 'append-owned-hook' });
          behavior.push('Install/remove only the exact owned Codex UserPromptSubmit matcher group, preserving all other native hooks, permission rules, trust choices and comments. Native /hooks approval and resume remain explicit.');
        }
      }
      const query = { provider: request.provider, projectRoot: request.projectRoot, installationId };
      let linkedGrants: LinkedInstallationGrant[] = [];
      if (this.options.linkedGrants) linkedGrants = (await this.options.linkedGrants(query)).map(grant => ({ grantId: grant.grantId, projectId: grant.projectId, sessionId: grant.sessionId, status: grant.status }));
      const planId = randomUUID();
      const preview: Omit<InstallationPlan, 'planHash'> = { schemaVersion: 1, planId, generation: registry.generation, action: request.action, installationId, provider: request.provider, projectRoot: request.projectRoot, scope: 'project', expiresAt: (this.options.now ?? Date.now)() + 15 * 60_000,
        affectedPaths: [...[...directories].map(directory => ({ path: directory, operation: 'ensure-private-directory' as const, beforeHash: null, afterHash: null })), ...operations.map(operation => ({ path: operation.path, operation: operation.after ? operation.before ? 'replace' as const : 'create' as const : 'remove' as const, beforeHash: operation.before?.hash ?? null, afterHash: operation.after }))],
        backupPaths: [...objects.keys()].map(hash => path.join(this.directory, 'objects', hash)), preservedPaths: after.preservedPaths, nativeConfigurationChanges, requestedBehavior: behavior, activation, linkedGrants, grantDiscovery: this.options.linkedGrants ? 'available' : 'unavailable', grantsRevoked: false, warning };
      await guard.check(); validateEntry(after);
      const plan: PlanFile = { schemaVersion: 1, preview, before, after, operations, directories: [...directories], directoryPins: [...guard.pins].map(([filename, pin]) => ({ path: filename, ...pin })), observations, inputFiles, objects: [...objects].map(([hash, content]) => ({ hash, content })) };
      const content = encode(plan), planHash = digest(canonicalJson(plan));
      assert(Buffer.byteLength(content) <= 8 * maxBytes, 'Installation plan exceeds the private-state budget.', 'INSTALLATION_LIMIT');
      const filename = path.join(this.directory, 'plans', `${planId}.json`); assert(!await exists(filename), 'Installation plan nonce collision.', 'INSTALLATION_COLLISION'); await atomicReplace(filename, content, guard);
      return { ...preview, planHash };
    });
  }
  private async readPlan(approval: InstallationApproval): Promise<PlanFile> {
    validateApproval(approval); const plan = decode<PlanFile>((await readSafe(path.join(this.directory, 'plans', `${approval.planId}.json`))).content);
    schema(plan && plan.schemaVersion === 1 && plan.preview?.schemaVersion === 1 && plan.preview.planId === approval.planId && plan.preview.generation === approval.generation && digest(canonicalJson(plan)) === approval.planHash && Array.isArray(plan.operations) && Array.isArray(plan.directories) && Array.isArray(plan.directoryPins) && Array.isArray(plan.objects) && Array.isArray(plan.observations) && Array.isArray(plan.inputFiles)); validateEntry(plan.after); if (plan.before) validateEntry(plan.before);
    schema(plan.after.installationId === plan.preview.installationId && plan.after.projectRoot === plan.preview.projectRoot);
    const root = path.join(this.directory, 'bundles', plan.after.installationId);
    for (const operation of plan.operations) { literalPath(operation.path); schema((operation.nativeConfig ? plan.after.provider === 'codex' && operation.path === path.join(plan.after.projectRoot, '.codex/hooks.json') : inside(root, operation.path)) && (operation.after === null || hashPattern.test(operation.after)) && (operation.before === null || hashPattern.test(operation.before.hash))); }
    for (const input of plan.inputFiles) { literalPath(input.path); schema(typeof input.nativeConfig === 'boolean' && (input.nativeConfig ? plan.after.provider === 'codex' && input.path === path.join(plan.after.projectRoot, '.codex/hooks.json') : inside(root, input.path)) && (input.stamp === null || hashPattern.test(input.stamp.hash))); }
    for (const object of plan.objects) schema(object && typeof object.content === 'string' && digest(object.content) === object.hash);
    for (const directory of plan.directories) { literalPath(directory); schema(inside(root, directory) || plan.after.provider === 'codex' && directory === path.join(plan.after.projectRoot, '.codex') || plan.after.versions.some(version => version.runtimeDirectories.some(relative => inside(path.join(this.stateDirectory, relative), directory) || inside(directory, path.join(this.stateDirectory, relative)) && inside(this.stateDirectory, directory)))); }
    return plan;
  }
  private async validatePins(plan: PlanFile, guard: DirectoryGuard): Promise<void> {
    for (const pin of plan.directoryPins) { assert(sameDirectory(pin.stamp, await directoryInfo(pin.path, pin.privateOnly)), 'Reviewed installation directory changed.', 'INSTALLATION_STALE_PLAN'); await guard.pin(pin.path, pin.privateOnly); }
  }
  private staging(plan: PlanFile, index: number, kind: 'stage' | 'restore'): string {
    const operation = plan.operations[index]!;
    // Native atomic replacement/publication must stay on the target filesystem.
    // These exact nonce-bound siblings are the only native temporary files owned
    // by the transaction; unknown collisions are never overwritten or swept.
    return operation.nativeConfig ? path.join(path.dirname(operation.path), `.murmur-${plan.preview.planId}-${index}.${kind}`)
      : path.join(this.directory, 'transactions', plan.preview.planId, `${index}.${kind}`);
  }
  private async validateInputs(plan: PlanFile, unchangedOnly = false): Promise<void> {
    for (const input of plan.inputFiles) {
      if (unchangedOnly && plan.operations.some(operation => operation.path === input.path)) continue;
      assert(matches(await snapshot(input.path, !input.nativeConfig), input.stamp), 'A reviewed installation dependency changed.', 'INSTALLATION_STALE_PLAN');
    }
    for (const observed of plan.observations) {
      const info = await lstat(observed.path);
      assert(await realpath(observed.path) === observed.path && info.isFile() && !info.isSymbolicLink() && (info.mode & 0o022) === 0 && canonicalJson(observation(observed.path, info)) === canonicalJson(observed), 'Reviewed native executable or public descriptor changed.', 'INSTALLATION_STALE_PLAN');
    }
  }
  private async ensureObjects(plan: PlanFile, guard: DirectoryGuard, transaction: string): Promise<void> {
    for (const object of plan.objects) {
      const filename = path.join(this.directory, 'objects', object.hash);
      if (await exists(filename)) assert((await readSafe(filename)).stamp.hash === object.hash, 'Private backup content changed.', 'INSTALLATION_COLLISION');
      else await publishNew(filename, object.content, path.join(transaction, `${object.hash}.object`), guard);
    }
  }
  private async result(registry: Registry, plan: PlanFile, recovered: boolean): Promise<InstallationResult> {
    const entry = registry.installations.find(candidate => candidate.installationId === plan.after.installationId);
    return { applied: !recovered, recovered, generation: registry.generation, installation: entry ? await this.summary(entry) : null, preservedPaths: entry?.preservedPaths ?? [], grantsRevoked: false, nativeLoaded: 'unverified' };
  }
  async apply(approval: InstallationApproval): Promise<InstallationResult> {
    this.human(); validateApproval(approval); const guard = await this.initialize(false); assert(guard, 'No installation plan exists.', 'INSTALLATION_APPROVAL');
    return this.locked(guard, false, async () => {
      const registry = await this.registry();
      assert(!registry.consumed.includes(approval.planId), 'Installation approval nonce was already consumed. Inspect or explicitly recover; never replay apply.', 'INSTALLATION_REPLAY');
      assert(!registry.pending, 'An interrupted installation requires explicit recovery first.', 'INSTALLATION_RECOVERY_REQUIRED');
      const plan = await this.readPlan(approval);
      assert(registry.generation === approval.generation && (this.options.now ?? Date.now)() <= plan.preview.expiresAt && canonicalJson(registry.installations.find(entry => entry.installationId === plan.after.installationId) ?? null) === canonicalJson(plan.before), 'Installation plan expired or state changed; review a fresh plan.', 'INSTALLATION_STALE_PLAN');
      await this.validatePins(plan, guard);
      await this.validateInputs(plan);
      for (const directory of plan.directories) assert(!await exists(directory), 'A planned installation directory now exists.', 'INSTALLATION_STALE_PLAN');
      for (const operation of plan.operations) { if (operation.nativeConfig) await this.pinConfigurationParents(plan.after.projectRoot, guard); else await this.pinParents(operation.path, guard); assert(matches(await this.operationSnapshot(operation), operation.before), 'Reviewed installation content changed.', 'INSTALLATION_STALE_PLAN'); }
      for (let index = 0; index < plan.operations.length; index++) for (const kind of ['stage', 'restore'] as const) assert(!await exists(this.staging(plan, index, kind)), 'Unrecognized transaction staging collision.', 'INSTALLATION_COLLISION');
      const transaction = path.join(this.directory, 'transactions', approval.planId); assert(!await exists(transaction), 'Transaction directory collision.', 'INSTALLATION_COLLISION'); await guard.ensure(transaction);
      const journal = encode(plan); await atomicReplace(path.join(transaction, 'journal.json'), journal, guard);
      registry.consumed.push(approval.planId); registry.pending = { ...approval, journalHash: digest(journal) }; registry.generation++;
      await this.save(registry, guard); await this.options.checkpoint?.('prepared', -1);
      await this.ensureObjects(plan, guard, transaction);
      for (const directory of plan.directories) { assert(!await exists(directory), 'A planned directory appeared during apply.', 'INSTALLATION_CHANGED'); await guard.ensure(directory); }
      for (let index = 0; index < plan.operations.length; index++) {
        const operation = plan.operations[index]!; await guard.check(); assert(matches(await this.operationSnapshot(operation), operation.before), 'Installation target changed during apply.', 'INSTALLATION_CHANGED');
        if (operation.after) { const content = plan.objects.find(object => object.hash === operation.after)?.content; schema(content !== undefined);
          if (operation.before && operation.nativeConfig) await replaceCompared(operation.path, content, operation.before, this.staging(plan, index, 'stage'), guard);
          else await publishNew(operation.path, content, this.staging(plan, index, 'stage'), guard);
        }
        else {
          // An atomic move, not an intent marker, proves this transaction actually
          // removed the original inode. Recovery must not undo a user's deletion
          // of an operation that was never reached. Retain this private evidence.
          const removed = path.join(transaction, `${index}.removed`);
          assert(!await exists(removed), 'Unrecognized removed-file evidence; preserve it.', 'INSTALLATION_COLLISION');
          await guard.check(); assert(matches(await this.operationSnapshot(operation), operation.before), 'Installation target changed before removal.', 'INSTALLATION_CHANGED');
          await rename(operation.path, removed); await syncDirectory(path.dirname(operation.path)); await syncDirectory(transaction);
        }
        await this.options.checkpoint?.('operation', index);
      }
      await guard.check(); await this.validateInputs(plan, true);
      registry.installations = registry.installations.filter(entry => entry.installationId !== plan.after.installationId).concat(plan.after); registry.pending = null;
      await this.save(registry, guard); await this.options.checkpoint?.('committed', -1);
      return this.result(registry, plan, false);
    }, approval);
  }
  /** Recovery aborts only the exact pending transaction. It never replays its
   * requested mutation, overwrites a later user edit, or recursively removes data.
   */
  async recover(approval: InstallationApproval): Promise<InstallationResult> {
    this.human(); validateApproval(approval); const guard = await this.initialize(false); assert(guard, 'No interrupted installation exists.', 'INSTALLATION_RECOVERY_REQUIRED');
    return this.locked(guard, true, async recoveredLock => {
      const registry = await this.registry();
      if (!registry.pending) {
        assert(recoveredLock?.approval && canonicalJson(recoveredLock.approval) === canonicalJson(approval), 'No matching interrupted transaction or completed-operation lock exists.', 'INSTALLATION_APPROVAL');
        const plan = await this.readPlan(approval);
        if (!registry.consumed.includes(approval.planId)) {
          assert(registry.generation === approval.generation && canonicalJson(registry.installations.find(entry => entry.installationId === plan.after.installationId) ?? null) === canonicalJson(plan.before), 'Uncommitted recovery approval is stale.', 'INSTALLATION_STALE_PLAN');
          registry.consumed.push(approval.planId); registry.generation++; await this.save(registry, guard);
        }
        return this.result(registry, plan, true);
      }
      assert(registry.pending && registry.pending.planId === approval.planId && registry.pending.planHash === approval.planHash && registry.pending.generation === approval.generation, 'Recovery must match the exact pending transaction.', 'INSTALLATION_APPROVAL');
      const plan = await this.readPlan(approval), transaction = path.join(this.directory, 'transactions', approval.planId); await guard.pin(transaction);
      const journal = await readSafe(path.join(transaction, 'journal.json')); schema(journal.stamp.hash === registry.pending.journalHash && canonicalJson(decode(journal.content)) === canonicalJson(plan));
      await this.validatePins(plan, guard);
      for (const directory of plan.directories) if (await exists(directory)) { if (directory === path.join(plan.after.projectRoot, '.codex')) await this.pinConfigurationParents(plan.after.projectRoot, guard); else { await this.pinParents(path.join(directory, '_'), guard); await guard.pin(directory); } }
      for (const object of plan.objects) await normalizeStaging(path.join(transaction, `${object.hash}.object`), path.join(this.directory, 'objects', object.hash), object.hash, guard, true, object.content);
      for (let index = plan.operations.length - 1; index >= 0; index--) {
        const operation = plan.operations[index]!;
        if (operation.nativeConfig) await this.pinConfigurationParents(plan.after.projectRoot, guard); else await this.pinParents(operation.path, guard);
        await normalizeStaging(this.staging(plan, index, 'stage'), operation.path, operation.after ?? operation.before!.hash, guard, !operation.nativeConfig, plan.objects.find(object => object.hash === (operation.after ?? operation.before!.hash))?.content);
        if (operation.before) await normalizeStaging(this.staging(plan, index, 'restore'), operation.path, operation.before.hash, guard, !operation.nativeConfig, plan.objects.find(object => object.hash === operation.before!.hash)?.content);
        const actual = await this.operationSnapshot(operation);
        if (operation.before) {
          const content = plan.objects.find(object => object.hash === operation.before!.hash)?.content; schema(content !== undefined);
          if (!actual) {
            assert(operation.after === null, 'The native configuration was deleted outside this transaction; recovery preserved the deletion.', 'INSTALLATION_RECOVERY_CONFLICT');
            const removed = await snapshot(path.join(transaction, `${index}.removed`));
            assert(removed && sameDirectory(removed, operation.before) && removed.hash === operation.before.hash && removed.mode === operation.before.mode, 'No unchanged removed-file evidence exists; recovery preserved the deletion.', 'INSTALLATION_RECOVERY_CONFLICT');
            await publishNew(operation.path, content, this.staging(plan, index, 'restore'), guard, operation.before.mode);
          }
          else if (actual.hash !== operation.before.hash) {
            assert(operation.nativeConfig && operation.after && actual.hash === operation.after, 'Changed content was preserved; recovery remains pending.', 'INSTALLATION_RECOVERY_CONFLICT');
            await replaceCompared(operation.path, content, actual, this.staging(plan, index, 'restore'), guard);
          }
        } else if (actual) {
          assert(actual.hash === operation.after, 'Interrupted content was edited; recovery preserved it and remains pending.', 'INSTALLATION_RECOVERY_CONFLICT'); await guard.check(); await unlink(operation.path); await syncDirectory(path.dirname(operation.path));
        }
      }
      for (const directory of [...plan.directories].reverse()) if (await exists(directory)) {
        await guard.check(); try { await rmdir(directory); guard.pins.delete(directory); await syncDirectory(path.dirname(directory)); }
        catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      registry.pending = null; registry.generation++; await this.save(registry, guard);
      return this.result(registry, plan, true);
    }, approval);
  }
}
