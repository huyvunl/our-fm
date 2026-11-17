const API = 'https://api.spotify.com';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const REFRESH_KEY = 'refresh_token';

export class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
  }
}

export class NotConnectedError extends Error {
  constructor(message = 'Spotify is not connected') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`Spotify rate limited, retry in ${retryAfterMs} ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

function mapTrack(t) {
  const images = t.album?.images ?? [];
  return {
    id: t.id,
    uri: t.uri,
    title: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join(', '),
    artistId: t.artists?.[0]?.id ?? null,
    album: t.album?.name ?? '',
    durationMs: t.duration_ms,
    explicit: !!t.explicit,
    imageUrl: images[1]?.url ?? images[0]?.url ?? null,
  };
}

export function createSpotify({ clientId, clientSecret, redirectUri, store, fetch = globalThis.fetch, now = Date.now }) {
  let accessToken = null;
  let expiresAt = 0;

  const basic = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body?.error === 'invalid_grant') {
      accessToken = null;
      store.deleteSetting(REFRESH_KEY);
      throw new NotConnectedError('Spotify authorization was revoked or expired');
    }
    if (!res.ok || !body?.access_token) {
      throw new SpotifyError(`Spotify token request failed (${res.status})`, res.status);
    }
    accessToken = body.access_token;
    expiresAt = now() + (body.expires_in ?? 3600) * 1000 - 60_000;
    if (body.refresh_token) store.setSetting(REFRESH_KEY, body.refresh_token);
  }

  async function ensureToken(force = false) {
    if (!force && accessToken && now() < expiresAt) return accessToken;
    const rt = store.getSetting(REFRESH_KEY);
    if (!rt) throw new NotConnectedError();
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
    return accessToken;
  }

  async function api(method, pathAndQuery, body) {
    const pathOnly = pathAndQuery.split('?')[0];
    for (let attempt = 0; ; attempt++) {
      const token = await ensureToken(attempt > 0);
      const init = { method, headers: { Authorization: `Bearer ${token}` } };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(API + pathAndQuery, init);
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 429) {
        const secs = Number(res.headers.get('Retry-After'));
        throw new RateLimitedError(Number.isFinite(secs) && secs > 0 ? secs * 1000 : 5000);
      }
      if (res.status === 204) return null;
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const detail = typeof data?.error?.message === 'string' ? `: ${data.error.message}` : '';
        throw new SpotifyError(`Spotify ${method} ${pathOnly} failed (${res.status})${detail}`, res.status);
      }
      return data;
    }
  }

  const enc = encodeURIComponent;

  return {
    isConnected() {
      return store.getSetting(REFRESH_KEY) !== null;
    },
    authorizeUrl(state) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: SCOPES,
        redirect_uri: redirectUri,
        state,
      });
      return `${AUTH_URL}?${q}`;
    },
    async exchangeCode(code) {
      await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    },
    async search(q) {
      const data = await api('GET', `/v1/search?type=track&limit=10&market=from_token&q=${enc(q)}`);
      return (data?.tracks?.items ?? []).map(mapTrack);
    },
    async getTrack(id) {
      return mapTrack(await api('GET', `/v1/tracks/${enc(id)}?market=from_token`));
    },
    async getDevices() {
      const data = await api('GET', '/v1/me/player/devices');
      return (data?.devices ?? []).map((d) => ({ id: d.id, name: d.name, isActive: !!d.is_active }));
    },
    async getPlayer() {
      const data = await api('GET', '/v1/me/player');
      if (!data) return null;
      return {
        trackId: data.item?.id ?? null,
        progressMs: data.progress_ms ?? 0,
        isPlaying: !!data.is_playing,
        deviceId: data.device?.id ?? null,
      };
    },
    async play(deviceId, uri) {
      await api('PUT', `/v1/me/player/play?device_id=${enc(deviceId)}`, { uris: [uri] });
    },
    async pause(deviceId) {
      await api('PUT', `/v1/me/player/pause?device_id=${enc(deviceId)}`);
    },
    async transfer(deviceId) {
      await api('PUT', '/v1/me/player', { device_ids: [deviceId], play: false });
    },
  };
}
