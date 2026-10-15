import { MurmurError, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';
import type { MaintenanceService } from '../core/maintenance.js';
import type { InstallationService } from '../integrations/index.js';
import type { InstallationApproval, InstallationPlanRequest, InstallationProvider } from '../integrations/types.js';
import { connectionQuery } from './connections.js';

export async function readAdministration(maintenance: MaintenanceService, integrations: InstallationService, url: URL, principal: Principal): Promise<{ handled: boolean; result?: unknown }> {
  if (url.pathname === '/v1/maintenance/credentials') {
    requireHuman(principal); connectionQuery(url, ['sessionId']);
    return { handled: true, result: maintenance.credentialStatus(text(url.searchParams.get('sessionId'), 'sessionId'), principal) };
  }
  if (url.pathname === '/v1/integrations') {
    requireHuman(principal); connectionQuery(url, ['projectRoot', 'provider']);
    return { handled: true, result: await integrations.inspect({
      ...(url.searchParams.has('projectRoot') ? { projectRoot: text(url.searchParams.get('projectRoot'), 'projectRoot', 4096) } : {}),
      ...(url.searchParams.has('provider') ? { provider: text(url.searchParams.get('provider'), 'provider') as InstallationProvider } : {}),
    }) };
  }
  return { handled: false };
}
export async function writeAdministration(maintenance: MaintenanceService, integrations: InstallationService, endpoint: string, body: Record<string, unknown>, principal: Principal, mutation: Mutation): Promise<{ handled: boolean; result?: unknown }> {
  const routes: Record<string, () => unknown | Promise<unknown>> = {
    '/v1/maintenance/credentials/revoke': () => maintenance.revokeManual(body, principal, mutation),
    '/v1/maintenance/credentials/rotate': () => maintenance.rotateManual(body, principal, mutation),
    '/v1/maintenance/retention/preview': () => maintenance.previewRetention(body, principal),
    '/v1/maintenance/retention/apply': () => maintenance.applyRetention(body, principal, mutation),
    '/v1/maintenance/backup': () => maintenance.backup(body, principal),
    '/v1/integrations/plan': () => integrations.plan(body as unknown as InstallationPlanRequest),
    '/v1/integrations/apply': () => integrations.apply(body as unknown as InstallationApproval),
    '/v1/integrations/recover': () => integrations.recover(body as unknown as InstallationApproval),
  };
  if (!Object.hasOwn(routes, endpoint)) return { handled: false };
  requireHuman(principal);
  try { return { handled: true, result: await routes[endpoint]!() }; }
  catch (error) {
    if (endpoint === '/v1/maintenance/backup' && (error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new MurmurError('Backup destination already exists. Existing files are never overwritten.', 'BACKUP_EXISTS', 409);
    throw error;
  }
}
