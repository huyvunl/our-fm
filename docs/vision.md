# Our FM: the final product and the road to it

Status: researched vision, 2026-11-17, revised after two reviews (see
`docs/reviews.md`). v1 is built and merged (see
`docs/superpowers/specs/2026-11-17-our-fm-v1-design.md`). This document says
what the finished Our FM contains and splits it into versions. It does not
design any version in detail; each version gets its own spec before building.

## Intent

About 8 colleagues replace an ad-filled office radio. Anyone opens a web page
and adds Spotify songs to a shared queue. A Node.js server owns the queue and
plays the songs through the Spotify Web API on the owner's Premium account. The
play device is the Spotify app on an old iPhone (or a PC) paired to a Bluetooth
speaker.

**Constraints:** about 8 users; free or about $5/month (Railway Hobby);
one Spotify Premium account; a Spotify app in Development Mode (Extended Quota
is closed to individuals, see Risks).

**What the owner asked for**
- Shared queue, now playing, skip with a safeguard. *(v1, built)*
- Log every play from day one. *(v1, built; v1.1 makes the log accurate)*
- Auto-play from office history when the queue is empty, with rules: no repeat
  of a song or artist within about 2 h; requests jump ahead of auto-picks;
  anyone can veto an auto-pick; optional explicit filter.
- A much better UI.
- A much better search, like Spotify's: look up an artist and browse their
  songs, top tracks and albums.

**v1 test findings that shape the plan**
- A skip done in the Spotify app is logged as a full play. This corrupts the
  data auto-play will learn from, so it is fixed first.
- `SKIP_VOTES` is an env setting. The owner tests with 1; the office default is
  3, or 2 when the requester votes.
- The Spotify web player (open.spotify.com) works as a play device. That gives a
  fallback when the iPhone drops out.

**Success for the finished product:** music plays all office day without anyone
touching the phone; anyone can find any song or artist in seconds; nobody
dominates the queue; quiet falls when it should; the office never hears the
same song twice in a morning.

## What the research changed

The Spotify Web API for a Development Mode app is much smaller than in 2024.
These facts decide what can be built (sources at the end):

| Capability | Status for our app | Consequence |
|---|---|---|
| Recommendations, related artists, audio features, audio analysis | Unavailable to apps created after 2024-11-27 [S1] | Auto-play cannot ask Spotify "what's similar". It must learn from our own play log, likes and an owner seed playlist. No mood or energy matching. |
| `GET /artists/{id}/top-tracks` | **Removed** for Development Mode apps (new apps 2026-02-11, existing apps 2026-03-09) [S2][S3] | The "top tracks" part of the search ask cannot be built as Spotify shows it. We approximate it (see v1.3). |
| `popularity` on tracks, albums, artists; artist `followers`; album `album_group` | Removed [S2] | We cannot sort by popularity. |
| `GET /search` | Kept. `limit` max **10** (was 50), default 5; `offset` up to 1000; filters `artist:`, `album:`, `track:`, `year:`, `genre:`. Result order is not documented. [S2][S4] | Search pages need "load more". |
| `GET /artists/{id}/albums` | Kept. `limit` max **10**, default 5; `include_groups` = `album`, `single`, `appears_on`, `compilation` [S5] | Albums and singles are separate paged calls with "load more". |
| `GET /artists/{id}`, `/albums/{id}`, `/albums/{id}/tracks`, `/tracks/{id}` | Kept, with the field removals above [S2] | Artist and album pages are buildable. |
| Batch `GET /tracks`, `/albums`, `/artists` | Removed [S2] | One call per item. Cache lookups. |
| `/me/player/*`, `GET`/`POST /me/player/queue`, `/me/player/recently-played`, `/me/top/{type}` | Kept [S2] | v1's playback design stands. |
| `GET /playlists/{id}/items` | Only for playlists the user owns or collaborates on [S3] | An owner-made seed playlist works for auto-play; other people's playlists do not. |
| Development Mode | Max 5 allowlisted users; owner must be Premium; Extended Quota needs a registered business with 250k monthly users [S6]. Quota is per developer account with **no published numbers or reset window**; a 429 carries `"reason": "QUOTA_EXCEEDED"`. Rate limits use a rolling 30 s window with `Retry-After` [S7] | Only the owner logs in to Spotify, as today. Keep call volume low and measure it. |
| Volume | Each device reports `supports_volume`; `PUT /me/player/volume` exists [S8]. Forum reports say phones often refuse it (unverified) [S8] | "Quiet" pauses rather than lowering the volume. |

Comparable products contributed these ideas:

- **Spotify Jam:** guests add songs; the host can stop guests changing what plays [S9]. Jam users ask for round-robin turns so one heavy adder doesn't bury everyone [S13]. → fair queue.
- **Festify:** a fallback playlist "will be played if no other songs are queued"; guests' votes move songs up the queue [S10]. → owner seed playlist for auto-play; vote-sorting rejected.
- **OutLoud:** the most-voted song plays next [S11]. → rejected for 8 people (see Out of scope).
- **Jukestar:** request, vote and veto [S11]. → we already have veto.
- **Rockbot:** explicit filter, time-based volume schedules, limits on requests [S12]. → explicit filter, office hours.
- **Open-source Jukebox and GoParty:** round-robin fair queueing [S13].

What makes office music work socially. These come from vendor surveys, so they
give direction, not data [S14][S15]:

- One person controlling the music hurts morale, so everyone gets a voice.
- The common fights are about volume, repetition and unsuitable songs. Our
  answers are quiet controls, no-repeat rules, the explicit filter and veto.
- People judge each other's taste. Requests show a name, but skips stay low-key:
  a threshold, not a public shaming.

## Final product

Every capability, grouped by theme. The tag is the version that delivers it.

### 1. Play & queue
- Shared queue, requests first, auto-picks after. `v1`
- Now playing with cover, progress, requester. `v1`
- Max 3 queued per person, remove your own. `v1`
- **Fair queue:** the person served longest ago goes next. `v1.2`
- **Requester can skip their own song alone** (1 vote). `v1.2`
- **Owner basics:** with the owner passcode, remove any song, force-skip, pause and resume. `v1.2`

### 2. Skip & veto
- Skip votes: 3, or 2 with the requester; env `SKIP_VOTES`. `v1`
- Veto: one vote skips an auto-pick. `v1`
- **Every play records how it ended** (`natural`, `vote`, `veto`,
  `device_skip`, `owner`, `lost`) and how far it got. A skip in the Spotify app
  is a `device_skip`. `v1.1`
- A vetoed auto-pick, or one skipped in the Spotify app, is not auto-picked again for 30 days. `v2`

### 3. Find music (search)
- Track search. `v1`
- **Recently played** list with "add again" ("what was that song?"). `v1.2`
- **Spotify-style typeahead:** one search returns artists, songs and albums;
  when the query matches an artist, that artist's card comes first. 10 per
  section, "load more". `v1.3`
- **Artist page:** "Popular" (approximation, see v1.3), "Office favourites"
  from our log, Albums and Singles (separate paged lists). `v1.3`
- **Album page:** track list, add any track. `v1.3`
- "Open in Spotify" link so a colleague can save a song to their own account. `v1.3`

### 4. Look & feel
- **Redesigned, mobile-first UI:** large now-playing card, clear up-next list,
  dark and light themes, coloured initials per person, installable to a phone
  home screen (PWA manifest), and a clear state for "queue empty, auto-play
  next". `v1.4`

### 5. Auto-play
- Picks a song when the queue is empty, during office hours only. `v2`
- Candidates: the owner's seed playlist from day one, plus songs the office
  requested and let finish, weighted by repeat requests and likes. History
  takes over gradually as the log grows. `v2`
- Rules: no repeat of a track or artist within 2 h (requests and auto-picks
  both count); requests jump ahead; veto with one vote; optional explicit
  filter. `v2`
- Shows why a song was picked ("liked by 3", "from the seed playlist"). `v2`

### 6. Office etiquette
- **Quiet now:** anyone can pause the music for 15/30/60 minutes (a call, a
  meeting); the same song resumes afterwards. The page shows who pressed it
  and until when; the owner or the same person can end it early. `v1.2`
- **Office hours:** auto-play runs only inside them; requests still play
  outside them. `v2`

### 7. Data & insight
- Every play logged with requester, source and timing. `v1`
- **End reason and progress on every play**; rows from before v1.1 flagged as
  less reliable. `v1.1`
- **Likes:** a heart on the current song, one per person per play. `v1.2`
- **CSV export of the play log**, the backup of the data auto-play depends on. `v1.2`

### 8. Operations
- Passcode, security headers, rate-limited login. `v1`
- **Hosted on Railway** with a volume for SQLite. `v1.1`
- **Speaker setup docs:** Guided Access, Auto-Lock off, charging, Spotify
  Autoplay off, and the web player as fallback device. `v1.1`
- **Quiet when idle:** no Spotify calls while nothing plays and the queue is
  empty. `v1.1`
- **Quota back-off:** a `QUOTA_EXCEEDED` 429 backs off exponentially and shows
  "Spotify quota reached". `v1.1`
- **Speaker-offline banner** ("offline since 10:42"). `v1.2`
- **Lean polling while playing** (about every 10 s) and a Spotify
  calls-today counter. `v1.2`

### Backlog (built only if the office asks)
Stats page (top songs, artists and requesters; most liked and skipped);
"deeper cuts" from albums of artists the office requests; kiosk view for an
office TV; weekly "Our FM favourites" playlist on the owner's account; a
settings page that moves env settings into the database; a push alert to the
owner's phone through ntfy.sh [S18] when Spotify needs a new login or the
speaker is offline (a long random topic name, and no song or colleague names
in the message, because public topics can be read by anyone who guesses them).

## Versions

**Ordering principle.** Auto-play learns from the play log, so the log must be
correct and collecting office data as early as possible. v1.1 is therefore the
smallest change that makes the log honest, deployed at once. Everything else
follows while the data accumulates. v2 depends only on v1.1's data and v1.2's
office basics, not on the search or UI work, so it can move ahead of v1.3 or
v1.4 if the office wants it sooner.

A "build session" is one focused agent session of spec → plan → build → review.

| Version | Goal | Size | Depends on |
|---|---|---|---|
| v1.1 Honest log | Deployed in the office; every play records how it ended; safe on quota | 1–2 | v1; owner's licensing decision |
| v1.2 Office basics | Fair, quiet-able, owner-controllable | 2–3 | v1.1 |
| v1.3 Spotify-style search | The owner's search ask | 2 | v1.1 |
| v1.4 New look | The owner's UI ask | 1–2 | v1.3 (it restyles the new search screens) |
| v2 Auto-play | Music continues through office hours without repeats | 2 | v1.1 data; v1.2 (owner pause, polling) |

### v1.1 Honest log
**Goal:** Our FM runs in the office, and from that day every logged row says
truthfully how the play ended.

**Before building: a 1-hour real-device spike.** On the iPhone and on the web
player, with `uris:[uri]` and Spotify Autoplay off, record the `GET /me/player`
responses for: next, previous (back to start), pause, a long pause, closing the
app, the phone sleeping, and a natural end. The detection rules below are
confirmed or corrected from these recordings, and the recordings become test
fixtures.

**Scope**
- `plays.end_reason` ∈ `natural | vote | veto | device_skip | owner | lost`, and
  `plays.progress_ms` at end for every play (estimated from the last
  observation). `skipped` stays for compatibility.
- A `device_skip` is counted only when a *different track* shows on the *same
  device* before the current one could have ended. "Back" (same track, progress
  drops) is not a skip. The device disappearing or nothing playing is `lost`.
- A `settings` row records the v1.1 cutover time; analysis treats older rows as
  less reliable.
- **Quiet when idle:** no Spotify calls while nothing plays and the queue is
  empty; a new request wakes the player (`kick()`), and a slow retry (every
  30 s) runs only while songs wait for a device. This alone cuts most of v1's
  ~29,000 calls a day.
- **Quota back-off:** a 429 whose body says `QUOTA_EXCEEDED`, or that has no
  `Retry-After`, backs off exponentially (1 min doubling to 30 min) instead of
  v1's flat 5 s retry, and the banner says "Spotify quota reached".
- A `lost` request that had not reached half its length goes back to the head
  of the queue once.
- `DEPLOY.md`: iOS Guided Access (keeps Spotify in front) and the web player as
  fallback device.
- Deploy to Railway per `DEPLOY.md`; `SKIP_VOTES` unset (3 / 2).

**Done when:** a scripted 10-action device test (natural end, Spotify-app next
×2, back, pause 2 min and resume, two vote skips, a veto of an `auto` item
inserted by a test fixture, closing the app, natural end) produces exactly the
expected `plays` rows, written down in advance with their `end_reason`; the
spike recordings run as player tests; a test shows no Spotify call during an
idle hour and the exponential back-off on a quota 429; the Railway URL serves
the office.

### v1.2 Office basics
**Goal:** the office can live with it every day: nobody dominates, a call can
quiet it, the owner can fix a bad moment, and the server stays well inside
Spotify's limits.

**Scope**
- Fair queue: the next request to play comes from the requester whose last
  song started longest ago (or never), oldest request first; auto-picks last.
  The up-next list shows the simulated play order, round by round, so what
  people see is what will play.
- Requester alone can skip their own request (`end_reason = vote`).
- Owner basics: env `OWNER_PASSCODE` unlocks remove-any, force-skip
  (`end_reason = owner`), pause and resume.
- Quiet now (`POST /api/quiet {minutes}`): always pauses (the iPhone, the main
  device, is reported to refuse volume changes, and pausing keeps the queue
  from draining). The current song stays current and resumes where it
  stopped; nothing is logged as ended. Shows who and until when.
- Likes: `likes(play_id, client_id, name, created_at)`, a heart in the current UI.
- Recently played (last 50) with "add again".
- Polling about every 10 s during a song (the v1 lookahead timer still starts
  the next song on time); a Spotify calls-today counter in `/api/state`;
  speaker-offline banner; CSV export at `GET /api/export/plays.csv`.

**Done when:**
- A simulation test with 3 people runs plays through the queue, not one static
  sort: A queues 3 songs, then B queues 1, then C queues 1. The songs play in
  the order a1, b1, c1, a2, a3.
- Owner actions return 403 without the owner passcode (tested).
- Quiet pauses, then resumes the same song within 5 s of its end time, with no
  `plays` row ended (tested with a fake clock).
- A full office day stays under 5,000 Spotify calls by the `/api/state` counter
  (our own ceiling; Spotify publishes none).
- An iPhone drop-out shows the banner within 15 s and playback resumes within
  30 s of Spotify returning.

### v1.3 Spotify-style search
**Goal:** finding music feels like Spotify: type an artist, land on their page,
browse albums, queue a song.

**Before building: a 1-hour spike.** Compare `search?q=artist:"<name>"&type=track`
order with Spotify's own "Popular" list for 5 artists. If the top 5 mostly
match, the section is labelled "Popular"; otherwise it is labelled "Songs", and
"Office favourites" leads.

**Scope**
- `GET /api/search?q&offset` (types artist, track, album; 10 each), with the
  artist card first when its name matches the query.
- `GET /api/artist/:id` (artist, popular approximation, office favourites from
  `plays`, first page of albums and singles); `GET /api/artist/:id/albums?group&offset`;
  `GET /api/album/:id`.
- Artist and album responses cached in SQLite for 24 h; 400 ms debounce kept.
- Search, artist and album screens in the current UI; "Open in Spotify" links.

**Done when:** with fake Spotify, tests cover the search merge, the
artist-first rule, album paging and the cache (a second artist-page load makes
no Spotify call); by hand, typing an artist's name and tapping their card
shows their albums, and a song from an album can be queued.

### v1.4 New look
**Goal:** the page looks and feels like a music app on a phone.

**Scope:** redesigned now-playing card and up-next list, search screens
restyled, coloured initials, dark and light themes, PWA manifest and icon,
"queue empty, auto-play next" state. No build step; CSP-safe ES modules.

**Done when:** at 375 px wide no screen scrolls sideways; three colleagues,
each given the same task ("queue a song from the second album of artist X"),
finish it in a median under 30 s; every v1.3 test still passes.

### v2 Auto-play
**Goal:** during office hours the music never stops, sounds like the office,
and never repeats within 2 h.

**Scope**
- `autopick.pick()` implemented. Pool: the owner's seed playlist
  (`SEED_PLAYLIST_ID`, read with `playlist-read-private`; the owner logs in once
  more) plus requested tracks whose `end_reason` is `natural`, scored by number
  of requests and likes. History's share grows with the log; there is no
  waiting period.
- Seed playlist minimum: 100 tracks from at least 40 artists. 2 h of music is
  about 35 songs, and that many need as many distinct artists; the margin
  covers the explicit filter and vetoes.
- Rules: exclude any track or artist started in the last 2 h; exclude tracks
  vetoed or device-skipped as auto-picks in the last 30 days; drop explicit
  tracks when `EXPLICIT_FILTER=1`; weighted random choice. If nothing is left,
  relax the artist rule, then shorten the track window to 1 h. Idle only if the
  pool is empty, with the banner "Auto-play has run out of songs: add to the
  seed playlist".
- Office hours (env `OFFICE_HOURS`, e.g. `Mon-Fri 09:00-17:00`, and `TZ`).
  A clock timer wakes the player at opening time, and inside office hours an
  empty queue gets a slow wake (every 60 s), so music starts in the morning and
  after a `lost` play even though idle polling is off.
- The next auto-pick is chosen when the v1 lookahead timer fires, so there is
  no silence between songs.
- "Why picked" line on auto-picks.

**Done when:** a simulated 8 h office day (fake Spotify, fake clock, a
100-track seed, 300 seeded plays, random requests, vetoes and device skips)
has no track or artist repeat inside 2 h, requests always before auto-picks,
no explicit tracks with the filter on, no auto-pick outside office hours, and
no idle gap longer than one tick; then one real office day logs zero idle
minutes inside office hours.

## Out of scope / rejected ideas

| Idea | Why not |
|---|---|
| Spotify recommendations, radio, related artists, mood or energy matching | The endpoints are closed to apps created after Nov 2024 [S1]. |
| Popularity sorting, "Spotify top tracks" exactly as Spotify shows it | Fields and endpoint removed for Development Mode in 2026 [S2]. Approximated instead. |
| Colleagues logging in to Spotify (save to their library, personal taste) | 5-user allowlist [S6]; "Open in Spotify" covers saving. |
| Upvote-sorted queue (Festify, OutLoud style) | With 8 people, voting on order adds friction and buries quiet voices; "served longest ago goes next" is fair and predictable. |
| Using Spotify's own queue, or playing an artist "context" for top tracks | Loses control of attribution, removal, skip votes and logging (v1 design). |
| Volume schedules, or Quiet by lowering the volume | Phones are reported to refuse volume changes [S8], and a quiet-but-playing speaker still drains the queue; pausing is simpler and certain. |
| Genre bans | Genre data is sparse and coarse; vetoes and the explicit filter are precise. |
| Extended Quota | Requires a registered business with 250k monthly users [S6]. |
| Accounts or SSO, native apps, multiple rooms, Slack or Teams bot, AI DJ voice | Not needed for 8 trusted colleagues; the passcode, names and a PWA are enough. A chat bot also needs workspace admin rights. |
| Web Playback SDK as the main device | The speaker is paired to the iPhone; the web player is only a fallback. |
| Stats, deeper cuts, kiosk, playlist sync, settings page | Moved to the backlog: little use for 8 people, and deeper cuts cost many paged calls. |

## Risks

1. **Licensing: the owner decides before v1.1 is deployed.** Spotify's terms
   allow personal, non-commercial use only. Spotify support says playing music
   for a whole office counts as commercial use, and points businesses to
   Soundtrack Your Brand [S16]. Business playback may also need a
   public-performance licence from the local collection society. This already
   applies to v1. The owner should confirm the office accepts this before the
   Railway deploy.
2. **Spotify narrows Development Mode again.** It did in Nov 2024 and Feb 2026
   [S1][S2]. Mitigation: use few endpoints (player, search, track, artist,
   album, one owned playlist). The play log, likes and CSV export are ours, so
   auto-play keeps working on our data even if lookups shrink.
3. **Unknown quota.** No numbers or reset window are published [S7]. v1 polls
   every 3 s around the clock (about 29,000 calls a day). v1's flat 5 s retry
   on a 429 without `Retry-After` could also keep hitting a quota block.
   Mitigation: no calls while idle and exponential quota back-off (v1.1),
   10 s polling and the call counter (v1.2), the 24 h cache (v1.3), no
   auto-play outside office hours (v2).
4. **"Popular" approximation may be poor.** Search order is undocumented [S4].
   Mitigation: the v1.3 spike decides the label; "Office favourites" is always
   right.
5. **Device-skip detection may misread the phone.** Mitigation: the v1.1
   real-device spike and recorded fixtures; `lost` is kept apart from
   `device_skip`, so the log never claims a skip it did not see.
6. **Speaker iPhone drops out** when Spotify is backgrounded or the phone
   sleeps. Mitigation: Guided Access, charging, the banner (v1.2), the web
   player fallback, and a `lost` request goes back to the queue (v1.1).
7. **Spotify login or Premium lapses** and the music stops [S3]. v1 already
   shows a "not connected" banner; a phone alert to the owner is in the
   backlog.
8. **Thin seed or history.** Mitigation: the seed playlist minimum (v2) and the
   "run out of songs" banner.
9. **Cost.** Railway Hobby is $5/month including $5 of usage [S17]. One small
   Node process with SQLite should fit; lean polling keeps CPU low. Check the
   bill after the first month.
10. **Taste conflicts.** Auto-play reflects the most active requesters.
    Mitigation: fair queue, veto, 30-day veto memory, likes from everyone.

## Sources

- [S1] Spotify for Developers, "Introducing some changes to our Web API", 2024-11-27. https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api
- [S2] Spotify, Web API changelog, February 2026. https://developer.spotify.com/documentation/web-api/references/changes/february-2026 ; March 2026 (external_ids restored): https://developer.spotify.com/documentation/web-api/references/changes/march-2026
- [S3] Spotify, February 2026 Dev Mode migration guide. https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- [S4] Spotify, Search reference. https://developer.spotify.com/documentation/web-api/reference/search
- [S5] Spotify, Get Artist's Albums reference. https://developer.spotify.com/documentation/web-api/reference/get-an-artists-albums
- [S6] Spotify, Quota modes (5 users, Premium owner, Extended Quota criteria). https://developer.spotify.com/documentation/web-api/concepts/quota-modes ; Spotify, "Update on Developer Access and Platform Security", 2026-02-06. https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
- [S7] Spotify, "Web API quota updates for Development Mode", 2026-07-23. https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates ; July 2026 changelog https://developer.spotify.com/documentation/web-api/references/changes/july-2026 ; Rate limits https://developer.spotify.com/documentation/web-api/concepts/rate-limits
- [S8] Spotify, Set Playback Volume reference. https://developer.spotify.com/documentation/web-api/reference/set-volume-for-users-playback ; unverified forum reports of phones refusing it: https://community.spotify.com/t5/Spotify-for-Developers/403-VOLUME-CONTROL-DISALLOW-on-Volume-Change-for-Set-Playback/td-p/7142685
- [S9] Spotify Support, "Jam". https://support.spotify.com/kg-en/article/jam/
- [S10] Festify. https://festify.rocks/
- [S11] OutLoud on Product Hunt. https://www.producthunt.com/posts/outloud-social-jukebox ; Jukestar and similar apps (listing, unverified): https://alternativeto.net/software/jukebox/about
- [S12] Rockbot: My Tech Decisions, "Rockbot brings music and choice to corporate office". https://mytechdecisions.com/audio/rockbot-brings-music-and-choice-to-corporate-office/ ; The Wichitan on the explicit filter: https://thewichitan.com/60501/ae/chartwells-rockbot-music-filter/
- [S13] Fair queueing: "Show HN: Jukebox – group playlist with fair queueing". https://news.ycombinator.com/item?id=44500840 ; GoParty https://github.com/procrastimax/goparty ; Spotify Community idea "Rotating Jam Queue". https://community.spotify.com/t5/Live-Ideas/Rotating-Jam-Queue-Each-Friend-In-Jam-Has-Own-Queue-Spotify/idi-p/6825586
- [S14] Vendor survey: "Change the record: Half of office workers argue over radio choices". https://digitalstrategyconsulting.com/transformation/skills/change-the-record-half-of-office-workers-argue-over-radio-choices/63549 ; The HR Director, "If music be the food of arguments". https://thehrdirector.com/?p=21411
- [S15] WTOP, "Listen to music at work? How not to annoy your co-workers", 2018. https://wtop.com/business-finance/2018/10/listen-to-music-at-work-how-not-to-annoy-your-co-workers
- [S16] Spotify Support, "Spotify for public or commercial use". https://support.spotify.com/us/account_payment_help/account_help/use-spotify-in-my-bar-restaurant-store-school-etc ; Spotify Community, "Using Spotify in our Office". https://community.spotify.com/t5/Accounts/Using-Spotify-in-our-Office/td-p/1151405
- [S17] Railway docs, Plans. https://docs.railway.com/pricing/plans
- [S18] ntfy, free HTTP-based push notifications. https://ntfy.sh
