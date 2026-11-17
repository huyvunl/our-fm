'use strict';

const POLL_MS = 3000;
const SEARCH_DEBOUNCE_MS = 400;
const BANNERS = {
  no_device: 'Open Spotify on the speaker iPhone',
  needs_auth: "Spotify isn't connected yet — owner: open /auth/login",
  idle: 'Queue is empty — add a song',
};

const $ = (id) => document.getElementById(id);

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

let clientId = lsGet('ofm.clientId');
if (!clientId) {
  clientId = crypto.randomUUID();
  lsSet('ofm.clientId', clientId);
}
let name = lsGet('ofm.name') || '';
let state = null;
let receivedAt = 0;
let authed = false;
let results = [];
let searchSeq = 0;
let inflight = false;

// ---- helpers ----
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function setCover(img, url) {
  if (url) {
    img.src = url;
    img.classList.remove('hidden');
  } else {
    img.removeAttribute('src');
  }
}

function toast(message) {
  $('toast-text').textContent = message;
  $('toast').classList.remove('hidden');
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Client-Id': clientId };
  const init = { method, headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (body) init.body = JSON.stringify({ name, ...body });
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    authed = false;
    renderViews();
    throw new Error('Passcode required');
  }
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

async function act(fn) {
  try {
    await fn();
  } catch (e) {
    if (authed) toast(e.message);
  }
  refresh();
}

// ---- views ----
function renderViews() {
  const needName = authed && !name;
  $('login-view').classList.toggle('hidden', authed);
  $('name-view').classList.toggle('hidden', !needName);
  $('app-view').classList.toggle('hidden', !authed || needName);
  $('who').textContent = name && authed ? name : '';
  $('change-name').classList.toggle('hidden', !(name && authed));
}

function renderBanner() {
  const banner = $('banner');
  const text = state.status === 'error' ? state.message : BANNERS[state.status];
  banner.classList.toggle('hidden', !text);
  banner.classList.toggle('error', state.status === 'error');
  banner.textContent = text || '';
}

function renderNow() {
  const np = state.nowPlaying;
  $('now').classList.toggle('hidden', !np);
  $('now-empty').classList.toggle('hidden', !!np);
  if (!np) return;
  $('now-title').textContent = np.title;
  $('now-artist').textContent = np.artist;
  $('now-by').textContent = np.source === 'auto' ? 'auto-pick' : `requested by ${np.requestedBy}`;
  setCover($('now-cover'), np.imageUrl);
  $('t-total').textContent = fmt(np.durationMs);
  const btn = $('skip');
  const tally = `${np.votes.length}/${np.votesNeeded}`;
  btn.textContent = np.iVoted ? `Voted (${tally})` : `Skip (${tally})`;
  btn.disabled = np.iVoted;
  tickProgress();
}

function tickProgress() {
  const np = state?.nowPlaying;
  if (!np) return;
  let pos = np.progressMs ?? 0;
  if (np.isPlaying) pos += Date.now() - receivedAt;
  pos = Math.min(pos, np.durationMs);
  $('t-elapsed').textContent = fmt(pos);
  $('fill').style.width = `${np.durationMs ? (pos / np.durationMs) * 100 : 0}%`;
}

function trackRow(track, extra) {
  const li = el('li', 'row');
  const img = el('img', 'cover');
  img.alt = '';
  img.loading = 'lazy';
  setCover(img, track.imageUrl);
  const info = el('div', 'info');
  const title = el('div', 'title', track.title);
  if (track.explicit) title.append(el('span', 'badge', 'E'));
  info.append(title, el('div', 'muted', extra.subtitle));
  li.append(img, info);
  if (extra.button) li.append(extra.button);
  return li;
}

function renderSlots() {
  if (!state) return;
  $('slots').textContent = `${state.me.queued} of ${state.me.max} slots used`;
}

function renderResults() {
  const list = $('results');
  list.replaceChildren();
  const full = state ? state.me.queued >= state.me.max : false;
  for (const track of results) {
    const btn = el('button', '', full ? 'Limit reached' : 'Add');
    btn.type = 'button';
    btn.disabled = full;
    btn.addEventListener('click', () => act(async () => {
      btn.disabled = true;
      await api('/api/queue', { method: 'POST', body: { trackId: track.id } });
    }));
    list.append(trackRow(track, { subtitle: `${track.artist} · ${fmt(track.durationMs)}`, button: btn }));
  }
}

function renderQueue() {
  const list = $('queue');
  list.replaceChildren();
  if (!state.queue.length) list.append(el('li', 'muted', 'Nothing queued'));
  for (const item of state.queue) {
    const by = item.source === 'auto' ? 'auto-pick' : `requested by ${item.requestedBy}`;
    let btn = null;
    if (item.mine) {
      btn = el('button', 'ghost', 'Remove');
      btn.type = 'button';
      btn.addEventListener('click', () => act(() => api(`/api/queue/${item.id}`, { method: 'DELETE' })));
    }
    list.append(trackRow(item, { subtitle: `${item.artist} · ${by}`, button: btn }));
  }
}

function render() {
  renderViews();
  if (!state) return;
  renderBanner();
  renderNow();
  renderSlots();
  renderResults();
  renderQueue();
}

// ---- data ----
async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    state = await api('/api/state');
    receivedAt = Date.now();
    authed = true;
    render();
  } catch {
    /* 401 is handled in api(); transient network errors retry on the next poll */
  } finally {
    inflight = false;
  }
}

async function search() {
  const q = $('q').value.trim();
  const seq = ++searchSeq;
  if (!q) {
    results = [];
    renderResults();
    return;
  }
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    results = data.tracks;
    renderResults();
  } catch (e) {
    if (seq === searchSeq && authed) toast(e.message);
  }
}

// ---- events ----
let searchTimer = null;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, SEARCH_DEBOUNCE_MS);
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const passcode = $('passcode').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    if (res.status === 204) {
      $('passcode').value = '';
      await refresh();
      return;
    }
    const data = await res.json().catch(() => null);
    toast(data?.error || 'Login failed');
  } catch {
    toast('Could not reach the server');
  }
});

$('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('name-input').value.trim().slice(0, 30);
  if (!value) return;
  name = value;
  lsSet('ofm.name', name);
  render();
});

$('change-name').addEventListener('click', () => {
  $('name-input').value = name;
  name = '';
  renderViews();
  $('name-input').focus();
});

$('skip').addEventListener('click', () => act(() => api('/api/skip', { method: 'POST' })));

$('toast-close').addEventListener('click', () => $('toast').classList.add('hidden'));

setInterval(refresh, POLL_MS);
setInterval(tickProgress, 250);
refresh();
