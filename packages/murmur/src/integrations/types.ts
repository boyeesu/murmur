export const INSTALLATION_SCHEMA_VERSION = 1 as const;
export type InstallationAction = 'install' | 'update' | 'uninstall' | 'rollback';
export type InstallationProvider = 'claude' | 'codex' | 'opencode' | 'cursor';
export type LinkedInstallationGrant = { grantId: string; projectId: string; sessionId: string; status: string };

/** Only public, non-credential metadata belongs in a strategy or its previews.
 * Strategies produce bundles, not arbitrary native-settings writes. A verified
 * config editor must be a separately reviewed extension of this contract.
 */
export type InstallationActivation = {
  kind: 'explicit-command' | 'manual';
  executable?: string;
  args?: string[];
  cwd: string;
  instructions: string;
  testedVersion: string;
  nativeLoaded: 'unverified';
};
export type InstallationStrategyContext = {
  stateDirectory: string;
  projectRoot: string;
  installationId: string;
  bundleDirectory: string;
};
export type InstallationProjectHook = {
  /** Deliberately restricted to the natively verified additive hook surface. */
  path: '.codex/hooks.json';
  keys: ['hooks', 'UserPromptSubmit'];
  entry: { hooks: Array<{ type: 'command'; command: string; timeout: number }> };
};
export type InstallationBundle = {
  files: ReadonlyArray<{ path: string; content: string }>;
  activation: InstallationActivation;
  requestedBehavior: string[];
  projectHook?: InstallationProjectHook;
  /** Relative to private state, never project/native configuration. Existing
   * runtime content is not installation-owned and is never removed by uninstall.
   */
  runtimeDirectories?: string[];
  /** Public descriptor/executable metadata to pin between plan and apply. */
  observedFiles?: string[];
};
export interface InstallationStrategy {
  provider: InstallationProvider;
  version: string;
  description: string;
  /** False means even bundle preparation is unverified/unavailable. */
  enabled?: boolean;
  limitation?: string;
  build(context: InstallationStrategyContext): Promise<InstallationBundle> | InstallationBundle;
}
export type InstallationPlanRequest = {
  action: InstallationAction;
  provider: InstallationProvider;
  projectRoot: string;
  installationId?: string;
};
export type InstallationApproval = { planId: string; planHash: string; generation: number };
export type InstallationPathChange = {
  path: string;
  operation: 'create' | 'replace' | 'remove' | 'ensure-private-directory';
  beforeHash: string | null;
  afterHash: string | null;
};
export type InstallationPlan = InstallationApproval & {
  schemaVersion: 1;
  action: InstallationAction;
  installationId: string;
  provider: InstallationProvider;
  projectRoot: string;
  scope: 'project';
  expiresAt: number;
  affectedPaths: InstallationPathChange[];
  backupPaths: string[];
  preservedPaths: string[];
  nativeConfigurationChanges: Array<{ path: string; keys: string[]; operation: 'append-owned-hook' | 'remove-owned-hook' | 'replace-owned-hook' }>;
  requestedBehavior: string[];
  activation: InstallationActivation | null;
  linkedGrants: LinkedInstallationGrant[];
  grantDiscovery: 'available' | 'unavailable';
  grantsRevoked: false;
  warning: string;
};
export type InstallationSummary = {
  installationId: string;
  provider: InstallationProvider;
  projectRoot: string;
  scope: 'project';
  status: 'installed' | 'removed';
  activeVersion: string | null;
  bundleDirectory: string | null;
  installedBundle: boolean;
  nativeConfigured: boolean;
  nativeLoaded: 'unverified';
  integrity: 'unchanged' | 'modified' | 'missing' | 'not-installed';
  activation: InstallationActivation | null;
  preservedPaths: string[];
};
export type InstallationLockInspection = {
  state: 'active' | 'stale' | 'unreadable' | 'unsafe';
  /** Pins the entire no-follow file stamp, not just possibly empty lock bytes. */
  fingerprint: string | null;
  approval: InstallationApproval | null;
  repairRequiresStoppedOwner: true;
};
export type InstallationLockRepair = { fingerprint: string; generation: number; ownerStopped: true };
export type InstallationLockRepairResult = { repaired: true; generation: number; preservedPath: string };
export type InstallationInspection = {
  schemaVersion: 1;
  generation: number;
  stateDirectory: string;
  installations: InstallationSummary[];
  providers: Array<{ provider: InstallationProvider; strategyVersion: string; description: string; enabled: boolean; limitation: string | null }>;
  pending: InstallationApproval | null;
  lock: InstallationLockInspection | null;
  nativeConfigurationChanges: [];
  warning: string;
};
export type InstallationResult = {
  applied: boolean;
  recovered: boolean;
  generation: number;
  installation: InstallationSummary | null;
  preservedPaths: string[];
  grantsRevoked: false;
  nativeLoaded: 'unverified';
};
