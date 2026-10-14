import { defaultStateDirectory } from '../daemon/config.js';
import { assert } from '../protocol/index.js';
import { commandFailure, flagMap, humanEnvironment, publicOutput } from './human-input.js';
import { InstallationService } from '../integrations/service.js';
import type { InstallationServiceAPI } from '../integrations/service.js';
import type { InstallationAction, InstallationProvider } from '../integrations/types.js';

export const integrationsHelp = `Usage: murmur integrations <action> [options]

Human-only, reviewed native integration lifecycle. No automatic native launch,
trust change, grant revocation, task abandonment or global installation.
  inspect [--root ABS_PROJECT] [--provider claude|codex|opencode|cursor]
  plan --action install|update|uninstall|rollback --provider TOOL --root ABS_PROJECT
       [--installation ID]
  install|update|uninstall|rollback --provider TOOL --root ABS_PROJECT
       [--installation ID]             Preview only; never applies implicitly
  apply --plan ID --hash SHA256 --generation N
  recover --plan ID --hash SHA256 --generation N
  repair-lock --fingerprint SHA256 --generation N --owner-stopped

Review every affected path, behavior and linked grant in a fresh plan. Apply
requires that exact generation, hash and one-use plan ID. Interrupted apply must
be explicitly recovered (aborted), not replayed. No token values are printed.
For an unreadable/orphan lock, first stop all installer processes yourself, inspect
its exact fingerprint/generation, then explicitly repair-lock with --owner-stopped.
Repair preserves the original lock bytes privately; a known live owner is refused.
Bundles and hashed backups remain private outside source. Uninstall removes only
unchanged Murmur-owned content and preserves edited files, helpers and workspaces.
Native loading is never inferred from bundle/config installation; follow the
provider-specific explicit activation instructions. Unknown providers fail closed.
`;
export type IntegrationsCommandDependencies = { stateDirectory?: string; env?: NodeJS.ProcessEnv; service?: InstallationServiceAPI };
const provider = (value: string | undefined): InstallationProvider => {
  assert(value && ['claude', 'codex', 'opencode', 'cursor'].includes(value), 'A supported --provider is required.', 'HUMAN_INPUT'); return value as InstallationProvider;
};
export async function integrationsMain(argv: string[], dependencies: IntegrationsCommandDependencies = {}): Promise<unknown> {
  try {
    // Even help is forbidden in managed/external scoped environments, before IO.
    humanEnvironment(dependencies.env);
    if (argv.length === 1 && argv[0] === '--help') return integrationsHelp;
    const [action, ...args] = argv;
    assert(action && ['inspect', 'plan', 'install', 'update', 'uninstall', 'rollback', 'apply', 'recover', 'repair-lock'].includes(action), 'Unknown integrations action. Use --help.', 'HUMAN_INPUT');
    const flags = flagMap(args, action === 'repair-lock' ? ['fingerprint', 'generation', 'owner-stopped'] : action === 'inspect' ? ['root', 'provider'] : action === 'apply' || action === 'recover' ? ['plan', 'hash', 'generation'] : ['provider', 'root', 'installation', ...(action === 'plan' ? ['action'] : [])], action === 'repair-lock' ? ['owner-stopped'] : []);
    const service = () => dependencies.service ?? new InstallationService({ stateDirectory: dependencies.stateDirectory ?? defaultStateDirectory(), env: dependencies.env });
    if (action === 'repair-lock') {
      const fingerprint = flags.get('fingerprint'), generation = flags.get('generation');
      assert(fingerprint && /^[a-f0-9]{64}$/.test(fingerprint) && generation && /^(?:0|[1-9]\d*)$/.test(generation) && Number.isSafeInteger(Number(generation)) && flags.has('owner-stopped'), 'Repair requires the inspected --fingerprint, --generation and explicit --owner-stopped confirmation.', 'HUMAN_INPUT');
      return publicOutput(await service().repairLock({ fingerprint, generation: Number(generation), ownerStopped: true }));
    }
    if (action === 'inspect') return publicOutput(await service().inspect({ ...(flags.has('root') ? { projectRoot: flags.get('root')! } : {}), ...(flags.has('provider') ? { provider: provider(flags.get('provider')) } : {}) }));
    if (action === 'apply' || action === 'recover') {
      const planId = flags.get('plan'), planHash = flags.get('hash'), generation = flags.get('generation');
      assert(planId && planHash && generation && /^(?:0|[1-9]\d*)$/.test(generation) && Number.isSafeInteger(Number(generation)), 'Apply/recovery requires --plan, --hash and an exact decimal --generation.', 'HUMAN_INPUT');
      return publicOutput(await service()[action]({ planId, planHash, generation: Number(generation) }));
    }
    const requestedAction = action === 'plan' ? flags.get('action') : action;
    assert(requestedAction && ['install', 'update', 'uninstall', 'rollback'].includes(requestedAction) && flags.has('root'), 'Plan requires an action, provider, and absolute project root.', 'HUMAN_INPUT');
    return publicOutput(await service().plan({ action: requestedAction as InstallationAction, provider: provider(flags.get('provider')), projectRoot: flags.get('root')!, ...(flags.has('installation') ? { installationId: flags.get('installation')! } : {}) }));
  } catch (error) { throw commandFailure(error); }
}
