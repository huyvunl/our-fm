# Our FM

Office song request queue that plays through Spotify on a Bluetooth speaker.

Colleagues open one web page, enter the office passcode and their name, and add
Spotify songs to a shared queue. The server plays them in order on the speaker
iPhone through the Spotify Web API. The page shows what is playing, its progress,
what is next, and who asked for each song. A song is skipped when 3 people vote,
or 2 if one of them requested it. Every play is logged in SQLite.

- Design: [docs/superpowers/specs/2026-11-17-our-fm-v1-design.md](docs/superpowers/specs/2026-11-17-our-fm-v1-design.md)
- Deploying (owner steps): [DEPLOY.md](DEPLOY.md)

## Run locally

Needs Node.js 24.

```bash
cp .env.example .env   # then fill in the values
npm install
npm run dev            # http://127.0.0.1:3000
```

For a real Spotify connection locally, register `http://127.0.0.1:3000/auth/callback`
as a redirect URI in your Spotify app (Spotify doesn't accept `localhost`).

## Test

```bash
npm test
```

Tests use `node:test` with a fake Spotify client, so they need no credentials or network.

## Layout

| Path | What it does |
|---|---|
| `src/config.js` | Reads and validates environment variables; holds limits |
| `src/db.js` | SQLite schema and queries (`queue`, `plays`, `skip_votes`, `settings`) |
| `src/spotify.js` | Spotify Web API client with token refresh |
| `src/player.js` | Playback loop: starts songs, detects their end, skip votes |
| `src/skip.js` | Skip vote rules |
| `src/autopick.js` | Placeholder for future auto-play when the queue is empty |
| `src/auth.js`, `src/app.js` | Passcode cookie and HTTP API |
| `src/server.js` | Entry point |
| `public/` | The web page |
