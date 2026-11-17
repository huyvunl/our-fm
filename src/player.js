import { TICK_MS, START_GRACE_MS, LOOKAHEAD_MS } from './config.js';
import { evaluateSkip } from './skip.js';
import { SpotifyError, NotConnectedError, RateLimitedError } from './spotify.js';

export class NothingPlayingError extends Error {
  constructor() {
    super('Nothing is playing');
    this.name = 'NothingPlayingError';
  }
}

const REFUSAL_BACKOFF_MS = 60_000;
const END_WINDOW_MS = 2000;

export function createPlayer({
  store, spotify, deviceName = null, autopick,
  clock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval },
  log = console,
}) {
  let status = 'idle';
  let message = null;
  let lastProgressMs = null;
  let lastIsPlaying = false;
  let lastUpdateAt = null;
  let misses = 0;
  let refusals = 0;
  let backoffUntil = 0;
  let lastDeviceId = null;
  let lookahead = null; // { playId, handle }
  let interval = null;

  let chain = Promise.resolve();
  function locked(fn) {
    const job = chain.then(() => fn());
    chain = job.catch(() => {});
    return job;
  }

  const setStatus = (s, m = null) => { status = s; message = m; };

  function estimate(cur) {
    if (!cur || lastProgressMs == null || lastUpdateAt == null) return null;
    const est = lastProgressMs + (lastIsPlaying ? clock.now() - lastUpdateAt : 0);
    return Math.min(est, cur.durationMs);
  }

  function cancelLookahead() {
    if (lookahead) clock.clearTimeout(lookahead.handle);
    lookahead = null;
  }

  function armLookahead(playId, ms) {
    if (lookahead?.playId === playId) return;
    cancelLookahead();
    const handle = clock.setTimeout(() => {
      if (lookahead?.handle === handle) lookahead = null;
      locked(() => advance(playId)).catch((e) => log.error('lookahead advance failed:', e.message));
    }, Math.max(0, ms));
    lookahead = { playId, handle };
  }

  function handleError(e) {
    if (e instanceof NotConnectedError) return setStatus('needs_auth', "Spotify isn't connected yet — owner: open /auth/login");
    if (e instanceof RateLimitedError) {
      backoffUntil = clock.now() + e.retryAfterMs;
      return log.warn(`Spotify rate limited; backing off ${e.retryAfterMs} ms`);
    }
    log.error('player error:', e.message);
    setStatus('error', e.message);
  }

  function handleRefusal(e, item) {
    refusals++;
    if (refusals === 1) {
      store.removeQueueItem(item.id);
      setStatus('error', `Couldn't play "${item.title}" — removed from queue`);
    } else {
      backoffUntil = clock.now() + REFUSAL_BACKOFF_MS;
      setStatus('error', `Spotify refused playback: ${e.message}`);
    }
    log.error(`play refused (${e.status}): ${e.message}`);
  }

  // Returns 'started' | 'empty' | 'waiting'.
  async function startNext() {
    try {
      let item = store.listQueue()[0];
      if (!item) {
        const t = await autopick.pick({ store, now: clock.now() });
        if (t) item = store.enqueue(t, { source: 'auto' }, clock.now());
      }
      if (!item) { setStatus('idle'); return 'empty'; }

      const devices = await spotify.getDevices();
      const device = (deviceName && devices.find((d) => d.name === deviceName)) || devices[0];
      if (!device) { setStatus('no_device', 'Open Spotify on the speaker iPhone'); return 'waiting'; }

      try {
        try {
          await spotify.play(device.id, item.uri);
        } catch (e) {
          if (!(e instanceof SpotifyError && e.status === 404)) throw e;
          await spotify.transfer(device.id);
          await spotify.play(device.id, item.uri);
        }
      } catch (e) {
        if (e instanceof SpotifyError && e.status === 404) {
          setStatus('no_device', 'Open Spotify on the speaker iPhone');
        } else if (e instanceof SpotifyError && (e.status === 400 || e.status === 403)) {
          handleRefusal(e, item);
        } else {
          throw e;
        }
        return 'waiting';
      }

      store.startPlay(item.id, clock.now());
      lastDeviceId = device.id;
      refusals = 0;
      misses = 0;
      lastProgressMs = 0;
      lastIsPlaying = true;
      lastUpdateAt = clock.now();
      setStatus('playing');
      return 'started';
    } catch (e) {
      handleError(e);
      return 'waiting';
    }
  }

  // Must be called from inside the lock.
  async function advance(playId, { skipped = false, progressMs = null } = {}) {
    const cur = store.currentPlay();
    if (!cur || cur.id !== playId) return;
    store.endPlay(cur.id, { endedAt: clock.now(), skipped, progressMs });
    cancelLookahead();
    lastIsPlaying = false;
    misses = 0;
    if ((await startNext()) === 'empty' && lastDeviceId) {
      try { await spotify.pause(lastDeviceId); } catch { /* ignored */ }
    }
  }

  async function tickBody() {
    if (!spotify.isConnected()) return setStatus('needs_auth', "Spotify isn't connected yet — owner: open /auth/login");
    if (clock.now() < backoffUntil) return;
    const p = await spotify.getPlayer();
    const cur = store.currentPlay();

    if (!cur) {
      await startNext();
      return;
    }
    if (p && p.trackId === cur.trackId) {
      misses = 0;
      lastProgressMs = p.progressMs;
      lastIsPlaying = p.isPlaying;
      lastUpdateAt = clock.now();
      if (p.deviceId) lastDeviceId = p.deviceId;
      const remaining = cur.durationMs - p.progressMs;
      if (p.isPlaying) {
        setStatus('playing');
        if (remaining <= LOOKAHEAD_MS) armLookahead(cur.id, remaining);
      } else if (p.progressMs === 0 || remaining < END_WINDOW_MS) {
        await advance(cur.id);
      } else {
        setStatus('paused');
      }
    } else if (clock.now() - Date.parse(cur.startedAt) > START_GRACE_MS) {
      if (++misses >= 2) await advance(cur.id);
    }
  }

  function tick() {
    return locked(async () => {
      try {
        await tickBody();
      } catch (e) {
        handleError(e);
      }
    }).catch((e) => log.error('tick failed:', e.message));
  }

  function skip(clientId, name) {
    return locked(async () => {
      const cur = store.currentPlay();
      if (!cur) throw new NothingPlayingError();
      store.addSkipVote(cur.id, clientId, name, clock.now());
      const { votes, needed, passed } = evaluateSkip(cur, store.listSkipVotes(cur.id));
      if (passed) await advance(cur.id, { skipped: true, progressMs: estimate(cur) });
      return { votes, needed, skipped: passed };
    });
  }

  return {
    tick,
    kick() { tick(); },
    skip,
    getState() {
      const cur = store.currentPlay();
      return {
        status,
        message,
        progressMs: estimate(cur),
        isPlaying: !!cur && lastIsPlaying,
      };
    },
    start() {
      if (interval) return;
      interval = clock.setInterval(() => tick(), TICK_MS);
      tick();
    },
    stop() {
      if (interval) clock.clearInterval(interval);
      interval = null;
      cancelLookahead();
    },
  };
}
