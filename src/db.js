import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL, uri TEXT NOT NULL,
  title TEXT NOT NULL, artist TEXT NOT NULL, artist_id TEXT, album TEXT NOT NULL,
  duration_ms INTEGER NOT NULL, explicit INTEGER NOT NULL, image_url TEXT,
  requested_by TEXT, requester_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('request','auto')),
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
  artist_id TEXT, album TEXT NOT NULL,
  duration_ms INTEGER NOT NULL, explicit INTEGER NOT NULL,
  uri TEXT NOT NULL, image_url TEXT,
  requested_by TEXT, requester_id TEXT,
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
`;

const iso = (ms) => new Date(ms).toISOString();

function trackFields(r) {
  return {
    trackId: r.track_id,
    uri: r.uri,
    title: r.title,
    artist: r.artist,
    artistId: r.artist_id,
    album: r.album,
    durationMs: r.duration_ms,
    explicit: r.explicit === 1,
    imageUrl: r.image_url,
    requestedBy: r.requested_by,
    requesterId: r.requester_id,
    source: r.source,
  };
}

function toQueueItem(r) {
  if (!r) return null;
  return { ...trackFields(r), id: r.id, addedAt: r.added_at };
}

function toPlay(r) {
  if (!r) return null;
  return {
    ...trackFields(r),
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    skipped: r.skipped === 1,
    progressMsAtSkip: r.progress_ms_at_skip,
  };
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);

  return {
    getSetting(key) {
      return q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key, value) {
      q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    deleteSetting(key) {
      q('DELETE FROM settings WHERE key = ?').run(key);
    },

    enqueue(t, { requestedBy = null, requesterId = null, source }, now) {
      const info = q(
        `INSERT INTO queue (track_id, uri, title, artist, artist_id, album, duration_ms, explicit,
           image_url, requested_by, requester_id, source, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(t.id, t.uri, t.title, t.artist, t.artistId ?? null, t.album, t.durationMs,
        t.explicit ? 1 : 0, t.imageUrl ?? null, requestedBy, requesterId, source, iso(now));
      return toQueueItem(q('SELECT * FROM queue WHERE id = ?').get(info.lastInsertRowid));
    },
    listQueue() {
      return q("SELECT * FROM queue ORDER BY (source = 'auto'), id").all().map(toQueueItem);
    },
    getQueueItem(id) {
      return toQueueItem(q('SELECT * FROM queue WHERE id = ?').get(id));
    },
    removeQueueItem(id) {
      return q('DELETE FROM queue WHERE id = ?').run(id).changes > 0;
    },
    countQueuedBy(requesterId) {
      return q("SELECT COUNT(*) AS n FROM queue WHERE requester_id = ? AND source = 'request'").get(requesterId).n;
    },
    isTrackQueuedOrPlaying(trackId) {
      return !!(
        q('SELECT 1 AS x FROM queue WHERE track_id = ? LIMIT 1').get(trackId) ||
        q('SELECT 1 AS x FROM plays WHERE track_id = ? AND ended_at IS NULL LIMIT 1').get(trackId)
      );
    },

    startPlay(queueId, now) {
      db.exec('BEGIN');
      try {
        const r = q('SELECT * FROM queue WHERE id = ?').get(queueId);
        if (!r) throw new Error(`queue item ${queueId} not found`);
        q('DELETE FROM queue WHERE id = ?').run(queueId);
        const info = q(
          `INSERT INTO plays (track_id, title, artist, artist_id, album, duration_ms, explicit, uri,
             image_url, requested_by, requester_id, source, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(r.track_id, r.title, r.artist, r.artist_id, r.album, r.duration_ms, r.explicit, r.uri,
          r.image_url, r.requested_by, r.requester_id, r.source, iso(now));
        db.exec('COMMIT');
        return toPlay(q('SELECT * FROM plays WHERE id = ?').get(info.lastInsertRowid));
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    currentPlay() {
      return toPlay(q('SELECT * FROM plays WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get());
    },
    getPlay(id) {
      return toPlay(q('SELECT * FROM plays WHERE id = ?').get(id));
    },
    endPlay(playId, { endedAt, skipped = false, progressMs = null }) {
      q('UPDATE plays SET ended_at = ?, skipped = ?, progress_ms_at_skip = ? WHERE id = ?')
        .run(iso(endedAt), skipped ? 1 : 0, progressMs, playId);
    },

    addSkipVote(playId, voterId, voterName, now) {
      q('INSERT OR IGNORE INTO skip_votes (play_id, voter_id, voter_name, created_at) VALUES (?, ?, ?, ?)')
        .run(playId, voterId, voterName, iso(now));
    },
    listSkipVotes(playId) {
      return q('SELECT voter_id, voter_name FROM skip_votes WHERE play_id = ? ORDER BY rowid').all(playId)
        .map((r) => ({ voterId: r.voter_id, voterName: r.voter_name }));
    },

    close() {
      db.close();
    },
  };
}
