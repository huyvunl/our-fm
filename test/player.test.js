import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { SpotifyError, RateLimitedError } from '../src/spotify.js';
import { createPlayer, NothingPlayingError, StalePlayError } from '../src/player.js';

const track = (n) => ({
  id: `t${n}`, uri: `spotify:track:t${n}`, title: `Song ${n}`, artist: 'Artist', artistId: 'ar',
  album: 'Album', durationMs: 200000, explicit: false, imageUrl: null,
});

function fakeSpotify() {
  const s = {
    calls: [],
    connected: true,
    player: null,
    devices: [{ id: 'd1', name: 'Office iPhone' }],
    playFn: async () => {},
    isConnected: () => s.connected,
    async getPlayer() { s.calls.push(['getPlayer']); if (s.player instanceof Error) throw s.player; return s.player; },
    async getDevices() { s.calls.push(['getDevices']); return s.devices; },
    async play(d, uri) { s.calls.push(['play', d, uri]); return s.playFn(d, uri); },
    async pause(d) { s.calls.push(['pause', d]); },
    async transfer(d) { s.calls.push(['transfer', d]); },
    count: (name) => s.calls.filter((c) => c[0] === name).length,
  };
  return s;
}

function fakeClock() {
  const c = {
    t: 1_000_000, timers: [], nextId: 1, intervals: new Map(),
    now: () => c.t,
    setTimeout(fn, ms) { const id = c.nextId++; c.timers.push({ id, fn, ms }); return id; },
    clearTimeout(id) { c.timers = c.timers.filter((x) => x.id !== id); },
    runTimers() { const due = c.timers; c.timers = []; due.forEach((x) => x.fn()); },
    setInterval(fn, ms) { const id = c.nextId++; c.intervals.set(id, ms); return id; },
    clearInterval(id) { c.intervals.delete(id); },
  };
  return c;
}

const quiet = { error() {}, warn() {}, log() {} };

function setup(deviceName = null) {
  const store = openDb(':memory:');
  const spotify = fakeSpotify();
  const clock = fakeClock();
  const mk = () => createPlayer({ store, spotify, deviceName, autopick: { pick: async () => null }, clock, log: quiet });
  const player = mk();
  const add = (n, who = 'a') => store.enqueue(track(n), { requestedBy: who, requesterId: who, source: 'request' }, clock.now());
  const show = (n, o = {}) => { spotify.player = { trackId: `t${n}`, progressMs: 1000, isPlaying: true, deviceId: 'd1', ...o }; };
  const seen = async (n = 1, o = {}) => { show(n, o); await player.tick(); };
  return { store, spotify, clock, player, add, show, mk, seen };
}

test('needs_auth when not connected', async () => {
  const { spotify, player } = setup();
  spotify.connected = false;
  await player.tick();
  assert.equal(player.getState().status, 'needs_auth');
  assert.equal(spotify.calls.length, 0);
});

test('starts the head of the queue on the named device', async () => {
  const { store, spotify, player, add } = setup('Office iPhone');
  spotify.devices = [{ id: 'd1', name: 'Other' }, { id: 'd2', name: 'Office iPhone' }];
  add(1);
  await player.tick();
  assert.deepEqual(spotify.calls.find((c) => c[0] === 'play'), ['play', 'd2', 'spotify:track:t1']);
  assert.equal(store.listQueue().length, 0);
  assert.equal(store.currentPlay().trackId, 't1');
  assert.equal(player.getState().status, 'playing');
});

test('falls back to the first device', async () => {
  const { spotify, player, add } = setup('Nope');
  spotify.devices = [{ id: 'd1', name: 'Other' }, { id: 'd2', name: 'Another' }];
  add(1);
  await player.tick();
  assert.equal(spotify.calls.find((c) => c[0] === 'play')[1], 'd1');
});

test('no_device when no devices; queue kept', async () => {
  const { store, spotify, player, add } = setup();
  spotify.devices = [];
  add(1);
  await player.tick();
  assert.equal(player.getState().status, 'no_device');
  assert.equal(store.listQueue().length, 1);
  assert.equal(store.currentPlay(), null);
});

test('404 on play transfers then retries once', async () => {
  const { spotify, player, add } = setup();
  let n = 0;
  spotify.playFn = async () => { if (n++ === 0) throw new SpotifyError('no active device', 404); };
  add(1);
  await player.tick();
  assert.deepEqual(spotify.calls.filter((c) => ['play', 'transfer'].includes(c[0])).map((c) => c[0]), ['play', 'transfer', 'play']);
  assert.equal(player.getState().status, 'playing');
});

test('play 403 drops the item', async () => {
  const { store, spotify, player, add } = setup();
  spotify.playFn = async () => { throw new SpotifyError('forbidden', 403); };
  add(1);
  await player.tick();
  const st = player.getState();
  assert.equal(st.status, 'error');
  assert.equal(st.message, "Couldn't play \"Song 1\" — removed from queue");
  assert.equal(store.listQueue().length, 0);
  assert.equal(store.currentPlay(), null);
});

test('advances when Spotify shows another track twice after grace', async () => {
  const { store, spotify, clock, player, add, show , seen } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  show(9);
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't1');
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't2');
  const ended = store.getPlay(1);
  assert.equal(ended.skipped, false);
  assert.ok(ended.endedAt);
  assert.equal(spotify.count('play'), 2);
});

test('ignores mismatch during the start grace', async () => {
  const { store, clock, player, add, show } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 2000;
  show(9);
  await player.tick();
  await player.tick();
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't1');
});

test('single null player response does not end the song; two in a row do', async () => {
  const { store, spotify, clock, player, add, show , seen } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  spotify.player = null;
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't1');
  show(1);
  await player.tick(); // seeing the current play resets the counter
  spotify.player = null;
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't1');
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't2');
});

test('iPhone asleep: song ends after two misses and next waits with no_device', async () => {
  const { store, spotify, clock, player, add , seen } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  spotify.player = null;
  spotify.devices = [];
  await player.tick();
  await player.tick();
  assert.equal(store.currentPlay(), null);
  assert.equal(player.getState().status, 'no_device');
  assert.equal(store.listQueue().length, 1);
});

test('advances when stopped at the end', async () => {
  const { store, clock, player, add, show , seen } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  show(1, { isPlaying: false, progressMs: 0 });
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't2');
});

test('paused mid-track waits', async () => {
  const { store, clock, player, add, show } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  show(1, { isPlaying: false, progressMs: 50000 });
  await player.tick();
  assert.equal(player.getState().status, 'paused');
  assert.equal(store.currentPlay().trackId, 't1');
});

test('lookahead timer starts the next song at the end; no second timer in window', async () => {
  const { store, spotify, clock, player, add, show } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  show(1, { progressMs: 198000 });
  await player.tick();
  assert.deepEqual(clock.timers.map((x) => x.ms), [2000]);
  await player.tick();
  assert.equal(clock.timers.length, 1);
  clock.runTimers();
  await player.tick(); // flushes the lock chain
  assert.equal(store.currentPlay().trackId, 't2');
  assert.equal(spotify.count('play'), 2);
});

test('pauses Spotify when the last song ends and the queue is empty', async () => {
  const { spotify, clock, player, add, show , seen } = setup();
  add(1);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  show(1, { isPlaying: false, progressMs: 0 });
  await player.tick();
  assert.deepEqual(spotify.calls.filter((c) => c[0] === 'pause'), [['pause', 'd1']]);
  assert.equal(player.getState().status, 'idle');
  assert.equal(player.getState().progressMs, null);
});

test('restart: open play still shown keeps playing; one not shown ends after two misses', async () => {
  const { store, spotify, clock, add, show, mk } = setup();
  add(1);
  await mk().tick();
  clock.t += 60000;

  const p2 = mk(); // fresh in-memory state, same DB
  show(1, { progressMs: 30000 });
  await p2.tick();
  assert.equal(store.currentPlay().trackId, 't1');
  assert.equal(p2.getState().status, 'playing');
  assert.equal(p2.getState().progressMs, 30000);

  const p3 = mk();
  spotify.player = null;
  await p3.tick();
  assert.ok(store.currentPlay());
  await p3.tick();
  assert.equal(store.currentPlay(), null);
});

const vote = (p, id, playId = 1) => p.skip(id, `Name ${id}`, playId);

test('skip: two non-requester votes do not skip, third does', async () => {
  const { store, clock, player, add, show } = setup();
  add(1, 'r'); add(2);
  await player.tick();
  clock.t += 6000;
  show(1, { progressMs: 10000 });
  await player.tick();
  clock.t += 1000; // estimate: 10000 + 1000
  assert.deepEqual(await vote(player, 'x'), { votes: 1, needed: 3, skipped: false });
  assert.deepEqual(await vote(player, 'y'), { votes: 2, needed: 3, skipped: false });
  assert.deepEqual(await vote(player, 'z'), { votes: 3, needed: 3, skipped: true });
  const ended = store.getPlay(1);
  assert.equal(ended.skipped, true);
  assert.equal(ended.progressMsAtSkip, 11000);
  assert.equal(store.currentPlay().trackId, 't2');
});

test('skip: requester plus one skips', async () => {
  const { store, player, add } = setup();
  add(1, 'r');
  await player.tick();
  assert.equal((await vote(player, 'r')).skipped, false);
  assert.deepEqual(await vote(player, 'x'), { votes: 2, needed: 2, skipped: true });
  assert.equal(store.currentPlay(), null);
});

test('skip: auto-pick vetoed by one vote', async () => {
  const { store, player } = setup();
  store.enqueue(track(1), { source: 'auto' }, 1);
  await player.tick();
  assert.equal((await vote(player, 'x')).skipped, true);
});

test('skip with nothing playing rejects NothingPlayingError', async () => {
  const { player } = setup();
  await assert.rejects(vote(player, 'x'), NothingPlayingError);
});

test('concurrent skip and lookahead advance exactly once', async () => {
  const { store, spotify, clock, player, add, show } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  show(1, { progressMs: 198000 });
  await player.tick();
  assert.equal(clock.timers.length, 1);
  await vote(player, 'x');
  await vote(player, 'y');
  const p = vote(player, 'z');
  clock.runTimers();
  const res = await p;
  assert.equal(res.skipped, true);
  await player.tick();
  assert.equal(store.getPlay(1).skipped, true);
  assert.equal(store.currentPlay().trackId, 't2');
  assert.equal(spotify.count('play'), 2);
  assert.equal(store.listQueue().length, 0);
});

test('second refusal in a row keeps the queue and backs off 60 s', async () => {
  const { store, spotify, clock, player, add } = setup();
  spotify.playFn = async () => { throw new SpotifyError('Premium required', 403); };
  add(1); add(2);
  await player.tick();
  assert.equal(store.listQueue().length, 1);
  await player.tick();
  const st = player.getState();
  assert.equal(store.listQueue().length, 1);
  assert.equal(st.status, 'error');
  assert.match(st.message, /^Spotify refused playback/);
  const n = spotify.calls.length;
  clock.t += 30000;
  await player.tick();
  assert.equal(spotify.calls.length, n);
  clock.t += 31000;
  await player.tick();
  assert.ok(spotify.calls.length > n);
});

test('successful play resets the refusal counter', async () => {
  const { store, spotify, clock, player, add, show , seen } = setup();
  let fail = true;
  spotify.playFn = async () => { if (fail) throw new SpotifyError('nope', 400); };
  add(1); add(2); add(3);
  await player.tick(); // refusal 1 drops song 1
  fail = false;
  await player.tick(); // plays song 2
  fail = true;
  clock.t += 6000;
  await seen(2);
  show(2, { isPlaying: false, progressMs: 0 });
  await player.tick(); // song 2 ends; song 3 refused: counted as first again, dropped
  assert.equal(store.listQueue().length, 0);
});

test('rate limit backs off', async () => {
  const { spotify, clock, player } = setup();
  spotify.player = new RateLimitedError(10000);
  await player.tick();
  const n = spotify.calls.length;
  clock.t += 5000;
  await player.tick();
  assert.equal(spotify.calls.length, n);
  clock.t += 6000;
  spotify.player = null;
  await player.tick();
  assert.ok(spotify.calls.length > n);
});

test('start/stop manage the interval', async () => {
  const { clock, player } = setup();
  player.start();
  assert.deepEqual([...clock.intervals.values()], [3000]);
  player.stop();
  assert.equal(clock.intervals.size, 0);
});

test('a play that never starts goes back to the head of the queue', async () => {
  const { store, clock, player, add, show } = setup();
  const first = add(1); const second = add(2);
  await player.tick();
  const startedPlayId = store.currentPlay().id;
  store.addSkipVote(startedPlayId, 'x', 'X', clock.now());
  clock.t += 6000;
  show(1, { isPlaying: false, progressMs: 0 });
  await player.tick();
  assert.equal(store.currentPlay(), null);
  assert.equal(store.getPlay(startedPlayId), null);
  assert.deepEqual(store.listQueue().map((q) => [q.id, q.trackId]), [[first.id, 't1'], [second.id, 't2']]);
  assert.equal(player.getState().status, 'no_device');
  assert.equal(player.getState().message, 'Open Spotify on the speaker iPhone');
  assert.equal(store.listSkipVotes(startedPlayId).length, 0);
});

test('a play that never shows up (two misses) is also returned to the queue', async () => {
  const { store, spotify, clock, player, add } = setup();
  add(1);
  await player.tick();
  clock.t += 6000;
  spotify.player = null;
  await player.tick();
  assert.ok(store.currentPlay());
  await player.tick();
  assert.equal(store.currentPlay(), null);
  assert.deepEqual(store.listQueue().map((q) => q.trackId), ['t1']);
});

test('stopped at 0 after having played still advances', async () => {
  const { store, clock, player, add, seen, show } = setup();
  add(1); add(2);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  show(1, { isPlaying: false, progressMs: 0 });
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't2');
  assert.equal(store.getPlay(1).skipped, false);
});

test('stopped at 0 within the start grace waits', async () => {
  const { store, clock, player, add, show } = setup();
  add(1);
  await player.tick();
  clock.t += 2000;
  show(1, { isPlaying: false, progressMs: 0 });
  await player.tick();
  assert.equal(store.currentPlay().trackId, 't1');
});

test('skip for a play that already changed is rejected without a vote', async () => {
  const { store, clock, player, add, seen } = setup();
  add(1, 'r'); add(2);
  await player.tick();
  clock.t += 6000;
  await seen(1);
  await vote(player, 'x'); await vote(player, 'y');
  await vote(player, 'z'); // skips play 1; play 2 now current
  assert.equal(store.currentPlay().trackId, 't2');
  await assert.rejects(vote(player, 'w', 1), StalePlayError);
  assert.equal(store.listSkipVotes(2).length, 0);
});

test('lookahead timer is cancelled when the same play is paused or far from the end', async () => {
  const { clock, player, add, show } = setup();
  add(1);
  await player.tick();
  clock.t += 6000;
  show(1, { progressMs: 198000 });
  await player.tick();
  assert.equal(clock.timers.length, 1);
  show(1, { progressMs: 198000, isPlaying: false });
  await player.tick();
  assert.equal(clock.timers.length, 0);
  show(1, { progressMs: 198000 });
  await player.tick();
  assert.equal(clock.timers.length, 1);
  show(1, { progressMs: 10000 }); // seeked back
  await player.tick();
  assert.equal(clock.timers.length, 0);
});

test('queue row removed before play starts is not an error', async () => {
  const { store, spotify, player, add } = setup();
  const item = add(1);
  const orig = spotify.getDevices;
  spotify.getDevices = async () => { store.removeQueueItem(item.id); return orig(); };
  await player.tick();
  assert.notEqual(player.getState().status, 'error');
  assert.equal(store.currentPlay(), null);
});

test('two ticks while one is pending cause one getPlayer call', async () => {
  const { spotify, player } = setup();
  const a = player.tick();
  const b = player.tick();
  await Promise.all([a, b]);
  assert.equal(spotify.count('getPlayer'), 1);
  await player.tick();
  assert.equal(spotify.count('getPlayer'), 2);
});

test('a repeating error is logged once; network errors get a friendly banner', async () => {
  const { spotify, store, clock } = setup();
  const errors = [];
  const p = createPlayer({ store, spotify, autopick: { pick: async () => null }, clock, log: { ...quiet, error: (...a) => errors.push(a.join(' ')) } });
  spotify.player = new TypeError('fetch failed');
  await p.tick(); await p.tick(); await p.tick();
  assert.equal(errors.length, 1);
  assert.equal(p.getState().status, 'error');
  assert.equal(p.getState().message, "Can't reach Spotify right now — retrying");
});

test('stop() resolves after in-flight work drains', async () => {
  const { spotify, player, add } = setup();
  add(1);
  let release;
  spotify.getDevices = () => new Promise((r) => { release = () => r([{ id: 'd1', name: 'x' }]); });
  const t = player.tick();
  let stopped = false;
  const st = player.stop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopped, false);
  release();
  await t; await st;
  assert.equal(stopped, true);
});

test('autopick receives store, spotify and now', async () => {
  const store = openDb(':memory:');
  const spotify = fakeSpotify();
  const clock = fakeClock();
  let ctx;
  const p = createPlayer({ store, spotify, autopick: { pick: async (c) => { ctx = c; return null; } }, clock, log: quiet });
  await p.tick();
  assert.equal(ctx.store, store);
  assert.equal(ctx.spotify, spotify);
  assert.equal(ctx.now, clock.now());
});
