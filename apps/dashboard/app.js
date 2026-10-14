(() => {
  'use strict';

  // Consume the one-use code before making requests. Never put credentials in storage.
  let bootstrapCode, pendingRequestId;
  {
    const initialHash = new URLSearchParams(location.hash.slice(1));
    bootstrapCode = initialHash.get('bootstrap');
    // A public request reference only selects a record after normal human sign-in.
    pendingRequestId = publicRequestReference(initialHash.get('request'));
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = {
    token: null, projectId: '', projects: [], page: 'tasks', data: {},
    search: '', filter: '', loaded: false, refreshing: false, queued: false,
    generation: 0, drawer: null, lastUpdated: null, expiryTimer: null,
    stream: null, streamTimer: null, pollTimer: null, refreshTimer: null,
    streamGeneration: 0, cursors: new Map(), reconnectAttempt: 0,
    connectionPollTimer: null, enrollmentEditor: null,
  };
  const pages = {
    tasks: ['Tasks', 'Keep ownership clear. See what is ready to move.'],
    alerts: ['Alerts', 'Resolve coordination conflicts before they become rework.'],
    decisions: ['Decisions', 'A shared record of what the team has agreed to.'],
    workspaces: ['Workspaces', 'Give each task a clear place to work.'],
    integration: ['Integration', 'Inspect and validate candidates before advancing the target.'],
    connections: ['Connections', 'Shared project focus. Separate chats, responsibilities, and task owners.'],
    adapters: ['Adapters', 'Configuration, connection, and verification are separate signals.'],
  };
  const endpoints = { decisions: '/v1/decisions', workspaces: '/v1/workspaces', integration: '/v1/integration/jobs', adapters: '/v1/adapters' };
  const authInstruction = 'Run npm run murmur -- dashboard and reopen the printed one-use URL.';
  let uid = 0;
  let toastTimer;

  function el(tag, attrs = {}, ...children) {
    const item = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') item.className = value;
      else if (key === 'text') item.textContent = value;
      else if (key.startsWith('on')) item.addEventListener(key.slice(2), value);
      else if (['value', 'checked', 'disabled', 'required', 'hidden', 'selected'].includes(key)) item[key] = value;
      else item.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) item.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return item;
  }
  function button(label, callback, kind = '', attrs = {}) {
    const item = el('button', { type: 'button', class: `button ${kind}`, ...attrs }, label);
    item.addEventListener('click', () => {
      try {
        const result = callback(item);
        if (result && typeof result.then === 'function') {
          item.disabled = true; item.setAttribute('aria-busy', 'true');
          result.catch(showActionError).finally(() => { item.disabled = false; item.removeAttribute('aria-busy'); });
        }
      } catch (error) { showActionError(error); }
    });
    return item;
  }
  function link(label, callback, className = '', attrs = {}) { return button(label, callback, `link-button ${className}`, attrs); }
  function short(value, length = 8) { return value ? String(value).slice(0, length) : '—'; }
  function pretty(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2); }
  function jsonBox(value) { return el('pre', { class: 'json-box', tabindex: '0' }, pretty(value)); }
  function inspectDetails(label, value) { return el('details', {}, el('summary', {}, label), jsonBox(value)); }
  function titleCase(value) { return String(value || 'unknown').replaceAll('_', ' ').replace(/^./, character => character.toUpperCase()); }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function project() { return state.projects.find(item => item.id === state.projectId); }
  function sessions() { return asArray(state.data.status?.sessions).filter(item => item.projectId === state.projectId); }
  function tasks() { return asArray(state.data.status?.tasks).filter(item => item.projectId === state.projectId); }
  function sessionName(id) {
    const session = sessions().find(item => item.id === id);
    if (!session) return id ? `Session ${short(id)}` : 'Unassigned';
    const launch = asArray(state.data.status?.launches).find(item => item.sessionId === id);
    return `${titleCase(session.tool)} / ${short(session.id)}${launch ? ` (${titleCase(launch.state)})` : ''}`;
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const h = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function badge(value, label) {
    const status = String(value || 'unknown').toLowerCase();
    let tone = 'neutral', symbol = '○';
    if (['active', 'connected', 'running', 'preparing', 'validating'].includes(status)) { tone = 'info'; symbol = '◉'; }
    if (['ready', 'accepted', 'passed', 'verified', 'integrated', 'approved', 'clean', 'ok', 'complete', 'completed', 'available'].includes(status)) { tone = 'good'; symbol = '✓'; }
    if (['blocked', 'warning', 'proposed', 'pending', 'unverified', 'no_checks', 'dirty', 'stale'].includes(status)) { tone = 'warning'; symbol = '△'; }
    if (['critical', 'error', 'failed', 'conflicted', 'recovery_required', 'missing'].includes(status)) { tone = 'critical'; symbol = '!'; }
    return el('span', { class: 'status' }, el('span', { class: `status-mark ${tone}`, 'aria-hidden': 'true' }, symbol), label || titleCase(value));
  }
  function notice(message, kind = '', title) {
    return el('div', { class: `notice ${kind ? `notice-${kind}` : ''}` }, title ? el('p', { class: 'notice-title' }, title) : null, el('p', {}, message));
  }
  function metadata(entries, className = '') {
    return el('dl', { class: `metadata ${className}` }, entries.flatMap(([name, value]) => [el('dt', {}, name), el('dd', {}, value ?? '—')]));
  }
  function empty(title, message, actions = [], symbol = '☷') {
    return el('section', { class: 'empty-state' }, el('span', { class: 'empty-symbol', 'aria-hidden': 'true' }, symbol), el('h2', {}, title), el('p', {}, message), actions.length ? el('div', { class: 'action-row' }, actions) : null);
  }
  function loading(label = 'Loading workspace…') { return el('div', { class: 'loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), label); }
  function table(headers, rows, caption) {
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap', tabindex: '0', 'aria-label': caption },
      el('table', { class: 'data-table' }, el('caption', { class: 'sr-only' }, caption),
        el('thead', {}, el('tr', {}, headers.map(text => el('th', { scope: 'col' }, text)))),
        el('tbody', {}, rows))));
  }
  function td(content, className = '') { return el('td', { class: className }, content); }
  function errorText(error) {
    const details = error.details ? `\n${pretty(error.details)}` : '';
    return `${error.code ? `${error.code}: ` : ''}${error.message || 'The request could not be completed.'}${details}`;
  }
  function showPageError(error) {
    const box = $('#page-error');
    box.replaceChildren(el('p', { class: 'notice-title' }, 'Could not refresh workspace'), el('p', {}, errorText(error)), button('Retry', () => refresh(), 'button-small'));
    box.hidden = false;
  }
  function showActionError(error) {
    showInfo('Action could not be completed', errorText(error), [notice('No success was assumed. Check the message and try the action again.', 'warning')]);
  }
  function toast(message) {
    $('#toast').textContent = message; $('#toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500);
  }
  function setConnection(label, tone = 'neutral') {
    const symbols = { neutral: '○', good: '✓', warning: '△', critical: '!' };
    $('#connection-status').replaceChildren(el('span', { class: `status-mark ${tone}`, 'aria-hidden': 'true' }, symbols[tone] || '○'), el('span', {}, label));
  }

  async function api(path, options = {}) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) throw new Error('Only same-origin requests are allowed.');
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (!options.bootstrap) {
      if (!state.token) throw new Error(authInstruction);
      headers.Authorization = `Bearer ${state.token}`;
    }
    if (options.method === 'POST') headers['Idempotency-Key'] = options.idempotencyKey || uuid();
    let response;
    try {
      response = await fetch(url, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal, credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('The local daemon is unreachable. Check that it is running, then retry. Your form has not been cleared.');
    }
    if (response.status === 401 && !options.bootstrap) {
      signOut('Your browser session has expired.');
      throw Object.assign(new Error(authInstruction), { code: 'SESSION_EXPIRED' });
    }
    if (options.stream && response.ok) return response;
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { throw new Error(`The daemon returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const details = data?.error;
      throw Object.assign(new Error(details?.message || `Request failed (${response.status}).`), { code: details?.code, details: details?.details, status: response.status });
    }
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body });
  function scoped(path, extras = {}, projectId = state.projectId) {
    const params = new URLSearchParams({ ...extras });
    if (projectId) params.set('projectId', projectId);
    return `${path}?${params}`;
  }
  function signOut(reason = '') {
    state.token = null; state.generation++; clearTimeout(state.expiryTimer); stopStream();
    clearInterval(state.connectionPollTimer); state.connectionPollTimer = null;
    state.enrollmentEditor?.invalidate('Sign in again, then perform a fresh review before approving.');
    $('#project-select').disabled = true; $('#register-project').disabled = true; $('#refresh').disabled = true;
    $('#page-actions').replaceChildren(); $('#page-error').hidden = true;
    setConnection('Not connected');
    const view = empty('Open a secure dashboard session', reason || 'Connect this browser to the Murmur daemon running on your machine.', [], '↗');
    view.append(el('code', { class: 'command' }, 'npm run murmur -- dashboard'), el('p', {}, 'Open the one-use URL printed by the command. Refreshing this page requires a new URL.'), el('p', { class: 'small space-top' }, 'Credentials stay in this tab’s memory. No account or external service is needed.'));
    if (pendingRequestId) view.append(el('p', { class: 'space-top' }, `Request reference: ${pendingRequestId}. This public reference does not sign you in. After normal sign-in, find it in Connections.`));
    $('#page-content').replaceChildren(view);
  }
  function renderProjectSelect() {
    const select = $('#project-select');
    select.replaceChildren();
    if (!state.projects.length) select.append(el('option', { value: '' }, 'No registered projects'));
    for (const item of state.projects) {
      const segments = String(item.root).split(/[\\/]/).filter(Boolean);
      const basename = segments.at(-1) || item.root;
      const duplicate = state.projects.filter(other => String(other.root).split(/[\\/]/).filter(Boolean).at(-1) === basename).length > 1;
      const label = duplicate ? segments.slice(-2).join('/') : basename;
      select.append(el('option', { value: item.id, selected: item.id === state.projectId, title: item.root }, label));
    }
    select.disabled = !state.token || !state.projects.length;
    select.title = project()?.root || '';
  }
  async function loadProjects() {
    const data = await api('/v1/status');
    state.projects = asArray(data.projects);
    renderProjectSelect();
    return data;
  }
  function clearData() { state.data = {}; state.loaded = false; state.search = ''; state.filter = ''; }
  async function selectProject(id) {
    stopStream(); state.generation++; state.projectId = id; clearData(); renderProjectSelect();
    renderPage();
    await refresh();
    if (state.token && state.projectId === id) startStream();
    syncConnectionPolling();
  }
  function refreshSoon(delay = 300) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => { if (state.token) void refresh(true); }, delay);
  }
  async function refresh(quiet = false) {
    if (!state.token) return;
    if (state.refreshing) { state.queued = true; return; }
    if (!state.projectId && state.page !== 'connections') { state.loaded = true; renderPage(); return; }
    state.refreshing = true; $('#refresh').disabled = true;
    const generation = state.generation, page = state.page, projectId = state.projectId;
    if (!state.loaded && !quiet) $('#page-content').replaceChildren(loading());
    const requests = projectId ? [['status', scoped('/v1/status', {}, projectId)], ['alerts', scoped('/v1/alerts', {}, projectId)]] : [];
    if (page === 'connections') {
      requests.push(['connectionRequests', '/v1/connections/requests']);
      if (projectId) requests.push(['groups', scoped('/v1/groups', {}, projectId)], ['grants', scoped('/v1/connections/grants', {}, projectId)]);
    }
    if (endpoints[page]) requests.push([page, scoped(endpoints[page], {}, projectId)]);
    try {
      const results = await Promise.allSettled(requests.map(([, path]) => page === 'connections' ? connectionAPI(path) : api(path)));
      if (generation !== state.generation || !state.token) return;
      const errors = [];
      results.forEach((result, index) => {
        const name = requests[index][0];
        if (result.status === 'fulfilled') state.data[name] = result.value;
        else errors.push(result.reason);
      });
      state.loaded = true;
      if (errors.length) showPageError(errors[0]); else {
        $('#page-error').hidden = true; state.lastUpdated = new Date();
        $('#updated-at').textContent = `Updated ${state.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }
      updateCounts();
      if (page === 'connections' && state.data.connectionRequests) state.enrollmentEditor?.observe(state.data.connectionRequests);
      if (page === state.page) renderContent();
    } finally {
      state.refreshing = false; $('#refresh').disabled = !state.token;
      if (state.queued) { state.queued = false; refreshSoon(100); }
    }
  }
  function updateCounts() {
    const counts = { tasks: tasks().length, alerts: state.data.alerts?.length, decisions: state.data.decisions?.length, workspaces: state.data.workspaces?.length, integration: state.data.integration?.length, adapters: state.data.adapters?.length };
    counts.connections = state.data.connectionRequests?.filter(item => requestState(item) === 'pending').length;
    for (const [name, count] of Object.entries(counts)) $(`[data-count="${name}"]`).textContent = count === undefined ? '' : String(count);
  }

  function stopStream() {
    state.streamGeneration++; state.stream?.abort(); state.stream = null;
    clearTimeout(state.streamTimer); clearInterval(state.pollTimer); clearTimeout(state.refreshTimer);
    state.pollTimer = null;
  }
  function startPolling() {
    if (!state.pollTimer) state.pollTimer = setInterval(() => { if (!document.hidden && state.token) void refresh(true); }, 5000);
  }
  function startStream() {
    stopStream(); state.reconnectAttempt = 0;
    const generation = state.streamGeneration;
    const projectId = state.projectId;
    if (!projectId || !state.token) return;
    async function connect() {
      if (generation !== state.streamGeneration || !state.token) return;
      const controller = new AbortController(); state.stream = controller;
      setConnection(state.reconnectAttempt ? 'Polling · reconnecting' : 'Connecting…', state.reconnectAttempt ? 'warning' : 'neutral');
      try {
        const response = await api(scoped('/v1/stream', { after: String(state.cursors.get(projectId) || 0) }, projectId), { stream: true, signal: controller.signal, headers: { Accept: 'text/event-stream' } });
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Streaming is unavailable.');
        if (generation !== state.streamGeneration) { controller.abort(); return; }
        clearInterval(state.pollTimer); state.pollTimer = null;
        setConnection('Live updates', 'good');
        const connectedAt = Date.now();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', eventId = '', eventName = '', data = [];
        const dispatch = () => {
          if (eventId && /^\d+$/.test(eventId)) state.cursors.set(projectId, Number(eventId));
          if (data.length && (eventName === 'update' || !eventName)) {
            try { const payload = JSON.parse(data.join('\n')); if (Number.isSafeInteger(payload.sequence)) state.cursors.set(projectId, payload.sequence); } catch { /* Event content is not rendered or trusted. */ }
            refreshSoon();
          }
          eventId = ''; eventName = ''; data = [];
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) { if (Date.now() - connectedAt > 10000) state.reconnectAttempt = 0; throw new Error('Stream closed.'); }
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 1024 * 1024) throw new Error('Stream frame exceeded the limit.');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
            if (!line) dispatch();
            else if (line.startsWith('id:')) eventId = line.slice(3).trim();
            else if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
        }
      } catch (error) {
        controller.abort();
        if (controller.signal.aborted && (generation !== state.streamGeneration || !state.token)) return;
        setConnection('Polling · stream offline', 'warning'); startPolling();
        const delay = Math.min(30000, 1000 * 2 ** Math.min(state.reconnectAttempt++, 5));
        state.streamTimer = setTimeout(connect, delay);
      }
    }
    void connect();
  }

  function navigate(page) {
    if (!pages[page]) return;
    state.page = page; state.search = ''; state.filter = '';
    document.body.classList.remove('nav-open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); $('#menu-toggle').setAttribute('aria-label', 'Open navigation');
    renderPage(); syncConnectionPolling(); if (state.token && (state.projectId || page === 'connections')) void refresh();
  }
  function renderPage() {
    const [title, description] = pages[state.page];
    document.title = `Murmur · ${title}`; $('#page-title').textContent = title; $('#page-description').textContent = description;
    document.querySelectorAll('[data-page]').forEach(item => {
      const active = item.dataset.page === state.page; item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    const actions = $('#page-actions'); actions.replaceChildren();
    if (!state.token) return;
    if (state.projectId) {
      if (state.page === 'connections') actions.append(button('Create group', openCreateGroup, 'button-primary'));
      if (state.page === 'tasks') actions.append(button('＋ New task', openNewTask, 'button-primary'));
      if (state.page === 'decisions') actions.append(button('Propose decision', openProposeDecision, 'button-primary'));
      if (state.page === 'workspaces') actions.append(button('Reconcile', reconcileWorkspaces), button('Adopt existing', openAdoptWorkspace), button('Create workspace', openCreateWorkspace, 'button-primary'));
      if (state.page === 'integration') actions.append(button('Validation settings', openValidationSettings), button('Prepare candidate', () => openPrepare(), 'button-primary'));
    }
    updateCounts(); renderContent();
  }
  function renderContent() {
    if (!state.token) return;
    const content = $('#page-content');
    if (!state.projectId && state.page !== 'connections') {
      content.replaceChildren(empty('Register your first project', 'Choose a local repository to coordinate tasks, decisions, and integration across your agents.', [button('Register project', openRegisterProject, 'button-primary')], '▱'));
      return;
    }
    if (!state.loaded) { content.replaceChildren(loading()); return; }
    const dataKey = state.page === 'tasks' ? 'status' : state.page === 'connections' ? 'connectionRequests' : state.page;
    if (!state.data[dataKey]) {
      content.replaceChildren(empty('This view is not available yet', 'The daemon has not returned data for this view. Retry the request; no empty or successful result has been assumed.', [button('Retry', () => refresh())], '○'));
      return;
    }
    // Keep an active search control and its caret stable during background refreshes.
    const active = document.activeElement;
    const focusId = active?.id;
    const selection = active?.selectionStart;
    const focusKey = active?.getAttribute?.('data-focus-key');
    const details = Array.from(content.querySelectorAll('details'));
    const openDetails = details.map((item, index) => item.open ? index : -1).filter(index => index >= 0);
    const focusedSummary = active?.tagName === 'SUMMARY' ? details.findIndex(item => item.firstElementChild === active) : -1;
    const renderers = { tasks: renderTasks, alerts: renderAlerts, decisions: renderDecisions, workspaces: renderWorkspaces, integration: renderIntegration, adapters: renderAdapters, connections: renderConnections };
    content.replaceChildren(renderers[state.page]());
    const newDetails = Array.from(content.querySelectorAll('details'));
    openDetails.forEach(index => { if (newDetails[index]) newDetails[index].open = true; });
    if (focusKey) Array.from(content.querySelectorAll('[data-focus-key]')).find(item => item.getAttribute('data-focus-key') === focusKey)?.focus({ preventScroll: true });
    if (focusedSummary >= 0) newDetails[focusedSummary]?.firstElementChild?.focus({ preventScroll: true });
    if (focusId && ['view-search', 'view-filter'].includes(focusId)) {
      const next = document.getElementById(focusId); next?.focus({ preventScroll: true });
      if (next?.setSelectionRange && typeof selection === 'number') next.setSelectionRange(selection, selection);
    }
  }
  function filterBar(placeholder, options, count) {
    const search = el('input', { id: 'view-search', type: 'search', value: state.search, placeholder, 'aria-label': placeholder, oninput: event => { state.search = event.target.value; renderContent(); } });
    const select = el('select', { id: 'view-filter', onchange: event => { state.filter = event.target.value; renderContent(); } }, el('option', { value: '' }, 'All states'), options.map(option => el('option', { value: option, selected: state.filter === option }, titleCase(option))));
    return el('div', { class: 'toolbar' }, el('div', { class: 'search-field' }, el('span', { class: 'search-mark', 'aria-hidden': 'true' }, '⌕'), search), options.length ? el('div', { class: 'filter-control' }, el('label', { for: 'view-filter' }, 'State'), select) : null, el('span', { class: 'result-count', role: 'status' }, `${count} ${count === 1 ? 'result' : 'results'}`));
  }
  function matches(item, fields) {
    const query = state.search.trim().toLowerCase();
    return (!state.filter || item.status === state.filter) && (!query || fields.map(value => pretty(value)).join(' ').toLowerCase().includes(query));
  }

  function renderTasks() {
    const all = tasks();
    if (!all.length) return empty('Make the next piece of work explicit', 'Create a task, choose its owner, and declare its intent. Other agents can then see what is in progress and avoid overlapping work.', [button('Create task', openNewTask, 'button-primary')]);
    const rows = all.filter(task => matches(task, [task.title, task.id, task.featureKey, sessionName(task.ownerSessionId)]));
    const result = el('div', {}, filterBar('Search tasks, owners, or features', ['active', 'blocked', 'ready', 'integrated', 'abandoned'], rows.length));
    if (!rows.length) { result.append(empty('No matching tasks', 'Try a different search or clear the state filter.', [button('Clear filters', () => { state.search = ''; state.filter = ''; renderContent(); })])); return result; }
    const view = table(['Task', 'Owner', 'Feature', 'Status', 'Revision'], rows.map(task => {
      const owner = sessions().find(session => session.id === task.ownerSessionId);
      return el('tr', {}, td([link(task.title, () => openTask(task.id), 'task-link', { 'data-focus-key': `task-${task.id}` }), el('div', { class: 'cell-subtitle mono' }, short(task.id))], 'primary-cell'),
        td(el('div', { class: 'owner' }, el('span', { class: 'owner-icon', 'aria-hidden': 'true' }, owner?.tool?.slice(0, 1).toUpperCase() || '–'), el('div', {}, titleCase(owner?.tool || 'Session'), el('div', { class: 'cell-subtitle mono' }, short(task.ownerSessionId))))),
        td(task.featureKey ? el('span', { class: 'tag' }, task.featureKey) : el('span', { class: 'muted' }, 'Not set')), td(badge(task.status)), td(el('span', { class: 'muted numeric' }, task.revision ?? '—')));
    }), 'Tasks in the selected project');
    view.append(el('div', { class: 'table-foot' }, `${sessions().length} registered ${sessions().length === 1 ? 'session' : 'sessions'} · ${asArray(state.data.status?.reservations).length} declared reservations. Select a task to inspect scope and next actions.`));
    result.append(view); return result;
  }
  function renderAlerts() {
    const all = asArray(state.data.alerts);
    if (!all.length) return empty('No coordination alerts', 'There are no current alerts for this project. New conflicts or stale declarations will appear here when reported by the daemon.', [], '✓');
    const rows = all.filter(item => matches({ ...item, status: item.severity }, [item.message, item.kind, item.taskIds]));
    const result = el('div', {}, filterBar('Search alerts', Array.from(new Set(all.map(item => item.severity).filter(Boolean))), rows.length));
    if (!rows.length) { result.append(empty('No matching alerts', 'Change the search or state filter to see other alerts.')); return result; }
    result.append(el('section', { class: 'panel', 'aria-label': 'Project alerts' }, rows.map(alert => el('article', { class: 'alert-item' },
      el('div', { class: 'item-top' }, el('div', { class: 'item-title' }, badge(alert.severity), el('h3', {}, titleCase(alert.kind))), alert.dismissible === false ? el('span', { class: 'small muted' }, 'Clears after reconciliation') : button('Dismiss', () => openDismissAlert(alert), 'button-small', { 'data-focus-key': `dismiss-${alert.id}` })),
      el('div', { class: 'item-body' }, el('p', {}, alert.message || 'Inspect the evidence below.'), alert.suggestedAction ? el('p', {}, el('strong', {}, 'Suggested action: '), pretty(alert.suggestedAction)) : null),
      el('div', { class: 'item-footer' }, asArray(alert.taskIds).map(id => link(`Task ${short(id)}`, () => openTask(id)))),
      alert.evidence ? inspectDetails('Inspect evidence', alert.evidence) : null))));
    return result;
  }
  function renderDecisions() {
    const all = asArray(state.data.decisions);
    if (!all.length) return empty('Give shared choices a durable record', 'Propose a decision with its rationale. Acceptance is an explicit action and can replace an existing decision for the same key.', [button('Propose decision', openProposeDecision, 'button-primary')], '◇');
    const rows = all.filter(item => matches(item, [item.key, item.value, item.rationale]));
    const result = el('div', {}, filterBar('Search decisions and rationale', Array.from(new Set(all.map(item => item.status))), rows.length));
    if (!rows.length) { result.append(empty('No matching decisions', 'Change the search or state filter to see other decisions.')); return result; }
    result.append(table(['Decision', 'Value', 'Version', 'Status', 'Action'], rows.map(item => el('tr', {},
      td([link(item.key, () => showDecision(item), 'task-link', { 'data-focus-key': `decision-${item.id}` }), el('div', { class: 'cell-subtitle' }, String(item.rationale || 'No rationale provided').slice(0, 110))], 'primary-cell'),
      td(el('code', {}, pretty(item.value).slice(0, 100)), 'path-cell'), td(item.version, 'numeric'), td(badge(item.status)),
      td(item.status === 'proposed' ? button('Review & accept', () => openAcceptDecision(item), 'button-small', { 'data-focus-key': `accept-${item.id}` }) : el('span', { class: 'muted small' }, item.supersededBy ? `Replaced by ${short(item.supersededBy)}` : 'Recorded')))), 'Project decisions and their acceptance status'));
    return result;
  }
  function renderWorkspaces() {
    const all = asArray(state.data.workspaces);
    if (!all.length) return empty('Keep concurrent work separate', 'Create an isolated workspace from a committed revision, or adopt an existing checkout. Attach it to a task when its agent is ready to restart there.', [button('Create workspace', openCreateWorkspace, 'button-primary'), button('Adopt existing', openAdoptWorkspace)], '▱');
    return el('div', {}, notice('Attaching a workspace changes bookkeeping only. A running agent must restart in that workspace.'),
      table(['Workspace', 'Branch', 'Kind', 'Working copy', 'Base'], all.map(item => el('tr', {},
        td([link(item.root, () => showInfo('Workspace details', 'Metadata recorded by the local daemon.', [metadata([['Workspace ID', item.id], ['Root', item.root], ['Branch', item.branch], ['Base SHA', item.baseSha], ['Kind', titleCase(item.kind)], ['Status', badge(item.status)]]), inspectDetails('Raw metadata', item)]), 'task-link'), el('div', { class: 'cell-subtitle mono' }, short(item.id))], 'primary-cell path-cell'),
        td(item.branch || 'Detached', 'path-cell'), td(titleCase(item.kind)), td(badge(item.observedState || 'not_observed')), td(el('code', { title: item.baseSha || '' }, short(item.baseSha, 10))))), 'Registered workspaces'));
  }
  function validationState(job) {
    const validation = job.validation;
    const statuses = [];
    let nonzeroExit = false;
    function inspect(value, depth = 0) {
      if (depth > 7 || value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (['status', 'state', 'result'].includes(key) && typeof entry === 'string') statuses.push(entry.toLowerCase());
        if (['exitCode', 'exit_code'].includes(key) && typeof entry === 'number' && entry !== 0) nonzeroExit = true;
        if (key === 'passed' && entry === false) statuses.push('failed');
        if (['timedOut', 'cancelled'].includes(key) && entry === true) statuses.push('failed');
        if (typeof entry === 'object') inspect(entry, depth + 1);
      }
    }
    inspect(validation);
    if (typeof validation === 'string') statuses.push(validation.toLowerCase());
    const failed = nonzeroExit || statuses.some(value => ['failed', 'failure', 'error', 'timed_out', 'timeout', 'cancelled'].includes(value));
    const passed = !failed && validation?.status === 'passed';
    const invalidated = validation?.status === 'invalidated';
    const unverified = validation?.status === 'unverified';
    return { failed, passed, label: failed ? 'Failed checks' : passed ? 'Passed checks' : invalidated ? 'Checks invalidated' : unverified ? 'Unverified' : 'Not validated', status: failed ? 'failed' : passed ? 'passed' : invalidated ? 'warning' : 'unverified' };
  }
  function approvalState(job) {
    const validation = validationState(job);
    const boundValidation = job.validation?.candidateSha === job.candidateSha && job.validation?.targetSha === job.targetSha;
    const blocked = ['conflicted', 'failed', 'recovery_required', 'validating', 'preparing', 'promoted', 'approved', 'integrated', 'completed', 'abandoned', 'cancelled'].includes(job.status);
    return { ...validation, allowed: Boolean(job.candidateSha && job.targetSha) && boundValidation && ['passed', 'unverified'].includes(job.validation?.status) && !blocked && !validation.failed };
  }
  function renderIntegration() {
    const all = asArray(state.data.integration);
    if (!all.length) return empty('Nothing is waiting for integration', 'Submit a task’s committed changeset from its detail drawer, then prepare a candidate. The source checkout stays unchanged during integration.', [button('Go to tasks', () => navigate('tasks'), 'button-primary'), button('Prepare from changeset ID', () => openPrepare())], '⇄');
    return el('div', {}, notice('Candidates are separate from source workspaces. Inspect the exact SHAs and check results before approving an update to the target.'),
      table(['Candidate', 'Status', 'Validation', 'Target', 'Action'], all.map(job => {
        const check = validationState(job);
        return el('tr', {}, td([link(`Candidate ${short(job.id)}`, () => openJob(job.id), 'task-link', { 'data-focus-key': `job-${job.id}` }), el('div', { class: 'job-shas' }, el('span', {}, 'Source ', el('code', { title: job.sourceSha || '' }, short(job.sourceSha, 12))), el('span', {}, 'Candidate ', el('code', { title: job.candidateSha || '' }, short(job.candidateSha, 12))))], 'primary-cell'),
          td(badge(job.status)), td(badge(check.status, check.label)), td([el('div', {}, job.targetRef || '—'), el('code', { class: 'muted', title: job.targetSha || '' }, short(job.targetSha, 12))]), td(button('Inspect', () => openJob(job.id), 'button-small', { 'data-focus-key': `inspect-${job.id}` })));
      }), 'Integration candidates'));
  }
  function renderAdapters() {
    const rows = asArray(state.data.adapters);
    if (!rows.length) return empty('No adapter diagnostics returned', 'The daemon did not report adapter rows. Refresh or inspect the daemon’s adapter configuration.', [button('Refresh diagnostics', () => refresh())], '⌘');
    const boolStatus = (value, yes, no) => value === true ? badge('verified', yes) : value === false ? badge('unverified', no) : badge('unknown', 'Unknown');
    return el('div', {}, notice('Configured does not mean connected. Connected does not mean verified. Only the daemon’s reported verification is shown.'),
      table(['Tool', 'Configured', 'Connected', 'Verified', 'Capabilities / notes'], rows.map(item => el('tr', {},
        td([el('strong', {}, titleCase(item.tool)), el('div', { class: 'cell-subtitle' }, titleCase(item.status))]), td(boolStatus(item.configured, 'Configured', 'Not configured')), td(boolStatus(item.connected, 'Connected', 'Not connected')), td(boolStatus(item.verified, 'Verified', 'Not verified')),
        td([el('div', { class: 'adapter-capabilities' }, Array.isArray(item.capabilities) ? item.capabilities.map(cap => el('span', { class: 'tag' }, pretty(cap))) : el('span', { class: 'small' }, pretty(item.capabilities))), item.note ? el('p', { class: 'cell-subtitle' }, item.note) : null, inspectDetails('Executables and diagnostics', { executables: item.executables, status: item.status, capabilities: item.capabilities, implementation: item.implementation })], 'path-cell'))), 'Adapter configuration, connection and verification diagnostics'));
  }

  function publicRequestReference(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
  }
  function focusPublicRequest() {
    if (!state.token || !pendingRequestId) return;
    navigate('connections'); state.search = pendingRequestId; renderContent();
    const reference = pendingRequestId;
    queueMicrotask(() => Array.from($('#page-content').querySelectorAll('[data-focus-key]')).find(item => item.dataset.focusKey === `request-${reference}`)?.focus());
  }
  function syncConnectionPolling() {
    clearInterval(state.connectionPollTimer); state.connectionPollTimer = null;
    // Pending requests have no verified project yet, so a project SSE stream is not sufficient.
    if (state.token && state.page === 'connections') state.connectionPollTimer = setInterval(() => { if (!document.hidden) void refresh(true); }, 5000);
  }
  function timestamp(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not reported';
    return new Date(value).toLocaleString();
  }
  function requestState(request) { return request.state === 'pending' && request.expiresAt <= Date.now() ? 'expired' : request.state; }
  function invitationState(invite) { return invite.revokedAt != null ? 'revoked' : invite.consumedAt != null ? 'consumed' : invite.expiresAt <= Date.now() ? 'expired' : 'pending'; }
  function grantState(grant) {
    if (grant.revokedAt != null) return ['revoked', 'Revoked'];
    if (grant.expiresAt <= Date.now()) return ['expired', 'Expired'];
    if (grant.bridgeFirstSeenAt == null && grant.bridgeLastSeenAt == null) return ['approved', 'Approved · not yet used'];
    if (typeof grant.bridgeLastSeenAt === 'number' && Date.now() - grant.bridgeLastSeenAt <= 5 * 60 * 1000) return ['active', 'Recent bridge contact'];
    return ['stale', 'No recent bridge contact'];
  }
  function connectionError(error) {
    // Do not render arbitrary backend error detail objects in approval or credential views.
    return Object.assign(new Error(error.message || 'The connection action could not be completed.'), { code: error.code, status: error.status });
  }
  async function connectionAPI(path, body, idempotencyKey) {
    try { return await api(path, body === undefined ? {} : { method: 'POST', body, idempotencyKey }); }
    catch (error) { throw connectionError(error); }
  }
  function connectionSection(title, description, content) {
    return el('section', { class: 'connection-section' }, el('div', { class: 'section-head' }, el('div', {}, el('h2', {}, title), el('p', { class: 'muted small space-top-sm' }, description))), content);
  }
  function renderConnections() {
    const allRequests = asArray(state.data.connectionRequests);
    const requests = allRequests.filter(item => matches({ status: requestState(item) }, [item.requestId, item.native?.tool, item.native?.nativeId, item.workspaceRoot, item.responsibility, item.groupTitle]));
    const groups = asArray(state.data.groups), grants = asArray(state.data.grants);
    const result = el('div', { class: 'connections-view' }, notice('A group focuses project context; it does not merge chats or share task ownership. Linking does not move files, isolate a shared checkout, or control a native process.'));
    const requestContent = el('div', {}, filterBar('Search request ID, chat, or workspace', ['pending', 'approved', 'rejected', 'expired'], requests.length));
    if (!requests.length) requestContent.append(empty('No matching connection requests', allRequests.length ? 'Clear the search or state filter to find a request.' : 'A supported native command can request approval. An invitation alone never grants access.', [], '⋈'));
    else requestContent.append(table(['Requesting chat', 'Requested workspace / group', 'Approval state', 'Action'], requests.map(request => {
      const status = requestState(request);
      return el('tr', {}, td([el('strong', {}, titleCase(request.native?.tool)), el('div', { class: 'cell-subtitle' }, `${titleCase(request.kind)} · ${request.native?.nativeId || 'No native ID reported'}`), el('div', { class: 'cell-subtitle mono' }, request.requestId)], 'primary-cell'),
        td([el('code', {}, request.workspaceRoot), el('div', { class: 'cell-subtitle' }, 'Unverified request hint — inspect before approval'), el('p', { class: 'cell-subtitle' }, request.groupTitle || 'Invitation target — resolved during review')], 'path-cell'),
        td([badge(status), el('div', { class: 'cell-subtitle' }, status === 'pending' ? `Request expires ${timestamp(request.expiresAt)}` : `Decision ${timestamp(request.decidedAt)}`)]),
        td(button(status === 'pending' ? 'Review request' : 'Inspect request', () => openEnrollment(request), 'button-small', { 'data-focus-key': `request-${request.requestId}` })));
    }), 'Human-only connection requests across this daemon'));
    result.append(connectionSection('Approval requests', 'Workspace-wide, not filtered by the project selector. A raw workspace hint is not a verified project binding.', requestContent));
    if (!state.projectId) {
      result.append(empty('Register a project before approving', 'Workspace inspection must resolve to a registered project. Register the repository, then perform a fresh request review.', [button('Register project', openRegisterProject)], '▱')); return result;
    }
    const groupContent = state.data.groups === undefined ? notice('Groups have not been loaded. Retry the workspace refresh; an empty result has not been assumed.', 'warning') : groups.length ?
      table(['Group', 'Members', 'State', 'Action'], groups.map(({ group, members }) => el('tr', {},
        td([link(group.title, () => openGroup(group.id), 'task-link', { 'data-focus-key': `group-${group.id}` }), el('div', { class: 'cell-subtitle' }, group.goal || 'No shared goal recorded')], 'primary-cell'),
        td(`${asArray(members).filter(member => member.state === 'active').length} active / ${asArray(members).length} recorded`), td(badge(group.state)), td(button('Inspect group', () => openGroup(group.id), 'button-small', { 'data-focus-key': `inspect-group-${group.id}` })))), 'Groups in the selected project') :
      empty('Bring separate responsibilities into focus', 'Create a group, add an existing task owner, or invite another chat to request its own approval.', [button('Create group', openCreateGroup, 'button-primary')], '⋈');
    result.append(connectionSection('Project groups', 'Each member retains its own session and assigned task. Feature keys remain exclusive active-work claims, not group keys.', groupContent));
    const grantContent = state.data.grants === undefined ? notice('Scoped grants have not been loaded. Retry the workspace refresh.', 'warning') : grants.length ?
      table(['Scoped binding', 'Access state', 'Fixed expiry', 'Action'], grants.map(grant => el('tr', {},
        td([el('strong', {}, `Task ${short(grant.taskId)}`), el('div', { class: 'cell-subtitle' }, `Session ${short(grant.sessionId)} · Group ${short(grant.groupId)}`), el('div', { class: 'cell-subtitle mono' }, grant.workspaceRoot)], 'primary-cell'),
        td([badge(...grantState(grant)), el('div', { class: 'cell-subtitle' }, `Last successful bridge request: ${timestamp(grant.bridgeLastSeenAt)}`)]), td(timestamp(grant.expiresAt)),
        td(button('Inspect grant', () => showGrant(grant), 'button-small', { 'data-focus-key': `grant-${grant.id}` })))), 'External grants in the selected project') :
      notice('No external grants in this project. Manual members have no native connection; managed members keep their existing managed lifetime.');
    result.append(connectionSection('Scoped external access', 'Bridge contact is not a heartbeat or proof of native-process liveness. Refresh never extends access. Lost or disconnected credentials require fresh approval.', grantContent));
    result.append(notice('Native commands are host- and version-gated. MCP or configuration being present does not prove that existing-chat linking is supported. Use the documented installed command only when supported; otherwise export a reviewed handoff for a new managed task.'));
    return result;
  }
  function openCreateGroup() {
    const projectId = state.projectId;
    showForm({ title: 'Create group', description: 'Share a project goal while keeping responsibilities and ownership separate.', submit: 'Create group',
      build: body => body.append(metadata([['Project', project()?.root], ['Project ID', projectId]]), el('div', { class: 'divider' }), field('Group title', input('title', '', { required: true, maxlength: '256' })), field('Shared goal (optional)', input('goal', '', { maxlength: '2048' })), notice('A group does not claim a feature key or transfer task ownership.')),
      onSubmit: form => connectionAPI('/v1/groups/create', { projectId, title: requiredText(form, 'title', 'Group title'), ...(value(form, 'goal') ? { goal: value(form, 'goal') } : {}) }),
      onSuccess: async result => { $('#modal').close(); toast('Group created.'); await refresh(true); if (result?.id) await openGroup(result.id); },
    });
  }
  async function openGroup(groupId) {
    const drawer = $('#drawer'), loadId = uuid(), projectId = state.projectId;
    state.drawer = { kind: 'group', id: groupId, loadId };
    $('#drawer-content').replaceChildren(dialogHeader('Group details', 'Loading a fresh group snapshot.', drawer, 'drawer-title'), loading('Loading members…'));
    if (!drawer.open) drawer.showModal();
    try {
      const detail = await connectionAPI(`/v1/groups/detail?${new URLSearchParams({ groupId })}`);
      if (!drawer.open || state.drawer?.loadId !== loadId || projectId !== state.projectId) return;
      if (!detail?.group || !Array.isArray(detail.members)) throw new Error('The daemon did not return a group and its members.');
      state.drawer.detail = detail; renderGroupDrawer(detail);
    } catch (error) {
      if (state.drawer?.loadId !== loadId || !drawer.open) return;
      $('#drawer-content').replaceChildren(dialogHeader('Group unavailable', 'No changes were assumed.', drawer, 'drawer-title'), el('div', { class: 'dialog-body' }, notice(errorText(connectionError(error)), 'error'), button('Reload group', () => openGroup(groupId))));
    }
    $('#drawer-title')?.focus();
  }
  function renderGroupDrawer({ group, members, invitations, invitationsTruncated }) {
    const drawer = $('#drawer');
    const body = el('div', { class: 'dialog-body' }, el('section', { class: 'detail-section' },
      metadata([['State', badge(group.state)], ['Project', state.projects.find(item => item.id === group.projectId)?.root || group.projectId], ['Group ID', group.id], ['Goal', group.goal || 'Not set'], ['Revision', group.revision]]),
      el('p', {}, 'This is a detail snapshot. Reload it before retrying any stale-revision action.'), el('div', { class: 'action-row' }, button('Reload group', () => openGroup(group.id), 'button-small'),
        group.state === 'active' ? [button('Invite another chat', () => openInvite(group), 'button-small'), button('Add existing owner', () => openAddMember(group), 'button-small'), button('Close group', () => openCloseGroup(group), 'button-small button-danger')] : null)),
      el('section', { class: 'detail-section' }, el('h3', {}, 'Members and ownership'), el('p', {}, 'Leaving or closing a connection does not hand off or abandon its task. Use Task actions separately.')));
    const memberSection = body.lastElementChild;
    if (!members.length) memberSection.append(notice('No members yet. Add an existing manual or active managed owner, or invite a supported chat to request approval.'));
    for (const member of members) {
      const task = tasks().find(item => item.id === member.taskId), session = sessions().find(item => item.id === member.sessionId);
      const grant = asArray(state.data.grants).find(item => item.memberId === member.id);
      const record = el('article', { class: 'member-record' }, el('div', { class: 'item-title' }, el('h4', {}, member.responsibility), badge(member.state), el('span', { class: 'tag' }, titleCase(member.kind))),
        metadata([['Member session', el('code', {}, member.sessionId)], ['Assigned task', task?.title || member.taskId], ['Task ID', el('code', {}, member.taskId)], ['Current task owner', task ? el('code', {}, task.ownerSessionId) : 'Not in the current project snapshot'], ['Workspace', session?.workspaceRoot || 'Not in the current snapshot'], ['Member revision', member.revision]]),
        member.native ? metadata([['Reported tool', titleCase(member.native.tool)], ['Reported chat ID', member.native.nativeId], ['Reported incarnation', member.native.incarnationId]]) : null,
        member.kind === 'manual' ? el('p', { class: 'small muted' }, 'Manual bookkeeping only; no native chat was connected or verified.') : member.kind === 'external' ? el('p', { class: 'small muted' }, grant ? `${grantState(grant)[1]}. Last bridge contact: ${timestamp(grant.bridgeLastSeenAt)}.` : 'Check scoped access below; membership alone does not prove live credentials.') : el('p', { class: 'small muted' }, 'Existing managed task and lifetime are unchanged.'),
        member.summary ? el('p', { class: 'text-preserve' }, member.summary) : null,
        member.handoff ? inspectDetails('Reviewed handoff and decision proposals', handoffFields(member.handoff)) : null,
        el('div', { class: 'action-row' }, button('Task actions', () => openTask(member.taskId, 'workflow'), 'button-small'), button('Export reviewed handoff', () => openExportHandoff(member), 'button-small'), member.state === 'active' ? button('Leave group', () => openLeaveMember(member), 'button-small button-danger') : null));
      if (task && task.ownerSessionId !== member.sessionId) record.append(notice('Task ownership no longer matches this membership. This is not a transferable connection; inspect the task and request fresh approval as needed.', 'warning'));
      memberSection.append(record);
    }
    const invites = el('section', { class: 'detail-section' }, el('h3', {}, 'Invitations'), el('p', {}, 'Single-use public codes only request approval. Codes expire after 15 minutes and grant no access by themselves.'));
    for (const invite of asArray(invitations)) invites.append(el('div', { class: 'related-item' }, el('div', { class: 'item-title' }, badge(invitationState(invite)), el('code', {}, invite.id)), el('p', {}, `Expires ${timestamp(invite.expiresAt)}`), invitationState(invite) === 'pending' ? button('Revoke invitation', () => openRevokeInvite(invite), 'button-small button-danger') : null));
    if (!asArray(invitations).length) invites.append(el('p', {}, invitations === undefined ? 'No invitation list was returned. A newly issued invitation can be revoked from its result dialog.' : 'No invitations issued.'));
    if (invitationsTruncated) invites.append(notice('Only the first 100 invitation records are shown. Additional records are omitted from this snapshot.', 'warning'));
    body.append(invites);
    $('#drawer-content').replaceChildren(dialogHeader(group.title, 'Project focus, not shared task ownership.', drawer, 'drawer-title'), body);
  }
  function afterGroupChange(message, groupId) {
    $('#modal').close(); toast(message); void refresh(true);
    if ($('#drawer').open && state.drawer?.kind === 'group' && state.drawer.id === groupId) void openGroup(groupId);
  }
  function openInvite(group) {
    let invitationCode, inviteHash;
    const idempotencyKey = uuid();
    showForm({ title: 'Invite another chat', description: group.title, submit: 'Create invitation',
      build: body => body.append(notice('This public, single-use code expires in 15 minutes. The other chat must make its own request and receive separate human approval. The code grants no access.'), notice('Use only a documented native command supported by the installed host version. A config file or MCP server does not establish that support.', 'warning')),
      onSubmit: async () => {
        if (!crypto.subtle?.digest) throw new Error('This browser cannot securely hash an invitation. Use a supported browser on the local dashboard origin.');
        if (!invitationCode) invitationCode = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        if (!inviteHash) inviteHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invitationCode))), byte => byte.toString(16).padStart(2, '0')).join('');
        return connectionAPI('/v1/groups/invite', { groupId: group.id, inviteHash }, idempotencyKey);
      },
      onSuccess: invitation => {
        if (!invitation?.id || invitation.groupId !== group.id) throw new Error('The daemon did not return the matching invitation record. Keep this form and retry; its code is retained only in this tab.');
        void refresh(true);
        showInfo('Invitation created', 'Share only this public invitation code with the other chat. It cannot be recovered from the daemon after this dialog is closed.', [el('code', { class: 'command' }, invitationCode), metadata([['Group', group.title], ['Expires', timestamp(invitation.expiresAt)]]), notice('This code only identifies a request for approval. Never share a browser login URL, private connection configuration, or credentials.')], [button('Copy invitation code', () => copyText(invitationCode, 'Invitation code copied.')), button('Revoke invitation', () => openRevokeInvite(invitation), 'button-danger')]);
      },
    });
  }
  async function copyText(text, message) {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select the displayed text or use Download instead.');
    await navigator.clipboard.writeText(text); toast(message);
  }
  function openRevokeInvite(invite) {
    showForm({ title: 'Revoke invitation', description: 'This prevents future approval using this invitation.', submit: 'Revoke invitation', danger: true,
      build: body => body.append(metadata([['Invitation', invite.id], ['Expires', timestamp(invite.expiresAt)]]), notice('Already approved memberships are unaffected. Revoke their scoped grants separately.')),
      onSubmit: () => connectionAPI('/v1/groups/invites/revoke', { inviteId: invite.id }), onSuccess: () => afterGroupChange('Invitation revoked.', invite.groupId),
    });
  }
  function eligibleGroupTasks() {
    const occupied = new Set(asArray(state.data.groups).flatMap(item => asArray(item.members)).filter(item => item.state === 'active').map(item => item.sessionId));
    return tasks().filter(task => {
      if (['integrated', 'abandoned'].includes(task.status) || occupied.has(task.ownerSessionId)) return false;
      const session = sessions().find(item => item.id === task.ownerSessionId);
      if (!session) return false;
      if (session.credentialMode === 'manual') return true;
      if (session.credentialMode !== 'managed') return false;
      return asArray(state.data.status?.launches).some(launch => launch.sessionId === session.id && launch.taskId === task.id && ['claimed', 'running'].includes(launch.state) && launch.expiresAt > Date.now());
    });
  }
  function handoffFields(handoff = {}) {
    // Explicit allowlists: no native history, arbitrary metadata, hashes, or credentials.
    const result = {};
    for (const key of ['summary', 'acceptanceCriteria', 'changedFiles', 'remainingWork', 'reads', 'writes', 'dependencies', 'blocker']) if (handoff[key] !== undefined) result[key] = handoff[key];
    for (const key of ['produces', 'consumes']) if (Array.isArray(handoff[key])) result[key] = handoff[key].map(item => ({ key: item.key, version: item.version, ...(item.value === undefined ? {} : { value: item.value }) }));
    if (Array.isArray(handoff.decisions)) result.decisions = handoff.decisions.map(item => ({ key: item.key, version: item.version, value: item.value, rationale: item.rationale }));
    return result;
  }
  function handoffEditor(body, draft = {}) {
    draft = draft || {};
    const structured = Object.fromEntries(['produces', 'consumes', 'dependencies', 'decisions'].map(key => [key, handoffFields(draft)[key] || []]));
    body.append(el('h3', { class: 'form-section-title' }, 'Review what will be shared'),
      field('Reviewed summary', textarea('handoffSummary', draft.summary || '', { maxlength: '4096', rows: '3' }), 'One short paragraph. Only your reviewed text is shared; no native conversation history is imported.'),
      field('Files already changed (reported)', textarea('handoffChangedFiles', asArray(draft.changedFiles).join('\n'), { rows: '3' }), 'Reported past changes, not intended writes or filesystem proof. One literal relative path per line, up to 64; no files are copied.'),
      field('Remaining work', textarea('handoffRemainingWork', asArray(draft.remainingWork).join('\n'), { rows: '3' }), 'Preserve the handoff checklist. One remaining item per line, up to 16 items and 512 characters each.'),
      field('Acceptance criteria', textarea('handoffCriteria', asArray(draft.acceptanceCriteria).join('\n'), { rows: '3' }), 'One criterion per line, up to 16.'),
      el('div', { class: 'two-columns' }, field('Files / paths read', textarea('handoffReads', asArray(draft.reads).join('\n'), { rows: '3' }), 'One literal relative path or directory prefix per line; no globs.'), field('Files / paths written', textarea('handoffWrites', asArray(draft.writes).join('\n'), { rows: '3' }), 'Declarations are coordination advice, not filesystem isolation.')),
      field('Current blocker (optional)', input('handoffBlocker', draft.blocker || '', { maxlength: '2048' })),
      field('Contracts, dependencies, and decision proposals (JSON)', textarea('handoffStructured', pretty(structured), { class: 'code-input', spellcheck: 'false', rows: '9' }), 'produces / consumes: arrays of {"key","version","value"?}. dependencies: task ID strings. decisions: {"key","version","value","rationale"}. Unknown fields are rejected.'),
      notice('Imported decisions remain proposals. They do not become accepted project decisions through connection approval. Remove credentials, private history, and anything you do not intend to share.', 'warning'));
  }
  function handoffText(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be non-empty text, at most ${max} characters, without control characters or line breaks.`);
    return value.trim();
  }
  function strictRecord(record, keys, label) {
    if (!record || Array.isArray(record) || typeof record !== 'object') throw new Error(`${label} must be a JSON object.`);
    const unknown = Object.keys(record).filter(key => !keys.includes(key));
    if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(', ')}.`);
  }
  function readHandoff(form) {
    const lines = (name, label, max, length) => {
      const entries = value(form, name).split('\n').map(item => item.trim()).filter(Boolean);
      if (entries.length > max) throw new Error(`${label} allows at most ${max} entries.`);
      return entries.map(item => handoffText(item, label, length));
    };
    const extra = parseJSON(value(form, 'handoffStructured') || '{}', 'Handoff structured fields');
    strictRecord(extra, ['produces', 'consumes', 'dependencies', 'decisions'], 'Handoff');
    for (const key of ['produces', 'consumes', 'dependencies', 'decisions']) if (extra[key] !== undefined && !Array.isArray(extra[key])) throw new Error(`Handoff “${key}” must be an array.`);
    const contracts = key => {
      const items = extra[key] || []; if (items.length > 32) throw new Error(`Use at most 32 ${key} contracts.`);
      const seen = new Set();
      return items.map(item => {
        strictRecord(item, ['key', 'version', 'value'], `Contract in ${key}`);
        const contractKey = handoffText(item.key, 'Contract key', 128);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(contractKey)) throw new Error('Contract keys must use letters, numbers, dots, underscores, colons, slashes, or hyphens.');
        if (seen.has(contractKey)) throw new Error(`Duplicate contract key in ${key}: ${contractKey}.`);
        seen.add(contractKey);
        return { key: contractKey, version: handoffText(item.version, 'Contract version', 64), ...(item.value === undefined ? {} : { value: handoffText(item.value, 'Contract value', 2048) }) };
      });
    };
    if ((extra.dependencies || []).length > 32) throw new Error('Use at most 32 dependency task IDs.');
    if ((extra.decisions || []).length > 8) throw new Error('Use at most 8 decision proposals.');
    const decisions = (extra.decisions || []).map(item => {
      strictRecord(item, ['key', 'version', 'value', 'rationale'], 'Decision proposal');
      const key = handoffText(item.key, 'Decision key', 128);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(key)) throw new Error('Decision keys must use letters, numbers, dots, underscores, colons, slashes, or hyphens.');
      return { key, version: handoffText(item.version, 'Decision version', 64), value: handoffText(item.value, 'Decision value', 2048), rationale: handoffText(item.rationale, 'Decision rationale', 2048) };
    });
    const handoff = { summary: value(form, 'handoffSummary'), changedFiles: lines('handoffChangedFiles', 'Reported changed files', 64, 1024), remainingWork: lines('handoffRemainingWork', 'Remaining work', 16, 512), acceptanceCriteria: lines('handoffCriteria', 'Acceptance criteria', 16, 512), reads: lines('handoffReads', 'Read paths', 64, 1024), writes: lines('handoffWrites', 'Write paths', 64, 1024), produces: contracts('produces'), consumes: contracts('consumes'), dependencies: (extra.dependencies || []).map(item => handoffText(item, 'Dependency task ID', 128)), decisions, blocker: value(form, 'handoffBlocker') || null };
    const hasContent = handoff.summary || handoff.blocker || ['acceptanceCriteria', 'changedFiles', 'remainingWork', 'reads', 'writes', 'produces', 'consumes', 'dependencies', 'decisions'].some(key => handoff[key].length);
    if (!hasContent) return undefined;
    handoff.summary = handoffText(handoff.summary, 'Reviewed summary', 4096);
    if (handoff.blocker) handoff.blocker = handoffText(handoff.blocker, 'Blocker', 2048);
    for (const path of [...handoff.reads, ...handoff.writes, ...handoff.changedFiles]) if (path.includes('\\') || /^(?:[\\/]|[a-zA-Z]:)/.test(path) || path.split(/[\\/]/).includes('..') || /[*?\[\]{}]/.test(path)) throw new Error('Read, write, and reported changed-file paths must be relative literal paths without parent traversal or globs.');
    if (new TextEncoder().encode(JSON.stringify(handoff)).length > 14 * 1024) throw new Error('The reviewed handoff is too large. Shorten it to leave room in the 16 KiB approval limit.');
    return handoff;
  }
  function openAddMember(group) {
    const available = eligibleGroupTasks();
    if (!available.length) { showInfo('No eligible existing owner', 'Add a non-terminal task owned by a manual session or an active managed launch in this project.', [notice('A session can have only one active membership. External sessions—including disconnected ones—must request fresh approval and cannot be added manually.', 'warning'), notice('Use Tasks to create a manual task. Manual membership records coordination only; it never connects a native chat.')]); return; }
    showForm({ title: 'Add existing owner', description: group.title, submit: 'Add group member', wide: true,
      build: body => {
        const taskSelect = select('taskId', available.map(task => [task.id, `${task.title} — ${sessionName(task.ownerSessionId)}`]));
        const binding = el('div');
        const showBinding = () => { const task = available.find(item => item.id === taskSelect.value) || available[0], session = sessions().find(item => item.id === task.ownerSessionId); binding.replaceChildren(metadata([['Member session', session.id], ['Task owner', task.ownerSessionId], ['Assigned task ID', task.id], ['Workspace', session.workspaceRoot], ['Mode', titleCase(session.credentialMode)]])); };
        taskSelect.addEventListener('change', showBinding); showBinding();
        body.append(field('Existing task and its owner', taskSelect), binding, el('div', { class: 'divider' }), field('Responsibility in this group', input('responsibility', '', { required: true, maxlength: '2048' })), notice('This only adds grouping; it never takes another owner’s task, starts a native chat, or revives external credentials.'));
        handoffEditor(body); body.append(checkbox('share', 'I reviewed this owner, responsibility, and the exact handoff to share.', true));
      },
      onSubmit: form => {
        const task = available.find(item => item.id === value(form, 'taskId'));
        if (!task || !checked(form, 'share')) throw new Error('Choose an eligible task and confirm the reviewed binding.');
        const handoff = readHandoff(form);
        return connectionAPI('/v1/groups/members/add', { groupId: group.id, sessionId: task.ownerSessionId, taskId: task.id, responsibility: requiredText(form, 'responsibility', 'Responsibility'), ...(handoff ? { handoff } : {}) });
      }, onSuccess: () => afterGroupChange('Group member added. Task ownership is unchanged.', group.id),
    });
  }
  function openLeaveMember(member) {
    showForm({ title: 'Leave group', description: member.responsibility, submit: 'Leave group', danger: true,
      build: body => body.append(metadata([['Member session', member.sessionId], ['Assigned task', member.taskId], ['Member revision', member.revision]]), notice(member.kind === 'external' ? 'External scoped access is revoked and only this grant’s reservations are released. Its task, feature claim, and work are preserved.' : 'Grouping is removed. Existing task ownership, managed authority, and reservations remain unchanged.', 'warning'), checkbox('confirm', 'I understand the task is not handed off, abandoned, or stopped.', true)),
      onSubmit: form => { if (!checked(form, 'confirm')) throw new Error('Confirm the effect on this membership.'); return connectionAPI('/v1/groups/members/leave', { memberId: member.id, revision: revisionOf(member) }); },
      onSuccess: () => afterGroupChange('Member left the group. Task ownership is unchanged.', member.groupId),
    });
  }
  function openCloseGroup(group) {
    showForm({ title: 'Close group', description: group.title, submit: 'Close group', danger: true,
      build: body => body.append(notice('Close the group and its memberships; external group grants are revoked. No task is handed off or abandoned, and no native process is stopped. Managed task authority remains independent.', 'warning'), metadata([['Group ID', group.id], ['Revision', group.revision]]), checkbox('confirm', 'Close this group without disposing of its tasks.', true)),
      onSubmit: form => { if (!checked(form, 'confirm')) throw new Error('Confirm group closure.'); return connectionAPI('/v1/groups/close', { groupId: group.id, revision: revisionOf(group) }); },
      onSuccess: () => afterGroupChange('Group closed. Its tasks remain for explicit disposition.', group.id),
    });
  }
  function showGrant(grant) {
    showInfo('Scoped external grant', 'A fixed connection scope, not proof that a native process is running.', [badge(...grantState(grant)),
      metadata([['Grant ID', grant.id], ['Request', grant.requestId], ['Project', grant.projectId], ['Group', grant.groupId], ['Member', grant.memberId], ['Session', grant.sessionId], ['Task', grant.taskId], ['Workspace', grant.workspaceRoot], ['Approved', timestamp(grant.createdAt)], ['Fixed expiry', timestamp(grant.expiresAt)], ['First bridge contact', timestamp(grant.bridgeFirstSeenAt)], ['Last bridge contact', timestamp(grant.bridgeLastSeenAt)], ['Revoked', grant.revokedAt == null ? 'No' : timestamp(grant.revokedAt)], ['Reason', grant.revokeReason || 'Not reported']]),
      notice('Access is limited to this task’s context, intent, status/blocker, plan checks, decision proposals, reservations, and membership leave. It cannot accept decisions, transfer tasks, integrate work, or control native processes.'),
      notice('Refresh never renews the deadline. Lost, revoked, expired, or disconnected credentials require a new request and fresh approval; historical approval cannot reactivate them.', 'warning')],
      grant.revokedAt == null && grant.expiresAt > Date.now() ? [button('Revoke scoped access', () => openRevokeGrant(grant), 'button-danger')] : []);
  }
  function openRevokeGrant(grant) {
    showForm({ title: 'Revoke scoped access', description: `Task ${grant.taskId}`, submit: 'Revoke scoped access', danger: true,
      build: body => body.append(metadata([['Grant', grant.id], ['Session', grant.sessionId], ['Workspace', grant.workspaceRoot]]), notice('Revoke this grant and release only its reservations. Its task, feature claim, and work remain. Use task actions separately for handoff or abandonment.', 'warning'), checkbox('confirm', 'Revoke access without handing off, abandoning, or stopping the task.', true)),
      onSubmit: form => { if (!checked(form, 'confirm')) throw new Error('Confirm revocation.'); return connectionAPI('/v1/connections/revoke', { grantId: grant.id }); },
      onSuccess: () => afterGroupChange('Scoped access revoked. Task ownership is unchanged.', grant.groupId),
    });
  }

  function eligibleReconnections(request, review, status, grants, groups) {
    if (request.kind !== 'external') return [];
    const reviewedIds = new Set(asArray(review.reconnectGrantIds));
    const members = asArray(groups).flatMap(detail => asArray(detail.members));
    return asArray(grants).filter(grant => reviewedIds.has(grant.id)).flatMap(grant => {
      const session = asArray(status.sessions).find(item => item.id === grant.sessionId), task = asArray(status.tasks).find(item => item.id === grant.taskId), member = members.find(item => item.id === grant.memberId);
      if (!session || !task || !member || (grant.revokedAt == null && grant.expiresAt > Date.now()) || session.credentialMode !== 'external' || task.ownerSessionId !== session.id || ['integrated', 'abandoned'].includes(task.status)) return [];
      if (grant.projectId !== review.inspection.projectId || session.projectId !== grant.projectId || task.projectId !== grant.projectId || session.workspaceRoot !== review.inspection.workspaceRoot || grant.workspaceRoot !== review.inspection.workspaceRoot) return [];
      if (!member.native || ['tool', 'nativeId', 'incarnationId'].some(key => member.native[key] !== request.native[key])) return [];
      if (asArray(grants).some(other => other.sessionId === session.id && other.revokedAt == null && other.expiresAt > Date.now()) || members.some(other => other.sessionId === session.id && other.state === 'active' && other.id !== member.id)) return [];
      return [{ grant, session, task, member }];
    });
  }
  function requestMetadata(request) {
    return metadata([['Public request ID', request.requestId], ['Request revision', request.revision], ['State', badge(requestState(request))], ['Request deadline', timestamp(request.expiresAt)], ['Connection kind', titleCase(request.kind)],
      ['Reported native tool', titleCase(request.native?.tool)], ['Reported chat ID', request.native?.nativeId], ['Reported incarnation', request.native?.incarnationId], ['Requested workspace', request.workspaceRoot],
      ['Requested group', request.groupTitle || 'Invitation target, resolved only during authenticated review'], ['Requested group goal', request.groupGoal || 'Not provided'], ['Requested responsibility', request.responsibility],
      ['Existing session', request.sessionId || 'New external session on approval'], ['Existing task', request.taskId || 'New separately owned task on approval']]);
  }
  function openEnrollment(initialRequest) {
    if (requestState(initialRequest) !== 'pending') {
      showInfo('Connection request record', 'Historical approval never reactivates a connection.', [requestMetadata(initialRequest), initialRequest.handoff ? inspectDetails('Requested handoff (not proof of approved content)', handoffFields(initialRequest.handoff)) : null,
        notice('For current approved scope and contact state, inspect its group membership and grant. An expired or rejected request needs a new request, not an approval retry.')].filter(Boolean)); return;
    }
    let request = initialRequest, review = null, inspectedStatus = null, inspecting = false, form;
    let reconnectCandidates = [];
    const reconnectControl = select('reconnectGrantId', [['', 'Create a new, separately owned task']], '');
    const reconnectDetails = el('div');
    const reconnectChoice = el('div', { hidden: initialRequest.kind !== 'external' }, field('Task binding', reconnectControl, 'Reconnect is optional and requires fresh approval and a new private capability. Only daemon-reviewed eligible bindings are listed.'), reconnectDetails, checkbox('confirmReconnect', 'I explicitly choose this same external session and still-owned task. Replace its expired/revoked access with a new grant; do not transfer ownership.'));
    reconnectControl.disabled = true;
    const requestBox = el('div', {}, requestMetadata(request));
    const reviewBox = el('div', { class: 'review-inspection', 'aria-live': 'polite' });
    const lifetimeBox = el('div', { class: 'review-lifetime' });
    const reviewError = el('div', { class: 'notice notice-error form-error', role: 'alert' });
    function setApprovalAvailable() {
      const approve = form?.querySelector('button[type="submit"]');
      if (approve) approve.disabled = !review || inspecting || requestState(request) !== 'pending' || !!reconnectControl.value && !reconnectCandidates.some(item => item.grant.id === reconnectControl.value);
    }
    function clearAcknowledgements() {
      if (!form) return;
      for (const name of ['confirmIdentity', 'confirmWorkspace', 'confirmSharing', 'confirmReconnect']) { const control = form.elements.namedItem(name); if (control) control.checked = false; }
    }
    function invalidate(message) {
      review = null; inspectedStatus = null; reconnectControl.disabled = true; clearAcknowledgements();
      reviewBox.replaceChildren(notice(message || 'Perform an authenticated workspace inspection, then review its exact project and connection scope before approval.', 'warning'));
      setApprovalAvailable();
    }
    function showLifetime() {
      if (!form) return;
      if (request.kind === 'managed') {
        const launch = asArray(inspectedStatus?.launches).find(item => item.sessionId === request.sessionId && item.taskId === request.taskId);
        lifetimeBox.replaceChildren(notice(`No external grant is created. This member keeps its existing managed task, authority, and lifetime. Managed deadline: ${timestamp(launch?.expiresAt)}. Approval does not extend it.`));
      } else {
        const hours = Number(value(form, 'expiryHours'));
        lifetimeBox.replaceChildren(notice(`Fixed grant lifetime: ${hours} ${hours === 1 ? 'hour' : 'hours'} from successful approval. Default 8 hours; maximum 24. Activity and refresh cannot renew it.`));
      }
    }
    function showReconnect() {
      const selected = reconnectCandidates.find(item => item.grant.id === reconnectControl.value);
      const confirmation = reconnectChoice.querySelector('.checkbox-field');
      confirmation.hidden = !reconnectControl.value; $('input', confirmation).required = !!reconnectControl.value;
      if (selected) reconnectDetails.replaceChildren(metadata([['Reconnect session', selected.session.id], ['Preserved task', selected.task.title], ['Task ID / owner', `${selected.task.id} / ${selected.task.ownerSessionId}`], ['Preserved feature claim', selected.task.featureKey || 'Not set'], ['Previous grant', selected.grant.id], ['Exact workspace', selected.session.workspaceRoot]]), notice('This explicit fresh approval keeps the same task and its owner, title, and feature claim. It replaces expired/revoked authority with a new capability and grant. It is not recovery of old credentials.', 'warning'));
      else reconnectDetails.replaceChildren(notice(reconnectControl.value ? 'The previously chosen binding is no longer eligible. Explicitly choose a new task or an eligible reviewed binding before approval.' : 'Default: create a new external session and its own task. No previous task or feature claim is taken.', reconnectControl.value ? 'warning' : ''));
      if (form) for (const name of ['title', 'featureKey']) { const control = form.elements.namedItem(name); if (control) { control.disabled = !!reconnectControl.value; control.closest?.('.field')?.classList.toggle('muted', !!reconnectControl.value); } }
      setApprovalAvailable();
    }
    reconnectControl.addEventListener('change', () => { clearAcknowledgements(); showReconnect(); });
    async function inspectRequest() {
      if (inspecting || $('#modal').dataset.busy === 'true') return;
      inspecting = true; invalidate(); reviewError.replaceChildren();
      const dialog = $('#modal'); dialog.dataset.busy = 'true';
      const disabled = Array.from(form.elements).map(item => [item, item.disabled]);
      form.querySelectorAll('input, textarea, select, button').forEach(item => { item.disabled = true; });
      $('[data-close]', dialog).disabled = true;
      form.setAttribute('aria-busy', 'true');
      try {
        const latest = asArray(await connectionAPI('/v1/connections/requests')).find(item => item.requestId === request.requestId);
        if (!latest) throw new Error('This request is no longer available. Your draft is preserved; close it only when you are ready.');
        request = latest; requestBox.replaceChildren(requestMetadata(request));
        if (requestState(request) !== 'pending') throw new Error('This request is no longer pending. Inspect its current outcome; do not retry approval.');
        const inspected = await connectionAPI('/v1/connections/review', { requestId: request.requestId, revision: revisionOf(request) });
        if (inspected?.requestId !== request.requestId || inspected.requestDigest !== request.requestDigest || !Number.isSafeInteger(inspected.revision) || !/^[a-f0-9]{64}$/.test(inspected.reviewDigest || '') || !inspected.inspection?.projectId || inspected.nativeIdentitySource !== 'request_metadata_not_authentication') throw new Error('The daemon did not return a complete matching review. Perform a fresh review; approval remains unavailable.');
        if (!state.token || !dialog.open || state.enrollmentEditor?.requestId !== request.requestId) return;
        const [details, grants, groups] = await Promise.all([connectionAPI(scoped('/v1/status', {}, inspected.inspection.projectId)), ...(request.kind === 'external' ? [connectionAPI(scoped('/v1/connections/grants', {}, inspected.inspection.projectId)), connectionAPI(scoped('/v1/groups', {}, inspected.inspection.projectId))] : [])]);
        if (!state.token || !dialog.open || state.enrollmentEditor?.requestId !== request.requestId) return;
        const inspectedProject = asArray(details.projects).find(item => item.id === inspected.inspection.projectId) || state.projects.find(item => item.id === inspected.inspection.projectId);
        inspectedStatus = details;
        reconnectCandidates = eligibleReconnections(request, inspected, details, grants, groups);
        const previousChoice = reconnectControl.value;
        reconnectControl.replaceChildren(el('option', { value: '' }, 'Create a new, separately owned task'), reconnectCandidates.map(item => el('option', { value: item.grant.id }, `Fresh reconnect: ${item.task.title} / session ${short(item.session.id)}`)));
        if (previousChoice && !reconnectCandidates.some(item => item.grant.id === previousChoice)) reconnectControl.append(el('option', { value: previousChoice, disabled: true }, 'Previous selection is no longer eligible'));
        reconnectControl.value = previousChoice;
        const task = asArray(details.tasks).find(item => item.id === request.taskId);
        const launch = asArray(details.launches).find(item => item.sessionId === request.sessionId && item.taskId === request.taskId);
        if (request.kind === 'managed' && (!task || task.ownerSessionId !== request.sessionId || !launch || !['claimed', 'running'].includes(launch.state) || !(launch.expiresAt > Date.now()))) throw new Error('The existing managed owner/task/lifetime could not be verified from the current status. Review again after checking its launch.');
        request = { ...request, revision: inspected.revision };
        requestBox.replaceChildren(requestMetadata(request));
        review = inspected;
        reviewBox.replaceChildren(el('h3', {}, 'Authenticated workspace inspection'), metadata([['Reviewed project', inspectedProject?.root || inspected.inspection.projectId], ['Project ID', inspected.inspection.projectId], ['Canonical project', inspected.inspection.canonicalPath], ['Exact workspace', inspected.inspection.workspaceRoot], ['Workspace mode', titleCase(inspected.inspection.mode)], ['Shared checkout', inspected.inspection.sharedCheckout ? 'Yes — another session is registered here' : 'Not observed (not proof of isolation)'], ['Resolved group', inspected.group?.title || request.groupTitle], ['Group goal', inspected.group?.goal || request.groupGoal || 'Not set'], ['Group ID', inspected.group?.id || 'New group on approval'], ['Review revision', inspected.revision]]),
          notice('Native tool, chat ID, and incarnation are reported request metadata, not authentication or proof of native ownership. Match them to the chat you intend to approve.', 'warning'),
          notice(inspected.inspection.sharedCheckout ? 'Shared workspace warning: linked agents can edit the same checkout. Declarations and reservations are advisory; this approval creates no filesystem isolation.' : 'This existing workspace is not moved or isolated. Advisory declarations and reservations do not enforce filesystem separation.', 'warning'),
          ...(inspected.inspection.mode === 'advisory' ? [notice('Advisory project mode: no Git isolation or committed-base guarantees are implied.', 'warning')] : []),
          request.kind === 'managed' ? metadata([['Existing task title', task.title], ['Existing task owner', task.ownerSessionId], ['Existing task ID', task.id], ['Managed deadline', timestamp(launch.expiresAt)]]) : notice('The default is a new external session and its own task. An optional reviewed reconnect below can keep only the same exact external session and its still-owned task; it cannot take another chat’s task.'));
        showLifetime(); showReconnect();
      } catch (error) {
        invalidate('Inspection did not complete. Keep your edited draft, resolve the issue, then inspect again. No approval was sent.');
        reviewError.replaceChildren(el('p', {}, errorText(connectionError(error))));
      } finally {
        inspecting = false; dialog.dataset.busy = 'false'; form.removeAttribute('aria-busy');
        disabled.forEach(([item, wasDisabled]) => { item.disabled = wasDisabled; });
        const close = $('[data-close]', dialog); if (close) close.disabled = false;
        reconnectControl.disabled = !review; showReconnect(); setApprovalAvailable();
      }
    }
    form = showForm({ title: 'Review connection request', description: 'Inspect first. Approve only the exact binding and handoff you have reviewed.', submit: 'Approve reviewed connection', wide: true,
      build: body => {
        body.append(requestBox, el('div', { class: 'divider' }), button('Inspect workspace / fresh review', inspectRequest), reviewError, reviewBox, el('div', { class: 'divider' }),
          field('Approved responsibility', input('responsibility', request.responsibility, { required: true, maxlength: '2048' })), reconnectChoice);
        if (request.kind === 'external') body.append(field('New task title (optional)', input('title', '', { maxlength: '512' }), 'Defaults to the approved responsibility. This creates a separate task; it never takes an existing task.'), field('Exclusive feature claim (optional)', input('featureKey', '', { maxlength: '128' }), 'Unique among active tasks in this project. This is not the group name or a shared key.'), field('Fixed external access lifetime', select('expiryHours', [[1, '1 hour'], [4, '4 hours'], [8, '8 hours (default)'], [12, '12 hours'], [24, '24 hours (maximum)']], 8)));
        body.append(lifetimeBox, notice(request.kind === 'external' ? 'Approved scope: task-focused group/project context; this task’s intent, status/blocker, plan checks, decision proposals, reservations, and membership leave. No accepted decisions, other-task mutation, handoff, integration, workspace operations, or launch control.' : 'Sharing adds group context to the existing managed session and task. It does not issue an external credential or expand or extend the managed launch’s authority.'));
        handoffEditor(body, request.handoff);
        body.append(checkbox('confirmIdentity', 'I matched this exact request, reported native metadata, and task/session binding to the chat I intend to approve.', true),
          checkbox('confirmWorkspace', 'I reviewed the authenticated project, canonical workspace, sharing scope, and displayed lifetime. Shared workspaces are not isolated.', true),
          checkbox('confirmSharing', 'I reviewed the approved responsibility and exact handoff content above. Decisions remain proposals.', true));
      },
      onSubmit: async submitted => {
        if (!review || inspecting) throw new Error('Perform a fresh workspace review before approving.');
        if (requestState(request) !== 'pending') { invalidate('The request deadline passed. A new request is required.'); throw new Error('This request is no longer pending.'); }
        if (!['confirmIdentity', 'confirmWorkspace', 'confirmSharing'].every(name => checked(submitted, name))) throw new Error('Review and confirm the identity, workspace/scope/lifetime, and shared content.');
        const handoff = readHandoff(submitted);
        const payload = { requestId: request.requestId, revision: review.revision, reviewDigest: review.reviewDigest, responsibility: requiredText(submitted, 'responsibility', 'Responsibility'), ...(handoff ? { handoff } : {}) };
        if (request.kind === 'external') {
          const hours = Number(value(submitted, 'expiryHours'));
          if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24) throw new Error('External access must be between 1 and 24 hours.');
          payload.expiresInSeconds = hours * 3600;
          if (reconnectControl.value) {
            if (!reconnectCandidates.some(item => item.grant.id === reconnectControl.value) || !checked(submitted, 'confirmReconnect')) throw new Error('Explicitly confirm an eligible reviewed reconnect binding.');
            payload.reconnectGrantId = reconnectControl.value;
          } else {
            if (value(submitted, 'title')) payload.title = value(submitted, 'title');
            if (value(submitted, 'featureKey')) payload.featureKey = value(submitted, 'featureKey');
          }
        }
        try { return await connectionAPI('/v1/connections/approve', payload); }
        catch (error) {
          invalidate('Approval did not complete reliably. Your draft is preserved. Perform a fresh review and inspect the current request outcome before any new approval attempt.');
          // showForm restores controls in finally; keep the stale approval button disabled afterwards.
          throw connectionError(error);
        }
      },
      onSuccess: async result => {
        state.enrollmentEditor = null;
        showInfo('Connection approved', 'Approval is recorded; it is not evidence that the original chat is running or has contacted Murmur.', [
          metadata([['Group', result.group?.title], ['Member session', result.member?.sessionId], ['Assigned task', result.member?.taskId], ['Responsibility', result.member?.responsibility], ['Access', result.grant ? grantState(result.grant)[1] : 'Existing managed lifetime, no external grant'], ['Fixed expiry', result.grant ? timestamp(result.grant.expiresAt) : 'Existing managed deadline remains unchanged']]),
          notice('The native helper must use its own private connection state. No browser bearer, bootstrap code, or scoped credential is exported here.'),
          notice('If it cannot connect, do not manually reactivate credentials. Request fresh approval or export a reviewed handoff for a new managed task.', 'warning')], [button('Inspect group', async () => { $('#modal').close(); if (result.group?.projectId !== state.projectId) await selectProject(result.group.projectId); await openGroup(result.group.id); })]);
        void refresh(true);
      },
    });
    state.enrollmentEditor = { requestId: request.requestId, form, invalidate, sync: () => { reconnectControl.disabled = !review; showReconnect(); setApprovalAvailable(); }, observe(records) {
      if (!review || inspecting) return;
      const latest = asArray(records).find(item => item.requestId === request.requestId);
      if (!latest || requestState(latest) !== 'pending' || latest.revision !== review.revision || latest.requestDigest !== review.requestDigest) invalidate('This request changed or expired since inspection. Your draft is intact; perform a fresh review before approving.');
    } };
    form.addEventListener('input', event => { if (!event.target.name?.startsWith('confirm')) clearAcknowledgements(); if (event.target.name === 'expiryHours') showLifetime(); });
    form.addEventListener('change', event => { if (!event.target.name?.startsWith('confirm')) clearAcknowledgements(); if (event.target.name === 'expiryHours') showLifetime(); });
    // Keep rejection explicit without replacing or discarding an edited approval draft on error.
    const rejectError = el('div', { class: 'notice notice-error form-error', role: 'alert' });
    const rejection = el('details', { class: 'space-top' }, el('summary', {}, 'Reject this request instead'), notice('Rejection creates no access and publishes none of this handoff.'), checkbox('confirmReject', 'Reject this pending request without approval.'), rejectError,
      button('Reject request', async () => {
        if ($('#modal').dataset.busy === 'true') return;
        if (!checked(form, 'confirmReject')) { rejectError.replaceChildren(el('p', {}, 'Confirm rejection before continuing.')); return; }
        const dialog = $('#modal'); dialog.dataset.busy = 'true';
        const disabled = Array.from(form.elements).map(item => [item, item.disabled]);
        form.querySelectorAll('input, textarea, select, button').forEach(item => { item.disabled = true; });
        $('[data-close]', dialog).disabled = true;
        try {
          await connectionAPI('/v1/connections/reject', { requestId: request.requestId, revision: revisionOf(request) });
          state.enrollmentEditor = null; dialog.close(); toast('Connection request rejected.'); void refresh(true);
        } catch (error) { invalidate('The request may have changed. Inspect again to refresh its revision; your draft is preserved.'); rejectError.replaceChildren(el('p', {}, errorText(connectionError(error)))); }
        finally { dialog.dataset.busy = 'false'; disabled.forEach(([item, wasDisabled]) => { item.disabled = wasDisabled; }); const close = $('[data-close]', dialog); if (close) close.disabled = false; setApprovalAvailable(); }
      }, 'button-danger'));
    form.querySelector('.form-actions').before(rejection);
    invalidate(); showLifetime(); showReconnect();
  }
  function handoffExportBinding(data) {
    if (data?.version !== 1 || data.kind !== 'reviewed_replacement_handoff' || !data.group || !data.member || Object.hasOwn(data, 'summary') || ['responsibility', 'summary', 'handoff'].some(key => Object.hasOwn(data.member, key))) throw new Error('The daemon did not return the current reviewed replacement format. Export a fresh handoff with the current daemon.');
    const pick = (item, keys) => Object.fromEntries(keys.map(key => [key, item[key]]));
    const group = pick(data.group, ['id', 'projectId']);
    const member = pick(data.member, ['id', 'groupId', 'projectId', 'sessionId', 'taskId', 'kind', 'revision', 'taskRevision', 'sessionRevision', 'workspaceRoot', 'workspaceFingerprint', 'projectFingerprint']);
    const ids = [group.id, group.projectId, member.id, member.groupId, member.projectId, member.sessionId, member.taskId];
    if (ids.some(id => !publicRequestReference(id)) || member.groupId !== group.id || member.projectId !== group.projectId || !['manual', 'managed', 'external'].includes(member.kind) || ['revision', 'taskRevision', 'sessionRevision'].some(key => !Number.isSafeInteger(member[key]) || member[key] < 1) || typeof member.workspaceRoot !== 'string' || !member.workspaceRoot || member.workspaceRoot.length > 4096 || /[\u0000-\u001f\u007f]/.test(member.workspaceRoot)) throw new Error('The export lacks a complete matching source binding and revision pins. Export a fresh handoff.');
    if (['workspaceFingerprint', 'projectFingerprint'].some(key => typeof member[key] !== 'string' || !member[key] || member[key].length > 256 || /[\u0000-\u001f\u007f]/.test(member[key]))) throw new Error('The export lacks complete source filesystem identity pins. Export a fresh handoff.');
    if (data.member.native === null) member.native = null;
    else {
      const native = data.member.native;
      if (!native || ['tool', 'nativeId', 'incarnationId'].some(key => typeof native[key] !== 'string' || !native[key] || native[key].length > 256 || /[\u0000-\u001f\u007f]/.test(native[key]))) throw new Error('The export lacks valid reported native metadata. Export a fresh handoff.');
      member.native = pick(native, ['tool', 'nativeId', 'incarnationId']);
    }
    return { group, member };
  }
  function reviewedExport(data, handoff, responsibility, briefing) {
    const { group, member } = handoffExportBinding(data);
    if (!handoff) throw new Error('A reviewed summary is required for a replacement handoff.');
    return { version: 1, kind: 'reviewed_replacement_handoff', group, member,
      responsibility: handoffText(responsibility, 'Reviewed responsibility', 2048), handoff: handoffFields(handoff), briefing,
      warning: 'This reviewed handoff can seed a NEW managed task. It does not attach to, stop, transfer, or copy files from the original chat. Existing workspace preparation and dirty-base consent still apply.' };
  }
  function serializeReviewedExport(data) {
    if (typeof data.briefing !== 'string' || data.briefing.length > 8192) throw new Error('The reviewed briefing must be at most 8192 characters. Shorten it before exporting; no content was truncated.');
    const text = JSON.stringify(data, null, 2) + '\n';
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > 16 * 1024) throw new Error(`This export is ${bytes} UTF-8 bytes; the maximum is 16384 bytes (16 KiB). Shorten the reviewed content before exporting. No content was truncated.`);
    return text;
  }
  async function openExportHandoff(member) {
    const data = await connectionAPI(`/v1/groups/briefing?${new URLSearchParams({ memberId: member.id })}`);
    // Validate the envelope before presenting any export controls; allowlist it again on submission.
    handoffExportBinding(data);
    showForm({ title: 'Export reviewed handoff', description: 'Review a replacement-task handoff. This does not change the existing task or connect its original chat.', submit: 'Review export', wide: true,
      build: body => {
        body.append(metadata([['Group', asArray(state.data.groups).find(item => item.group.id === data.group.id)?.group.title || data.group.id], ['Project ID', data.group.projectId], ['Original session', data.member.sessionId], ['Original task', data.member.taskId], ['Exact source workspace', data.member.workspaceRoot], ['Member revision', data.member.revision], ['Task revision', data.member.taskRevision], ['Session revision', data.member.sessionRevision]]), el('div', { class: 'divider' }), field('Reviewed responsibility', input('responsibility', data.responsibility, { required: true, maxlength: '2048' })));
        body.append(notice('For a runnable replacement, first integrate or explicitly abandon the original task, then export a fresh snapshot. The source group must remain active. These source binding and revision pins are not editable.', 'warning'));
        handoffEditor(body, handoffFields(data.handoff || {}));
        body.append(field('Reviewed project briefing', textarea('briefing', data.briefing || '', { rows: '12' }), 'At most 8192 characters; the complete UTF-8 JSON file must fit within 16 KiB. Oversized content is rejected, never truncated. Review this project context; no native history or file contents are imported.'), notice('Export only. A separate explicit CLI launch may seed a NEW managed task; it does not reuse ownership, copy uncommitted files, stop the original chat, or bypass workspace preparation and committed-base checks.', 'warning'), checkbox('confirm', 'I reviewed all exported content and removed credentials or private history.', true));
      },
      onSubmit: form => {
        if (!checked(form, 'confirm')) throw new Error('Review the full export before continuing.');
        const result = reviewedExport(data, readHandoff(form), requiredText(form, 'responsibility', 'Responsibility'), form.elements.namedItem('briefing')?.value || '');
        serializeReviewedExport(result);
        return result;
      },
      onSuccess: result => {
        const text = serializeReviewedExport(result);
        showInfo('Reviewed handoff ready', 'Download or copy only after reviewing this exact document.', [notice(result.warning, 'warning'), jsonBox(text)], [button('Download JSON', () => {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          const anchor = el('a', { href: url, download: `murmur-handoff-${short(member.id, 16).replace(/[^A-Za-z0-9_-]/g, '_')}.json` });
          document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Reviewed handoff downloaded.');
        }, 'button-primary'), button('Copy JSON', () => copyText(text, 'Reviewed handoff copied.'))]);
      },
    });
  }

  function dialogHeader(title, description, dialog, id = 'modal-title') {
    return el('header', { class: 'dialog-header' }, el('div', {}, el('h2', { id, tabindex: '-1' }, title), description ? el('p', {}, description) : null), button('×', () => dialog.close(), 'icon-button', { 'aria-label': 'Close dialog', 'data-close': 'true' }));
  }
  function openModal(title, description, wide = false) {
    const dialog = $('#modal');
    dialog.classList.toggle('wide', wide); dialog.dataset.busy = 'false';
    $('#modal-content').replaceChildren(dialogHeader(title, description, dialog));
    const body = el('div', { class: 'dialog-body' }); $('#modal-content').append(body);
    if (!dialog.open) dialog.showModal();
    return { dialog, body };
  }
  function showInfo(title, description, contents = [], actions = []) {
    const { body, dialog } = openModal(title, description, true);
    body.append(el('div', { class: 'stack' }, contents), el('div', { class: 'form-actions' }, actions, button('Close', () => dialog.close())));
    $('#modal-title').focus();
  }
  function field(label, control, hint = '') {
    const id = control.id || `field-${++uid}`; control.id = id;
    const hintId = `${id}-hint`;
    if (hint) control.setAttribute('aria-describedby', hintId);
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('p', { class: 'field-hint', id: hintId }, hint) : null);
  }
  function input(name, value = '', attrs = {}) { return el('input', { name, value, ...attrs }); }
  function textarea(name, value = '', attrs = {}) { return el('textarea', { name, ...attrs }, value); }
  function select(name, choices, value) { return el('select', { name }, choices.map(([id, label]) => el('option', { value: id, selected: id === value }, label))); }
  function checkbox(name, label, required = false) {
    const id = `field-${++uid}`;
    return el('div', { class: 'checkbox-field' }, input(name, 'true', { type: 'checkbox', id, required }), el('label', { for: id }, label));
  }
  function value(form, name) { return form.elements.namedItem(name)?.value?.trim() || ''; }
  function checked(form, name) { return form.elements.namedItem(name)?.checked === true; }
  function parseJSON(text, label) {
    try { return JSON.parse(text); } catch { throw new Error(`${label} must be valid JSON. Check quotation marks, commas, and brackets.`); }
  }
  function requiredText(form, name, label) { const text = value(form, name); if (!text) throw new Error(`${label} is required.`); return text; }
  function revisionOf(item) {
    if (!Number.isSafeInteger(item?.revision)) throw new Error('The daemon did not return a usable revision. Reload this record before changing it.');
    return item.revision;
  }
  function showForm({ title, description, build, submit = 'Save changes', onSubmit, onSuccess, wide = false, danger = false }) {
    const { dialog, body } = openModal(title, description, wide);
    const form = el('form'); const fields = el('div');
    const errorBox = el('div', { class: 'notice notice-error form-error', role: 'alert' });
    build(fields, form);
    const cancel = button('Cancel', () => dialog.close(), '', { 'data-close': 'true' });
    const save = el('button', { type: 'submit', class: `button ${danger ? 'button-danger' : 'button-primary'}` }, submit);
    form.append(fields, errorBox, el('div', { class: 'form-actions' }, cancel, save)); body.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (dialog.dataset.busy === 'true' || !form.reportValidity()) return;
      errorBox.replaceChildren(); dialog.dataset.busy = 'true';
      const disabled = Array.from(form.elements).map(item => [item, item.disabled]);
      form.setAttribute('aria-busy', 'true'); save.textContent = 'Working…';
      // Read values in onSubmit before disabling controls; values remain available while busy.
      try {
        const request = onSubmit(form);
        form.querySelectorAll('input, textarea, select, button').forEach(item => { item.disabled = true; });
        $('[data-close]', dialog).disabled = true;
        const result = await request;
        dialog.dataset.busy = 'false';
        if (onSuccess) await onSuccess(result, form); else { dialog.close(); toast('Changes saved.'); void refresh(true); }
      } catch (error) {
        errorBox.append(el('p', { class: 'notice-title' }, 'Action not completed'), el('p', { class: 'text-preserve' }, errorText(error)));
        errorBox.scrollIntoView({ block: 'nearest' });
      } finally {
        dialog.dataset.busy = 'false'; form.removeAttribute('aria-busy');
        disabled.forEach(([item, wasDisabled]) => { item.disabled = wasDisabled; });
        const close = $('[data-close]', dialog); if (close) close.disabled = false;
        save.textContent = submit;
        if (state.enrollmentEditor?.form === form) state.enrollmentEditor.sync();
      }
    });
    queueMicrotask(() => { const first = $('input:not([type="checkbox"]), select, textarea', form); (first || $('#modal-title')).focus(); });
    return form;
  }
  function afterChange(message, taskId) {
    $('#modal').close(); toast(message); void refresh(true);
    if (taskId && $('#drawer').open && state.drawer?.id === taskId) void openTask(taskId, state.drawer.tab);
  }

  function openRegisterProject() {
    showForm({ title: 'Register project', description: 'Connect an existing local repository. This does not create or clone files.', submit: 'Register project',
      build: body => body.append(field('Repository root', input('root', '', { required: true, placeholder: '/absolute/path/to/repository', autocomplete: 'off' }), 'Use an absolute path on this machine.')),
      onSubmit: form => post('/v1/projects', { root: requiredText(form, 'root', 'Repository root') }),
      onSuccess: async result => {
        $('#modal').close(); toast('Project registered.');
        await loadProjects(); await selectProject(result.id || result.project?.id || state.projects[0]?.id || '');
      },
    });
  }
  function openNewTask() {
    const projectId = state.projectId;
    const available = sessions().filter(item => item.credentialMode === 'manual'); let createdSession;
    showForm({ title: 'New task', description: 'Give this work a clear owner before declaring its scope.', submit: 'Create task',
      build: body => {
        const owner = select('sessionId', [['__manual__', 'Create a manual session'], ...available.map(item => [item.id, `${titleCase(item.tool)} / ${short(item.id)} — ${item.workspaceRoot}`])], available[0]?.id || '__manual__');
        const workspace = input('workspaceRoot', project()?.root || '', { required: !available.length, autocomplete: 'off' });
        const manualFields = el('div', { hidden: available.length > 0 }, field('Manual session workspace', workspace, 'Registering a manual session does not launch or verify an agent.'));
        owner.addEventListener('change', () => { manualFields.hidden = owner.value !== '__manual__'; workspace.required = !manualFields.hidden; });
        body.append(field('Task title', input('title', '', { required: true, maxlength: '500', placeholder: 'Describe a concrete piece of work' })), field('Feature key (optional)', input('featureKey', '', { placeholder: 'e.g. auth/session-renewal' }), 'An exclusive active-work claim in this project, not a group key. Use Connections to group separate tasks.'), field('Owner', owner), manualFields);
      },
      onSubmit: async form => {
        let sessionId = value(form, 'sessionId');
        const title = requiredText(form, 'title', 'Task title');
        if (sessionId === '__manual__') {
          const workspaceRoot = requiredText(form, 'workspaceRoot', 'Workspace root');
          if (!createdSession || createdSession.workspaceRoot !== workspaceRoot) {
            // Deliberately discard the returned session token. Only the session record is used.
            const { session } = await post('/v1/sessions', { projectId, workspaceRoot, tool: 'manual', nativeId: uuid(), instanceId: uuid() });
            if (!session?.id) throw new Error('The daemon did not return the new session record.');
            createdSession = session;
          }
          sessionId = createdSession.id;
        }
        const featureKey = value(form, 'featureKey');
        return post('/v1/tasks', { projectId, sessionId, title, ...(featureKey ? { featureKey } : {}) });
      },
      onSuccess: async task => {
        $('#modal').close(); toast('Task created.'); await refresh(true);
        if (task?.id) await openTask(task.id);
      },
    });
  }
  function taskFromContext(context, id) {
    return context?.task?.id ? context.task : asArray(context?.tasks).find(item => item.id === id) || tasks().find(item => item.id === id);
  }
  function intentFromContext(context, task) {
    return context?.intent || task?.intent || asArray(context?.intents).find(item => item.taskId === task?.id) || null;
  }
  async function openTask(id, tab = 'overview') {
    const drawer = $('#drawer'); const loadId = uuid();
    state.drawer = { id, tab, context: null, task: null, loadId };
    $('#drawer-content').replaceChildren(dialogHeader('Task details', `Task ${short(id)}`, drawer, 'drawer-title'), loading('Loading task context…'));
    if (!drawer.open) drawer.showModal();
    const projectId = state.projectId;
    try {
      const context = await api(scoped('/v1/context', { taskId: id }, projectId));
      if (state.drawer?.loadId !== loadId || !drawer.open || projectId !== state.projectId) return;
      const task = taskFromContext(context, id);
      if (!task) throw new Error('This task was not returned by the daemon. Refresh the project and try again.');
      Object.assign(state.drawer, { context, task }); renderTaskDrawer();
    } catch (error) {
      if (state.drawer?.loadId !== loadId || !drawer.open) return;
      $('#drawer-content').replaceChildren(dialogHeader('Task details unavailable', `Task ${short(id)}`, drawer, 'drawer-title'), el('div', { class: 'dialog-body' }, notice(errorText(error), 'error'), button('Reload task', () => openTask(id, tab))));
    }
    $('#drawer-title')?.focus();
  }
  function renderTaskDrawer() {
    const { task, context, tab } = state.drawer;
    const drawer = $('#drawer');
    const header = dialogHeader(task.title, `Task ${short(task.id)} · Revision ${task.revision}`, drawer, 'drawer-title');
    header.firstChild.append(el('div', { class: 'drawer-summary' }, badge(task.status), el('span', { class: 'small muted' }, sessionName(task.ownerSessionId))));
    const tabs = el('div', { class: 'drawer-tabs', role: 'tablist', 'aria-label': 'Task details' });
    const names = [['overview', 'Overview'], ['intent', 'Intent & scope'], ['workflow', 'Actions']];
    names.forEach(([id, label], index) => {
      const item = button(label, () => { state.drawer.tab = id; renderTaskDrawer(); $(`#tab-${id}`).focus(); }, `drawer-tab ${id === tab ? 'active' : ''}`, { id: `tab-${id}`, role: 'tab', 'aria-selected': String(id === tab), 'aria-controls': 'task-tab-panel', tabindex: id === tab ? '0' : '-1' });
      item.addEventListener('keydown', event => {
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!direction) return; event.preventDefault();
        const next = names[(index + direction + names.length) % names.length][0];
        state.drawer.tab = next; renderTaskDrawer(); $(`#tab-${next}`).focus();
      });
      tabs.append(item);
    });
    const body = el('div', { class: 'dialog-body', id: 'task-tab-panel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` });
    if (context.truncated) body.append(notice('This context is bounded and was truncated by the daemon. Some related records may not be shown.', 'warning'));
    if (tab === 'overview') body.append(taskOverview(task, context));
    if (tab === 'intent') body.append(taskIntent(task, context));
    if (tab === 'workflow') body.append(taskWorkflow(task));
    $('#drawer-content').replaceChildren(header, tabs, body);
  }
  function taskOverview(task, context) {
    const owner = sessions().find(item => item.id === task.ownerSessionId);
    const intent = intentFromContext(context, task);
    const alerts = asArray(context.alerts).filter(alert => !alert.taskIds?.length || alert.taskIds.includes(task.id));
    const decisions = asArray(context.decisions);
    const result = el('div', {},
      el('section', { class: 'detail-section' }, el('div', { class: 'section-head' }, el('h3', {}, 'Ownership'), button('Reload task', () => openTask(task.id, state.drawer.tab), 'button-small button-quiet')),
        metadata([['Owner', sessionName(task.ownerSessionId)], ['Workspace', owner?.workspaceRoot || task.workspaceRoot || 'Not returned'], ['Feature', task.featureKey || 'Not set'], ['Revision', task.revision], ['Task ID', el('code', {}, task.id)]])),
      el('section', { class: 'detail-section' }, el('div', { class: 'section-head' }, el('h3', {}, 'Declared scope'), button('Edit intent', () => openIntent(task, context), 'button-small')),
        intent ? el('div', { class: 'two-columns' }, scopeGroup('Reads', intent.reads), scopeGroup('Writes', intent.writes)) : el('p', {}, 'No intent was returned for this task. Declare what it will read, write, and produce.')),
      el('section', { class: 'detail-section' }, el('h3', {}, `Alerts (${alerts.length})`), alerts.length ? alerts.map(alert => el('div', { class: 'related-item' }, badge(alert.severity), el('p', {}, alert.message || titleCase(alert.kind)), alert.evidence ? inspectDetails('Evidence', alert.evidence) : null, button('Review dismissal', () => openDismissAlert(alert), 'button-small button-quiet'))) : el('p', {}, 'No alerts in this task’s current context.')),
      el('section', { class: 'detail-section' }, el('h3', {}, 'Decisions in context'), decisions.length ? decisions.map(decision => el('div', { class: 'related-item' }, el('div', { class: 'item-title' }, link(decision.key, () => showDecision(decision)), badge(decision.status)), el('p', {}, pretty(decision.value)))) : el('p', {}, 'No decisions were returned in this task’s context.')));
    if (context.briefing) result.append(el('section', { class: 'detail-section' }, inspectDetails('Daemon briefing', context.briefing)));
    return result;
  }
  function scopeGroup(label, entries) {
    return el('div', {}, el('h4', {}, label), asArray(entries).length ? el('ul', { class: 'scope-list' }, entries.map(entry => el('li', {}, el('code', {}, pretty(entry))))) : el('p', { class: 'small muted space-top-sm' }, 'None declared'));
  }
  function taskIntent(task, context) {
    const intent = intentFromContext(context, task);
    return el('div', {}, el('section', { class: 'detail-section' }, el('div', { class: 'section-head' }, el('h3', {}, 'Intent declaration'), button('Replace intent', () => openIntent(task, context), 'button-small')),
      el('p', {}, 'Intent is a full declaration, not a patch. Saving replaces the existing criteria, scopes, contracts, and dependencies.'),
      intent ? el('div', { class: 'stack' }, ...['acceptanceCriteria', 'reads', 'writes', 'produces', 'consumes', 'dependencies'].map(key => scopeGroup({ acceptanceCriteria: 'Acceptance criteria', reads: 'Reads', writes: 'Writes', produces: 'Produces', consumes: 'Consumes', dependencies: 'Dependencies' }[key], intent[key]))) : notice('No intent was returned by the daemon. Use Replace intent to make this task’s scope explicit.')),
      inspectDetails('Full task context', context));
  }
  function taskWorkflow(task) {
    const terminal = ['integrated', 'abandoned'].includes(task.status);
    function action(title, description, label, fn, disabled = false) {
      return el('section', { class: 'workflow-action' }, el('h3', {}, title), el('p', {}, description), button(label, fn, '', { disabled }));
    }
    return el('div', {},
      notice('Actions use the revision shown above. If another agent changes this task, reload its detail before retrying a stale-revision error.'),
      action('Task state', 'Set active, blocked, or ready. Abandonment requires confirmation. Integration is recorded by the integration workflow, not set manually.', 'Change status', () => openTaskStatus(task), task.status === 'integrated'),
      action('Ownership handoff', 'Transfer ownership to another registered session in this project.', 'Hand off task', () => openHandoff(task), terminal),
      action('Workspace attachment', 'Update the task’s workspace bookkeeping. This does not move an agent; restart the agent in the chosen workspace.', 'Attach workspace', () => openAttachWorkspace(task), terminal),
      action('Submit committed work', 'The source workspace must be clean and its work committed. Submission captures a changeset; it does not integrate or approve it.', 'Submit changeset', () => openSubmission(task), terminal));
  }
  function openTaskStatus(task) {
    showForm({ title: 'Change task status', description: task.title, submit: 'Update status',
      build: body => {
        const status = select('status', ['active', 'blocked', 'ready', 'abandoned'].map(item => [item, titleCase(item)]), task.status);
        const confirmation = checkbox('abandon', 'I intend to abandon this task. This is not an integration or completion.', false); confirmation.hidden = status.value !== 'abandoned';
        status.addEventListener('change', () => { confirmation.hidden = status.value !== 'abandoned'; $('input', confirmation).required = !confirmation.hidden; });
        $('input', confirmation).required = !confirmation.hidden;
        body.append(field('Status', status), confirmation, el('p', { class: 'field-hint' }, `Expected task revision: ${task.revision}`));
      },
      onSubmit: form => {
        const status = value(form, 'status');
        if (status === 'abandoned' && !checked(form, 'abandon')) throw new Error('Confirm abandonment before continuing.');
        return post('/v1/tasks/update', { taskId: task.id, revision: revisionOf(task), status });
      }, onSuccess: () => afterChange('Task status updated.', task.id),
    });
  }
  function openHandoff(task) {
    const available = sessions().filter(session => session.id !== task.ownerSessionId);
    if (!available.length) { showInfo('No other owner is available', 'Register another session in this project before handing off this task.', [notice('A manual session can be registered when creating a new task. Tool sessions are registered by their adapters.')]); return; }
    showForm({ title: 'Hand off task', description: task.title, submit: 'Hand off task',
      build: body => body.append(metadata([['Current owner', sessionName(task.ownerSessionId)], ['Revision', task.revision]]), el('div', { class: 'divider' }), field('New owner', select('sessionId', available.map(item => [item.id, `${titleCase(item.tool)} / ${short(item.id)} — ${item.workspaceRoot}`])))),
      onSubmit: form => post('/v1/tasks/update', { taskId: task.id, revision: revisionOf(task), handoffSessionId: requiredText(form, 'sessionId', 'New owner') }), onSuccess: () => afterChange('Task handed off.', task.id),
    });
  }
  function openIntent(task, context) {
    const existing = intentFromContext(context, task) || {};
    const keys = ['acceptanceCriteria', 'reads', 'writes', 'produces', 'consumes', 'dependencies'];
    const initial = Object.fromEntries(keys.map(key => [key, asArray(existing[key])]));
    showForm({ title: 'Replace task intent', description: task.title, submit: 'Replace intent', wide: true,
      build: body => body.append(notice('This replaces the whole intent. Keep every criterion, scope, contract, and dependency you still need.', 'warning'), field('Intent JSON', textarea('intent', pretty(initial), { class: 'code-input', required: true, spellcheck: 'false', rows: '17' }), 'Each top-level field must be an array. Reads and writes are literal relative paths or directory prefixes, not globs. Contract versions and values are strings.'),
        inspectDetails('Example declaration (not submitted)', { acceptanceCriteria: ['Session renewal has a regression test'], reads: ['src/auth'], writes: ['src/auth/session.ts'], produces: [{ key: 'auth.session.contract', version: '1', value: 'Renewable opaque session' }], consumes: [], dependencies: [] }), el('p', { class: 'field-hint' }, `Expected task revision: ${task.revision}`)),
      onSubmit: form => {
        const intent = parseJSON(value(form, 'intent'), 'Intent');
        if (!intent || Array.isArray(intent) || typeof intent !== 'object') throw new Error('Intent must be a JSON object.');
        for (const key of keys) if (!Array.isArray(intent[key])) throw new Error(`Intent field “${key}” must be an array.`);
        const unknown = Object.keys(intent).filter(key => !keys.includes(key));
        if (unknown.length) throw new Error(`Unknown intent fields: ${unknown.join(', ')}.`);
        return post('/v1/intents', { taskId: task.id, revision: revisionOf(task), ...intent });
      }, onSuccess: () => afterChange('Task intent replaced.', task.id),
    });
  }
  async function openAttachWorkspace(task) {
    const { body, dialog } = openModal('Attach workspace', 'Loading registered workspaces…');
    body.append(loading('Loading workspaces…'));
    let workspaces;
    try { workspaces = asArray(await api(scoped('/v1/workspaces'))); }
    catch (error) { if (dialog.open && $('#modal-content').contains(body)) showActionError(error); return; }
    if (!dialog.open || !$('#modal-content').contains(body)) return;
    if (!workspaces.length) { showInfo('No workspace is available', 'Create or adopt a workspace in the Workspaces view, then return to this task.', [notice('Attaching a workspace only updates bookkeeping; it does not move a running agent.')]); return; }
    showForm({ title: 'Attach workspace', description: task.title, submit: 'Attach workspace',
      build: body => body.append(field('Workspace', select('workspaceId', workspaces.map(item => [item.id, `${item.branch || titleCase(item.kind)} — ${item.root}`]))), notice('This only updates bookkeeping. The running agent must restart in the selected workspace.', 'warning'), checkbox('acknowledge', 'I understand the agent must restart in the selected workspace.', true), el('p', { class: 'field-hint' }, `Expected task revision: ${task.revision}`)),
      onSubmit: form => post('/v1/workspaces/attach', { taskId: task.id, workspaceId: value(form, 'workspaceId'), revision: revisionOf(task) }), onSuccess: () => afterChange('Workspace attached. Restart the agent there.', task.id),
    });
  }
  function openSubmission(task) {
    showForm({ title: 'Submit changeset', description: task.title, submit: 'Submit changeset',
      build: body => body.append(notice('The task’s source workspace must be clean and committed. Submission records the changeset; preparing and approving integration are separate actions.'), metadata([['Task', task.id], ['Revision', task.revision], ['Owner', sessionName(task.ownerSessionId)]])),
      onSubmit: () => post('/v1/submissions', { taskId: task.id, revision: revisionOf(task) }),
      onSuccess: changeset => {
        toast('Changeset submitted.'); void refresh(true);
        showInfo('Changeset submitted', 'The work is recorded, not integrated. Prepare a candidate when you are ready to inspect it.', [jsonBox(changeset)], changeset?.id ? [button('Prepare candidate', () => openPrepare(changeset.id), 'button-primary')] : []);
        if (state.drawer?.id === task.id) void openTask(task.id, 'workflow');
      },
    });
  }

  function openProposeDecision() {
    const projectId = state.projectId;
    showForm({ title: 'Propose decision', description: 'Record a shared choice and why it should be made. Proposing does not accept it.', submit: 'Propose decision',
      build: body => body.append(field('Decision key', input('key', '', { required: true, placeholder: 'e.g. api.session-format' })), field('Version', input('version', 'v1', { required: true }), 'A contract version is a string, such as v1 or 1.'), field('Decision value', textarea('value', '', { required: true, spellcheck: 'false', placeholder: 'Use opaque tokens with explicit session renewal.' }), 'A plain-text string. You can write a serialized JSON contract here if needed; it is stored as text.'), field('Rationale', textarea('rationale', '', { required: true, placeholder: 'Explain the trade-off and who it affects.' })), field('Related task (optional)', select('taskId', [['', 'No specific task'], ...tasks().map(task => [task.id, task.title])]))),
      onSubmit: form => {
        const taskId = value(form, 'taskId');
        return post('/v1/decisions/propose', { projectId, key: requiredText(form, 'key', 'Decision key'), value: requiredText(form, 'value', 'Decision value'), version: requiredText(form, 'version', 'Version'), rationale: requiredText(form, 'rationale', 'Rationale'), ...(taskId ? { taskId } : {}) });
      }, onSuccess: () => afterChange('Decision proposed. It has not been accepted.'),
    });
  }
  function showDecision(decision) {
    showInfo(decision.key, 'Recorded decision', [metadata([['Decision ID', decision.id], ['Version', decision.version], ['Status', badge(decision.status)], ['Revision', decision.revision], ['Replaced by', decision.supersededBy || '—']]), el('div', {}, el('h3', {}, 'Value'), jsonBox(decision.value)), el('div', {}, el('h3', {}, 'Rationale'), el('p', { class: 'item-body' }, decision.rationale || 'Not provided'))], decision.status === 'proposed' ? [button('Review & accept', () => openAcceptDecision(decision), 'button-primary')] : []);
  }
  async function openAcceptDecision(decision) {
    const projectId = state.projectId;
    const { body, dialog } = openModal('Review decision acceptance', 'Checking the proposal and current accepted value…', true);
    body.append(loading('Loading current decisions…'));
    let decisions;
    try { decisions = asArray(await api(scoped('/v1/decisions', {}, projectId))); }
    catch (error) { if (dialog.open && $('#modal-content').contains(body)) showActionError(error); return; }
    if (!dialog.open || !$('#modal-content').contains(body)) return;
    const proposed = decisions.find(item => item.id === decision.id);
    if (!proposed || proposed.status !== 'proposed') throw new Error('This decision is no longer proposed. Refresh the Decisions view before continuing.');
    const accepted = decisions.find(item => item.key === proposed.key && item.status === 'accepted');
    showForm({ title: 'Accept this decision?', description: proposed.key, submit: 'Accept decision', wide: true,
      build: body => body.append(metadata([['Decision ID', proposed.id], ['Version', proposed.version], ['Revision', proposed.revision]]), el('div', { class: 'divider' }), el('h3', {}, 'Exact proposed value'), jsonBox(proposed.value), el('p', { class: 'item-body' }, proposed.rationale || 'No rationale provided.'), el('div', { class: 'divider' }),
        accepted ? el('div', { class: 'stack' }, notice('Accepting this proposal supersedes the currently accepted decision below.', 'warning'), metadata([['Replaces ID', accepted.id], ['Version', accepted.version]]), jsonBox(accepted.value)) : notice('No decision is currently accepted for this key. This proposal will become the accepted value.'), checkbox('confirm', 'Accept this exact decision and the replacement shown above.', true)),
      onSubmit: () => post('/v1/decisions/accept', { decisionId: proposed.id, revision: revisionOf(proposed), expectedAcceptedId: accepted?.id || null }), onSuccess: () => afterChange('Decision accepted.'),
    });
  }
  function openDismissAlert(alert) {
    const projectId = state.projectId;
    showForm({ title: 'Dismiss this alert?', description: titleCase(alert.kind), submit: 'Dismiss alert',
      build: body => body.append(el('p', {}, alert.message || 'Review the evidence for this alert.'), el('div', { class: 'divider' }), alert.evidence ? jsonBox(alert.evidence) : el('p', { class: 'muted' }, 'No additional evidence was returned.'), notice('Dismissal applies only to this alert’s current evidence. If the evidence changes, the alert can appear again.', 'warning'), checkbox('confirm', 'Dismiss this evidence-scoped alert.', true)),
      onSubmit: () => post('/v1/alerts/dismiss', { projectId, alertId: alert.id }),
      onSuccess: () => afterChange('Alert dismissed for its current evidence.', state.drawer?.id),
    });
  }
  function openCreateWorkspace() {
    const projectId = state.projectId;
    showForm({ title: 'Create workspace', description: 'Create an isolated workspace from a committed revision of this project.', submit: 'Create workspace',
      build: body => body.append(field('Base revision', input('baseRevision', 'HEAD', { required: true, spellcheck: 'false' }), 'A committed revision, branch, tag, or SHA. The default is HEAD.'), checkbox('allowDirtyBase', 'Start from committed revision; do not copy uncommitted files'), el('p', { class: 'field-hint' }, 'Unchecked by default: a dirty source repository blocks creation. Check only to allow using its committed revision while leaving uncommitted files behind.'), notice('Creating a workspace does not automatically attach it to a task or start an agent.')),
      onSubmit: form => post('/v1/workspaces/create', { projectId, baseRevision: requiredText(form, 'baseRevision', 'Base revision'), ...(checked(form, 'allowDirtyBase') ? { allowDirtyBase: true } : {}) }),
      onSuccess: workspace => { toast('Workspace created.'); void refresh(true); showInfo('Workspace created', 'Attach it from a task’s Actions tab when the agent is ready to restart there.', [jsonBox(workspace)]); },
    });
  }
  function openAdoptWorkspace() {
    const projectId = state.projectId;
    showForm({ title: 'Adopt existing workspace', description: 'Register a local checkout or worktree without moving its files.', submit: 'Adopt workspace',
      build: body => body.append(field('Workspace root', input('root', '', { required: true, placeholder: '/absolute/path/to/workspace', autocomplete: 'off' }), 'The daemon verifies the workspace belongs to the selected project.')),
      onSubmit: form => post('/v1/workspaces/adopt', { projectId, root: requiredText(form, 'root', 'Workspace root') }), onSuccess: () => afterChange('Workspace adopted.'),
    });
  }
  function reconcileWorkspaces() {
    const projectId = state.projectId;
    showForm({ title: 'Reconcile workspace metadata', description: 'Compare registered workspaces with the local repository and report bookkeeping changes.', submit: 'Reconcile workspaces',
      build: body => body.append(metadata([['Project', project()?.root || projectId]]), notice('This reconciles recorded workspace metadata. It is not a commit, merge, or integration approval.')),
      onSubmit: () => post('/v1/workspaces/reconcile', { projectId }),
      onSuccess: result => { toast('Workspace reconciliation complete.'); void refresh(true); showInfo('Reconciliation result', 'The daemon returned the following metadata.', [jsonBox(result)]); },
    });
  }
  function openPrepare(changesetId = '') {
    showForm({ title: 'Prepare integration candidate', description: 'Build an inspectable candidate from an existing submitted changeset. This does not approve integration.', submit: 'Prepare candidate',
      build: body => body.append(field('Changeset ID', input('changesetId', changesetId, { required: true, placeholder: 'UUID returned by task submission', spellcheck: 'false' }), 'Submit committed work from a task’s Actions tab to get a changeset ID.'), notice('The source checkout remains unchanged. Conflicts or failed preparation will be reported, never treated as success.')),
      onSubmit: form => post('/v1/integration/prepare', { changesetId: requiredText(form, 'changesetId', 'Changeset ID') }),
      onSuccess: async job => {
        toast('Preparation finished. Review the candidate’s state.'); void refresh(true);
        if (job?.id) await openJob(job.id); else showInfo('Preparation result', 'Inspect the state returned by the daemon.', [jsonBox(job)]);
      },
    });
  }
  function openValidationSettings() {
    const projectId = state.projectId;
    showForm({ title: 'Configure validation commands', description: 'These commands execute on this machine with your local-user privileges, not in a sandbox.', submit: 'Save validation configuration', wide: true,
      build: body => body.append(notice('Only configure commands you trust. Saving replaces the validation command list. Nothing is proposed or approved automatically.', 'warning'), field('Expected configuration revision', input('revision', '0', { type: 'number', min: '0', step: '1', required: true }), 'Use 0 for the initial configuration. There is no read endpoint yet; supply the current revision when replacing an existing configuration.'), field('Commands (JSON array)', textarea('commands', '[]', { class: 'code-input', required: true, rows: '10', spellcheck: 'false' }), 'Each command has a command string, an args array, and a timeoutMs number. An empty list means no checks are configured.'), inspectDetails('Example command shape (not submitted)', [{ command: 'npm', args: ['test'], timeoutMs: 30000 }]), checkbox('privileges', 'I have reviewed this exact command list and understand it runs with local-user privileges, not sandboxed.', true)),
      onSubmit: form => {
        const revision = Number(value(form, 'revision'));
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Configuration revision must be a non-negative whole number.');
        const commands = parseJSON(value(form, 'commands'), 'Commands');
        if (!Array.isArray(commands)) throw new Error('Commands must be a JSON array.');
        for (const command of commands) {
          if (!command || typeof command.command !== 'string' || !command.command.trim() || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string') || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) throw new Error('Each command needs a nonempty command string, a string args array, and a positive integer timeoutMs.');
        }
        if (!checked(form, 'privileges')) throw new Error('Acknowledge the local-user privileges before saving.');
        return post('/v1/validation/config', { projectId, revision, commands });
      },
      onSuccess: result => { toast('Validation configuration saved.'); showInfo('Validation configuration saved', 'Keep the returned revision for your next configuration update. No validation or approval was started.', [jsonBox(result)]); void refresh(true); },
    });
  }
  function jobFromInspection(inspection) {
    if (!inspection?.job || typeof inspection.job.id !== 'string') throw new Error('The daemon did not return an integration job inside the inspection response.');
    return inspection.job;
  }
  async function openJob(jobId) {
    const { body, dialog } = openModal(`Candidate ${short(jobId)}`, 'Loading integration inspection…', true);
    body.append(loading('Inspecting candidate…'));
    try {
      const inspection = await api(scoped('/v1/integration/job', { jobId }));
      if (dialog.open && $('#modal-content').contains(body)) showJob(jobFromInspection(inspection), inspection);
    } catch (error) {
      if (dialog.open && $('#modal-content').contains(body)) showInfo('Inspection unavailable', errorText(error), [], [button('Retry inspection', () => openJob(jobId), 'button-primary')]);
    }
  }
  function showJob(job, inspection = job) {
    const approval = approvalState(job);
    const canValidate = Boolean(job.candidateSha) && !['preparing', 'validating', 'conflicted', 'recovery_required', 'promoted', 'approved', 'integrated', 'completed', 'abandoned', 'cancelled'].includes(job.status);
    const actions = [button('Reload inspection', () => openJob(job.id)), button('Run validation', () => openValidateJob(job), '', { disabled: !canValidate }), button('Review approval', () => openApproveJob(job.id), 'button-primary', { disabled: !approval.allowed, title: approval.allowed ? 'Review the exact candidate before approval' : 'Approval requires an eligible candidate and passed or explicitly unverified validation.' })];
    const contents = [
      el('div', { class: 'action-row' }, badge(job.status), badge(approval.status, approval.label)),
      metadata([['Job ID', job.id], ['Target ref', job.targetRef], ['Source SHA', el('code', {}, job.sourceSha || '—')], ['Target SHA', el('code', {}, job.targetSha || '—')], ['Candidate SHA', el('code', {}, job.candidateSha || '—')], ['Candidate root', el('code', {}, job.candidateRoot || '—')]]),
      !approval.allowed ? notice(approval.failed ? 'Validation failed. Failed checks cannot be bypassed with a no-checks acknowledgement. Correct the candidate and rerun the appropriate workflow.' : 'Approval is unavailable in this state. A candidate must be prepared with explicit passed or unverified validation; invalidated, conflicting, in-progress, and terminal states are blocked.', 'warning') : notice('Review validation and exact SHAs before approval. The source checkout remains unchanged.'),
      el('div', {}, el('h3', {}, 'Validation record'), jsonBox(job.validation || { status: 'not returned' })),
      inspectDetails('Bounded inspection and job metadata', inspection),
    ];
    showInfo(`Candidate ${short(job.id)}`, 'Inspect first. Validate next. Approve explicitly.', contents, actions);
  }
  function openValidateJob(job) {
    showForm({ title: 'Run candidate validation', description: 'Run the project’s configured commands against this candidate.', submit: 'Run validation',
      build: body => body.append(metadata([['Job', job.id], ['Candidate SHA', el('code', {}, job.candidateSha)], ['Target SHA', el('code', {}, job.targetSha)]]), el('div', { class: 'divider' }), notice('Configured commands run with local-user privileges, not sandboxed. Validation does not approve or promote the candidate.', 'warning'), checkbox('privileges', 'Run the configured local commands for this candidate.', true)),
      onSubmit: () => post('/v1/integration/validate', { jobId: job.id }),
      onSuccess: result => { toast('Validation finished. Review the reported checks.'); void refresh(true); showJob(result); },
    });
  }
  async function openApproveJob(jobId) {
    const { body, dialog } = openModal('Review candidate approval', 'Checking the current candidate and target SHAs…', true);
    body.append(loading('Loading exact candidate…'));
    let job, inspection;
    try { inspection = await api(scoped('/v1/integration/job', { jobId })); job = jobFromInspection(inspection); }
    catch (error) { if (dialog.open && $('#modal-content').contains(body)) showActionError(error); return; }
    if (!dialog.open || !$('#modal-content').contains(body)) return;
    const approval = approvalState(job);
    if (!approval.allowed) { showJob(job, inspection); return; }
    const unverified = job.validation?.status === 'unverified';
    showForm({ title: 'Approve this exact candidate?', description: 'Approval advances the recorded target to the candidate shown below.', submit: 'Approve candidate', wide: true,
      build: body => body.append(metadata([['Job ID', job.id], ['Target ref', job.targetRef], ['Current target SHA', job.targetSha], ['Candidate SHA', job.candidateSha], ['Source SHA', job.sourceSha]], 'approval-shas'), badge(approval.status, approval.label), notice('The source checkout remains unchanged. The server rechecks candidate and target SHAs; a changed target requires a fresh review.', 'warning'),
        unverified ? checkbox('noChecks', 'I acknowledge that this candidate has no verified checks and explicitly approve it without them.', true) : el('p', { class: 'field-hint' }, 'The daemon reports passing checks for this validation record.'), checkbox('confirm', 'Approve the exact candidate SHA and target SHA shown above.', true), inspectDetails('Validation being reviewed', job.validation)),
      onSubmit: form => {
        if (unverified && !checked(form, 'noChecks')) throw new Error('Explicitly acknowledge the unverified candidate before approval.');
        return post('/v1/integration/approve', { jobId: job.id, candidateSha: job.candidateSha, targetSha: job.targetSha, ...(unverified ? { acknowledgeNoChecks: true } : {}) });
      },
      onSuccess: result => { toast('Approval request completed. Review the resulting integration state.'); void refresh(true); showJob(result); },
    });
  }

  document.querySelectorAll('[data-page]').forEach(item => item.addEventListener('click', () => navigate(item.dataset.page)));
  $('#brand-link').addEventListener('click', event => { event.preventDefault(); navigate('tasks'); });
  $('#project-select').addEventListener('change', event => { void selectProject(event.target.value).catch(showPageError); });
  $('#register-project').addEventListener('click', openRegisterProject);
  $('#refresh').addEventListener('click', () => { void refresh(); });
  $('#menu-toggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    $('#menu-toggle').setAttribute('aria-expanded', String(open)); $('#menu-toggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); $('#menu-toggle').setAttribute('aria-label', 'Open navigation'); $('#menu-toggle').focus(); }
  });
  $('#modal').addEventListener('cancel', event => { if ($('#modal').dataset.busy === 'true') event.preventDefault(); });
  $('#drawer').addEventListener('close', () => { state.drawer = null; });
  $('#modal').addEventListener('close', () => { state.enrollmentEditor = null; });
  window.addEventListener('hashchange', () => {
    const params = new URLSearchParams(location.hash.slice(1));
    const reference = publicRequestReference(params.get('request'));
    if (!params.has('request')) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (reference) { pendingRequestId = reference; if (state.token) focusPublicRequest(); else signOut(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) refreshSoon(100); });

  async function boot() {
    if (!bootstrapCode) { signOut(); return; }
    setConnection('Signing in…');
    try {
      const auth = await api('/v1/browser/bootstrap', { method: 'POST', body: { code: bootstrapCode }, bootstrap: true });
      bootstrapCode = null;
      if (typeof auth?.token !== 'string' || !auth.token) throw new Error('The daemon did not return a browser session.');
      state.token = auth.token;
      const expires = typeof auth.expiresAt === 'number' ? auth.expiresAt : Date.parse(auth.expiresAt);
      if (Number.isFinite(expires)) state.expiryTimer = setTimeout(() => signOut('Your browser session has expired.'), Math.max(0, Math.min(expires - Date.now(), 2147483647)));
      $('#register-project').disabled = false; $('#refresh').disabled = false;
      await loadProjects();
      if (pendingRequestId) state.page = 'connections';
      await selectProject(state.projects[0]?.id || '');
      if (pendingRequestId) focusPublicRequest();
      if (!state.projectId) setConnection('Connected', 'good');
    } catch (error) { signOut(`Could not open this browser session. ${error.message} ${authInstruction}`); } finally { bootstrapCode = null; }
  }
  void boot();
})();
