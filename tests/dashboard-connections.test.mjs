import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Exercise the shipped browser script without a server or third-party DOM dependency.
// Only this test copy exposes closure internals; the distributed dashboard stays private.
const source = await readFile(new URL('../apps/dashboard/app.js', import.meta.url), 'utf8');
const exposed = source.replace('  void boot();', '  globalThis.dashboard = { state, boot, renderContent, refresh, openEnrollment, eligibleGroupTasks, readHandoff, handoffFields, reviewedExport, grantState, requestState, publicRequestReference, openAddMember, openGroup, openInvite, eligibleReconnections, serializeReviewedExport, openExportHandoff };');
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
  for (const name of ['tasks', 'alerts', 'decisions', 'workspaces', 'integration', 'adapters', 'connections']) { const node = document.createElement('button'); node.setAttribute('data-page', name); const count = document.createElement('span'); count.setAttribute('data-count', name); node.append(count); document.body.append(node); }
  const calls = [], events = new Map();
  const location = { origin: 'http://127.0.0.1:43123', pathname: '/ui/', search: '', hash };
  const context = vm.createContext({ document, window: { addEventListener: (event, fn) => events.set(event, fn) }, Node: Element, location, history: { replaceState: (_, __, path) => { location.hash = ''; location.path = path; } }, crypto: webcrypto, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, navigator: {}, queueMicrotask, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, fetch: async (url, options) => { const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url: url.pathname + url.search, options, body }); const data = await fetcher(url, body); return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 }); } });
  vm.runInContext(exposed, context, { filename: 'dashboard/app.js' });
  return { ...context.dashboard, document, calls, location, events };
}
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
const field = (form, name) => form.elements.namedItem(name);
const clickText = async (root, text) => { const button = root.querySelectorAll('button').find(item => item.textContent === text); assert(button, `Missing button: ${text}`); await button.click(); await settle(); return button; };
const handoffForm = (extra = {}, overrides = {}) => { const values = { handoffSummary: 'Coordinate a reviewed change', handoffChangedFiles: '', handoffRemainingWork: '', handoffCriteria: 'Has a regression test', handoffReads: 'src/api', handoffWrites: 'src/api/index.ts', handoffBlocker: '', handoffStructured: JSON.stringify(extra), ...overrides }; return { elements: { namedItem: name => ({ value: values[name] || '' }) } }; };
function fixture(kind = 'external') {
  const now = Date.now();
  const request = { requestId: 'public-request-1', kind, state: 'pending', revision: 1, expiresAt: now + 600000, decidedAt: null, workspaceRoot: '/unverified/workspace-hint', native: { tool: 'codex', nativeId: 'reported-chat-id', incarnationId: 'reported-incarnation' }, groupTitle: '<script>untrusted group</script>', groupGoal: 'Shared goal', responsibility: 'Own the endpoint', handoff: { summary: 'Review me', changedFiles: ['src/auth/reported-past.ts'], remainingWork: ['Finish the endpoint test'], writes: ['src/auth/planned-next.ts'], acceptanceCriteria: [] }, sessionId: kind === 'managed' ? 'session-1' : null, taskId: kind === 'managed' ? 'task-1' : null, requestDigest: 'a'.repeat(64), review: null, capabilityHash: 'NEVER_SHOW_CANDIDATE', pollSecretHash: 'NEVER_SHOW_POLL' };
  const review = { requestId: request.requestId, revision: 2, requestDigest: request.requestDigest, reviewDigest: 'b'.repeat(64), inspection: { projectId: 'project-1', workspaceRoot: '/verified/workspace', canonicalPath: '/verified/project', mode: 'advisory', sharedCheckout: true, projectFingerprint: 'NEVER_SHOW_FINGERPRINT', workspaceFingerprint: 'NEVER_SHOW_WORKSPACE_HASH' }, group: null, nativeIdentitySource: 'request_metadata_not_authentication' };
  const status = { projects: [{ id: 'project-1', root: '/verified/project' }], tasks: [{ id: 'task-1', projectId: 'project-1', ownerSessionId: 'session-1', title: 'Existing managed work', status: 'active' }], sessions: [{ id: 'session-1', projectId: 'project-1', credentialMode: kind === 'managed' ? 'managed' : 'manual', workspaceRoot: '/verified/workspace' }], launches: kind === 'managed' ? [{ sessionId: 'session-1', taskId: 'task-1', state: 'running', expiresAt: now + 300000 }] : [] };
  return { request, review, status };
}
function authenticated(harness, status) { harness.state.token = 'PRIVATE_BROWSER_BEARER'; harness.state.projectId = 'project-1'; harness.state.projects = status.projects; harness.state.data.status = status; harness.state.page = 'connections'; harness.state.loaded = true; }

test('public request references never bootstrap or authenticate the browser', async () => {
  const app = browser({ hash: '#request=public-request-1' });
  await app.boot();
  assert.equal(app.calls.length, 0); assert.equal(app.state.token, null); assert.equal(app.location.hash, '');
  assert.match(app.document.body.textContent, /does not sign you in/);
  assert.equal(app.publicRequestReference('../private'), null); assert.equal(app.publicRequestReference('<script>'), null);
  assert.equal(app.publicRequestReference('public-request_1'), 'public-request_1');
});

test('handoff parsing validates structured parts and never accepts extra fields', () => {
  const app = browser();
  const parsed = app.readHandoff(handoffForm({ produces: [{ key: 'api.output', version: '1', value: 'response' }], decisions: [{ key: 'api.shape', version: '1', value: 'json', rationale: 'Interoperability' }] }));
  assert.equal(parsed.decisions[0].value, 'json'); assert.equal(parsed.produces[0].key, 'api.output');
  for (const [extra, overrides, pattern] of [
    [{ credential: 'secret' }, {}, /unknown fields/],
    [{ decisions: [{ key: 'safe', version: '1', value: 'x', rationale: 'why', status: 'accepted' }] }, {}, /unknown fields/],
    [{ produces: [{ key: 'a', version: 1 }] }, {}, /Contract version/],
    [{ produces: [{ key: 'a', version: '1' }, { key: 'a', version: '2' }] }, {}, /Duplicate contract/],
    [{ dependencies: [null] }, {}, /Dependency task ID/],
    [{}, { handoffStructured: '{broken' }, /valid JSON/],
    [{}, { handoffWrites: '../outside' }, /relative literal paths/],
    [{}, { handoffWrites: 'src\\file.ts' }, /relative literal paths/],
    [{}, { handoffSummary: '' }, /Reviewed summary/],
  ]) assert.throws(() => app.readHandoff(handoffForm(extra, overrides)), pattern);
  assert.equal(app.readHandoff(handoffForm({}, { handoffSummary: '', handoffCriteria: '', handoffReads: '', handoffWrites: '' })), undefined);
});

test('manual member picker excludes external, terminal, occupied, and expired managed bindings', () => {
  const app = browser(); const { status } = fixture(); authenticated(app, status);
  const modes = ['manual', 'external', 'managed', 'managed', 'manual', 'manual'];
  app.state.data.status.sessions = modes.map((credentialMode, n) => ({ id: `s${n}`, projectId: 'project-1', credentialMode }));
  app.state.data.status.tasks = modes.map((_, n) => ({ id: `t${n}`, ownerSessionId: `s${n}`, projectId: 'project-1', status: n === 4 ? 'abandoned' : 'active' }));
  app.state.data.groups = [{ members: [{ sessionId: 's5', state: 'active' }] }];
  app.state.data.status.launches = [{ sessionId: 's2', taskId: 't2', state: 'running', expiresAt: Date.now() + 60000 }, { sessionId: 's3', taskId: 't3', state: 'running', expiresAt: Date.now() - 1 }];
  assert.deepEqual(Array.from(app.eligibleGroupTasks(), item => item.id), ['t0', 't2']);
});

test('grant labels distinguish approval, contact, expiry and revocation without liveness claims', () => {
  const app = browser(), grant = { revokedAt: null, expiresAt: Date.now() + 3600000, bridgeFirstSeenAt: null, bridgeLastSeenAt: null };
  assert.equal(app.grantState(grant)[1], 'Approved · not yet used');
  grant.bridgeFirstSeenAt = Date.now(); grant.bridgeLastSeenAt = Date.now(); assert.equal(app.grantState(grant)[1], 'Recent bridge contact');
  grant.bridgeLastSeenAt -= 3600000; assert.equal(app.grantState(grant)[1], 'No recent bridge contact');
  grant.expiresAt = Date.now() - 1; assert.equal(app.grantState(grant)[0], 'expired');
  grant.revokedAt = Date.now(); assert.equal(app.grantState(grant)[0], 'revoked');
});

test('external approval sends exact review revision/digest, default expiry and only reviewed handoff', async () => {
  const { request, review, status } = fixture(); let approved;
  const app = browser({ fetcher: async (url, body) => {
    if (url.pathname === '/v1/connections/requests') return [request];
    if (url.pathname === '/v1/connections/review') { assert.equal(body.revision, 1); return review; }
    if (url.pathname === '/v1/status') return status;
    if (url.pathname === '/v1/connections/approve') { approved = body; return { group: { id: 'g1', title: 'Group', projectId: 'project-1' }, member: { sessionId: 'new-session', taskId: 'new-task', responsibility: body.responsibility }, grant: { expiresAt: Date.now() + 28800000, revokedAt: null, bridgeFirstSeenAt: null, bridgeLastSeenAt: null } }; }
    return [];
  } }); authenticated(app, status); app.openEnrollment(request);
  const form = app.document.querySelector('form'); assert(form.querySelector('button[type="submit"]').disabled);
  field(form, 'responsibility').value = 'Human-reviewed responsibility'; field(form, 'handoffSummary').value = 'Human-reviewed summary'; await clickText(form, 'Inspect workspace / fresh review');
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
  assert.match(form.textContent, /\/verified\/workspace/); assert.match(form.textContent, /Shared workspace warning/); assert.match(form.textContent, /Reported past changes, not intended writes or filesystem proof/);
  for (const name of ['confirmIdentity', 'confirmWorkspace', 'confirmSharing']) field(form, name).checked = true; await form.fire('submit');
  assert.equal(approved.revision, 2); assert.equal(approved.reviewDigest, review.reviewDigest); assert.equal(approved.expiresInSeconds, 28800);
  assert.equal(approved.responsibility, 'Human-reviewed responsibility'); assert.equal(approved.handoff.summary, 'Human-reviewed summary');
  assert.deepEqual(approved.handoff.changedFiles, ['src/auth/reported-past.ts']); assert.deepEqual(approved.handoff.remainingWork, ['Finish the endpoint test']); assert.deepEqual(approved.handoff.writes, ['src/auth/planned-next.ts']);
  assert.equal(approved.sessionId, undefined); assert.equal(approved.taskId, undefined);
  assert(!app.document.body.textContent.includes('NEVER_SHOW')); assert(!app.document.body.textContent.includes('PRIVATE_BROWSER_BEARER')); assert(!app.document.body.textContent.includes(review.reviewDigest));
  assert(app.calls.every(call => call.options.headers.Authorization === 'Bearer PRIVATE_BROWSER_BEARER'));
});

test('HTTP approval failure and refresh keep edited fields/focus and require fresh review', async () => {
  const { request, review, status } = fixture(); let approvalCalls = 0;
  const app = browser({ fetcher: async url => {
    if (url.pathname === '/v1/connections/requests') return [{ ...request, revision: 2 }];
    if (url.pathname === '/v1/connections/review') return review;
    if (url.pathname === '/v1/status') return status;
    if (url.pathname === '/v1/connections/approve') { approvalCalls++; return new Response(JSON.stringify({ error: { code: 'STALE_REVIEW', message: 'Workspace changed.', details: { capabilityHash: 'NEVER_SHOW_ERROR' } } }), { status: 409 }); }
    return [];
  } }); authenticated(app, status); app.state.data.connectionRequests = [request]; app.openEnrollment(request); await settle();
  const form = app.document.querySelector('form'); const summary = field(form, 'handoffSummary'); summary.value = 'Keep this draft'; summary.focus(); summary.setSelectionRange(4, 7); await app.refresh(true);
  assert(app.document.querySelector('form') === form, 'Existing form element survives refresh'); assert.equal(summary.value, 'Keep this draft'); assert(app.document.activeElement === summary, 'Focused input survives refresh'); assert.equal(summary.selectionStart, 4); await clickText(form, 'Inspect workspace / fresh review');
  for (const name of ['confirmIdentity', 'confirmWorkspace', 'confirmSharing']) field(form, name).checked = true; await form.fire('submit');
  assert.equal(approvalCalls, 1); assert.equal(summary.value, 'Keep this draft'); assert.equal(form.querySelector('button[type="submit"]').disabled, true);
  assert.match(form.textContent, /Perform a fresh review/); assert(!form.textContent.includes('NEVER_SHOW_ERROR'));
  for (const name of ['confirmIdentity', 'confirmWorkspace', 'confirmSharing']) field(form, name).checked = true;
  await form.fire('submit'); assert.equal(approvalCalls, 1, 'Cannot send a blind approval retry');
});

test('managed enrollment preserves existing task and lifetime instead of requesting an external grant', async () => {
  const { request, review, status } = fixture('managed'); let approved;
  const app = browser({ fetcher: async (url, body) => {
    if (url.pathname === '/v1/connections/requests') return [request];
    if (url.pathname === '/v1/connections/review') return review;
    if (url.pathname === '/v1/status') return status;
    if (url.pathname === '/v1/connections/approve') { approved = body; return { group: { id: 'g1' }, member: { sessionId: 'session-1', taskId: 'task-1' }, grant: null }; }
    return [];
  } });
  authenticated(app, status); app.openEnrollment(request);
  const form = app.document.querySelector('form');
  assert.equal(field(form, 'expiryHours'), undefined); assert.equal(field(form, 'featureKey'), undefined); assert.equal(field(form, 'title'), undefined);
  await clickText(form, 'Inspect workspace / fresh review'); assert.match(form.textContent, /Existing managed work/);
  for (const name of ['confirmIdentity', 'confirmWorkspace', 'confirmSharing']) field(form, name).checked = true;
  await form.fire('submit');
  assert(approved); for (const key of ['expiresInSeconds', 'title', 'featureKey', 'sessionId', 'taskId']) assert.equal(approved[key], undefined);
});

function exportFixture() {
  return { version: 1, kind: 'reviewed_replacement_handoff',
    group: { id: 'group', projectId: 'project-1', capability: 'NEVER_SHOW' },
    member: { id: 'member', groupId: 'group', projectId: 'project-1', sessionId: 'session', taskId: 'task', kind: 'external', revision: 3, taskRevision: 7, sessionRevision: 2, workspaceRoot: '/verified/workspace', workspaceFingerprint: '1:42:1000', projectFingerprint: '1:21:900', pollSecret: 'NEVER_SHOW', native: { tool: 'codex', nativeId: 'chat', incarnationId: 'run', token: 'NEVER_SHOW' } },
    responsibility: 'Original reviewed responsibility', handoff: { summary: 'Original reviewed summary', changedFiles: ['src/auth/already-changed.ts'], remainingWork: ['Finish the regression test'], acceptanceCriteria: ['Original criterion'], decisions: [] }, briefing: 'Project context', warning: 'Replacement only', bearer: 'NEVER_SHOW', nativeHistory: 'NEVER_SHOW' };
}

test('reviewed export edits only top-level content and preserves minimal source pins', () => {
  const app = browser();
  const handoff = app.readHandoff(handoffForm());
  const data = exportFixture(), before = JSON.stringify(data);
  const result = app.reviewedExport(data, handoff, 'Reviewed responsibility', 'Reviewed project context');
  assert(!JSON.stringify(result).includes('NEVER_SHOW')); assert.match(result.warning, /NEW managed task/); assert.match(result.warning, /does not attach to, stop, transfer, or copy files/);
  assert.equal(result.handoff.summary, 'Coordinate a reviewed change'); assert.equal(result.responsibility, 'Reviewed responsibility');
  assert.equal(result.summary, undefined); assert.equal(result.member.handoff, undefined); assert.equal(result.member.summary, undefined); assert.equal(result.member.responsibility, undefined);
  assert.deepEqual(Object.keys(result.group).sort(), ['id', 'projectId']);
  for (const key of ['id', 'groupId', 'projectId', 'sessionId', 'taskId', 'kind', 'revision', 'taskRevision', 'sessionRevision', 'workspaceRoot', 'workspaceFingerprint', 'projectFingerprint']) assert.equal(result.member[key], data.member[key]);
  assert.deepEqual(Object.keys(result.member).sort(), ['id', 'groupId', 'projectId', 'sessionId', 'taskId', 'kind', 'native', 'revision', 'taskRevision', 'sessionRevision', 'workspaceRoot', 'workspaceFingerprint', 'projectFingerprint'].sort());
  assert.equal(JSON.stringify(data), before, 'The immutable source snapshot is not edited');
  assert.throws(() => app.reviewedExport({ ...data, member: { ...data.member, workspaceFingerprint: undefined } }, handoff, 'Review', ''), /filesystem identity pins/);
  assert.throws(() => app.reviewedExport({ ...data, summary: 'Legacy duplicated field' }, handoff, 'Review', ''), /current reviewed replacement format/);
  assert.throws(() => app.reviewedExport({ ...data, member: { ...data.member, handoff: {} } }, handoff, 'Review', ''), /current reviewed replacement format/);
  assert.throws(() => app.reviewedExport({ ...data, member: { ...data.member, taskRevision: undefined } }, handoff, 'Review', ''), /revision pins/);
  assert.throws(() => app.reviewedExport({ ...data, member: { ...data.member, projectId: 'different-project' } }, handoff, 'Review', ''), /matching source binding/);
});

test('invitation code stays local until success and reuses its hash and idempotency key on retry', async () => {
  const { status } = fixture(); let attempts = 0;
  const app = browser({ fetcher: async url => {
    if (url.pathname === '/v1/groups/invite') { attempts++; if (attempts === 1) throw new Error('Temporary network failure'); return { id: 'invite-1', groupId: 'group-1', expiresAt: Date.now() + 900000, createdAt: Date.now(), consumedAt: null, revokedAt: null }; }
    if (url.pathname === '/v1/status') return status;
    return [];
  } });
  authenticated(app, status); app.openInvite({ id: 'group-1', title: 'Shared focus' });
  const form = app.document.querySelector('form');
  await form.fire('submit');
  const first = app.calls.find(call => call.url === '/v1/groups/invite');
  assert(first); assert.deepEqual(Object.keys(first.body).sort(), ['groupId', 'inviteHash']); assert.match(first.body.inviteHash, /^[a-f0-9]{64}$/);
  assert(!app.document.body.textContent.includes(first.body.inviteHash)); assert.equal(app.document.querySelector('.command'), null, 'No public code shown before a successful invitation receipt');
  await form.fire('submit');
  const inviteCalls = app.calls.filter(call => call.url === '/v1/groups/invite');
  assert.equal(inviteCalls.length, 2); assert.equal(inviteCalls[0].body.inviteHash, inviteCalls[1].body.inviteHash); assert.equal(inviteCalls[0].options.headers['Idempotency-Key'], inviteCalls[1].options.headers['Idempotency-Key']);
  const code = app.document.querySelector('.command').textContent; assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const expectedHash = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(code))), byte => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(expectedHash, first.body.inviteHash); assert(!JSON.stringify(first.body).includes(code));
});

function reconnectFixture() {
  const base = fixture();
  const grant = { id: 'old-grant', projectId: 'project-1', sessionId: 'session-1', taskId: 'task-1', memberId: 'old-member', groupId: 'old-group', workspaceRoot: '/verified/workspace', expiresAt: Date.now() - 1000, revokedAt: null };
  base.status.sessions[0].credentialMode = 'external';
  const member = { id: 'old-member', sessionId: 'session-1', taskId: 'task-1', state: 'left', kind: 'external', native: base.request.native };
  return { ...base, grants: [grant], groups: [{ group: { id: 'old-group' }, members: [member] }], review: { ...base.review, reconnectGrantIds: ['old-grant'] } };
}

test('reconnect choices require daemon-reviewed eligibility and still-matching public binding', () => {
  const app = browser(), data = reconnectFixture();
  assert.equal(app.eligibleReconnections(data.request, data.review, data.status, data.grants, data.groups).length, 1);
  assert.equal(app.eligibleReconnections(data.request, { ...data.review, reconnectGrantIds: [] }, data.status, data.grants, data.groups).length, 0);
  assert.equal(app.eligibleReconnections(data.request, data.review, data.status, [{ ...data.grants[0], expiresAt: Date.now() + 60000 }], data.groups).length, 0);
  data.status.tasks[0].ownerSessionId = 'different-owner';
  assert.equal(app.eligibleReconnections(data.request, data.review, data.status, data.grants, data.groups).length, 0);
});

test('fresh reconnect is an explicit acknowledgement and never sends a new owner, title, or feature claim', async () => {
  const { request, review, status, grants, groups } = reconnectFixture(); let approval;
  const app = browser({ fetcher: async (url, body) => {
    if (url.pathname === '/v1/connections/requests') return [request];
    if (url.pathname === '/v1/connections/review') return review;
    if (url.pathname === '/v1/status') return status;
    if (url.pathname === '/v1/connections/grants') return grants;
    if (url.pathname === '/v1/groups') return groups;
    if (url.pathname === '/v1/connections/approve') { approval = body; return { group: { id: 'new-group' }, member: { sessionId: 'session-1', taskId: 'task-1' }, grant: { expiresAt: Date.now() + 28800000 } }; }
    return [];
  } });
  authenticated(app, status); app.openEnrollment(request); const form = app.document.querySelector('form');
  field(form, 'title').value = 'This new-title draft is preserved but not sent'; field(form, 'featureKey').value = 'do-not-transfer';
  await clickText(form, 'Inspect workspace / fresh review'); assert.equal(field(form, 'reconnectGrantId').value, '');
  field(form, 'reconnectGrantId').value = 'old-grant'; await field(form, 'reconnectGrantId').fire('change');
  for (const name of ['confirmIdentity', 'confirmWorkspace', 'confirmSharing']) field(form, name).checked = true;
  await form.fire('submit'); assert.equal(approval, undefined, 'Cannot reconnect without explicit separate acknowledgement');
  field(form, 'confirmReconnect').checked = true; await form.fire('submit');
  assert.equal(approval.reconnectGrantId, 'old-grant'); assert.equal(approval.revision, review.revision); assert.equal(approval.reviewDigest, review.reviewDigest);
  for (const key of ['title', 'featureKey', 'taskId', 'sessionId', 'handoffSessionId']) assert.equal(approval[key], undefined);
});

test('SSE-triggered refresh invalidates an outdated review without replacing its draft or focus', async () => {
  const { request, review, status } = fixture(); let revision = 1;
  const app = browser({ fetcher: async url => {
    if (url.pathname === '/v1/connections/requests') return [{ ...request, revision }];
    if (url.pathname === '/v1/connections/review') { revision = 2; return review; }
    if (url.pathname === '/v1/status') return status;
    return [];
  } });
  authenticated(app, status); app.openEnrollment(request); const form = app.document.querySelector('form');
  await clickText(form, 'Inspect workspace / fresh review');
  const summary = field(form, 'handoffSummary'); summary.value = 'Retain this review draft'; summary.focus(); summary.setSelectionRange(2, 8);
  revision = 3; await app.refresh(true);
  assert(app.document.querySelector('form') === form); assert(app.document.activeElement === summary); assert.equal(summary.value, 'Retain this review draft'); assert.equal(summary.selectionEnd, 8);
  assert(form.querySelector('button[type="submit"]').disabled); assert.match(form.textContent, /changed or expired since inspection/);
});

test('group detail renders reload-safe invitation revocation and separate task/session ownership', async () => {
  const { status } = fixture();
  const app = browser({ fetcher: async () => ({ group: { id: 'group-1', projectId: 'project-1', title: 'Project focus', goal: 'Coordinate separately owned work', revision: 4, state: 'active' },
    members: [{ id: 'member-1', groupId: 'group-1', projectId: 'project-1', sessionId: 'session-1', taskId: 'task-1', responsibility: 'Own the endpoint', kind: 'manual', revision: 2, state: 'active', summary: 'Reviewed summary', native: null, handoff: null }],
    invitations: [{ id: 'invite-1', groupId: 'group-1', expiresAt: Date.now() + 900000, createdAt: Date.now(), consumedAt: null, revokedAt: null, inviteHash: 'NEVER_SHOW_INVITE_HASH' }], invitationsTruncated: true }) });
  authenticated(app, status); await app.openGroup('group-1');
  const drawer = app.document.querySelector('#drawer');
  assert.match(drawer.textContent, /Member session/); assert.match(drawer.textContent, /Current task owner/); assert.match(drawer.textContent, /Revoke invitation/);
  assert.match(drawer.textContent, /Only the first 100 invitation records/); assert.match(drawer.textContent, /Manual bookkeeping only/); assert(!drawer.textContent.includes('NEVER_SHOW_INVITE_HASH'));
});


test('replacement export enforces whole UTF-8 size and briefing limits without truncating', () => {
  const app = browser();
  const accepted = { briefing: 'a'.repeat(8192), summary: 'Reviewed summary' };
  const text = app.serializeReviewedExport(accepted);
  assert.equal(JSON.parse(text).briefing.length, 8192);
  const longBriefing = { briefing: 'a'.repeat(8193) };
  assert.throws(() => app.serializeReviewedExport(longBriefing), /8192 characters/);
  assert.equal(longBriefing.briefing.length, 8193);
  const multiByte = { briefing: '界'.repeat(6000), summary: 'Short summary' };
  assert(multiByte.briefing.length < 8192);
  assert.throws(() => app.serializeReviewedExport(multiByte), /UTF-8 bytes/);
  assert.equal(multiByte.briefing.length, 6000);
  assert.throws(() => app.serializeReviewedExport({ briefing: '', summary: 'a'.repeat(16384) }), /16 KiB/);
  const empty = { briefing: '', handoff: { summary: '' } };
  const overhead = Buffer.byteLength(app.serializeReviewedExport(empty));
  empty.handoff.summary = 'a'.repeat(16384 - overhead);
  assert.equal(Buffer.byteLength(app.serializeReviewedExport(empty)), 16384);
  empty.handoff.summary += 'a';
  assert.throws(() => app.serializeReviewedExport(empty), /maximum is 16384/);
});


test('export form keeps oversized human edits and produces only the new bounded shape', async () => {
  const exportedSource = exportFixture(), { status } = fixture();
  const app = browser({ fetcher: async () => exportedSource }); authenticated(app, status);
  await app.openExportHandoff({ id: 'member' }); await settle();
  const form = app.document.querySelector('form'), briefing = field(form, 'briefing');
  field(form, 'responsibility').value = 'Human-edited responsibility'; field(form, 'handoffSummary').value = 'Human-edited summary'; field(form, 'handoffChangedFiles').value = 'src/auth/reviewed-past.ts'; field(form, 'handoffRemainingWork').value = 'Complete the invalidation test\nReview the migration'; field(form, 'confirm').checked = true;
  briefing.value = 'a'.repeat(8193); await form.fire('submit');
  assert(app.document.querySelector('form') === form); assert.equal(briefing.value.length, 8193); assert.match(form.textContent, /8192 characters/);
  briefing.value = ' '.repeat(8193); await form.fire('submit');
  assert.equal(briefing.value.length, 8193); assert.match(form.textContent, /8192 characters/);
  briefing.value = '界'.repeat(6000); await form.fire('submit');
  assert(app.document.querySelector('form') === form); assert.equal(briefing.value.length, 6000); assert.match(form.textContent, /UTF-8 bytes/);
  briefing.value = '  Human-reviewed project context\n'; await form.fire('submit');
  const exported = JSON.parse(app.document.querySelector('.json-box').textContent);
  assert.equal(exported.responsibility, 'Human-edited responsibility'); assert.equal(exported.handoff.summary, 'Human-edited summary');
  assert.deepEqual(exported.handoff.changedFiles, ['src/auth/reviewed-past.ts']); assert.deepEqual(exported.handoff.remainingWork, ['Complete the invalidation test', 'Review the migration']);
  assert.equal(exported.member.taskRevision, 7); assert.equal(exported.member.sessionRevision, 2); assert.equal(exported.member.workspaceRoot, '/verified/workspace');
  assert.equal(exported.briefing, '  Human-reviewed project context\n'); assert.equal(exported.member.workspaceFingerprint, exportedSource.member.workspaceFingerprint); assert.equal(exported.member.projectFingerprint, exportedSource.member.projectFingerprint);
  assert.equal(exported.member.handoff, undefined); assert.equal(exported.summary, undefined); assert(!JSON.stringify(exported).includes('NEVER_SHOW'));
});


test('reported past changes and remaining checklist are distinct, bounded, and preserved in handoff', () => {
  const app = browser();
  const parsed = app.readHandoff(handoffForm({}, { handoffChangedFiles: 'src/old-change.ts\nsrc/prior-test.ts', handoffRemainingWork: 'Finish validation\nReview the edge case', handoffWrites: 'src/future-change.ts' }));
  assert.deepEqual(Array.from(parsed.changedFiles), ['src/old-change.ts', 'src/prior-test.ts']);
  assert.deepEqual(Array.from(parsed.remainingWork), ['Finish validation', 'Review the edge case']);
  assert.deepEqual(Array.from(parsed.writes), ['src/future-change.ts']);
  const exported = app.handoffFields(parsed);
  assert.deepEqual(Array.from(exported.changedFiles), Array.from(parsed.changedFiles)); assert.deepEqual(Array.from(exported.remainingWork), Array.from(parsed.remainingWork));
  assert.throws(() => app.readHandoff(handoffForm({}, { handoffChangedFiles: '../outside.ts' })), /relative literal paths/);
  assert.throws(() => app.readHandoff(handoffForm({}, { handoffChangedFiles: '/absolute/file.ts' })), /relative literal paths/);
  assert.throws(() => app.readHandoff(handoffForm({}, { handoffChangedFiles: Array.from({ length: 65 }, (_, n) => `src/file-${n}.ts`).join('\n') })), /at most 64/);
  assert.throws(() => app.readHandoff(handoffForm({}, { handoffRemainingWork: Array.from({ length: 17 }, (_, n) => `Remaining ${n}`).join('\n') })), /at most 16/);
  assert.throws(() => app.readHandoff(handoffForm({}, { handoffRemainingWork: 'a'.repeat(513) })), /512 characters/);
});
