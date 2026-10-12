import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { MurmurError } from '../protocol/index.js';
import { HEARTBEAT_MS, STATE_HEADER, PROTOCOL_HEADER, validateSupervisorConnection } from '../protocol/agent.js';
import type { LaunchPreparation, LaunchStatus, SupervisorConnection } from '../protocol/agent.js';
import type { DriverInvocation } from './drivers.js';

export type ControlOperation = 'claim' | 'started' | 'heartbeat' | 'end';
export type EndReason = 'exited' | 'interrupted' | 'spawn_failed' | 'lease_lost';
export type ControlBody = { launchId: string; controllerId: string; revision: number; pid?: number; reason?: EndReason; exitCode?: number | null };
export type SupervisorTransportOptions = {
  fetch?: typeof fetch; now?: () => number; uuid?: () => string;
  requestTimeoutMs?: number; retryDelaysMs?: number[];
};
export type SupervisorDependencies = SupervisorTransportOptions & {
  spawn?: typeof spawn;
  signals?: { on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown; removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown };
  heartbeatMs?: number; killGraceMs?: number; stderr?: (text: string) => void;
};

export class SupervisorError extends MurmurError {
  retryable: boolean;
  constructor(code: string, retryable = false) {
    super('Managed launch control could not be confirmed.', code, 503);
    this.retryable = retryable;
  }
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const terminal = (status: LaunchStatus): boolean => ['ended', 'failed', 'expired', 'recovery_required'].includes(status.state);

/** Scoped transport only. This module never reads a descriptor or imports the human client. */
export class SupervisorClient {
  readonly connection: SupervisorConnection;
  private fetcher: typeof fetch;
  private now: () => number;
  private uuid: () => string;
  private timeout: number;
  private delays: number[];
  constructor(connection: SupervisorConnection, options: SupervisorTransportOptions = {}) {
    this.connection = validateSupervisorConnection(connection);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.timeout = options.requestTimeoutMs ?? 5000;
    this.delays = options.retryDelaysMs?.length ? options.retryDelaysMs : [100, 300, 1000];
  }

  private async request(endpoint: string, body?: ControlBody, key?: string, deadline?: number): Promise<LaunchStatus> {
    const remaining = deadline === undefined ? this.timeout : Math.min(this.timeout, deadline - this.now());
    if (remaining <= 0) throw new SupervisorError('SUPERVISOR_DEADLINE');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SupervisorError('SUPERVISOR_UNAVAILABLE', true)); }, remaining);
    });
    const operation = async (): Promise<LaunchStatus> => {
      const response = await this.fetcher(`${this.connection.origin}${endpoint}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.connection.supervisorToken}`,
          [STATE_HEADER]: this.connection.stateId,
          [PROTOCOL_HEADER]: String(this.connection.protocolVersion),
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key! } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.headers.get(STATE_HEADER) !== this.connection.stateId || response.headers.get(PROTOCOL_HEADER) !== String(this.connection.protocolVersion)) {
        void response.body?.cancel().catch(() => {});
        throw new SupervisorError('SUPERVISOR_IDENTITY_MISMATCH');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // Never surface server/native error bodies: they can contain scoped secrets.
        const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
        throw new SupervisorError(response.status === 409 ? 'LAUNCH_CONTROL_CONFLICT' : 'LAUNCH_CONTROL_REJECTED', retryable);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new SupervisorError('SUPERVISOR_RESPONSE_INVALID');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 128 * 1024) throw new SupervisorError('SUPERVISOR_RESPONSE_INVALID');
          chunks.push(chunk.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      }
      let value: LaunchStatus;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as LaunchStatus; }
      catch { throw new SupervisorError('SUPERVISOR_RESPONSE_INVALID'); }
      if (!value || value.id !== this.connection.launchId || !Number.isSafeInteger(value.lifecycleRevision) || value.lifecycleRevision < 0 ||
          !['preparing', 'prepared', 'claimed', 'running', 'ended', 'failed', 'expired', 'recovery_required'].includes(value.state) ||
          !(value.expiresAt === null || Number.isSafeInteger(value.expiresAt)) ||
          !(value.controllerId === null || typeof value.controllerId === 'string')) {
        throw new SupervisorError('SUPERVISOR_RESPONSE_INVALID');
      }
      return value;
    };
    try { return await Promise.race([operation(), timeout]); }
    catch (error) {
      if (error instanceof SupervisorError) throw error;
      throw new SupervisorError('SUPERVISOR_UNAVAILABLE', true);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async status(): Promise<LaunchStatus> {
    return this.request(`/v1/launch-control/status?launchId=${encodeURIComponent(this.connection.launchId)}`);
  }

  async mutate(operation: ControlOperation, body: ControlBody, options: { key?: string; deadline?: number; maxAttempts?: number } = {}): Promise<LaunchStatus> {
    if (body.launchId !== this.connection.launchId) throw new SupervisorError('SUPERVISOR_BINDING_MISMATCH');
    // Copy once. All attempts have the same idempotency key AND exact body/revision.
    const frozen = { ...body };
    const key = options.key ?? this.uuid();
    const attempts = options.maxAttempts ?? 3;
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(`/v1/launch-control/${operation}`, frozen, key, options.deadline); }
      catch (error) {
        if (!(error instanceof SupervisorError) || !error.retryable || attempt + 1 >= attempts) throw error;
        const delay = Math.max(1, this.delays[Math.min(attempt, this.delays.length - 1)]!);
        if (options.deadline !== undefined && this.now() + delay >= options.deadline) throw new SupervisorError('SUPERVISOR_DEADLINE');
        await pause(delay);
      }
    }
  }
}

function signalCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 1);
}

type ChildOutcome = { code: number | null; signal: NodeJS.Signals | null; spawnFailed: boolean };

/** One in-memory owner, one claim, at most one spawn attempt; never PID recovery/takeover. */
export async function superviseLaunch(preparation: LaunchPreparation, invocation: DriverInvocation, dependencies: SupervisorDependencies = {}): Promise<number> {
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const client = new SupervisorClient(preparation.supervisor, dependencies);
  const controllerId = uuid();
  const signals = dependencies.signals ?? process;
  const stderr = dependencies.stderr ?? (text => { process.stderr.write(text); });
  let status = preparation.launch;
  let child: ChildProcess | undefined;
  let childDone = false;
  let childSpawned = false;
  let interrupted: NodeJS.Signals | undefined;
  let lost = false;
  let uncertain = false;
  let finishing = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let serial: Promise<void> = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = serial.then(operation);
    serial = next.catch(() => {});
    return next;
  };
  const killOwned = (signal: NodeJS.Signals): void => {
    if (!child || childDone) return;
    try { child.kill(signal); } catch { /* Best effort, only this owned process handle. */ }
    if (!killTimer) killTimer = setTimeout(() => {
      if (!childDone) { try { child?.kill('SIGKILL'); } catch { /* No PID lookup or process-group kill. */ } }
    }, dependencies.killGraceMs ?? 5000);
  };
  const lose = (): void => {
    if (lost) return;
    stderr('Murmur supervision was lost; stopping only the owned child. Work is preserved.\n');
    lost = true;
    clearTimeout(heartbeatTimer);
    killOwned('SIGTERM');
  };
  const onInterrupt = (): void => { interrupted ??= 'SIGINT'; killOwned('SIGINT'); };
  const onTerminate = (): void => { interrupted ??= 'SIGTERM'; killOwned('SIGTERM'); };
  const armDeadline = (): void => {
    clearTimeout(deadlineTimer);
    if (status.expiresAt === null) throw new SupervisorError('SUPERVISOR_RESPONSE_INVALID');
    deadlineTimer = setTimeout(() => { uncertain = true; lose(); }, Math.max(0, status.expiresAt - now()));
  };
  const update = (next: LaunchStatus, operation: ControlOperation): void => {
    const expected = operation === 'claim' ? 'claimed' : operation === 'started' ? 'running' : status.state;
    if (next.controllerId !== controllerId || next.lifecycleRevision !== status.lifecycleRevision + 1 ||
        (operation === 'end' ? !terminal(next) : next.state !== expected) ||
        (operation !== 'end' && (next.expiresAt === null || next.expiresAt <= now()))) {
      throw new SupervisorError('SUPERVISOR_RESPONSE_INVALID');
    }
    status = next;
    if (operation !== 'end') armDeadline();
  };
  const mutate = async (operation: ControlOperation, extra: Partial<ControlBody> = {}): Promise<void> => {
    try {
      const next = await client.mutate(operation, {
        launchId: status.id, controllerId, revision: status.lifecycleRevision, ...extra,
      }, { deadline: status.expiresAt ?? undefined, maxAttempts: operation === 'end' ? 3 : 128 });
      // A late response must never resurrect a process after its confirmed deadline.
      if (lost && operation !== 'end') throw new SupervisorError('SUPERVISOR_DEADLINE');
      update(next, operation);
    } catch (error) { uncertain = true; throw error; }
  };
  const scheduleHeartbeat = (): void => {
    if (finishing || lost) return;
    heartbeatTimer = setTimeout(() => {
      void enqueue(async () => {
        if (finishing || lost) return;
        await mutate('heartbeat');
        scheduleHeartbeat();
      }).catch(lose);
    }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
  };

  signals.on('SIGINT', onInterrupt);
  signals.on('SIGTERM', onTerminate);
  try {
    if (status.state !== 'prepared' || status.id !== client.connection.launchId || status.controllerId !== null || status.pid !== null) {
      throw new SupervisorError('LAUNCH_NOT_PREPARED');
    }
    // No status-based takeover: an ambiguous claim exhausted under this key never spawns.
    const claim = await client.mutate('claim', { launchId: status.id, controllerId, revision: status.lifecycleRevision }, { deadline: status.expiresAt ?? undefined });
    update(claim, 'claim');
    scheduleHeartbeat();
    let outcome: ChildOutcome = { code: null, signal: null, spawnFailed: false };
    if (!interrupted && !lost) {
      let spawnedResolve!: (spawned: boolean) => void;
      let exitedResolve!: (outcome: ChildOutcome) => void;
      const spawned = new Promise<boolean>(resolve => { spawnedResolve = resolve; });
      const exited = new Promise<ChildOutcome>(resolve => { exitedResolve = resolve; });
      const finish = (result: ChildOutcome): void => {
        if (childDone) return;
        childDone = true;
        finishing = true;
        clearTimeout(killTimer);
        clearTimeout(heartbeatTimer);
        spawnedResolve(!result.spawnFailed);
        exitedResolve(result);
      };
      try {
        child = (dependencies.spawn ?? spawn)(invocation.executable, invocation.args, {
          cwd: invocation.cwd, env: invocation.env, shell: false, stdio: 'inherit',
        });
        child.once('spawn', () => { childSpawned = true; spawnedResolve(true); });
        child.on('error', () => {
          // A post-spawn process error is not proof that the process has exited.
          if (childSpawned) lose();
          else finish({ code: null, signal: null, spawnFailed: true });
        });
        child.once('exit', (code, signal) => { finish({ code, signal, spawnFailed: false }); });
      } catch { finish({ code: null, signal: null, spawnFailed: true }); }
      if (await spawned) {
        if (!Number.isSafeInteger(child?.pid) || Number(child?.pid) <= 0) { uncertain = true; lose(); }
        else await enqueue(() => mutate('started', { pid: child!.pid })).catch(lose);
      }
      outcome = await exited;
    }
    finishing = true;
    clearTimeout(heartbeatTimer);
    await serial;
    const reason: EndReason = interrupted ? 'interrupted' : lost ? 'lease_lost' : outcome.spawnFailed ? 'spawn_failed' : 'exited';
    // If the preceding CAS remains ambiguous, a fresh mutation would be unsafe.
    // Expiry is the revocation fallback; neither end nor expiry completes the task.
    if (!uncertain) {
      await enqueue(() => mutate('end', { reason, exitCode: outcome.code })).catch(() => {
        stderr('Murmur could not confirm launch end; scoped access expires at the last confirmed deadline. Work is preserved.\n');
      });
    } else {
      stderr('Murmur cannot safely advance the unresolved control mutation; no takeover or automatic replay with a new key was attempted. Work is preserved.\n');
    }
    if (interrupted) return signalCode(interrupted);
    if (lost || outcome.spawnFailed) return 1;
    return outcome.code ?? (outcome.signal ? signalCode(outcome.signal) : 1);
  } finally {
    finishing = true;
    clearTimeout(heartbeatTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(killTimer);
    signals.removeListener('SIGINT', onInterrupt);
    signals.removeListener('SIGTERM', onTerminate);
  }
}
