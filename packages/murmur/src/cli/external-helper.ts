import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, canonicalJson, integer, MurmurError, object, TOOLS } from '../protocol/index.js';
import { validateExternalConnection, validatePublicConnectionDescriptor } from '../protocol/external.js';
import type { CreateEnrollmentInput, EnrollmentReceipt, ExternalConnection, ExternalOperation, NativeBinding, PublicConnectionDescriptor } from '../protocol/external.js';
import { EnrollmentClient, ExternalClient, snapshotExternalJson, validateEnrollmentInput, validateEnrollmentReceipt } from './external-client.js';
import type { ExternalTransport } from './external-client.js';

/** Trusted host implementation only; never deserialize this from CLI/model input.
 * The version-scoped Claude adapter obtains current UUID/cwd from host hook stdin.
 * Other claimed native IDs or copied handles are not identity evidence.
 */
export type TrustedNativeContext = { native: NativeBinding; workspaceRoot: string; incarnationVerified: true };
export type ExistingChatHelperOptions = {
  privateDirectory: string; descriptorPath: string;
  nativeContext: () => TrustedNativeContext | Promise<TrustedNativeContext>;
  transport?: ExternalTransport;
  timeoutMs?: number;
};
type Observation = { native: NativeBinding; workspaceRoot: string; workspaceIdentity: string };
type PrivateState = {
  version: 1; observation: Observation; descriptor: PublicConnectionDescriptor;
  candidateCapability: string; pollSecret: string; requestKey: string; input: CreateEnrollmentInput;
  receipt: EnrollmentReceipt | null; connection: ExternalConnection | null; phase: 'pending' | 'active' | 'left' | 'retired';
};
type Loaded = { state: PrivateState; info: Stats };
type MutexPin = { directory: Stats; info: Stats; directoryName: string; filename: string };
type Call = { aborted: boolean; signal: AbortSignal; observation: Observation; descriptor: PublicConnectionDescriptor; directory: Stats; filename: string; fileInfo?: Stats; mutex?: MutexPin };
const MAX_STATE_BYTES = 64 * 1024;
// Do not open/close another raw descriptor for an inode locked by SQLite in this
// process: POSIX descriptor closure can release that process's fcntl locks.
const heldMutexes = new Set<string>();
const busy = () => new MurmurError('Another operation or an unrecognized legacy lock owns this private binding. No lock was removed.', 'EXTERNAL_HELPER_BUSY', 409);
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const sameFile = (a: Stats, b: Stats) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const privateOwner = (info: Stats) => (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid());
const fingerprint = (info: Stats) => `${info.dev}:${info.ino}:${info.birthtimeMs}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
function fail(): never { throw new MurmurError('Private external helper state is unsafe or changed. No fallback or credential recovery was attempted.', 'EXTERNAL_PRIVATE_STATE', 409); }
function selectedFields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = object(raw);
  assert(Object.keys(value).every(key => allowed.includes(key)), 'Unexpected external helper fields or binding selector.', 'EXTERNAL_INPUT');
  return value;
}
function absolute(value: unknown): string {
  assert(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value), 'An explicit canonical absolute helper path is required.', 'EXTERNAL_CONFIGURATION');
  return value;
}
async function privateDirectory(directory: string): Promise<Stats> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !privateOwner(info) || await realpath(directory) !== directory) fail();
  return info;
}
async function readPrivateFile(filename: string, maximum: number): Promise<{ value: unknown; info: Stats } | null> {
  let before: Stats;
  try { before = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !privateOwner(before) || before.size > maximum) fail();
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!sameFile(before, info) || !info.isFile() || !privateOwner(info) || info.nlink !== 1) fail();
    const buffer = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < buffer.length) { const next = await file.read(buffer, used, buffer.length - used, null); if (!next.bytesRead) break; used += next.bytesRead; }
    if (used > maximum || !sameFile(info, await file.stat()) || !sameFile(info, await lstat(filename))) fail();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))); } catch { fail(); }
    return { value, info };
  } finally { await file.close(); }
}

/** The ONLY file discovery allowed here: an explicitly supplied connection.json. */
export async function readPublicConnectionFile(filename: string): Promise<PublicConnectionDescriptor> {
  try {
    absolute(filename);
    assert(path.basename(filename) === 'connection.json', 'Only connection.json is a public connection descriptor.', 'EXTERNAL_CONFIGURATION');
    const directory = path.dirname(filename), before = await privateDirectory(directory);
    const result = await readPrivateFile(filename, 2048);
    if (!result || !sameIdentity(before, await privateDirectory(directory))) fail();
    return Object.freeze(validatePublicConnectionDescriptor(result.value));
  } catch (error) {
    if (error instanceof MurmurError) throw error;
    throw new MurmurError('The explicitly supplied public connection descriptor is unavailable or unsafe.', 'EXTERNAL_DESCRIPTOR');
  }
}

/** Programmatic private helper, used only by a verified host adapter, never MCP.
 * All storage selection comes from a fresh trusted provider, never an argument,
 * model-selected native ID, environment selector, or handle copied in chat text.
 */
export class ExistingChatHelper {
  #directory: string;
  #descriptorPath: string;
  #provider: ExistingChatHelperOptions['nativeContext'];
  #transport: ExternalTransport;
  #timeoutMs: number;
  #directoryPin: Stats | undefined;
  constructor(options: ExistingChatHelperOptions) {
    this.#directory = absolute(options.privateDirectory);
    this.#descriptorPath = absolute(options.descriptorPath);
    assert(path.basename(this.#descriptorPath) === 'connection.json', 'Only the public connection descriptor is supported.', 'EXTERNAL_CONFIGURATION');
    assert(typeof options.nativeContext === 'function', 'A trusted native context provider is required.', 'NATIVE_ADAPTER_UNVERIFIED', 403);
    this.#provider = options.nativeContext;
    this.#transport = { ...options.transport, redactSecrets: [...(options.transport?.redactSecrets ?? [])] };
    this.#timeoutMs = integer(options.timeoutMs ?? 10_000, 'timeoutMs', 1, 30_000);
  }
  async #observation(): Promise<Observation> {
    const raw = selectedFields(snapshotExternalJson(await this.#provider()), ['native', 'workspaceRoot', 'incarnationVerified']);
    assert(raw.incarnationVerified === true, 'A verified native incarnation or invalidation event is required.', 'NATIVE_ADAPTER_UNVERIFIED', 403);
    const native = selectedFields(raw.native, ['tool', 'nativeId', 'incarnationId']);
    assert(TOOLS.includes(native.tool as NativeBinding['tool']) && ['nativeId', 'incarnationId'].every(name => typeof native[name] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(native[name] as string)), 'Fresh native identity is invalid.', 'EXTERNAL_NATIVE_CONTEXT', 403);
    const workspaceRoot = absolute(raw.workspaceRoot), info = await lstat(workspaceRoot);
    assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(workspaceRoot) === workspaceRoot, 'Native workspace is not the exact canonical directory.', 'EXTERNAL_NATIVE_CONTEXT', 403);
    const relative = path.relative(workspaceRoot, this.#directory);
    assert(relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'Private helper state must be outside the source workspace.', 'EXTERNAL_CONFIGURATION');
    return { native: native as NativeBinding, workspaceRoot, workspaceIdentity: fingerprint(info) };
  }
  #notAborted(call: Pick<Call, 'aborted'>): void { assert(!call.aborted, 'External helper timed out. No retry was attempted.', 'EXTERNAL_TIMEOUT', 504); }
  async #fresh(call: Call): Promise<void> {
    this.#notAborted(call);
    const current = await this.#observation(); this.#notAborted(call);
    assert(canonicalJson(current) === canonicalJson(call.observation), 'The current native chat, incarnation, or workspace changed.', 'EXTERNAL_NATIVE_CHANGED', 403);
    const directory = await privateDirectory(this.#directory); this.#notAborted(call);
    if (!sameIdentity(directory, call.directory)) fail();
    if (call.mutex) {
      const { directoryName, filename, directory: pinnedDirectory, info } = call.mutex;
      const currentFile = await lstat(filename);
      if (!sameIdentity(pinnedDirectory, await privateDirectory(directoryName)) || !sameIdentity(info, currentFile)
        || !currentFile.isFile() || currentFile.isSymbolicLink() || currentFile.nlink !== 1 || !privateOwner(currentFile)) fail();
      this.#notAborted(call);
    }
    const descriptor = await readPublicConnectionFile(this.#descriptorPath); this.#notAborted(call);
    assert(descriptor.stateId === call.descriptor.stateId && descriptor.origin === call.descriptor.origin && descriptor.protocolVersion === call.descriptor.protocolVersion, 'Public service identity changed; no rediscovery was attempted.', 'EXTERNAL_STATE_MISMATCH', 409);
    if (call.fileInfo && !sameFile(call.fileInfo, await lstat(call.filename))) fail();
  }
  async #lock(call: Call): Promise<() => Promise<void>> {
    const directoryName = `${call.filename}.lock`, filename = path.join(directoryName, 'mutex.sqlite');
    if (heldMutexes.has(filename)) throw busy();
    heldMutexes.add(filename);
    let file: Awaited<ReturnType<typeof open>> | undefined, database: DatabaseSync | undefined;
    const release = async () => {
      // Close SQLite BEFORE the no-follow descriptor; never unlink the mutex or
      // replace its inode. Process death also releases the OS-owned SQLite lock.
      try { database?.close(); }
      finally { try { await file?.close(); } finally { heldMutexes.delete(filename); } }
    };
    try {
      // The permanent directory is the new-format marker, atomically excluding
      // old O_EXCL file writers. A legacy regular-file marker may have a live
      // owner: refuse it, never migrate/delete it or guess a PID/age. 0.4 had no
      // enabled native adapter, but older programmatic helpers remain possible.
      // An interrupted first initialization leaves a recognizable directory, so
      // a later call can safely open/create its dedicated empty SQLite mutex.
      try { await mkdir(directoryName, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const marker = await lstat(directoryName);
      if (marker.isFile() && marker.nlink === 1 && privateOwner(marker)) throw busy();
      const directory = await privateDirectory(directoryName);
      try { file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const before = await lstat(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !privateOwner(before)) fail();
        file = await open(filename, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!sameFile(before, await file.stat())) fail();
      }
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || !privateOwner(info)) fail();
      call.mutex = { directoryName, filename, directory, info };
      await this.#fresh(call);
      database = new DatabaseSync(filename, { timeout: 0 });
      await this.#fresh(call);
      // No tables, proof material, or coordination DB transaction: only this
      // binding's empty mutex database is locked across the asynchronous work.
      database.exec('BEGIN EXCLUSIVE');
      await this.#fresh(call);
      return release;
    } catch (error) {
      await release();
      const sqliteCode = (error as { errcode?: number }).errcode;
      if (typeof sqliteCode === 'number' && [5, 6].includes(sqliteCode & 0xff)) throw busy();
      throw error;
    }
  }
  async #withCall<T>(work: (call: Call) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const budget = { aborted: false, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      budget.aborted = true; controller.abort(); reject(new MurmurError('External helper timed out. No retry was attempted.', 'EXTERNAL_TIMEOUT', 504));
    }, this.#timeoutMs); });
    const execute = async (): Promise<T> => {
      const observation = await this.#observation(); this.#notAborted(budget);
      const directory = await privateDirectory(this.#directory); this.#notAborted(budget);
      if (this.#directoryPin && !sameIdentity(directory, this.#directoryPin)) fail();
      this.#directoryPin ??= directory;
      const descriptor = await readPublicConnectionFile(this.#descriptorPath); this.#notAborted(budget);
      const call: Call = Object.assign(budget, { observation, directory, descriptor, filename: path.join(this.#directory, `${hash(canonicalJson(observation))}.json`) });
      const release = await this.#lock(call);
      try {
        await this.#fresh(call);
        const result = await work(call);
        await this.#fresh(call);
        return result;
      } finally { await release(); }
    };
    try { return await Promise.race([execute(), timeout]); }
    catch (error) {
      if (error instanceof MurmurError) throw error;
      throw new MurmurError('Private external helper operation failed safely. No fallback was attempted.', 'EXTERNAL_PRIVATE_STATE', 409);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  #options(call: Call, state?: PrivateState): ExternalTransport {
    const actual = this.#transport.fetch ?? globalThis.fetch;
    return { ...this.#transport, redactSecrets: [...(this.#transport.redactSecrets ?? []), ...(state ? [state.candidateCapability, state.pollSecret] : [])],
      fetch: async (input, init) => {
        await this.#fresh(call);
        const signal = AbortSignal.any([call.signal, ...(init?.signal ? [init.signal] : [])]);
        return actual(input, { ...init, signal });
      } };
  }
  async #load(call: Call): Promise<Loaded | null> {
    await this.#fresh(call);
    const result = await readPrivateFile(call.filename, MAX_STATE_BYTES);
    if (!result) return null;
    const raw = selectedFields(result.value, ['version', 'observation', 'descriptor', 'candidateCapability', 'pollSecret', 'requestKey', 'input', 'receipt', 'connection', 'phase']);
    assert(raw.version === 1 && ['pending', 'active', 'left', 'retired'].includes(raw.phase as string), 'Invalid private external state.', 'EXTERNAL_PRIVATE_STATE');
    assert(typeof raw.candidateCapability === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw.candidateCapability) && typeof raw.pollSecret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw.pollSecret) && raw.candidateCapability !== raw.pollSecret, 'Invalid private external proofs.', 'EXTERNAL_PRIVATE_STATE');
    assert(typeof raw.requestKey === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(raw.requestKey), 'Invalid private request key.', 'EXTERNAL_PRIVATE_STATE');
    const descriptor = validatePublicConnectionDescriptor(raw.descriptor), input = validateEnrollmentInput(raw.input);
    assert(canonicalJson(raw.observation) === canonicalJson(call.observation) && input.workspaceRoot === call.observation.workspaceRoot && canonicalJson(input.native) === canonicalJson(call.observation.native), 'Stored native binding does not match the current chat.', 'EXTERNAL_NATIVE_CHANGED', 403);
    assert(descriptor.origin === call.descriptor.origin && descriptor.stateId === call.descriptor.stateId && descriptor.protocolVersion === call.descriptor.protocolVersion, 'Stored external service identity changed.', 'EXTERNAL_STATE_MISMATCH', 409);
    assert(input.capabilityHash === hash(raw.candidateCapability) && input.pollSecretHash === hash(raw.pollSecret), 'Stored private proofs changed.', 'EXTERNAL_PRIVATE_STATE');
    const receipt = raw.receipt === null ? null : validateEnrollmentReceipt(raw.receipt);
    const connection = raw.connection === null ? null : validateExternalConnection(raw.connection);
    if (connection) assert(raw.phase === 'active' && receipt?.state === 'approved' && connection.origin === descriptor.origin && connection.stateId === descriptor.stateId && connection.workspaceRoot === call.observation.workspaceRoot && connection.capability === raw.candidateCapability, 'Stored external connection does not match its approval.', 'EXTERNAL_PRIVATE_STATE');
    else assert(raw.phase !== 'active', 'Active private connection is incomplete.', 'EXTERNAL_PRIVATE_STATE');
    call.fileInfo = result.info;
    return { info: result.info, state: { version: 1, observation: call.observation, descriptor, candidateCapability: raw.candidateCapability, pollSecret: raw.pollSecret,
      requestKey: raw.requestKey, input, receipt, connection, phase: raw.phase as PrivateState['phase'] } };
  }
  async #save(call: Call, state: PrivateState): Promise<void> {
    await this.#fresh(call);
    const bytes = Buffer.from(`${canonicalJson(state)}\n`);
    assert(bytes.length <= MAX_STATE_BYTES, 'Private external state is too large.', 'EXTERNAL_PRIVATE_STATE');
    if (!call.fileInfo) {
      try { await lstat(call.filename); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const temporary = path.join(this.#directory, `write-${randomUUID()}.json`);
    let created: Stats | undefined;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); created = await file.stat(); }
      finally { await file.close(); }
      await this.#fresh(call);
      if (!call.fileInfo) {
        try { await lstat(call.filename); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await rename(temporary, call.filename);
      call.fileInfo = await lstat(call.filename);
      if (!sameIdentity(created, call.fileInfo) || !privateOwner(call.fileInfo)) fail();
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(call.directory, await directory.stat())) fail();
        await directory.sync();
      } finally { await directory.close(); }
      await this.#fresh(call);
    } finally {
      if (created) try {
        if (sameIdentity(call.directory, await privateDirectory(this.#directory)) && sameIdentity(created, await lstat(temporary))) await unlink(temporary);
      } catch { /* Preserve uncertain or already-renamed files. */ }
    }
  }
  #view(state: PrivateState): Record<string, unknown> {
    return { state: state.phase === 'left' || state.phase === 'retired' ? state.phase : state.connection ? 'connected' : state.receipt?.state ?? 'not-submitted',
      requestId: state.receipt?.requestId ?? null, expiresAt: state.connection?.expiresAt ?? state.receipt?.expiresAt ?? null,
      reviewUrl: `${state.descriptor.origin}/ui/`, reviewLinkIsInert: true };
  }
  async #retireInvalidAuthority(call: Call, state: PrivateState, error: unknown): Promise<boolean> {
    // Transport checks state/protocol before exposing HTTP errors. A timeout,
    // 503, wrong service/identity, or changed native observation proves nothing
    // about authority and must NEVER destroy the old proof or enable replacement.
    if (!(error instanceof MurmurError) || error.status !== 401) return false;
    const rejected = error.code === 'EXTERNAL_UNAUTHORIZED';
    const elapsed = error.code === 'EXTERNAL_EXPIRED' && state.connection !== null && state.connection.expiresAt <= Date.now();
    if ((!rejected && !elapsed) || (state.phase !== 'active' && state.receipt?.state !== 'approved')) return false;
    await this.#fresh(call);
    state.phase = 'retired'; state.connection = null;
    await this.#save(call, state);
    return true;
  }
  async #pollPending(call: Call, state: PrivateState): Promise<void> {
    if (state.phase !== 'pending' || !state.receipt || state.receipt.state === 'rejected' || state.receipt.state === 'expired') return;
    const client = new EnrollmentClient(call.descriptor, this.#options(call, state));
    // The request deadline limits HUMAN approval, not a subsequently approved
    // grant's lifetime. Always ask using the existing proof, even after deadline.
    const current = await client.status(state.receipt.requestId, state.pollSecret);
    assert(current.revision >= state.receipt.revision && current.expiresAt === state.receipt.expiresAt, 'Enrollment receipt binding changed.', 'EXTERNAL_IDENTITY_MISMATCH', 409);
    state.receipt = current;
    if (current.state === 'approved') {
      state.connection = await client.activate(state.candidateCapability, call.observation.workspaceRoot);
      state.phase = 'active';
    }
    await this.#save(call, state);
  }
  async #enroll(input: Record<string, unknown>): Promise<unknown> {
    return this.#withCall(async call => {
      // Validate the requested draft before any existing-authority/poll request.
      const draft = validateEnrollmentInput({ ...input, native: call.observation.native, workspaceRoot: call.observation.workspaceRoot,
        capabilityHash: '0'.repeat(64), pollSecretHash: '1'.repeat(64) });
      const loaded = await this.#load(call);
      const prior = loaded?.state;
      if (prior) {
        try {
          if (prior.phase === 'active' && prior.connection) await new ExternalClient(prior.connection, this.#options(call, prior)).identity();
          else await this.#pollPending(call, prior);
        } catch (error) {
          // Only an EXPLICIT new start/join proceeds from definitive retirement
          // to fresh proofs and a new request. It never carries old approval over.
          if (!await this.#retireInvalidAuthority(call, prior, error)) throw error;
        }
      }
      const replace = prior && (prior.phase === 'left' || prior.phase === 'retired' || prior.receipt?.state === 'rejected' || prior.receipt?.state === 'expired');
      const previous = replace ? undefined : prior;
      const candidateCapability = previous?.candidateCapability ?? secret(), pollSecret = previous?.pollSecret ?? secret();
      const request = validateEnrollmentInput({ ...draft, capabilityHash: hash(candidateCapability), pollSecretHash: hash(pollSecret) });
      let state = previous;
      if (state) {
        assert(state.phase === 'pending' && canonicalJson(state.input) === canonicalJson(request), 'This chat already has another connection request or membership. No ownership was reused.', 'EXTERNAL_ALREADY_BOUND', 409);
        if (state.receipt) return this.#view(state);
      } else {
        state = { version: 1, observation: call.observation, descriptor: call.descriptor, candidateCapability, pollSecret, requestKey: randomUUID(),
          input: request, receipt: null, connection: null, phase: 'pending' };
        await this.#save(call, state); // Both private secrets exist durably BEFORE enrollment.
      }
      const client = new EnrollmentClient(call.descriptor, this.#options(call, state));
      state.receipt = await client.request(state.input, state.requestKey);
      await this.#save(call, state);
      return this.#view(state);
    });
  }
  start(raw: unknown): Promise<unknown> {
    const input = selectedFields(snapshotExternalJson(raw), ['groupTitle', 'groupGoal', 'responsibility', 'handoff']);
    return this.#enroll(input);
  }
  join(inviteCode: string, raw: unknown): Promise<unknown> {
    assert(typeof inviteCode === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(inviteCode), 'Invalid invitation code.', 'EXTERNAL_INPUT');
    const input = selectedFields(snapshotExternalJson(raw), ['responsibility', 'handoff']);
    return this.#enroll({ ...input, inviteHash: hash(inviteCode) });
  }
  status(): Promise<unknown> {
    return this.#withCall(async call => {
      const loaded = await this.#load(call);
      if (!loaded) return { state: 'disconnected' };
      const state = loaded.state;
      if (state.phase === 'left' || state.phase === 'retired') return this.#view(state);
      try {
        if (state.connection) {
          const client = new ExternalClient(state.connection, this.#options(call, state));
          return { ...this.#view(state), identity: await client.identity() };
        }
        await this.#pollPending(call, state);
        return this.#view(state);
      } catch (error) {
        await this.#retireInvalidAuthority(call, state, error);
        throw error;
      }
    });
  }
  run(operation: ExternalOperation, raw: unknown = {}, key?: string): Promise<unknown> {
    const input = object(snapshotExternalJson(raw));
    const allowed = ['identity', 'context', 'member-status', 'intent', 'task-status', 'check-plan', 'propose-decision', 'reserve', 'release', 'leave'];
    assert(allowed.includes(operation), 'Unsupported external helper operation.', 'EXTERNAL_INPUT');
    if (['identity', 'member-status', 'leave'].includes(operation)) selectedFields(input, []);
    if (operation === 'context') selectedFields(input, ['after']);
    return this.#withCall(async call => {
      const loaded = await this.#load(call), state = loaded?.state;
      assert(state?.phase === 'active' && state.connection, 'This current native chat has no active private external connection.', 'EXTERNAL_NOT_CONNECTED', 403);
      const client = new ExternalClient(state.connection, this.#options(call, state));
      try {
        switch (operation) {
          case 'identity': return await client.identity();
          case 'context': return await client.context(input.after === undefined ? 0 : integer(input.after, 'after', 0, Number.MAX_SAFE_INTEGER));
          case 'member-status': return await client.memberStatus();
          case 'intent': return await client.intent(input, key);
          case 'task-status': return await client.taskStatus(input, key);
          case 'check-plan': return await client.checkPlan(input, key);
          case 'propose-decision': return await client.proposeDecision(input, key);
          case 'reserve': return await client.reserve(input, key);
          case 'release': return await client.release(input, key);
          case 'leave': {
            const result = await client.leave(key);
            state.phase = 'left'; state.connection = null;
            await this.#save(call, state);
            return result;
          }
        }
      } catch (error) {
        await this.#retireInvalidAuthority(call, state, error);
        throw error;
      }
    });
  }
  refresh(after = 0): Promise<unknown> { return this.run('context', { after }); }
  leave(key?: string): Promise<unknown> { return this.run('leave', {}, key); }
}
