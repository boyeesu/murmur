(() => {
  'use strict';

  // Consume the one-use code before making requests. Never put credentials in storage.
  let bootstrapCode = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = {
    token: null, projectId: '', projects: [], page: 'tasks', data: {},
    search: '', filter: '', loaded: false, refreshing: false, queued: false,
    generation: 0, drawer: null, lastUpdated: null, expiryTimer: null,
    stream: null, streamTimer: null, pollTimer: null, refreshTimer: null,
    streamGeneration: 0, cursors: new Map(), reconnectAttempt: 0,
  };
  const pages = {
    tasks: ['Tasks', 'Keep ownership clear. See what is ready to move.'],
    alerts: ['Alerts', 'Resolve coordination conflicts before they become rework.'],
    decisions: ['Decisions', 'A shared record of what the team has agreed to.'],
    workspaces: ['Workspaces', 'Give each task a clear place to work.'],
    integration: ['Integration', 'Inspect and validate candidates before advancing the target.'],
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
    if (options.method === 'POST') headers['Idempotency-Key'] = uuid();
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
    $('#project-select').disabled = true; $('#register-project').disabled = true; $('#refresh').disabled = true;
    $('#page-actions').replaceChildren(); $('#page-error').hidden = true;
    setConnection('Not connected');
    const view = empty('Open a secure dashboard session', reason || 'Connect this browser to the Murmur daemon running on your machine.', [], '↗');
    view.append(el('code', { class: 'command' }, 'npm run murmur -- dashboard'), el('p', {}, 'Open the one-use URL printed by the command. Refreshing this page requires a new URL.'), el('p', { class: 'small space-top' }, 'Credentials stay in this tab’s memory. No account or external service is needed.'));
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
  }
  function refreshSoon(delay = 300) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => { if (state.token) void refresh(true); }, delay);
  }
  async function refresh(quiet = false) {
    if (!state.token) return;
    if (state.refreshing) { state.queued = true; return; }
    if (!state.projectId) { state.loaded = true; renderPage(); return; }
    state.refreshing = true; $('#refresh').disabled = true;
    const generation = state.generation, page = state.page, projectId = state.projectId;
    if (!state.loaded && !quiet) $('#page-content').replaceChildren(loading());
    const requests = [['status', scoped('/v1/status', {}, projectId)], ['alerts', scoped('/v1/alerts', {}, projectId)]];
    if (endpoints[page]) requests.push([page, scoped(endpoints[page], {}, projectId)]);
    try {
      const results = await Promise.allSettled(requests.map(([, path]) => api(path)));
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
      if (page === state.page) renderContent();
    } finally {
      state.refreshing = false; $('#refresh').disabled = !state.token;
      if (state.queued) { state.queued = false; refreshSoon(100); }
    }
  }
  function updateCounts() {
    const counts = { tasks: tasks().length, alerts: state.data.alerts?.length, decisions: state.data.decisions?.length, workspaces: state.data.workspaces?.length, integration: state.data.integration?.length, adapters: state.data.adapters?.length };
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
    renderPage(); if (state.token && state.projectId) void refresh();
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
    if (!state.projectId) {
      content.replaceChildren(empty('Register your first project', 'Choose a local repository to coordinate tasks, decisions, and integration across your agents.', [button('Register project', openRegisterProject, 'button-primary')], '▱'));
      return;
    }
    if (!state.loaded) { content.replaceChildren(loading()); return; }
    const dataKey = state.page === 'tasks' ? 'status' : state.page;
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
    const renderers = { tasks: renderTasks, alerts: renderAlerts, decisions: renderDecisions, workspaces: renderWorkspaces, integration: renderIntegration, adapters: renderAdapters };
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
    const available = sessions(); let createdSession;
    showForm({ title: 'New task', description: 'Give this work a clear owner before declaring its scope.', submit: 'Create task',
      build: body => {
        const owner = select('sessionId', [['__manual__', 'Create a manual session'], ...available.map(item => [item.id, `${titleCase(item.tool)} / ${short(item.id)} — ${item.workspaceRoot}`])], available[0]?.id || '__manual__');
        const workspace = input('workspaceRoot', project()?.root || '', { required: !available.length, autocomplete: 'off' });
        const manualFields = el('div', { hidden: available.length > 0 }, field('Manual session workspace', workspace, 'Registering a manual session does not launch or verify an agent.'));
        owner.addEventListener('change', () => { manualFields.hidden = owner.value !== '__manual__'; workspace.required = !manualFields.hidden; });
        body.append(field('Task title', input('title', '', { required: true, maxlength: '500', placeholder: 'Describe a concrete piece of work' })), field('Feature key (optional)', input('featureKey', '', { placeholder: 'e.g. auth/session-renewal' }), 'Group related tasks with a stable key.'), field('Owner', owner), manualFields);
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
      await selectProject(state.projects[0]?.id || '');
      if (!state.projectId) setConnection('Connected', 'good');
    } catch (error) { signOut(`Could not open this browser session. ${error.message} ${authInstruction}`); } finally { bootstrapCode = null; }
  }
  void boot();
})();
