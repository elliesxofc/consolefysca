// FYSC Console — private mobile admin for the fysca board.
// Talks only to the token-gated /admin/api routes in fysca/adminApi.js.
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const POLL_MS = 5000;
  const CID_PATTERN = /UC[\w-]{22}/;
  const KEYS = {
    base: 'fysc.apiBase',
    token: 'fysc.token',
    expiresAt: 'fysc.expiresAt',
    tab: 'fysc.tab',
    subHistory: 'fysc.subcountHistory'
  };

  // ---------------------------------------------------------------- utils

  // Storage can throw (private mode, blocked site data); the app still has
  // to work, it just won't remember anything between launches.
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  };

  const $ = (id) => document.getElementById(id);

  // Builds an element. Children are appended as text nodes unless they're
  // already nodes, so data from the server is never parsed as HTML.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function setText(el, text) {
    text = String(text);
    if (el.textContent !== text) el.textContent = text;
  }

  const fullNumber = new Intl.NumberFormat();
  const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

  function formatGain(n) {
    if (!n) return '0/day';
    return (n > 0 ? '+' : '−') + compactNumber.format(Math.abs(n)) + '/day';
  }

  function gainClass(n) {
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  }

  function formatDateTime(ms) {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  function formatCountdown(ms) {
    const mins = Math.round((ms - Date.now()) / 60000);
    if (mins < 1) return 'any moment';
    if (mins < 60) return `in ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h ${mins % 60}m`;
    return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function formatAgo(ms) {
    const secs = Math.round((Date.now() - ms) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    return `${Math.floor(secs / 60)}m ago`;
  }

  // Accepts "1,000,000", "1 000 000", etc. Returns null if it isn't a whole
  // number (the server checks again; this just catches typos sooner).
  function parseWholeNumber(value, { allowNegative = false } = {}) {
    const cleaned = String(value).replace(/[\s,_]/g, '');
    const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
    if (!pattern.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isSafeInteger(n) ? n : null;
  }

  // "yyyy-MM-ddTHH:mm" in local time, which is what datetime-local wants.
  function toLocalInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function normalizeBase(value) {
    let base = String(value || '').trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base;
  }

  // ---------------------------------------------------------------- state

  const state = {
    base: storage.get(KEYS.base) || normalizeBase((window.FYSC_CONFIG || {}).apiBase),
    token: storage.get(KEYS.token),
    expiresAt: Number(storage.get(KEYS.expiresAt)) || 0,
    overview: null,
    lastSync: 0,
    online: null, // null until the first poll finishes
    pollTimer: null,
    polling: false,
    pollAgain: false,
    announceWhen: 'now'
  };

  // ---------------------------------------------------------------- api

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    let response;
    try {
      response = await fetch(state.base + '/admin/api' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store'
      });
    } catch (e) {
      throw new ApiError('Can’t reach the server.', 0);
    }

    let data = null;
    try { data = await response.json(); } catch (e) { /* non-JSON body */ }

    if (response.status === 401 && path !== '/login') {
      signOut('Your session ended. Sign in again.');
      throw new ApiError('Signed out.', 401);
    }
    if (!response.ok) {
      const message = (data && data.error)
        || (response.status === 404 ? 'This server doesn’t have the console API yet.' : `Server error (${response.status}).`);
      throw new ApiError(message, response.status);
    }
    return data;
  }

  // ---------------------------------------------------------------- toasts

  function toast(message, type = 'info') {
    const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
    $('toasts').append(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }, type === 'error' ? 4500 : 3000);
  }

  // Swaps a button to a spinner + label while fn runs, and puts it back
  // afterwards whether fn succeeded or not. Returns fn's result.
  async function withBusy(btn, label, fn) {
    if (btn.disabled) return null;
    const original = Array.from(btn.childNodes);
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spinner' }), label);
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.replaceChildren(...original);
    }
  }

  // Runs one admin action from a button: busy state, success/failure toast,
  // and an immediate re-poll so every screen reflects the change.
  function runAction(btn, { busy, request, success, failure }) {
    return withBusy(btn, busy, async () => {
      try {
        const data = await request();
        if (success) toast(typeof success === 'function' ? success(data) : success, 'success');
        requestPoll();
        return data;
      } catch (e) {
        if (e.status !== 401) toast(`${failure}: ${e.message}`, 'error');
        return null;
      }
    });
  }

  // ---------------------------------------------------------------- sheets

  // Bottom sheets stack (a confirm can open on top of a channel sheet).
  // Each one pushes a history entry so Android's back button closes the
  // sheet instead of leaving the app.
  const sheetStack = [];
  // Counts the history.back() calls we made ourselves, whose popstate
  // events shouldn't close another sheet.
  let ownPops = 0;

  function openSheet(content, { onClose } = {}) {
    const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'sheet-grabber' }), content);
    const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
    const entry = { backdrop, onClose };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeSheet(entry);
    });
    sheetStack.push(entry);
    $('sheetRoot').append(backdrop);
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => backdrop.classList.add('open'));
    history.pushState({ fyscSheet: true }, '');
    return entry;
  }

  function closeSheet(entry = sheetStack[sheetStack.length - 1], { fromHistory = false } = {}) {
    const index = sheetStack.indexOf(entry);
    if (index === -1) return;
    sheetStack.splice(index, 1);
    entry.backdrop.classList.remove('open');
    setTimeout(() => entry.backdrop.remove(), 220);
    if (!sheetStack.length) document.body.classList.remove('sheet-open');
    if (!fromHistory) {
      ownPops += 1;
      history.back();
    }
    if (entry.onClose) entry.onClose();
  }

  window.addEventListener('popstate', () => {
    if (ownPops > 0) {
      ownPops -= 1;
      return;
    }
    if (sheetStack.length) closeSheet(undefined, { fromHistory: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetStack.length) closeSheet();
  });

  function confirmSheet({ title, message, confirmLabel, danger = false }) {
    return new Promise((resolve) => {
      let confirmed = false;
      const entry = openSheet(
        h('div', { class: 'sheet-body' },
          h('h2', { class: 'sheet-title' }, title),
          message && h('p', { class: 'sheet-text' }, message),
          h('div', { class: 'sheet-actions' },
            h('button', {
              class: `btn block ${danger ? 'danger-solid' : 'primary'}`,
              type: 'button',
              onclick: () => { confirmed = true; closeSheet(entry); }
            }, confirmLabel),
            h('button', { class: 'btn block ghost', type: 'button', onclick: () => closeSheet(entry) }, 'Cancel'))),
        { onClose: () => resolve(confirmed) });
    });
  }

  // ---------------------------------------------------------------- polling

  async function poll() {
    if (!state.token) return;
    if (state.polling) {
      state.pollAgain = true;
      return;
    }
    state.polling = true;
    try {
      state.overview = await api('/overview');
      state.lastSync = Date.now();
      setOnline(true);
      renderAll();
    } catch (e) {
      if (e.status !== 401) setOnline(false);
    } finally {
      state.polling = false;
      if (state.pollAgain) {
        state.pollAgain = false;
        poll();
      }
    }
  }

  // Re-polls right away (or right after an in-flight poll finishes), so an
  // action's result shows up without waiting for the next 5s tick.
  function requestPoll() {
    poll();
  }

  function startPolling() {
    stopPolling();
    poll();
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token) poll();
  });

  function setOnline(online) {
    if (state.online !== false && online === false) toast('Lost connection to the server. Retrying…', 'error');
    if (state.online === false && online === true) toast('Back online', 'success');
    state.online = online;
    renderStatus();
  }

  function renderStatus() {
    const pill = $('statusPill');
    if (state.online === null) {
      pill.dataset.state = 'connecting';
      setText($('statusText'), 'Connecting…');
    } else if (state.online) {
      pill.dataset.state = 'online';
      setText($('statusText'), 'Live · ' + formatAgo(state.lastSync));
    } else {
      pill.dataset.state = 'offline';
      setText($('statusText'), 'Offline');
    }
  }

  // ---------------------------------------------------------------- channel rows

  // Rows are kept per channel and moved/updated in place on every poll,
  // rather than rebuilt, so avatars don't reload and taps don't get lost.
  const homeRows = new Map();
  const channelRows = new Map();

  function createChannelRow(cid) {
    const parts = {
      rank: h('span', { class: 'row-rank' }),
      avatar: h('span', { class: 'avatar' }),
      name: h('span', { class: 'row-name' }),
      subs: h('span', { class: 'row-subs' }),
      gain: h('span', { class: 'gain' })
    };
    const row = h('button', { class: 'row', type: 'button', onclick: () => openChannelSheet(cid) },
      parts.rank, parts.avatar, h('span', { class: 'row-main' }, parts.name, parts.subs), parts.gain);
    row.parts = parts;
    return row;
  }

  function setAvatar(el, channel) {
    const initial = channel.name.trim().charAt(0).toUpperCase() || '?';
    const key = channel.image + '|' + initial;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(initial);
    if (/^https?:\/\//i.test(channel.image)) {
      const img = h('img', { src: channel.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
      // The initial letter underneath shows through if the image 404s.
      img.addEventListener('error', () => img.remove());
      el.append(img);
    }
  }

  function renderRows(container, channels, cache) {
    const seen = new Set();
    const rows = channels.map((channel) => {
      seen.add(channel.cid);
      let row = cache.get(channel.cid);
      if (!row) {
        row = createChannelRow(channel.cid);
        cache.set(channel.cid, row);
      }
      const { parts } = row;
      setText(parts.rank, String(channel.rank).padStart(2, '0'));
      setText(parts.name, channel.name);
      setText(parts.subs, fullNumber.format(channel.subs));
      setText(parts.gain, formatGain(channel.gain));
      parts.gain.className = 'gain ' + gainClass(channel.gain);
      setAvatar(parts.avatar, channel);
      return row;
    });
    for (const cid of cache.keys()) {
      if (!seen.has(cid)) cache.delete(cid);
    }
    replaceChildrenIfChanged(container, rows);
  }

  // Only touches the DOM when the order actually changed. Re-inserting a
  // row that's mid-tap can make the browser drop the tap.
  function replaceChildrenIfChanged(container, nodes) {
    const current = container.children;
    let same = current.length === nodes.length;
    for (let i = 0; same && i < nodes.length; i++) same = current[i] === nodes[i];
    if (!same) container.replaceChildren(...nodes);
  }

  function findChannel(cid) {
    return state.overview ? state.overview.channels.find((c) => c.cid === cid) : null;
  }

  // ---------------------------------------------------------------- render

  function renderAll() {
    if (!state.overview) return;
    renderHome();
    renderChannels();
    renderAnnounce();
    updateChannelSheet();
    renderStatus();
  }

  function liveAnnouncement() {
    const current = state.overview && state.overview.announcement;
    return current && current.message ? current.message : '';
  }

  function renderHome() {
    const { channels, scheduled } = state.overview;
    const live = liveAnnouncement();
    $('homeAnnLive').classList.toggle('active', !!live);
    setText($('homeAnnLiveText'), live ? 'Live on the boards' : 'No announcement live');
    $('homeAnnMessage').hidden = !live;
    setText($('homeAnnMessage'), live);
    const next = scheduled[0];
    $('homeAnnNext').hidden = !next;
    if (next) setText($('homeAnnNext'), `Next: ${formatDateTime(next.sendAt)} (${formatCountdown(next.sendAt)})`);

    setText($('tileChannels'), fullNumber.format(channels.length));
    setText($('tileScheduled'), fullNumber.format(scheduled.length));
    const topGainer = channels.reduce((best, c) => (!best || c.gain > best.gain ? c : best), null);
    setText($('tileTopGainer'), topGainer ? topGainer.name : '–');
    setText($('tileTopGainerGain'), topGainer ? formatGain(topGainer.gain) : '');

    renderRows($('homeTopList'), channels.slice(0, 10), homeRows);
  }

  function renderChannels() {
    const { channels } = state.overview;
    const needle = $('channelSearch').value.trim().toLowerCase();
    const filtered = needle
      ? channels.filter((c) => c.name.toLowerCase().includes(needle)
          || c.originalName.toLowerCase().includes(needle)
          || c.cid.toLowerCase().includes(needle))
      : channels;
    renderRows($('channelList'), filtered, channelRows);
    $('channelEmpty').hidden = filtered.length > 0 || channels.length === 0;
    setText($('channelCount'), needle
      ? `${filtered.length} of ${channels.length} channels`
      : `${channels.length} channels, ranked by subscribers`);
  }

  const scheduledRows = new Map();

  function renderAnnounce() {
    const live = liveAnnouncement();
    $('annLive').classList.toggle('active', !!live);
    setText($('annLiveText'), live ? `Live: “${live}”` : 'No announcement live');
    $('annTakeDown').hidden = !live;

    const { scheduled } = state.overview;
    const seen = new Set();
    const rows = scheduled.map((item) => {
      seen.add(item.id);
      let row = scheduledRows.get(item.id);
      if (!row) {
        const time = h('div', { class: 'sched-time' });
        const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'Cancel');
        cancel.addEventListener('click', () => cancelScheduled(item, cancel));
        row = h('div', { class: 'sched-row' },
          h('div', { class: 'sched-info' }, time, h('div', { class: 'sched-message' }, item.message)),
          cancel);
        row.time = time;
        scheduledRows.set(item.id, row);
      }
      setText(row.time, `${formatDateTime(item.sendAt)} · ${formatCountdown(item.sendAt)}`);
      return row;
    });
    for (const id of scheduledRows.keys()) {
      if (!seen.has(id)) scheduledRows.delete(id);
    }
    replaceChildrenIfChanged($('scheduledList'), rows);
    $('scheduledEmpty').hidden = rows.length > 0;
  }

  function renderSettings() {
    setText($('settingsServer'), state.base || '–');
    setText($('settingsExpiry'), state.expiresAt ? formatDateTime(state.expiresAt) : '–');
    renderInstall();
  }

  // ---------------------------------------------------------------- tabs

  const TABS = ['home', 'channels', 'announce', 'settings'];

  function showTab(tab) {
    if (!TABS.includes(tab)) tab = 'home';
    storage.set(KEYS.tab, tab);
    for (const name of TABS) $('view-' + name).hidden = name !== tab;
    document.querySelectorAll('.tabbar button').forEach((btn) => {
      btn.setAttribute('aria-current', btn.dataset.tab === tab ? 'page' : 'false');
    });
    setText($('viewTitle'), $('view-' + tab).dataset.title);
    if (tab === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- channel sheet

  let channelSheet = null; // { cid, entry, parts }

  function subHistory() {
    try { return JSON.parse(storage.get(KEYS.subHistory) || '{}'); } catch (e) { return {}; }
  }

  function setSubHistory(cid, value) {
    const history = subHistory();
    if (value === undefined) delete history[cid];
    else history[cid] = value;
    storage.set(KEYS.subHistory, JSON.stringify(history));
  }

  function openChannelSheet(cid) {
    const channel = findChannel(cid);
    if (!channel) return;

    const parts = {
      avatar: h('span', { class: 'avatar lg' }),
      title: h('h2', { class: 'sheet-title' }),
      original: h('p', { class: 'sheet-sub' }),
      subs: h('span', { class: 'stat-value' }),
      gain: h('span', { class: 'stat-value' }),
      rank: h('span', { class: 'stat-value' }),
      resetName: h('button', { class: 'btn ghost small', type: 'button' }, 'Use original name'),
      revert: h('button', { class: 'btn ghost small', type: 'button' })
    };

    const nameInput = h('input', { type: 'text', maxLength: 60, placeholder: 'New display name', autocomplete: 'off' });
    const nameSave = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const renameForm = h('form', { class: 'action' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Display name'),
        h('div', { class: 'input-row' }, nameInput, nameSave)),
      parts.resetName);
    renameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        toast('Type a name first.', 'error');
        nameInput.focus();
        return;
      }
      renameChannel(cid, name, nameSave).then((ok) => { if (ok) nameInput.value = ''; });
    });
    parts.resetName.addEventListener('click', () => renameChannel(cid, '', parts.resetName));

    const subsInput = h('input', { type: 'text', inputMode: 'numeric', placeholder: 'e.g. 1,000,000', autocomplete: 'off' });
    const subsSave = h('button', { class: 'btn primary', type: 'submit' }, 'Set');
    const subsForm = h('form', { class: 'action' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Subscriber count'),
        h('div', { class: 'input-row' }, subsInput, subsSave)),
      parts.revert);
    subsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const count = parseWholeNumber(subsInput.value);
      if (count === null) {
        toast('Enter a whole number, like 1000000.', 'error');
        subsInput.focus();
        return;
      }
      setSubcount(cid, count, subsSave).then((ok) => { if (ok) subsInput.value = ''; });
    });
    parts.revert.addEventListener('click', () => {
      const previous = subHistory()[cid];
      if (previous !== undefined) setSubcount(cid, previous, parts.revert, { reverting: true });
    });

    const gainInput = h('input', { type: 'text', inputMode: 'numeric', placeholder: 'Subs per day', autocomplete: 'off' });
    const gainSave = h('button', { class: 'btn primary', type: 'submit' }, 'Set');
    const signToggle = h('button', { class: 'btn icon-btn', type: 'button', 'aria-label': 'Make negative or positive' }, '±');
    signToggle.addEventListener('click', () => {
      const v = gainInput.value.trim();
      gainInput.value = v.startsWith('-') ? v.slice(1) : '-' + v;
      gainInput.focus();
    });
    const chips = h('div', { class: 'chips' },
      [0, 1000, 10000, 100000, 1000000].map((n) => h('button', {
        class: 'chip',
        type: 'button',
        onclick: () => { gainInput.value = fullNumber.format(n); }
      }, n ? compactNumber.format(n) : '0')));
    const gainForm = h('form', { class: 'action' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Growth per day'),
        h('div', { class: 'input-row' }, gainInput, signToggle, gainSave)),
      chips,
      h('p', { class: 'hint' }, 'Growth can be glitchy on the board, same as on the web panel.'));
    gainForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const gain = parseWholeNumber(gainInput.value, { allowNegative: true });
      if (gain === null) {
        toast('Enter a whole number, like 5000.', 'error');
        gainInput.focus();
        return;
      }
      setGrowth(cid, gain, gainSave).then((ok) => { if (ok) gainInput.value = ''; });
    });

    const removeBtn = h('button', { class: 'btn danger block', type: 'button' }, 'Remove from board');
    removeBtn.addEventListener('click', () => removeChannel(cid, removeBtn));

    const cidChip = h('button', { class: 'cid-chip', type: 'button', 'aria-label': 'Copy channel ID' }, cid);
    cidChip.addEventListener('click', () => copyText(cid));

    const content = h('div', { class: 'sheet-body' },
      h('div', { class: 'channel-head' },
        parts.avatar,
        h('div', { class: 'channel-head-text' }, parts.title, parts.original, cidChip)),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Subs'), parts.subs),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Growth'), parts.gain),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Rank'), parts.rank)),
      renameForm,
      subsForm,
      gainForm,
      h('div', { class: 'action' }, removeBtn));

    const entry = openSheet(content, { onClose: () => { channelSheet = null; } });
    channelSheet = { cid, entry, parts };
    updateChannelSheet();
  }

  // Keeps an open channel sheet's numbers live as polls come in. Inputs are
  // left alone so nothing you're typing gets overwritten.
  function updateChannelSheet() {
    if (!channelSheet) return;
    const channel = findChannel(channelSheet.cid);
    if (!channel) return;
    const { parts } = channelSheet;
    setText(parts.title, channel.name);
    parts.original.hidden = !channel.renamed;
    setText(parts.original, `Originally “${channel.originalName}”`);
    parts.resetName.hidden = !channel.renamed;
    setText(parts.subs, fullNumber.format(channel.subs));
    setText(parts.gain, formatGain(channel.gain));
    setText(parts.rank, '#' + channel.rank);
    setAvatar(parts.avatar, channel);

    const previous = subHistory()[channel.cid];
    parts.revert.hidden = previous === undefined;
    if (previous !== undefined) setText(parts.revert, `Undo: back to ${fullNumber.format(previous)}`);
  }

  function copyText(text) {
    if (!navigator.clipboard) {
      toast('Copying isn’t available here.', 'error');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toast('Copied', 'success'),
      () => toast('Couldn’t copy.', 'error'));
  }

  // ---------------------------------------------------------------- actions

  const channelPath = (cid, action) => `/channels/${encodeURIComponent(cid)}/${action}`;

  async function renameChannel(cid, name, btn) {
    const data = await runAction(btn, {
      busy: 'Saving',
      request: () => api(channelPath(cid, 'rename'), { method: 'POST', body: { name } }),
      success: name ? 'Renamed' : 'Back to the original name',
      failure: 'Couldn’t rename'
    });
    return !!data;
  }

  async function setSubcount(cid, count, btn, { reverting = false } = {}) {
    const data = await runAction(btn, {
      busy: reverting ? 'Reverting' : 'Setting',
      request: () => api(channelPath(cid, 'subcount'), { method: 'POST', body: { count } }),
      success: (d) => (reverting ? 'Reverted to ' : 'Set to ') + fullNumber.format(d.current),
      failure: reverting ? 'Couldn’t revert' : 'Couldn’t set the count'
    });
    if (!data) return false;
    // Remember what it was before this change so it can be undone later,
    // even after closing the app. A revert has nothing left to undo.
    setSubHistory(cid, reverting ? undefined : data.previous);
    updateChannelSheet();
    return true;
  }

  async function setGrowth(cid, gain, btn) {
    const data = await runAction(btn, {
      busy: 'Setting',
      request: () => api(channelPath(cid, 'growth'), { method: 'POST', body: { gain } }),
      success: (d) => 'Growth set to ' + formatGain(d.gain),
      failure: 'Couldn’t set growth'
    });
    return !!data;
  }

  async function removeChannel(cid, btn) {
    const channel = findChannel(cid);
    const ok = await confirmSheet({
      title: `Remove ${channel ? channel.name : 'this channel'}?`,
      message: 'Its count and growth drop to 0, so it falls off the bottom of the board. Same as Remove on the web panel.',
      confirmLabel: 'Remove',
      danger: true
    });
    if (!ok) return;
    const data = await runAction(btn, {
      busy: 'Removing',
      request: () => api(channelPath(cid, 'remove'), { method: 'POST' }),
      success: 'Removed from the board',
      failure: 'Couldn’t remove'
    });
    if (data && channelSheet && channelSheet.cid === cid) closeSheet(channelSheet.entry);
  }

  function openAddChannelSheet() {
    const input = h('input', {
      type: 'text',
      placeholder: 'UC… or a channel link',
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off'
    });
    input.spellcheck = false;
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Add to board');
    const form = h('form', { class: 'sheet-body' },
      h('h2', { class: 'sheet-title' }, 'Add a channel'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Channel ID'), input),
      h('p', { class: 'hint' }, 'Paste a UC… ID or a youtube.com/channel/… link.'),
      submit);
    const entry = openSheet(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const match = input.value.match(CID_PATTERN);
      if (!match) {
        toast('That doesn’t contain a channel ID (UC + 22 characters).', 'error');
        input.focus();
        return;
      }
      const data = await runAction(submit, {
        busy: 'Adding',
        request: () => api('/channels', { method: 'POST', body: { cid: match[0] } }),
        success: 'Channel added',
        failure: 'Couldn’t add'
      });
      if (data) closeSheet(entry);
    });
    setTimeout(() => input.focus(), 250);
  }

  async function refreshOverlays(btn) {
    const ok = await confirmSheet({
      title: 'Refresh every overlay?',
      message: 'All open boards reload within a few seconds, including the one on stream.',
      confirmLabel: 'Refresh all'
    });
    if (!ok) return;
    await runAction(btn, {
      busy: 'Refreshing',
      request: () => api('/refresh', { method: 'POST' }),
      success: 'Boards will reload in a few seconds',
      failure: 'Couldn’t refresh'
    });
  }

  function setAnnounceWhen(when) {
    state.announceWhen = when;
    document.querySelectorAll('.segmented button').forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.when === when ? 'true' : 'false');
    });
    const later = when === 'later';
    $('annWhenField').hidden = !later;
    setText($('annSubmit'), later ? 'Schedule' : 'Post now');
    if (later) {
      const input = $('annWhen');
      const now = new Date();
      input.min = toLocalInputValue(now);
      if (!input.value) {
        // Default to 10 minutes out, rounded up to the next 5.
        const suggested = new Date(now.getTime() + 10 * 60000);
        suggested.setMinutes(Math.ceil(suggested.getMinutes() / 5) * 5, 0, 0);
        input.value = toLocalInputValue(suggested);
      }
    }
  }

  async function submitAnnouncement(btn) {
    const textarea = $('annText');
    const message = textarea.value.trim();
    if (!message) {
      toast('Write a message first.', 'error');
      textarea.focus();
      return;
    }
    let data;
    if (state.announceWhen === 'later') {
      const sendAt = new Date($('annWhen').value).getTime();
      if (!sendAt || sendAt <= Date.now()) {
        toast('Pick a time in the future.', 'error');
        return;
      }
      data = await runAction(btn, {
        busy: 'Scheduling',
        request: () => api('/announcement/schedule', { method: 'POST', body: { message, sendAt } }),
        success: `Scheduled for ${formatDateTime(sendAt)}`,
        failure: 'Couldn’t schedule'
      });
      if (data) $('annWhen').value = '';
    } else {
      data = await runAction(btn, {
        busy: 'Posting',
        request: () => api('/announcement', { method: 'POST', body: { message } }),
        success: 'Posted to the boards',
        failure: 'Couldn’t post'
      });
    }
    if (data) {
      textarea.value = '';
      updateCounter();
    }
  }

  async function takeDownAnnouncement(btn) {
    await runAction(btn, {
      busy: 'Taking down',
      request: () => api('/announcement', { method: 'POST', body: { message: '' } }),
      success: 'Announcement taken down',
      failure: 'Couldn’t take it down'
    });
  }

  async function cancelScheduled(item, btn) {
    const ok = await confirmSheet({
      title: 'Cancel this announcement?',
      message: `“${item.message}” won’t go out at ${formatDateTime(item.sendAt)}.`,
      confirmLabel: 'Cancel it',
      danger: true
    });
    if (!ok) return;
    await runAction(btn, {
      busy: 'Cancelling',
      request: () => api('/announcement/schedule/cancel', { method: 'POST', body: { id: item.id } }),
      success: 'Cancelled',
      failure: 'Couldn’t cancel'
    });
  }

  function updateCounter() {
    setText($('annCounter'), `${$('annText').value.length} / 500`);
  }

  // ---------------------------------------------------------------- install

  let deferredInstall = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    renderInstall();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    renderInstall();
    toast('Installed', 'success');
  });

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function renderInstall() {
    const card = $('installCard');
    if (isStandalone() || (!deferredInstall && !isIos())) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('installBtn').hidden = !deferredInstall;
    setText($('installText'), deferredInstall
      ? 'Add FYSC Console to your home screen so it opens full-screen like an app.'
      : 'In Safari, tap Share, then “Add to Home Screen”.');
  }

  // ---------------------------------------------------------------- auth

  function showLogin(message) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginServer').value = state.base;
    const error = $('loginError');
    error.hidden = !message;
    setText(error, message || '');
    (state.base ? $('loginPassword') : $('loginServer')).focus();
  }

  function enterApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    state.online = null;
    renderStatus();
    showTab(storage.get(KEYS.tab) || 'home');
    startPolling();
  }

  function signOut(message) {
    stopPolling();
    state.token = null;
    state.expiresAt = 0;
    state.overview = null;
    storage.remove(KEYS.token);
    storage.remove(KEYS.expiresAt);
    while (sheetStack.length) closeSheet(undefined, { fromHistory: true });
    homeRows.clear();
    channelRows.clear();
    scheduledRows.clear();
    $('homeTopList').replaceChildren();
    $('channelList').replaceChildren();
    $('scheduledList').replaceChildren();
    showLogin(message);
  }

  async function handleLogin(e) {
    e.preventDefault();
    const base = normalizeBase($('loginServer').value);
    const password = $('loginPassword').value;
    const showError = (msg) => {
      $('loginError').hidden = false;
      setText($('loginError'), msg);
    };

    if (!base) return showError('Enter the fysca server address.');
    if (location.protocol === 'https:' && base.startsWith('http:')) {
      return showError('This app is on https, so the browser blocks an http:// server. Use the server’s https:// address.');
    }
    if (!password) return showError('Enter the admin password.');

    state.base = base;
    state.token = null;
    await withBusy($('loginSubmit'), 'Signing in', async () => {
      try {
        const data = await api('/login', { method: 'POST', body: { password } });
        state.token = data.token;
        state.expiresAt = data.expiresAt;
        storage.set(KEYS.base, base);
        storage.set(KEYS.token, data.token);
        storage.set(KEYS.expiresAt, String(data.expiresAt));
        $('loginPassword').value = '';
        $('loginError').hidden = true;
        enterApp();
      } catch (err) {
        showError(err.status === 0
          ? `Can’t reach ${base}. Check the address and that the server is running.`
          : err.message);
      }
    });
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    setText($('appVersion'), 'v' + APP_VERSION);

    $('loginForm').addEventListener('submit', handleLogin);

    document.querySelectorAll('.tabbar button').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.goto));
    });

    $('homeAnnouncement').addEventListener('click', () => showTab('announce'));
    $('refreshOverlaysBtn').addEventListener('click', (e) => refreshOverlays(e.currentTarget));

    $('channelSearch').addEventListener('input', () => { if (state.overview) renderChannels(); });
    $('addChannelBtn').addEventListener('click', openAddChannelSheet);

    $('annText').addEventListener('input', updateCounter);
    document.querySelectorAll('.segmented button').forEach((btn) => {
      btn.addEventListener('click', () => setAnnounceWhen(btn.dataset.when));
    });
    $('annSubmit').addEventListener('click', (e) => submitAnnouncement(e.currentTarget));
    $('annTakeDown').addEventListener('click', (e) => takeDownAnnouncement(e.currentTarget));

    $('installBtn').addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      renderInstall();
    });
    $('changeServerBtn').addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: 'Switch server?',
        message: 'This signs you out so you can sign in to a different fysca server.',
        confirmLabel: 'Sign out and switch'
      });
      if (ok) signOut();
    });
    $('signOutBtn').addEventListener('click', async () => {
      const ok = await confirmSheet({ title: 'Sign out?', confirmLabel: 'Sign out', danger: true });
      if (ok) signOut();
    });

    // Keeps "Live · 12s ago" and the scheduled countdowns current between polls.
    setInterval(() => {
      if (!state.token) return;
      renderStatus();
      if (state.overview && !$('view-announce').hidden) renderAnnounce();
    }, 1000);

    if (state.token && state.expiresAt > Date.now()) enterApp();
    else signOut();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    }
  }

  boot();
})();
