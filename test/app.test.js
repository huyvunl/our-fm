import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { SpotifyError, NotConnectedError } from '../src/spotify.js';
import { NothingPlayingError, StalePlayError } from '../src/player.js';
import { cookieValueFor } from '../src/auth.js';

const PASS = 'office-pass-1';
const COOKIE = `ofm=${cookieValueFor(PASS)}`;
const A = 'client-aaaaaaaa';
const B = 'client-bbbbbbbb';

function track(id, over = {}) {
  return {
    id, uri: `spotify:track:${id}`, title: `Title ${id}`, artist: 'Artist', artistId: 'ar1', album: 'Album',
    durationMs: 200000, explicit: false, imageUrl: 'https://i.scdn.co/image/x', ...over,
  };
}

async function setup(over = {}) {
  const store = openDb(':memory:');
  const calls = { getTrack: [], kick: 0, exchangeCode: [] };
  const spotify = {
    connected: true,
    tracks: {},
    isConnected() { return this.connected; },
    async search() { return [track('s1')]; },
    async getTrack(id) { calls.getTrack.push(id); return this.tracks[id] ?? track(id); },
    authorizeUrl(state) { return `https://accounts.spotify.com/authorize?state=${state}`; },
    async exchangeCode(code) { calls.exchangeCode.push(code); this.connected = true; },
    ...over.spotify,
  };
  const player = {
    getState: () => ({ status: 'idle', message: null, progressMs: null, isPlaying: false }),
    skip: async () => ({ votes: 1, needed: 3, skipped: false }),
    kick() { calls.kick++; },
    ...over.player,
  };
  const config = { officePasscode: PASS };
  const app = createApp({ config, store, spotify, player });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(path, { method = 'GET', body, cookie = COOKIE, clientId = A, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (clientId) h['x-client-id'] = clientId;
    let payload;
    if (method !== 'GET') h['content-type'] ??= 'application/json';
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const close = () => { server.close(); server.closeAllConnections?.(); store.close(); };
  return { api, store, spotify, player, calls, close };
}

test('healthz is open', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/healthz', { cookie: null });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'ok');
});

test('api requires the passcode cookie', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/api/state', { cookie: null });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Passcode required');
});

test('login sets cookie; wrong passcode 401; 11th failure 429', async (t) => {
  const s = await setup(); t.after(s.close);
  const ok = await s.api('/api/login', { method: 'POST', body: { passcode: PASS }, cookie: null });
  assert.equal(ok.status, 204);
  const sc = ok.headers.get('set-cookie');
  assert.ok(sc.includes(`ofm=${cookieValueFor(PASS)}`));
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  for (let i = 0; i < 10; i++) {
    const r = await s.api('/api/login', { method: 'POST', body: { passcode: 'wrong' }, cookie: null });
    assert.equal(r.status, 401);
  }
  const blocked = await s.api('/api/login', { method: 'POST', body: { passcode: 'wrong' }, cookie: null });
  assert.equal(blocked.status, 429);
});

test('mutating routes need JSON', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/api/queue', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
});

test('bad JSON body is 400 without a stack trace', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/api/queue', { method: 'POST', raw: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
  assert.ok(!/\.js:\d+/.test(r.text));
});

test('unknown api route is 404 json', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});

test('security headers present', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/healthz', { cookie: null });
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /img-src 'self' https:\/\/i\.scdn\.co/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('state shape', async (t) => {
  const s = await setup({ player: { getState: () => ({ status: 'no_device', message: null, progressMs: null, isPlaying: false }) } });
  t.after(s.close);
  const r = await s.api('/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'no_device');
  assert.equal(r.json.nowPlaying, null);
  assert.deepEqual(r.json.queue, []);
  assert.equal(r.json.me.max, 3);
  assert.equal(r.json.me.queued, 0);
  assert.equal(typeof r.json.serverTime, 'number');
  s.store.enqueue(track('q1'), { requestedBy: 'Ann', requesterId: A, source: 'request' }, Date.now());
  const r2 = await s.api('/api/state');
  assert.equal(r2.json.queue[0].mine, true);
  assert.ok(!r2.text.includes('requesterId'));
});

test('state nowPlaying includes votes and iVoted', async (t) => {
  const s = await setup({ player: { getState: () => ({ status: 'playing', message: null, progressMs: 1000, isPlaying: true }) } });
  t.after(s.close);
  const item = s.store.enqueue(track('p1'), { requestedBy: 'Ann', requesterId: A, source: 'request' }, Date.now());
  const play = s.store.startPlay(item.id, Date.now());
  s.store.addSkipVote(play.id, B, 'Bob', Date.now());
  const r = await s.api('/api/state', { clientId: B });
  const np = r.json.nowPlaying;
  assert.equal(np.trackId, 'p1');
  assert.equal(np.progressMs, 1000);
  assert.equal(np.isPlaying, true);
  assert.deepEqual(np.votes, ['Bob']);
  assert.equal(np.iVoted, true);
  assert.equal(np.votesNeeded, 3);
  assert.equal(np.requestedBy, 'Ann');
  assert.ok(!r.text.includes('requesterId'));
});

test('queue adds a track looked up on Spotify', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/api/queue', { method: 'POST', body: { trackId: 'abc123', name: 'Ann' } });
  assert.equal(r.status, 201);
  assert.deepEqual(s.calls.getTrack, ['abc123']);
  assert.equal(s.calls.kick, 1);
  assert.equal(r.json.title, 'Title abc123');
  assert.equal(r.json.requestedBy, 'Ann');
  assert.ok(!r.text.includes('requesterId'));
});

test('queue item title is returned verbatim', async (t) => {
  const evil = '<script>alert("x")</script>';
  const s = await setup(); t.after(s.close);
  s.spotify.tracks.evil = track('evil', { title: evil });
  await s.api('/api/queue', { method: 'POST', body: { trackId: 'evil', name: '<b>Ann</b>' } });
  const r = await s.api('/api/state');
  assert.equal(r.json.queue[0].title, evil);
  assert.equal(r.json.queue[0].requestedBy, '<b>Ann</b>');
});

test('duplicate track 409, fourth request 409, another client can add', async (t) => {
  const s = await setup(); t.after(s.close);
  const add = (id, clientId = A) => s.api('/api/queue', { method: 'POST', clientId, body: { trackId: id, name: 'Ann' } });
  assert.equal((await add('t1')).status, 201);
  assert.equal((await add('t1', B)).status, 409);
  assert.equal((await add('t2')).status, 201);
  assert.equal((await add('t3')).status, 201);
  const fourth = await add('t4');
  assert.equal(fourth.status, 409);
  assert.ok(fourth.json.error);
  assert.equal((await add('t4', B)).status, 201);
});

test('queue validation: bad trackId and empty name are 400', async (t) => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.api('/api/queue', { method: 'POST', body: { name: '   ', trackId: 'x1' } })).status, 400);
  assert.equal((await s.api('/api/queue', { method: 'POST', body: { name: 'Ann' } })).status, 400);
  assert.equal((await s.api('/api/queue', { method: 'POST', body: { name: 'Ann', trackId: 'a/b' } })).status, 400);
});

test('queue when not connected 503', async (t) => {
  const s = await setup({ spotify: { getTrack: async () => { throw new NotConnectedError(); }, isConnected: () => false } });
  t.after(s.close);
  const r = await s.api('/api/queue', { method: 'POST', body: { trackId: 'x1', name: 'Ann' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "Spotify isn't connected yet");
});

test('remove own 204, someone else 403, missing 404', async (t) => {
  const s = await setup(); t.after(s.close);
  const made = await s.api('/api/queue', { method: 'POST', body: { trackId: 'r1', name: 'Ann' } });
  const id = made.json.id;
  assert.equal((await s.api(`/api/queue/${id}`, { method: 'DELETE', clientId: B })).status, 403);
  assert.equal((await s.api(`/api/queue/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await s.api(`/api/queue/${id}`, { method: 'DELETE' })).status, 404);
});

test('skip returns player result; NothingPlayingError 409', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await s.api('/api/skip', { method: 'POST', body: { name: 'Ann', playId: 3 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { votes: 1, needed: 3, skipped: false });
  const s2 = await setup({ player: { skip: async () => { throw new NothingPlayingError(); } } });
  t.after(s2.close);
  const r2 = await s2.api('/api/skip', { method: 'POST', body: { name: 'Ann', playId: 3 } });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error, 'Nothing is playing');
  const s3 = await setup({ player: { skip: async () => { throw new StalePlayError(); } } });
  t.after(s3.close);
  const r3 = await s3.api('/api/skip', { method: 'POST', body: { name: 'Ann', playId: 2 } });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.error, 'That song already changed');
  assert.equal((await s.api('/api/skip', { method: 'POST', body: { name: 'Ann' } })).status, 400);
  assert.equal((await s.api('/api/skip', { method: 'POST', body: { name: 'Ann', playId: 'x' } })).status, 400);
});

test('missing or bad X-Client-Id 400; empty name 400', async (t) => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.api('/api/state', { clientId: null })).status, 400);
  assert.equal((await s.api('/api/state', { clientId: 'short' })).status, 400);
  assert.equal((await s.api('/api/state', { clientId: 'bad id with spaces!' })).status, 400);
  assert.equal((await s.api('/api/skip', { method: 'POST', body: { name: '  ', playId: 1 } })).status, 400);
  assert.equal((await s.api('/api/skip', { method: 'POST', body: { name: 'x'.repeat(31), playId: 1 } })).status, 400);
});

test('search: empty q 400; SpotifyError 502 with message', async (t) => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.api('/api/search?q=')).status, 400);
  assert.equal((await s.api('/api/search')).status, 400);
  const ok = await s.api('/api/search?q=hello');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.tracks[0].id, 's1');
  const s2 = await setup({ spotify: { search: async () => { throw new SpotifyError('Spotify GET /v1/search failed (403)', 403); } } });
  t.after(s2.close);
  const r = await s2.api('/api/search?q=hello');
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'Spotify GET /v1/search failed (403)');
});

test('/auth/login redirects with a state when disconnected; 409 when connected', async (t) => {
  const s = await setup(); t.after(s.close);
  s.spotify.connected = false;
  const r = await s.api('/auth/login');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^https:\/\/accounts\.spotify\.com\/authorize\?state=.+/);
  s.spotify.connected = true;
  assert.equal((await s.api('/auth/login')).status, 409);
  assert.equal((await s.api('/auth/login', { cookie: null })).status, 401);
});

test('/auth/callback: unknown state 400; issued state works once', async (t) => {
  const s = await setup(); t.after(s.close);
  s.spotify.connected = false;
  assert.equal((await s.api('/auth/callback?code=c&state=nope')).status, 400);
  const login = await s.api('/auth/login');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const ok = await s.api(`/auth/callback?code=thecode&state=${state}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/');
  assert.deepEqual(s.calls.exchangeCode, ['thecode']);
  assert.equal((await s.api(`/auth/callback?code=thecode&state=${state}`)).status, 400);
});

test('/auth/callback with access_denied redirects home after the state check', async (t) => {
  const s = await setup(); t.after(s.close);
  s.spotify.connected = false;
  const login = await s.api('/auth/login');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const r = await s.api(`/auth/callback?error=access_denied&state=${state}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  assert.deepEqual(s.calls.exchangeCode, []);
});

test('page request shapes: skip {name, playId}, queue {name, trackId}, delete {name}', async (t) => {
  const got = [];
  const s = await setup({ player: { skip: async (c, n, id) => { got.push([c, n, id]); return { votes: 1, needed: 3, skipped: false }; } } });
  t.after(s.close);
  assert.equal((await s.api('/api/skip', { method: 'POST', body: { name: 'Ann', playId: 7 } })).status, 200);
  assert.deepEqual(got, [[A, 'Ann', 7]]);
  assert.equal((await s.api('/api/queue', { method: 'POST', body: { name: 'Ann', trackId: 'abc123' } })).status, 201);
  const id = s.store.listQueue()[0].id;
  assert.equal((await s.api(`/api/queue/${id}`, { method: 'DELETE', body: { name: 'Ann' } })).status, 204);
});

test('state nowPlaying voteCount counts distinct voters', async (t) => {
  const s = await setup(); t.after(s.close);
  const q = s.store.enqueue(track('v1'), { requestedBy: 'Ann', requesterId: A, source: 'request' }, 1);
  const p = s.store.startPlay(q.id, 2);
  s.store.addSkipVote(p.id, B, 'Bob', 3);
  s.store.addSkipVote(p.id, 'client-cccccccc', 'bob', 4); // same name, not counted
  const np = (await s.api('/api/state')).json.nowPlaying;
  assert.equal(np.votes.length, 2);
  assert.equal(np.voteCount, 1);
});
