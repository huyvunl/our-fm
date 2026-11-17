import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { MAX_QUEUED_PER_PERSON } from './config.js';
import { evaluateSkip } from './skip.js';
import { NothingPlayingError, StalePlayError } from './player.js';
import { SpotifyError, NotConnectedError, RateLimitedError } from './spotify.js';
import {
  COOKIE_NAME, cookieValueFor, passcodeMatches, createLoginLimiter,
  requireAuth, requireJson, securityHeaders,
} from './auth.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const STATE_TTL_MS = 10 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clientIdOf(req) {
  const id = req.get('x-client-id');
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new HttpError(400, 'Missing or invalid X-Client-Id');
  return id;
}

function nameOf(req) {
  const name = req.body?.name;
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 30) throw new HttpError(400, 'Name must be 1-30 characters');
  return trimmed;
}

function publicItem(item, clientId) {
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    album: item.album,
    imageUrl: item.imageUrl,
    durationMs: item.durationMs,
    explicit: item.explicit,
    requestedBy: item.requestedBy,
    source: item.source,
    mine: item.requesterId != null && item.requesterId === clientId,
  };
}

export function createApp({ config, store, spotify, player, now = Date.now, randomId = crypto.randomUUID }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const cookieValue = cookieValueFor(config.officePasscode);
  const limiter = createLoginLimiter({ now });
  const oauthStates = new Map(); // state -> expiresAt

  app.use(securityHeaders);
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

  app.post('/api/login', (req, res) => {
    if (limiter.isBlocked(req.ip)) return res.status(429).json({ error: 'Too many attempts, try again later' });
    if (!passcodeMatches(req.body?.passcode, config.officePasscode)) {
      limiter.recordFailure(req.ip);
      return res.status(401).json({ error: 'Wrong passcode' });
    }
    limiter.reset(req.ip);
    res.cookie(COOKIE_NAME, cookieValue, {
      httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge: YEAR_MS,
    });
    res.status(204).end();
  });

  app.use(requireAuth(cookieValue));
  app.use(requireJson);

  // ---- API ----
  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.get('/state', (req, res) => {
    const clientId = clientIdOf(req);
    const ps = player.getState();
    const cur = store.currentPlay();
    let nowPlaying = null;
    if (cur) {
      const votes = store.listSkipVotes(cur.id);
      const ev = evaluateSkip(cur, votes);
      nowPlaying = {
        playId: cur.id,
        trackId: cur.trackId,
        title: cur.title,
        artist: cur.artist,
        album: cur.album,
        imageUrl: cur.imageUrl,
        durationMs: cur.durationMs,
        progressMs: ps.progressMs,
        isPlaying: ps.isPlaying,
        requestedBy: cur.requestedBy,
        source: cur.source,
        votes: votes.map((v) => v.voterName),
        voteCount: ev.votes,
        votesNeeded: ev.needed,
        iVoted: votes.some((v) => v.voterId === clientId),
      };
    }
    res.json({
      status: ps.status,
      message: ps.message,
      nowPlaying,
      queue: store.listQueue().map((i) => publicItem(i, clientId)),
      serverTime: now(),
      me: { queued: store.countQueuedBy(clientId), max: MAX_QUEUED_PER_PERSON },
    });
  });

  api.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 1 || q.length > 100) throw new HttpError(400, 'Search text must be 1-100 characters');
    res.json({ tracks: await spotify.search(q) });
  });

  api.post('/queue', async (req, res) => {
    const clientId = clientIdOf(req);
    const name = nameOf(req);
    const trackId = req.body?.trackId;
    if (typeof trackId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(trackId)) throw new HttpError(400, 'Invalid trackId');

    const check = () => {
      if (store.isTrackQueuedOrPlaying(trackId)) throw new HttpError(409, 'That song is already queued or playing');
      if (store.countQueuedBy(clientId) >= MAX_QUEUED_PER_PERSON) {
        throw new HttpError(409, `Limit reached: you can have ${MAX_QUEUED_PER_PERSON} songs in the queue`);
      }
    };
    check();
    const track = await spotify.getTrack(trackId);
    check(); // state may have changed while waiting for Spotify
    const item = store.enqueue(track, { requestedBy: name, requesterId: clientId, source: 'request' }, now());
    player.kick();
    res.status(201).json(publicItem(item, clientId));
  });

  api.delete('/queue/:id', (req, res) => {
    const clientId = clientIdOf(req);
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const item = Number.isSafeInteger(id) ? store.getQueueItem(id) : null;
    if (!item) throw new HttpError(404, 'Queue item not found');
    if (item.requesterId == null || item.requesterId !== clientId) throw new HttpError(403, 'You can only remove your own songs');
    store.removeQueueItem(id);
    res.status(204).end();
  });

  api.post('/skip', async (req, res) => {
    const clientId = clientIdOf(req);
    const name = nameOf(req);
    const playId = req.body?.playId;
    if (!Number.isSafeInteger(playId)) throw new HttpError(400, 'Invalid playId');
    res.json(await player.skip(clientId, name, playId));
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // ---- Spotify login ----
  app.get('/auth/login', (req, res) => {
    if (spotify.isConnected()) throw new HttpError(409, 'Spotify is already connected');
    const t = now();
    for (const [s, exp] of oauthStates) if (exp <= t) oauthStates.delete(s);
    const state = randomId();
    oauthStates.set(state, t + STATE_TTL_MS);
    res.redirect(spotify.authorizeUrl(state));
  });

  app.get('/auth/callback', async (req, res) => {
    const { state, code, error } = req.query;
    const expiresAt = typeof state === 'string' ? oauthStates.get(state) : undefined;
    if (typeof state === 'string') oauthStates.delete(state);
    if (expiresAt === undefined || expiresAt <= now()) throw new HttpError(400, 'Invalid or expired login state');
    if (typeof error === 'string') return res.redirect('/');
    if (typeof code !== 'string' || !code) throw new HttpError(400, 'Missing code');
    await spotify.exchangeCode(code);
    res.redirect('/');
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof NothingPlayingError || err instanceof StalePlayError) return res.status(409).json({ error: err.message });
    if (err instanceof NotConnectedError) return res.status(503).json({ error: "Spotify isn't connected yet" });
    if (err instanceof RateLimitedError) return res.status(503).json({ error: 'Spotify is busy, try again in a moment' });
    if (err instanceof SpotifyError) return res.status(502).json({ error: err.message });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.status === 413) return res.status(413).json({ error: 'Request body too large' });
    if (err?.status >= 400 && err.status < 500) return res.status(400).json({ error: 'Invalid request body' });
    console.error('unhandled error:', err?.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
