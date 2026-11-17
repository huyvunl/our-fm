# Our FM v1 — Design

## Intent

About 8 colleagues replace an ad-filled office radio with a shared song queue.
Anyone opens a web page, adds Spotify songs, and the songs play in order on the
office Bluetooth speaker. An old iPhone runs the Spotify app paired to that
speaker. A cloud server (Railway, ~$5/month, free `*.up.railway.app` HTTPS URL)
controls the iPhone through the Spotify Web API. The owner has Spotify Premium.

**Success:** a colleague can add a song in under 30 seconds; songs play back to
back without anyone touching the iPhone; everyone sees what is playing, its
progress, what is next, and who asked for each; one person cannot skip
everything; every play is logged.

**Out of scope for v1, designed for:** auto-play when the queue is empty, with
no-repeat rules, veto, and an explicit-lyrics filter.

## Approach

The server owns the queue and starts each track with
`PUT /me/player/play {uris:[uri]}` on the speaker iPhone. It polls
`GET /me/player` every 3 s to notice when a track ends.

Rejected:
- **Spotify's native queue** (`POST /me/player/queue`): items can't be removed
  or reordered, so attribution, removal and skip votes drift from reality.
- **Web Playback SDK**: makes a browser the device; the speaker is paired to the
  iPhone.

## Known Spotify constraints

- Development Mode apps have a small user allowlist; only the owner logs in, so
  this is fine. The owner must be Premium (they are).
- Recommendations, related-artists and audio-features endpoints are not
  available to new apps (deprecated late 2024). Future auto-play must build
  candidates from our own `plays` log, `GET /me/player/recently-played` (max 50)
  and `GET /me/top/tracks` only.
- The iPhone drops out of `GET /me/player/devices` when Spotify is backgrounded
  for long or the phone sleeps. DEPLOY.md tells the owner: keep it charging,
  Auto-Lock off, Spotify open, and Spotify's own Autoplay setting off.
- Redirect URIs must be HTTPS (or a loopback IP such as `http://127.0.0.1`), so
  production uses the Railway URL.

## Architecture

One Node.js 24 process (Express 5, the only dependency), one SQLite file via
built-in `node:sqlite`, one static page. Railway runs a single instance (the
volume forces that), so in-memory state such as rate limits and the OAuth nonce
is acceptable.

| Unit | Purpose | Depends on |
|---|---|---|
| `src/config.js` | Read and validate env; fail fast. Holds constants. | env |
| `src/db.js` | Open SQLite, create schema, all SQL. | `node:sqlite` |
| `src/spotify.js` | Spotify HTTP client: token refresh, search, track, devices, player, play, pause, transfer. Injectable `fetch`. | `db` (token storage), fetch |
| `src/skip.js` | Pure function: votes needed and pass/fail. | — |
| `src/autopick.js` | Seam for future auto-play. `pick()` returns `null` in v1. | — |
| `src/player.js` | Tick loop and the playback state machine. Serializes tick, timer and skip with one lock. | `db`, `spotify`, `skip`, `autopick`, clock |
| `src/auth.js` | Passcode cookie, login rate limit, JSON-only guard. | `config` |
| `src/app.js` | Express routes. Builds the app from injected deps (testable). | all above |
| `src/server.js` | Boot: config, db, spotify, player, app, listen. | all above |
| `public/index.html`, `public/app.js` | The UI. No build step. | API |

## Configuration

Env vars (all in `.env.example` with placeholder values; `.env` is gitignored):

| Var | Required | Notes |
|---|---|---|
| `OFFICE_PASSCODE` | yes | At least 8 characters, otherwise startup fails. |
| `SPOTIFY_CLIENT_ID` | yes | |
| `SPOTIFY_CLIENT_SECRET` | yes | |
| `SPOTIFY_REDIRECT_URI` | yes | e.g. `https://our-fm-production.up.railway.app/auth/callback` |
| `SPOTIFY_DEVICE_NAME` | no | Exact device name; falls back to the first available device. |
| `DB_PATH` | no | Default `./data/our-fm.db`; Railway: `/data/our-fm.db`. Parent dir is created if missing. |
| `PORT` | no | Railway sets it; default 3000. |

Constants in `config.js`: `MAX_QUEUED_PER_PERSON = 3`, `SKIP_VOTES = 3`,
`SKIP_VOTES_WITH_REQUESTER = 2`, `TICK_MS = 3000`, `START_GRACE_MS = 5000`,
`LOOKAHEAD_MS = 3500`.

Local run: `npm run dev` = `node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/server.js`.
Railway: `npm start` = `node --disable-warning=ExperimentalWarning src/server.js`; `engines.node` is `24.x`
(`node:sqlite` is still flagged experimental in Node 24 but needs no flag).

## Identity

No accounts. On first visit the page asks for a display name and creates a
random `clientId` (UUID); both live in `localStorage`. Every API request sends
the clientId in an `X-Client-Id` header (kept out of URLs and logs); mutating
requests also send `name` in the JSON body. The **clientId** keys the per-person cap,
skip votes and "remove my own song"; the **name** is for display and is what
`plays.requested_by` records. This is spoofable by anyone with dev tools; that
is accepted for 8 trusted colleagues behind a passcode. The clientId only
prevents casual ballot stuffing by typing different names.

Name: trimmed, 1–30 characters. clientId: 8–64 characters of `[A-Za-z0-9-]`.

## Data model (SQLite)

```sql
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- refresh_token lives here.

CREATE TABLE IF NOT EXISTS queue (            -- pending items only
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL, uri TEXT NOT NULL,
  title TEXT NOT NULL, artist TEXT NOT NULL, artist_id TEXT, album TEXT NOT NULL,
  duration_ms INTEGER NOT NULL, explicit INTEGER NOT NULL, image_url TEXT,
  requested_by TEXT, requester_id TEXT,       -- NULL for auto
  source TEXT NOT NULL CHECK (source IN ('request','auto')),
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (            -- the play log, from day one
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
  artist_id TEXT, album TEXT NOT NULL,
  duration_ms INTEGER NOT NULL, explicit INTEGER NOT NULL,
  uri TEXT NOT NULL, image_url TEXT,
  requested_by TEXT, requester_id TEXT,       -- NULL for auto
  source TEXT NOT NULL CHECK (source IN ('request','auto')),
  started_at TEXT NOT NULL, ended_at TEXT,
  skipped INTEGER NOT NULL DEFAULT 0, progress_ms_at_skip INTEGER
);
CREATE INDEX IF NOT EXISTS plays_started ON plays(started_at);

CREATE TABLE IF NOT EXISTS skip_votes (
  play_id INTEGER NOT NULL REFERENCES plays(id),
  voter_id TEXT NOT NULL, voter_name TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (play_id, voter_id)
);
```

- Queue order: `ORDER BY (source = 'auto'), id` — requests always before auto-picks.
- The current song is the one `plays` row with `ended_at IS NULL`. Starting a
  track deletes the queue row and inserts the plays row in one transaction.
- Times are ISO 8601 UTC strings. `artist` is the comma-joined artist names;
  `artist_id` is the primary artist's id (for the future no-repeat rule).
- Journal mode WAL.

## Spotify client (`spotify.js`)

- Scopes (least privilege for v1): `user-read-playback-state`,
  `user-modify-playback-state`. Future auto-play adds `user-read-recently-played`
  and `user-top-read`, which means the owner logs in once more.
- Access token cached in memory with expiry; refreshed from the stored refresh
  token via `POST https://accounts.spotify.com/api/token` (Basic auth). A new
  refresh token in the response replaces the stored one.
- On 401: refresh once and retry. On `invalid_grant`: delete the refresh token
  (status becomes `needs_auth`).
- On 403 (e.g. a Development Mode restriction or a non-Premium account):
  throw a `SpotifyError` whose message names the endpoint; the player shows it
  as status `error`, search/queue return 502 with that message.
- On 429: throw a `RateLimited` error carrying `Retry-After`; the player skips
  ticks until then.
- Never log tokens, codes or the Authorization header.
- Methods: `isConnected()`, `exchangeCode(code)`, `search(q)` (limit 10, type
  track, market `from_token`), `getTrack(id)`, `getDevices()`, `getPlayer()`
  (`null` on 204), `play(deviceId, uri)`, `pause(deviceId)`,
  `transfer(deviceId)`. Each returns plain objects; track objects are mapped to
  `{id, uri, title, artist, artistId, album, durationMs, explicit, imageUrl}`.

## Player (`player.js`)

State exposed to the API: `status` ∈ `needs_auth | no_device | idle | playing |
paused | error`, `lastProgressMs`, `lastIsPlaying`, `lastUpdateAt`, `message`.

One lock (a promise chain) serializes `tick()`, the lookahead timer and
`skip()`. Every action re-reads the current play from the DB inside the lock and
checks the play id it was scheduled for, so nothing double-advances.

**tick()**, every `TICK_MS`:
1. Not connected → `needs_auth`, stop.
2. Inside a 429 back-off window → stop.
3. `p = getPlayer()`; `cur` = current play.
4. If `cur`:
   - `p` shows `cur.track_id`: record progress and is_playing.
     - Playing and `remaining ≤ LOOKAHEAD_MS` → arm a single timer (keyed by
       `cur.id`) for `remaining` ms that calls `advance(cur.id)`.
     - Not playing and (`progress == 0` or `remaining < 2000`) → `advance(cur.id)`.
     - Not playing mid-track → `paused` (someone paused the iPhone); wait.
   - `p` shows something else or nothing, and `cur` started more than
     `START_GRACE_MS` ago → count a miss; on the **second consecutive** miss
     `advance(cur.id)` (a single transient 204 doesn't end a song). Seeing
     `cur` resets the counter. This also reconciles a stale current play after
     a server restart, and a play that never actually started.
5. If no `cur` and the queue is non-empty → `startNext()`.
6. If no `cur` and the queue is empty → `autopick.pick()`; when it returns a
   track, enqueue it with source `auto` and `startNext()`. In v1 it returns
   `null` → `idle`.

**advance(playId, {skipped, progressMs})**: if `playId` is still current, set
`ended_at` (and `skipped`, `progress_ms_at_skip`), cancel the lookahead timer, then
`startNext()`. If there is nothing to start, call `pause()` so Spotify's own
autoplay can't play unlogged songs (errors from pause are ignored).

**startNext()**:
1. Next queue row (or autopick; v1 none) → if none, `idle`.
2. Device: `getDevices()`; pick the one named `SPOTIFY_DEVICE_NAME`, else the
   first. None → `no_device`; queue waits; retry next tick.
3. `play(device.id, uri)`. On 404 (no active device): `transfer(device.id)`, then
   retry `play` once. Still failing → `no_device`.
4. Success → in one transaction delete the queue row and insert the plays row
   with `started_at = now` → `playing`.

The lookahead timer is kept on purpose: without it each song change has up
to 3 s of silence. It is one timer, armed once per play id, run inside the
lock, and it re-checks the play id, so it cannot double-advance.

Errors other than 429/auth: log a short message, status `error` with message,
retry next tick. The loop never throws out.

## Skip (`skip.js`, used by `player.skip`)

`votesNeeded(play, voterIds)`:
- `source = 'auto'` → 1 (anyone can veto an auto-pick).
- the requester (`requester_id`) has voted → `SKIP_VOTES_WITH_REQUESTER` (2).
- otherwise → `SKIP_VOTES` (3).

`player.skip(clientId, name)`, inside the lock: no current play → 409.
Insert vote (idempotent per voter). Votes belong to one play, so they reset
with every song. A vote counts toward the threshold only if both its clientId
and its normalized name (trimmed, lower-case) are new for this play, so
clearing localStorage and re-entering your name doesn't add a vote. The
requester is recognised by `requester_id`. If counted voters ≥ needed →
`advance(cur.id, {skipped: true, progressMs: estimated current progress})`.
Returns `{votes, needed, skipped}`.

Estimated progress = `lastProgressMs + (now − lastUpdateAt)` when playing,
capped at `duration_ms`.

## Access control (`auth.js`)

- `app.set('trust proxy', 1)` (Railway puts one proxy in front) so `req.ip` is
  the client IP.
- `POST /api/login {passcode}`: timing-safe compare. Success sets cookie
  `ofm` = HMAC-SHA256(key = passcode, "our-fm-v1") hex; `HttpOnly; Secure`
  (when the request is HTTPS); `SameSite=Lax; Path=/; Max-Age` 1 year. Changing
  the passcode logs everyone out. Failures: max 10 per IP per 15 min → 429.
- `requireAuth` guards every route except `GET /healthz`, `POST /api/login`,
  the login page and static assets. API calls without the cookie get 401; the
  page shows the passcode form instead of the app (the client checks via
  `GET /api/state` → 401).
- The cookie value is a static secret shared by all browsers; it stays valid
  until the passcode changes. Accepted for this audience.
- `Secure` is set when `req.secure` is true, which works behind Railway's proxy
  because `trust proxy` is set.
- Every response gets `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and
  `Content-Security-Policy: default-src 'self'; img-src 'self' https://i.scdn.co; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`.
  Spotify cover art comes from `i.scdn.co`.
- Mutating routes (`POST`, `DELETE`) require `Content-Type: application/json`,
  else 415. With `SameSite=Lax` this blocks cross-site form posts.

## Spotify login (owner, one time)

- `GET /auth/login`: needs the office cookie **and** only works while Spotify
  is not connected (no refresh token); otherwise 409 "already connected". This
  stops a colleague from silently swapping in their own account. It creates a
  random `state`, keeps it in memory for 10 minutes, and redirects to Spotify's
  authorize URL.
- `GET /auth/callback?code&state`: `state` must match a live nonce (single use),
  else 400. Exchange the code, store the refresh token, redirect to `/`.
- To reconnect a different account later, Spotify revoking access (owner removes
  the app at spotify.com/account/apps) yields `invalid_grant`, which clears the
  token and reopens `/auth/login`.

## HTTP API

All JSON. All need the cookie except where noted.

| Route | Body / query | Result |
|---|---|---|
| `GET /healthz` (open) | | `200 ok` |
| `POST /api/login` (open) | `{passcode}` | 204 + cookie; 401; 429 |
| `GET /api/state` | header `X-Client-Id` | `{status, message, nowPlaying, queue, serverTime, me:{queued, max}}` |
| `GET /api/search` | `?q` (1–100 chars) | `{tracks:[…]}` (needs connection, else 503) |
| `POST /api/queue` | `{trackId, name}` | 201 item; 400 invalid; 409 duplicate or "limit reached"; 503 not connected |
| `DELETE /api/queue/:id` | (header) | 204; 403 not yours; 404 |
| `POST /api/skip` | `{name}` | `{votes, needed, skipped}`; 409 nothing playing |
| `GET /auth/login`, `GET /auth/callback` | | see above |

`nowPlaying`: `{playId, trackId, title, artist, album, imageUrl, durationMs,
progressMs, isPlaying, requestedBy, source, votes:[names], votesNeeded,
iVoted}`. `queue` items: `{id, title, artist, album, imageUrl, durationMs,
explicit, requestedBy, source, mine}`.

`POST /api/queue` fetches the track from `GET /v1/tracks/{id}` (client metadata
is not trusted). It rejects a track that is already queued or currently
playing (409); requests are not otherwise blocked by recent plays — the 2 h
no-repeat rule applies to auto-picks only. It enforces `MAX_QUEUED_PER_PERSON` pending requests per
`clientId` (409 with a clear message). After inserting, it nudges the player
(`player.kick()` runs a tick now) so an idle system starts within a second.

Error bodies: `{error: "human readable message"}`.

## UI (`public/`)

Single page, plain HTML + one script, no framework, no inline script (CSP).
Mobile friendly.

1. **Passcode view** when `/api/state` returns 401.
2. **Name prompt** on first visit (stored with a generated clientId); a small
   "change name" link.
3. **Status banner:** `no_device` → "Open Spotify on the speaker iPhone";
   `needs_auth` → "Spotify isn't connected yet — owner: open /auth/login";
   `error` → the message; `idle` → "Queue is empty — add a song".
4. **Now playing:** cover, title, artist, "requested by X", progress bar and
   times interpolated client-side between polls, Skip button showing
   "Skip (votes/needed)" and disabled after you voted.
5. **Search:** debounced input (400 ms) → results with cover, title, artist,
   explicit badge, duration, Add button. Shows "2 of 3 slots used".
6. **Up next:** ordered list with requester; "Remove" on your own items.

Polling `GET /api/state` every 3 s (immediately after any action). All text is
inserted with `textContent` (no HTML injection from song titles or names).

## Future auto-play (designed, not built)

- `autopick.pick({db, spotify, now})` returns a track or `null`. The player
  already calls it when the queue is empty and enqueues results with source
  `auto`, which sort after requests.
- Candidates: our `plays` log, recently-played, top tracks.
- No repeat: exclude `track_id` or `artist_id` present in `plays` with
  `started_at` within the last 2 h (the `plays_started` index serves this).
- Veto: already in v1 — an auto-pick skips on 1 vote.
- Explicit filter: a `settings` row `explicit_filter`; the picker drops
  `explicit = 1` candidates.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Spotify not connected | status `needs_auth`; search and queueing return 503 (the track can't be looked up). |
| No device | `no_device`; queue kept; retried each tick. |
| 404 on play | transfer + one retry, then `no_device`. |
| 400/403 on play | first time: drop that item with a message; second in a row: keep the queue, show the error, back off 60 s. |
| 401 | refresh once; `invalid_grant` → token cleared → `needs_auth`. |
| 429 | back off for Retry-After. |
| Network / 5xx | status `error`, retry next tick. |
| Someone pauses on the iPhone | `paused`; we wait. |
| Someone plays something else on the iPhone | after grace, current play ends (not skipped), next request starts. |
| Server restart | stale current play reconciled by the tick rule. |

## Testing

`node --test` (Node 24 built-in), no extra test deps.

- `db`: schema, queue order (requests before auto), start-track transaction,
  per-client counts, duplicate detection — against `:memory:`.
- `skip`: thresholds for request, requester-voted, auto.
- `spotify`: fake `fetch` — token refresh and caching, 401 retry, 429 error,
  `invalid_grant` clears token, track mapping, 204 → null.
- `player`: fake Spotify client and injected clock/timers — starts next when
  idle; advances on track change, on stop at end, via lookahead timer; ignores
  mismatch during grace; pauses on empty queue after end; paused mid-track
  waits; no device; 404 → transfer → retry; skip thresholds end the play with
  `skipped=1` and progress; no double advance when timer and tick race.
- `auth` + `app`: Express app on port 0 with fake player/spotify — 401 without
  cookie, login sets cookie, rate limit, 415 on non-JSON, queue cap, duplicate,
  remove-own/403, `/auth/login` 409 when connected, state nonce check.
- Smoke: boot `server.js` with dummy env and a temp DB; `/healthz` 200; login;
  `/api/state` → `needs_auth`.
