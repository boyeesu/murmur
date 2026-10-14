import type { GroupsService } from '../core/groups.js';
import type { ExternalGrantService } from '../core/external-grants.js';
import { assert, requireHuman, text } from '../protocol/index.js';
import type { Mutation, Principal } from '../protocol/index.js';

/** Reject ambiguous selectors rather than authenticating one and reading another. */
export function connectionQuery(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    assert(allowed.includes(key) && url.searchParams.getAll(key).length === 1, 'Unexpected or duplicate connection query field.', 'CONNECTION_INPUT');
  }
}
export async function readConnections(groups: GroupsService, external: ExternalGrantService, url: URL, principal: Principal): Promise<{ handled: boolean; result?: unknown }> {
  const queries: Record<string, string[]> = {
    '/v1/groups': ['projectId'], '/v1/groups/detail': ['groupId'], '/v1/groups/briefing': ['memberId'],
    '/v1/connections/requests': [], '/v1/connections/grants': ['projectId'],
  };
  if (!Object.hasOwn(queries, url.pathname)) return { handled: false };
  requireHuman(principal);
  connectionQuery(url, queries[url.pathname]!);
  switch (url.pathname) {
    case '/v1/groups': return { handled: true, result: groups.list(text(url.searchParams.get('projectId'), 'projectId'), principal) };
    case '/v1/groups/detail': return { handled: true, result: groups.get(text(url.searchParams.get('groupId'), 'groupId'), principal) };
    case '/v1/groups/briefing': return { handled: true, result: groups.briefing({ memberId: text(url.searchParams.get('memberId'), 'memberId') }, principal) };
    case '/v1/connections/requests': return { handled: true, result: external.listRequests(principal) };
    case '/v1/connections/grants': return { handled: true, result: external.listGrants(principal, url.searchParams.has('projectId') ? text(url.searchParams.get('projectId'), 'projectId') : undefined) };
  }
  return { handled: false };
}
export async function writeConnections(groups: GroupsService, external: ExternalGrantService, endpoint: string, body: Record<string, unknown>, principal: Principal, mutation: Mutation): Promise<{ handled: boolean; result?: unknown }> {
  const routes: Record<string, () => unknown | Promise<unknown>> = {
    '/v1/groups/create': () => groups.create(body, principal, mutation),
    '/v1/groups/invite': () => groups.invite(body, principal, mutation),
    '/v1/groups/invites/revoke': () => groups.revokeInvite(body, principal, mutation),
    '/v1/groups/members/add': () => groups.addExisting(body, principal, mutation),
    '/v1/groups/members/leave': () => groups.leave(body, principal, mutation),
    '/v1/groups/close': () => groups.close(body, principal, mutation),
    '/v1/groups/requests': () => groups.requestManaged(body, principal, mutation),
    '/v1/connections/review': () => external.review(body, principal, mutation),
    '/v1/connections/approve': () => external.approve(body, principal, mutation),
    '/v1/connections/reject': () => external.reject(body, principal, mutation),
    '/v1/connections/revoke': () => external.revoke(body, principal, mutation),
  };
  if (!Object.hasOwn(routes, endpoint)) return { handled: false };
  if (endpoint !== '/v1/groups/requests' && endpoint !== '/v1/groups/members/leave') requireHuman(principal);
  return { handled: true, result: await routes[endpoint]!() };
}
