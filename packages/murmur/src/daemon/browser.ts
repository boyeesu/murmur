import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assert } from '../protocol/index.js';
import type { CoordinationStore } from '../storage/store.js';

export class BrowserAccess {
  private tickets = new Map<string, { expiresAt: number; key: string }>();
  private sessions = new Map<string, number>();
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
    for (const [key, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(key);
  }
  ticket(origin: string, key: string) {
    this.prune();
    for (const [code, entry] of this.tickets) if (entry.key === key) return { url: `${origin}/ui/#bootstrap=${code}`, expiresAt: entry.expiresAt };
    assert(this.tickets.size < 32, 'Too many pending dashboard sign-ins. Try again after one minute.', 'RATE_LIMIT', 429);
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 60000;
    this.tickets.set(code, { expiresAt, key });
    return { url: `${origin}/ui/#bootstrap=${code}`, expiresAt };
  }
  exchange(code: string) {
    this.prune();
    assert(this.tickets.has(code), 'Dashboard sign-in is expired or already used. Reopen it from the CLI.', 'INVALID_BOOTSTRAP', 401);
    this.tickets.delete(code);
    assert(this.sessions.size < 16, 'Too many active dashboard sessions.', 'RATE_LIMIT', 429);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 30 * 60 * 1000;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }
  authenticated(token: string): boolean { this.prune(); return this.sessions.has(token); }
  close(): void { this.tickets.clear(); this.sessions.clear(); }
}

export async function serveDashboard(pathname: string, response: ServerResponse): Promise<boolean> {
  const assets: Record<string, [string, string]> = {
    '/ui/': ['index.html', 'text/html; charset=utf-8'],
    '/ui/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/ui/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  if (!Object.hasOwn(assets, pathname)) return false;
  const [filename, contentType] = assets[pathname];
  let data: Buffer;
  try { data = await readFile(new URL(`../dashboard/${filename}`, import.meta.url)); }
  catch { response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('Dashboard assets are not built. Run npm run build.'); return true; }
  response.writeHead(200, {
    'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(data);
  return true;
}

export function beginEventStream(request: IncomingMessage, response: ServerResponse, store: CoordinationStore, projectId: string, after: number, alive: () => boolean): void {
  store.project(projectId);
  let cursor = after;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
  response.write(': connected\n\n');
  const tick = () => {
    if (response.destroyed || !alive()) { clearInterval(timer); response.end(); return; }
    try {
      const events = store.events(projectId, cursor);
      if (!events.length) { if (!response.write(': heartbeat\n\n')) response.end(); return; }
      for (const event of events) {
        cursor = Number(event.sequence);
        if (!response.write(`id: ${cursor}\nevent: update\ndata: ${JSON.stringify({ sequence: cursor, type: event.type, createdAt: event.createdAt })}\n\n`)) { response.end(); break; }
      }
    } catch { response.end(); }
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  request.once('close', () => clearInterval(timer));
  response.once('close', () => clearInterval(timer));
  tick();
}
