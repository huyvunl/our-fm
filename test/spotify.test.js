import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createSpotify, SpotifyError, NotConnectedError, RateLimitedError } from '../src/spotify.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const tokenRes = (extra = {}) => json({ access_token: 'AT', expires_in: 3600, ...extra });

function setup(responses, { refresh = 'RT' } = {}) {
  const store = openDb(':memory:');
  if (refresh) store.setSetting('refresh_token', refresh);
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next;
  };
  const spotify = createSpotify({
    clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://x/cb', store, fetch, now: () => 1_000_000,
  });
  return { store, calls, spotify };
}
const isToken = (c) => c.url === 'https://accounts.spotify.com/api/token';

test('refreshes once and caches the access token', async () => {
  const { calls, spotify } = setup([tokenRes(), json({ devices: [] }), json({ devices: [] })]);
  await spotify.getDevices();
  await spotify.getDevices();
  assert.equal(calls.filter(isToken).length, 1);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('cid:sec').toString('base64'));
});

test('stores a rotated refresh token', async () => {
  const { store, spotify } = setup([tokenRes({ refresh_token: 'RT2' }), json({ devices: [] })]);
  await spotify.getDevices();
  assert.equal(store.getSetting('refresh_token'), 'RT2');
});

test('retries once after 401', async () => {
  const { calls, spotify } = setup([
    tokenRes(), json({}, 401), tokenRes(), json({ devices: [{ id: 'd', name: 'N', is_active: true }] }),
  ]);
  const devices = await spotify.getDevices();
  assert.deepEqual(devices, [{ id: 'd', name: 'N', isActive: true }]);
  assert.equal(calls.length, 4);
});

test('invalid_grant clears the token', async () => {
  const { store, spotify } = setup([json({ error: 'invalid_grant' }, 400)]);
  await assert.rejects(() => spotify.getDevices(), NotConnectedError);
  assert.equal(store.getSetting('refresh_token'), null);
  assert.equal(spotify.isConnected(), false);
});

test('no stored token is NotConnectedError', async () => {
  const { spotify } = setup([], { refresh: null });
  await assert.rejects(() => spotify.search('x'), NotConnectedError);
});

test('429 becomes RateLimitedError', async () => {
  const { spotify } = setup([tokenRes(), json({}, 429, { 'Retry-After': '7' })]);
  await assert.rejects(() => spotify.getDevices(), (e) => e instanceof RateLimitedError && e.retryAfterMs === 7000);
});

test('403 becomes SpotifyError', async () => {
  const { spotify } = setup([tokenRes(), json({ error: { message: 'nope' } }, 403)]);
  await assert.rejects(
    () => spotify.search('x'),
    (e) => e instanceof SpotifyError && e.status === 403 && /\/v1\/search/.test(e.message),
  );
});

test('getPlayer returns null on 204', async () => {
  const { spotify } = setup([tokenRes(), new Response(null, { status: 204 })]);
  assert.equal(await spotify.getPlayer(), null);
});

test('getPlayer maps state', async () => {
  const { spotify } = setup([
    tokenRes(),
    json({ is_playing: true, progress_ms: 1234, item: { id: 't1' }, device: { id: 'dev' } }),
  ]);
  assert.deepEqual(await spotify.getPlayer(), { trackId: 't1', progressMs: 1234, isPlaying: true, deviceId: 'dev' });
});

const item = {
  id: 't1', uri: 'spotify:track:t1', name: 'Song', duration_ms: 200000, explicit: true,
  artists: [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }],
  album: { name: 'Alb', images: [{ url: 'big' }, { url: 'mid' }, { url: 'small' }] },
};

test('maps a track', async () => {
  const { spotify } = setup([tokenRes(), json({ tracks: { items: [item] } })]);
  const [t] = await spotify.search('hello world');
  assert.deepEqual(t, {
    id: 't1', uri: 'spotify:track:t1', title: 'Song', artist: 'A, B', artistId: 'a1',
    album: 'Alb', durationMs: 200000, explicit: true, imageUrl: 'mid',
  });
});

test('search url', async () => {
  const { calls, spotify } = setup([tokenRes(), json({ tracks: { items: [] } })]);
  await spotify.search('a b');
  assert.equal(calls[1].url, 'https://api.spotify.com/v1/search?type=track&limit=10&market=from_token&q=a%20b');
});

test('getTrack', async () => {
  const { calls, spotify } = setup([tokenRes(), json(item)]);
  const t = await spotify.getTrack('t1');
  assert.equal(t.title, 'Song');
  assert.equal(calls[1].url, 'https://api.spotify.com/v1/tracks/t1?market=from_token');
});

test('play sends uris and device id', async () => {
  const { calls, spotify } = setup([tokenRes(), new Response(null, { status: 204 })]);
  await spotify.play('dev1', 'spotify:track:x');
  assert.match(calls[1].url, /device_id=dev1/);
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.body, '{"uris":["spotify:track:x"]}');
});

test('pause and transfer', async () => {
  const { calls, spotify } = setup([tokenRes(), new Response(null, { status: 204 }), new Response(null, { status: 204 })]);
  await spotify.pause('d1');
  await spotify.transfer('d2');
  assert.match(calls[1].url, /\/me\/player\/pause\?device_id=d1$/);
  assert.equal(calls[2].url, 'https://api.spotify.com/v1/me/player');
  assert.equal(calls[2].init.body, '{"device_ids":["d2"],"play":false}');
});

test('exchangeCode stores refresh token and caches access token', async () => {
  const { store, calls, spotify } = setup([tokenRes({ refresh_token: 'NEW' }), json({ devices: [] })], { refresh: null });
  await spotify.exchangeCode('code1');
  assert.equal(store.getSetting('refresh_token'), 'NEW');
  assert.equal(spotify.isConnected(), true);
  assert.match(String(calls[0].init.body), /grant_type=authorization_code/);
  await spotify.getDevices();
  assert.equal(calls.filter(isToken).length, 1);
});

test('authorizeUrl includes scopes and state', () => {
  const { spotify } = setup([]);
  const u = new URL(spotify.authorizeUrl('st8'));
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('scope'), 'user-read-playback-state user-modify-playback-state');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://x/cb');
  assert.equal(u.searchParams.get('state'), 'st8');
});
