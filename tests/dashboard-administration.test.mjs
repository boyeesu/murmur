import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Exercise the shipped browser script without a server or third-party DOM dependency.
// Only this test copy exposes closure internals; the distributed dashboard stays private.
const source = await readFile(new URL('../apps/dashboard/app.js', import.meta.url), 'utf8');
const exposed = source.replace('  void boot();', '  globalThis.dashboard = { state, boot, renderContent, refresh, navigate, selectProject, signOut, openInstallation, openInstallationRecovery, openCredential, openRetention, openBackup };');
assert.notEqual(exposed, source);

function matches(node, selector) {
  if (node.tagName === '#TEXT') return false;
  selector = selector.trim();
  const not = selector.match(/:not\(([^)]+)\)/);
  if (not && matches(node, not[1])) return false;
  selector = selector.replace(/:not\([^)]+\)/g, '');
  const tag = selector.match(/^[\w-]+/);
  if (tag && node.tagName !== tag[0].toUpperCase()) return false;
  for (const [, id] of selector.matchAll(/#([\w-]+)/g)) if (node.id !== id) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!node.className.split(/\s+/).includes(name)) return false;
  for (const [, name, quoted, plain] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)"|=([^\]]+))?\]/g)) {
    const actual = node.getAttribute(name);
    if (actual == null || (quoted !== undefined || plain !== undefined) && actual !== (quoted ?? plain)) return false;
  }
  return true;
}
class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.attributes = {}; this.dataset = {}; this.events = new Map(); this.className = ''; this.disabled = false; this.checked = false; this.open = false; }
  get disabled() { return this._disabled; }
  set disabled(value) { this._disabled = !!value; if (this._disabled && this.document.activeElement === this) this.document.activeElement = this.document.body; }
  set innerHTML(_) { throw new Error('Unsafe HTML sink'); }
  set outerHTML(_) { throw new Error('Unsafe HTML sink'); }
  setAttribute(key, value) {
    value = String(value); this.attributes[key] = value;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    else if (key === 'id' || key === 'name' || key === 'type') this[key] = value;
    else if (key === 'class') this.className = value;
  }
  getAttribute(key) { if (key === 'id' || key === 'name' || key === 'type') return this[key] ?? null; if (key === 'class') return this.className; return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name), toggle: (name, force) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); const on = force ?? !set.has(name); if (on) set.add(name); else set.delete(name); this.className = [...set].join(' '); return on; }, remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); } }; }
  append(...children) { for (const child of children) { const item = child instanceof Element ? child : this.document.createTextNode(String(child)); item.parentElement = this; this.children.push(item); } }
  replaceChildren(...children) { this.children.forEach(item => { item.parentElement = null; }); this.children = []; this.append(...children); }
  before(item) { const index = this.parentElement.children.indexOf(this); item.parentElement = this.parentElement; this.parentElement.children.splice(index, 0, item); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); }
  get firstChild() { return this.children[0]; }
  get firstElementChild() { return this.children.find(item => item.tagName !== '#TEXT'); }
  get lastElementChild() { return this.children.filter(item => item.tagName !== '#TEXT').at(-1); }
  get textContent() { return this.tagName === '#TEXT' ? this.text || '' : this.children.map(item => item.textContent).join(''); }
  set textContent(value) { if (this.tagName === '#TEXT') this.text = String(value); else this.replaceChildren(String(value)); }
  get value() { if (this._value !== undefined) return this._value; if (this.tagName === 'SELECT') return (this.children.find(item => item.selected) || this.children[0])?.value || ''; return this.tagName === 'TEXTAREA' || this.tagName === 'OPTION' ? this.textContent : ''; }
  set value(value) { this._value = String(value); }
  get elements() { const elements = this.querySelectorAll('input, textarea, select, button'); elements.namedItem = name => elements.find(item => item.name === name); return elements; }
  querySelectorAll(selector) { const selectors = selector.split(','); const result = []; const visit = node => { for (const child of node.children) { if (selectors.some(part => matches(child, part))) result.push(child); visit(child); } }; visit(this); return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(event, callback) { this.events.set(event, [...(this.events.get(event) || []), callback]); }
  async fire(type, event = {}) { const value = { preventDefault() {}, target: this, ...event }; await Promise.all((this.events.get(type) || []).map(callback => callback(value))); }
  click() { if (!this.disabled) return this.fire('click'); }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  reportValidity() { return this.elements.every(item => item.disabled || !item.required || (item.type === 'checkbox' ? item.checked : !!item.value)); }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
}
function browser({ hash = '', fetcher = async () => ({}) } = {}) {
  const document = { createElement(tag) { return new Element(tag, document); }, createTextNode(text) { const node = new Element('#text', document); node.text = text; return node; }, querySelector(selector) { return this.body.querySelector(selector); }, querySelectorAll(selector) { return this.body.querySelectorAll(selector); }, getElementById(id) { return this.querySelector(`#${id}`); }, addEventListener() {}, hidden: false };
  document.body = document.createElement('body'); document.activeElement = document.body;
  for (const id of ['project-select', 'register-project', 'refresh', 'page-actions', 'page-error', 'connection-status', 'page-content', 'toast', 'updated-at', 'page-title', 'page-description', 'menu-toggle', 'brand-link']) { const node = document.createElement(id === 'project-select' ? 'select' : 'div'); node.id = id; document.body.append(node); }
  for (const name of ['modal', 'drawer']) { const node = document.createElement('dialog'); node.id = name; const content = document.createElement('div'); content.id = `${name}-content`; node.append(content); document.body.append(node); }
  for (const name of ['tasks', 'alerts', 'decisions', 'workspaces', 'integration', 'adapters', 'connections', 'operations']) { const node = document.createElement('button'); node.setAttribute('data-page', name); const count = document.createElement('span'); count.setAttribute('data-count', name); node.append(count); document.body.append(node); }
  const calls = [], events = new Map();
  const location = { origin: 'http://127.0.0.1:43123', pathname: '/ui/', search: '', hash };
  const context = vm.createContext({ document, window: { addEventListener: (event, fn) => events.set(event, fn) }, Node: Element, location, history: { replaceState: (_, __, path) => { location.hash = ''; location.path = path; } }, crypto: webcrypto, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, navigator: {}, queueMicrotask, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, fetch: async (url, options) => { const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url: url.pathname + url.search, options, body }); const data = await fetcher(url, body); return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 }); } });
  vm.runInContext(exposed, context, { filename: 'dashboard/app.js' });
  return { ...context.dashboard, document, calls, location, events };
}
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
const field = (form, name) => form.elements.namedItem(name);
const clickText = async (root, text) => { const button = root.querySelectorAll('button').find(item => item.textContent === text); assert(button, `Missing button: ${text}`); await button.click(); await settle(); return button; };

const hash = 'a'.repeat(64);
const planId = '12345678-1234-1234-1234-123456789abc';
function fixtures() {
  const status = { projects: [{ id: 'p1', root: '/verified/project' }], sessions: [{ id: 's1', projectId: 'p1', tool: 'codex', credentialMode: 'manual', tokenHash: 'NEVER_SHOW_TOKEN' }], tasks: [] };
  const inspection = { schemaVersion: 1, generation: 4, stateDirectory: '/private/state/integrations', installations: [], providers: ['claude', 'codex', 'opencode', 'cursor'].map(provider => ({ provider, enabled: ['claude', 'codex'].includes(provider), description: 'Provider', limitation: null })), pending: null, opaqueAuthorizer: 'NEVER_SHOW_AUTHORIZER' };
  const plan = { schemaVersion: 1, planId, planHash: hash, generation: 4, action: 'install', installationId: 'ins_123', provider: 'codex', projectRoot: '/verified/project', scope: 'project', expiresAt: Date.now() + 900000,
    affectedPaths: [{ path: '/verified/project/.codex/hooks.json', operation: 'replace', beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64) }, { path: '/private/state/bundle/hook.js', operation: 'create', beforeHash: null, afterHash: 'd'.repeat(64) }], backupPaths: ['/private/state/objects/backup-hash'], preservedPaths: ['/private/state/custom-user-file'], nativeConfigurationChanges: [{ path: '/verified/project/.codex/hooks.json', keys: ['hooks', 'UserPromptSubmit'], operation: 'append-owned-hook' }], requestedBehavior: ['Preserve all non-owned native hooks'], activation: { kind: 'manual', cwd: '/verified/project', instructions: 'Approve /hooks separately', testedVersion: 'tested', nativeLoaded: 'unverified' }, linkedGrants: [{ grantId: 'grant-kept', projectId: 'p1', sessionId: 's1', status: 'active' }], grantDiscovery: 'available', grantsRevoked: false, token: 'NEVER_SHOW_PLAN_TOKEN', authorizer: { sql: 'NEVER_SHOW_SQL' } };
  const credential = { sessionId: 's1', projectId: 'p1', mode: 'manual', revision: 8, revokedAt: null, changedAt: 1700000000000, canRotate: true, tokenHash: 'NEVER_SHOW_CREDENTIAL' };
  return { status, inspection, plan, credential };
}
function setup(fetcher, fixture = fixtures()) {
  const app = browser({ fetcher: async (url, body) => {
    const result = await fetcher?.(url, body);
    if (result !== undefined) return result;
    if (url.pathname === '/v1/status') return fixture.status;
    if (url.pathname === '/v1/integrations') return fixture.inspection;
    if (url.pathname === '/v1/integrations/plan') return fixture.plan;
    if (url.pathname === '/v1/maintenance/credentials') return fixture.credential;
    return [];
  } });
  Object.assign(app.state, { token: 'PRIVATE_BROWSER_BEARER', projectId: 'p1', projects: fixture.status.projects, loaded: true, page: 'operations', data: { status: fixture.status, operations: fixture.inspection } });
  return app;
}
function failure(code, message = 'NEVER_SHOW_SERVER_MESSAGE') { return new Response(JSON.stringify({ error: { code, message, details: { sql: 'NEVER_SHOW_SQL', token: 'NEVER_SHOW_ERROR_TOKEN' } } }), { status: 409 }); }
async function confirm(form) { field(form, 'confirmAdministration').checked = true; await form.fire('change', { target: field(form, 'confirmAdministration') }); }
async function submit(form) { await form.fire('submit'); await settle(); }
function submitButton(form) { return form.querySelector('button[type="submit"]'); }
function assertPrivate(app) {
  assert.doesNotMatch(app.document.body.textContent, /NEVER_SHOW|PRIVATE_BROWSER_BEARER/);
  for (const request of app.calls) {
    assert.equal(request.options.headers.Authorization, 'Bearer PRIVATE_BROWSER_BEARER');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.mode, 'same-origin');
    assert.equal(request.options.redirect, 'error');
    assert(!/rotate|restore|bootstrap|poll/.test(request.url));
  }
}

test('Operations uses gated provider capabilities and keeps rotation and restore CLI-only', () => {
  const app = setup(); app.renderContent();
  const buttons = app.document.querySelectorAll('button');
  for (const provider of ['claude', 'codex']) assert.equal(app.document.querySelector(`[data-focus-key="manage-${provider}"]`).disabled, false);
  for (const provider of ['opencode', 'cursor']) assert.equal(app.document.querySelector(`[data-focus-key="manage-${provider}"]`).disabled, true);
  assert(buttons.find(item => item.textContent === 'Rotate credential · CLI only').disabled);
  assert(buttons.find(item => item.textContent === 'Offline restore · CLI only').disabled);
  assert.match(app.document.body.textContent, /Bundle management only/);
  assert.match(app.document.body.textContent, /Additive project .codex\/hooks.json/);
  assert.match(app.document.body.textContent, /Native loaded/);
  assert.match(app.document.body.textContent, /across all projects/);
  assert.throws(() => app.openInstallation('opencode'), /verified available provider/);
  assert.throws(() => app.openInstallation('cursor'), /verified available provider/);
  assertPrivate(app);
});

test('installation plans show exact public hashes paths preserved content and grants, then send only exact approval', async () => {
  const fixture = fixtures(); let applied;
  const app = setup((url, body) => {
    if (url.pathname === '/v1/integrations/apply') { applied = body; return { applied: true, recovered: false, generation: 5, installation: { status: 'installed', integrity: 'unchanged', nativeConfigured: true }, preservedPaths: [], grantsRevoked: false, nativeLoaded: 'unverified' }; }
  }, fixture);
  const form = app.openInstallation('codex');
  assert(submitButton(form).disabled);
  await clickText(form, 'Create fresh plan');
  assert(submitButton(form).disabled, 'review alone is not confirmation');
  for (const text of [fixture.plan.planId, hash, fixture.plan.affectedPaths[0].beforeHash, fixture.plan.affectedPaths[0].afterHash, fixture.plan.backupPaths[0], fixture.plan.preservedPaths[0], 'grant-kept', 'UserPromptSubmit']) assert(form.textContent.includes(text));
  await confirm(form); assert(!submitButton(form).disabled); await submit(form);
  assert.deepEqual(applied, { planId, planHash: hash, generation: 4 });
  const request = app.calls.find(item => item.url === '/v1/integrations/plan');
  assert.deepEqual(request.body, { action: 'install', provider: 'codex', projectRoot: '/verified/project' });
  assert(app.calls.some(item => item.url === '/v1/integrations?projectRoot=%2Fverified%2Fproject&provider=codex'));
  assert.match(app.document.body.textContent, /Installation plan applied/);
  assert.match(app.document.body.textContent, /Native loadedUnverified/);
  assertPrivate(app);
});

test('uninstall uses an explicit installation ID and never revokes grants or abandons tasks', async () => {
  const fixture = fixtures(), installation = { installationId: 'ins_owned', status: 'installed' };
  fixture.plan = { ...fixture.plan, installationId: installation.installationId, action: 'uninstall', nativeConfigurationChanges: [], activation: null };
  const app = setup(undefined, fixture), form = app.openInstallation('codex', installation);
  field(form, 'installationAction').value = 'uninstall'; await form.fire('change', { target: field(form, 'installationAction') });
  await clickText(form, 'Create fresh plan');
  assert.deepEqual(app.calls.find(item => item.url === '/v1/integrations/plan').body, { action: 'uninstall', provider: 'codex', projectRoot: '/verified/project', installationId: 'ins_owned' });
  assert.match(form.textContent, /Uninstall does not revoke linked grants, abandon tasks, delete source files/);
  assert(!app.calls.some(item => /revoke|tasks|abandon/.test(item.url)));
});

test('changed action invalidates the reviewed plan and expiry prevents apply', async () => {
  const fixture = fixtures(), app = setup(undefined, fixture), form = app.openInstallation('codex');
  await clickText(form, 'Create fresh plan'); await confirm(form);
  await form.fire('change', { target: field(form, 'installationAction') });
  assert(submitButton(form).disabled); assert.equal(field(form, 'confirmAdministration').checked, false);
  await confirm(form); await submit(form);
  assert(!app.calls.some(item => item.url === '/v1/integrations/apply'));
  fixture.plan.expiresAt = Date.now() - 1000;
  await clickText(form, 'Create fresh plan');
  assert(submitButton(form).disabled); assert.match(form.textContent, /expired/);
});

test('failed apply cannot replay and preserves focused draft through SSE refresh with safe errors', async () => {
  const app = setup(url => url.pathname === '/v1/integrations/apply' ? failure('INSTALLATION_STALE_PLAN') : undefined);
  const form = app.openInstallation('codex'), action = field(form, 'installationAction'); action.focus();
  await clickText(form, 'Create fresh plan'); await confirm(form); await submit(form);
  assert.equal(app.document.querySelector('form'), form); assert.equal(app.document.activeElement, action);
  assert(submitButton(form).disabled); assert(!field(form, 'confirmAdministration').checked);
  assert.match(form.textContent, /files changed/); assertPrivate(app);
  await app.refresh(true);
  assert.equal(app.document.querySelector('form'), form); assert.equal(field(form, 'installationAction'), action); assert.equal(app.document.activeElement, action);
  await confirm(form); await submit(form);
  assert.equal(app.calls.filter(item => item.url === '/v1/integrations/apply').length, 1);
});

test('SSE generation changes and sign-out invalidate installation reviews without removing drafts', async () => {
  const fixture = fixtures(), app = setup(undefined, fixture), form = app.openInstallation('codex');
  await clickText(form, 'Create fresh plan'); await confirm(form);
  fixture.inspection.generation = 5;
  await app.refresh(true);
  assert(submitButton(form).disabled); assert.match(form.textContent, /state changed/); assert(!field(form, 'confirmAdministration').checked);
  fixture.plan.generation = 5;
  await clickText(form, 'Create fresh plan'); await confirm(form);
  app.signOut(); assert(submitButton(form).disabled); assert.equal(app.document.querySelector('form'), form);
  await submit(form); assert(!app.calls.some(item => item.url === '/v1/integrations/apply'));
});

test('pending recovery is explicitly re-inspected and aborts only the exact pending transaction', async () => {
  const fixture = fixtures(); fixture.inspection.pending = { planId, planHash: hash, generation: 3 };
  let recovered;
  const app = setup((url, body) => {
    if (url.pathname === '/v1/integrations/recover') { recovered = body; return { applied: false, recovered: true, generation: 5, installation: null, preservedPaths: [], nativeLoaded: 'unverified', grantsRevoked: false }; }
  }, fixture);
  app.renderContent(); assert(app.document.querySelector('[data-focus-key="manage-codex"]').disabled);
  const form = app.openInstallationRecovery(); await clickText(form, 'Inspect exact pending transaction');
  assert(submitButton(form).disabled); assert.match(form.textContent, /aborts the identified pending/);
  await confirm(form); await submit(form);
  assert.deepEqual(recovered, { planId, planHash: hash, generation: 3 });
  assert.equal(app.calls.filter(item => item.url === '/v1/integrations/recover').length, 1);
  assert(!app.calls.some(item => /integrations\/(apply|plan)$/.test(item.url)));
  assert.match(app.document.body.textContent, /did not retry installation/); assertPrivate(app);
});

test('recovery failures clear approval and never automatically retry', async () => {
  const fixture = fixtures(); fixture.inspection.pending = { planId, planHash: hash, generation: 3 };
  const app = setup(url => url.pathname === '/v1/integrations/recover' ? failure('INSTALLATION_RECOVERY_CONFLICT') : undefined, fixture);
  const form = app.openInstallationRecovery(); await clickText(form, 'Inspect exact pending transaction'); await confirm(form); await submit(form);
  assert(submitButton(form).disabled); assert.match(form.textContent, /preserved changed content/);
  await confirm(form); await submit(form);
  assert.equal(app.calls.filter(item => item.url === '/v1/integrations/recover').length, 1); assertPrivate(app);
});

test('manual revoke sends credential revision, never heartbeat revision or secret fields', async () => {
  let revoked; const fixture = fixtures(); fixture.status.sessions[0].revision = 9999;
  const app = setup((url, body) => {
    if (url.pathname === '/v1/maintenance/credentials/revoke') { revoked = body; return { ...fixture.credential, revision: 9, revokedAt: Date.now() }; }
  }, fixture);
  const form = app.openCredential('s1'); await clickText(form, 'Inspect current credential');
  assert(submitButton(form).disabled); await confirm(form); await submit(form);
  assert.deepEqual(revoked, { sessionId: 's1', revision: 8 });
  assert.match(app.document.body.textContent, /Manual credential revoked/); assertPrivate(app);
});

test('managed, external, and already-revoked credentials cannot use manual revoke', async () => {
  for (const mode of ['managed', 'external', 'manual']) {
    const fixture = fixtures(); fixture.credential = { ...fixture.credential, mode, canRotate: mode === 'manual', revision: mode === 'manual' ? 8 : null, revokedAt: mode === 'manual' ? Date.now() : null };
    const app = setup(undefined, fixture), form = app.openCredential('s1');
    await clickText(form, 'Inspect current credential'); await confirm(form);
    assert(submitButton(form).disabled); assert.match(form.textContent, /Revocation disabled/);
    await submit(form); assert(!app.calls.some(item => /credentials\/revoke/.test(item.url))); assertPrivate(app);
  }
});

function preview(body) { return { ...body, revision: 12, previewDigest: hash, counts: { 'unreviewed-drafts': 0, events: body.classes.includes('events') ? 6 : 0, 'context-records': body.classes.includes('context-records') ? 3 : 0, 'mutation-payloads': 0 }, cutoffs: { before: body.before, events: [{ projectId: 'another-project', throughSequence: 18, count: 6 }], contexts: [{ projectId: 'another-project', before: body.before, count: 3 }] }, candidates: { token: 'NEVER_SHOW_CANDIDATE', sql: 'NEVER_SHOW_SQL' } }; }
async function retentionDraft(form, classes = ['events', 'context-records']) {
  field(form, 'retentionBefore').value = '2025-01-02T03:04';
  for (const key of classes) field(form, `retention-${key}`).checked = true;
  await form.fire('input', { target: field(form, 'retentionBefore') });
}

test('retention defaults select nothing, validates cutoff, and shows daemon-wide class counts and exact project cutoffs', async () => {
  const app = setup((url, body) => url.pathname === '/v1/maintenance/retention/preview' ? preview(body) : undefined), form = app.openRetention();
  assert(form.querySelectorAll('input[type="checkbox"]').every(item => !item.checked));
  await clickText(form, 'Run retention preview'); assert(!app.calls.length);
  field(form, 'retentionBefore').value = '2025-01-02T03:04';
  await clickText(form, 'Run retention preview'); assert.match(form.textContent, /Select at least one/); assert(!app.calls.length);
  await retentionDraft(form); await clickText(form, 'Run retention preview');
  assert.match(form.textContent, /another-project/); assert.match(form.textContent, /Event cutoff sequence/); assert.match(form.textContent, /18/);
  assert.match(form.textContent, /Context cutoff/); assert.match(form.textContent, /Not selected/);
  assert.match(form.textContent, /epoch ms/); assert.match(form.textContent, /idempotency tombstones/);
  assert(submitButton(form).disabled); assertPrivate(app);
});

test('retention apply requires exact fresh digest/revision and explicit irreversible confirmation', async () => {
  let applied;
  const app = setup((url, body) => {
    if (url.pathname === '/v1/maintenance/retention/preview') return preview(body);
    if (url.pathname === '/v1/maintenance/retention/apply') { applied = body; return { ...preview(body), applied: true, newRevision: 13 }; }
  }), form = app.openRetention();
  await retentionDraft(form); await clickText(form, 'Run retention preview'); await confirm(form); await submit(form);
  assert.deepEqual(applied, { before: new Date('2025-01-02T03:04').getTime(), classes: ['events', 'context-records'], previewDigest: hash, revision: 12 });
  assert.match(app.document.body.textContent, /Reviewed metadata pruned/); assertPrivate(app);
});

test('stale retention keeps cutoff classes and focus across refresh, clears confirmation, and requires new review', async () => {
  const app = setup((url, body) => {
    if (url.pathname === '/v1/maintenance/retention/preview') return preview(body);
    if (url.pathname === '/v1/maintenance/retention/apply') return failure('STALE_RETENTION_PREVIEW');
  }), form = app.openRetention();
  await retentionDraft(form); const cutoff = field(form, 'retentionBefore'); cutoff.focus(); cutoff.setSelectionRange(4, 7);
  await clickText(form, 'Run retention preview'); await confirm(form); await submit(form); await app.refresh(true);
  assert.equal(app.document.querySelector('form'), form); assert.equal(app.document.activeElement, cutoff); assert.equal(cutoff.selectionStart, 4);
  assert.equal(cutoff.value, '2025-01-02T03:04'); assert(field(form, 'retention-events').checked); assert(field(form, 'retention-context-records').checked);
  assert(!field(form, 'confirmAdministration').checked); assert(submitButton(form).disabled); assert.match(form.textContent, /retention preview is stale/);
  await confirm(form); await submit(form); assert.equal(app.calls.filter(item => item.url === '/v1/maintenance/retention/apply').length, 1);
  await clickText(form, 'Run retention preview'); await confirm(form); assert(!submitButton(form).disabled);
  await form.fire('change', { target: field(form, 'retention-events') }); assert(submitButton(form).disabled); assertPrivate(app);
});

test('backup requires a new absolute private destination and explicit confirmation, without downloads or overwrite flags', async () => {
  let backup;
  const app = setup((url, body) => { if (url.pathname === '/v1/maintenance/backup') { backup = body; return { destination: body.destination, pages: 12, schemaVersion: 1, sensitive: true, token: 'NEVER_SHOW_BACKUP_TOKEN' }; } }), form = app.openBackup();
  assert.match(form.textContent, /contains private credentials/); assert.match(form.textContent, /0700/); assert.match(form.textContent, /never overwrites/);
  field(form, 'backupDestination').value = 'relative.sqlite'; field(form, 'confirmBackup').checked = true; await submit(form); assert.equal(backup, undefined);
  field(form, 'backupDestination').value = '/private/backups/new.sqlite'; field(form, 'confirmBackup').checked = false; await submit(form); assert.equal(backup, undefined);
  field(form, 'confirmBackup').checked = true; await submit(form);
  assert.deepEqual(backup, { destination: '/private/backups/new.sqlite' });
  assert.match(app.document.body.textContent, /Private backup created/); assertPrivate(app);
});

test('backup errors retain private path draft, clear consent, and never echo raw daemon details', async () => {
  const app = setup(url => url.pathname === '/v1/maintenance/backup' ? failure('UNKNOWN') : undefined), form = app.openBackup();
  const destination = field(form, 'backupDestination'); destination.value = '/private/new.sqlite'; destination.focus(); destination.setSelectionRange(3, 5); field(form, 'confirmBackup').checked = true;
  await submit(form); await app.refresh(true);
  assert.equal(field(form, 'backupDestination'), destination); assert.equal(destination.value, '/private/new.sqlite'); assert.equal(app.document.activeElement, destination);
  assert(!field(form, 'confirmBackup').checked); await submit(form);
  assert.equal(app.calls.filter(item => item.url === '/v1/maintenance/backup').length, 1); assertPrivate(app);
});

test('rendered server-supplied path and label content stays literal text and never HTML', async () => {
  const fixture = fixtures(); fixture.plan.preservedPaths = ['<img src=x onerror=steal()>']; fixture.inspection.providers[0].limitation = '<script>attack()</script>';
  const app = setup(undefined, fixture); app.renderContent(); const form = app.openInstallation('codex'); await clickText(form, 'Create fresh plan');
  assert.match(app.document.body.textContent, /<script>attack\(\)<\/script>/); assert.match(form.textContent, /<img src=x onerror=steal\(\)>/);
  assert.equal(app.document.querySelectorAll('img, script').length, 0); assertPrivate(app);
});

test('maintenance remains available without a registered project and inspection errors do not imply an empty install', async () => {
  const fixture = fixtures(); fixture.status.projects = []; fixture.status.sessions = [];
  const app = setup(url => url.pathname === '/v1/integrations' ? failure('INVALID_SCHEMA') : undefined, fixture);
  app.state.projectId = ''; delete app.state.data.operations; await app.refresh();
  assert.match(app.document.body.textContent, /Installation inspection is unavailable/); assert.match(app.document.body.textContent, /Preview retention/); assert.match(app.document.body.textContent, /Create private backup/);
  assert(!app.document.querySelector('[data-focus-key="retention"]').disabled); assert(app.document.querySelector('[data-focus-key="manage-codex"]').disabled); assertPrivate(app);
});


test('switching projects during a plan request keeps it unavailable and never applies the old scope', async () => {
  let resolvePlan;
  const fixture = fixtures(), app = setup(url => url.pathname === '/v1/integrations/plan' ? new Promise(resolve => { resolvePlan = resolve; }) : undefined, fixture);
  const form = app.openInstallation('codex');
  await clickText(form, 'Create fresh plan');
  assert(resolvePlan); app.state.generation++; app.state.projectId = 'other-project';
  resolvePlan(fixture.plan); await settle();
  assert(submitButton(form).disabled); assert.match(form.textContent, /project changed/);
  await confirm(form); await submit(form);
  assert(!app.calls.some(item => item.url === '/v1/integrations/apply'));
});

test('a credential revoke revision conflict requires a fresh inspection, not a write retry', async () => {
  const app = setup(url => url.pathname === '/v1/maintenance/credentials/revoke' ? failure('STALE_REVISION') : undefined), form = app.openCredential('s1');
  await clickText(form, 'Inspect current credential'); await confirm(form); await submit(form);
  assert(submitButton(form).disabled); assert.match(form.textContent, /credential revision changed/);
  await confirm(form); await submit(form);
  assert.equal(app.calls.filter(item => item.url === '/v1/maintenance/credentials/revoke').length, 1); assertPrivate(app);
});

test('backup consent is cleared when its destination changes', async () => {
  const app = setup(), form = app.openBackup(); field(form, 'confirmBackup').checked = true;
  const destination = field(form, 'backupDestination'); destination.value = '/private/changed.sqlite'; await form.fire('input', { target: destination });
  assert(!field(form, 'confirmBackup').checked); await submit(form); assert.equal(app.calls.length, 0);
});


test('failed reviewed submit restores focus to fresh review when its apply button becomes disabled', async () => {
  const app = setup(url => url.pathname === '/v1/integrations/apply' ? failure('INSTALLATION_STALE_PLAN') : undefined), form = app.openInstallation('codex');
  await clickText(form, 'Create fresh plan'); await confirm(form); submitButton(form).focus();
  await submit(form);
  assert(submitButton(form).disabled); assert.equal(app.document.activeElement, form.querySelector('[data-administration-review]'));
});


test('installer locks pause new plans and direct humans to explicit CLI inspection', async () => {
  for (const state of ['active', 'stale', 'unreadable', 'unsafe']) {
    const fixture = fixtures();
    fixture.inspection.lock = { state, fingerprint: hash, approval: null, repairRequiresStoppedOwner: true, secret: 'NEVER_SHOW_LOCK' };
    const app = setup(undefined, fixture); app.renderContent();
    for (const provider of ['claude', 'codex']) assert(app.document.querySelector(`[data-focus-key="manage-${provider}"]`).disabled);
    assert.match(app.document.body.textContent, /installer operation lock is present/);
    assert.match(app.document.body.textContent, /No lock is removed automatically/);
    assertPrivate(app);
  }
});
