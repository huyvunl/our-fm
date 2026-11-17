import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

const T = Date.UTC(2026, 0, 1, 12, 0, 0);
const track = (id, title = id) => ({
  id, uri: `spotify:track:${id}`, title, artist: 'Art', artistId: 'a1', album: 'Alb',
  durationMs: 1000, explicit: true, imageUrl: null,
});
const req = (name = 'Ann', id = 'c1') => ({ requestedBy: name, requesterId: id, source: 'request' });
const auto = { requestedBy: null, requesterId: null, source: 'auto' };

test('queue orders requests before auto picks', () => {
  const db = openDb(':memory:');
  db.enqueue(track('A'), auto, T);
  db.enqueue(track('B'), req(), T);
  db.enqueue(track('C'), req(), T);
  assert.deepEqual(db.listQueue().map((q) => q.title), ['B', 'C', 'A']);
  assert.equal(db.listQueue()[0].explicit, true);
});

test('startPlay moves the row into plays', () => {
  const db = openDb(':memory:');
  const q = db.enqueue(track('A'), req(), T);
  db.startPlay(q.id, T);
  assert.deepEqual(db.listQueue(), []);
  const p = db.currentPlay();
  assert.equal(p.trackId, 'A');
  assert.equal(p.requestedBy, 'Ann');
  assert.equal(p.source, 'request');
  assert.equal(p.startedAt, new Date(T).toISOString());
  assert.equal(p.endedAt, null);
  assert.equal(p.skipped, false);
});

test('endPlay records skip and progress', () => {
  const db = openDb(':memory:');
  const q = db.enqueue(track('A'), req(), T);
  const p = db.startPlay(q.id, T);
  db.endPlay(p.id, { endedAt: T + 5000, skipped: true, progressMs: 61000 });
  const row = db.getPlay(p.id);
  assert.equal(row.skipped, true);
  assert.equal(row.progressMsAtSkip, 61000);
  assert.equal(row.endedAt, new Date(T + 5000).toISOString());
  assert.equal(db.currentPlay(), null);
});

test("countQueuedBy counts only that client's requests", () => {
  const db = openDb(':memory:');
  db.enqueue(track('A'), req('Ann', 'c1'), T);
  db.enqueue(track('B'), req('Ann', 'c1'), T);
  db.enqueue(track('C'), req('Bob', 'c2'), T);
  db.enqueue(track('D'), auto, T);
  assert.equal(db.countQueuedBy('c1'), 2);
  assert.equal(db.countQueuedBy('c2'), 1);
});

test('isTrackQueuedOrPlaying', () => {
  const db = openDb(':memory:');
  const q = db.enqueue(track('A'), req(), T);
  assert.equal(db.isTrackQueuedOrPlaying('A'), true);
  const p = db.startPlay(q.id, T);
  assert.equal(db.isTrackQueuedOrPlaying('A'), true);
  db.endPlay(p.id, { endedAt: T + 1 });
  assert.equal(db.isTrackQueuedOrPlaying('A'), false);
});

test('skip votes are idempotent per voter', () => {
  const db = openDb(':memory:');
  const p = db.startPlay(db.enqueue(track('A'), req(), T).id, T);
  db.addSkipVote(p.id, 'v1', 'Bob', T);
  db.addSkipVote(p.id, 'v1', 'Bob', T);
  db.addSkipVote(p.id, 'v2', 'Cy', T);
  assert.deepEqual(db.listSkipVotes(p.id), [
    { voterId: 'v1', voterName: 'Bob' }, { voterId: 'v2', voterName: 'Cy' },
  ]);
});

test('settings round-trip and delete', () => {
  const db = openDb(':memory:');
  assert.equal(db.getSetting('k'), null);
  db.setSetting('k', 'v');
  db.setSetting('k', 'v2');
  assert.equal(db.getSetting('k'), 'v2');
  db.deleteSetting('k');
  assert.equal(db.getSetting('k'), null);
});

test('removeQueueItem and getQueueItem', () => {
  const db = openDb(':memory:');
  const q = db.enqueue(track('A'), req(), T);
  assert.equal(db.getQueueItem(q.id).trackId, 'A');
  assert.equal(db.removeQueueItem(q.id), true);
  assert.equal(db.removeQueueItem(q.id), false);
  assert.equal(db.getQueueItem(q.id), null);
});

test('file db creates parent dir', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ourfm-')), 'nested', 'x.db');
  const db = openDb(p);
  assert.ok(fs.existsSync(p));
  db.close();
});

test('unstartPlay restores the queue row with its id and place, and drops votes', () => {
  const db = openDb(':memory:');
  const a = db.enqueue(track('A'), req(), T);
  const b = db.enqueue(track('B'), req('Bob', 'c2'), T + 1);
  const p = db.startPlay(a.id, T + 10);
  db.addSkipVote(p.id, 'c9', 'Zed', T + 11);
  db.unstartPlay(p.id);
  assert.equal(db.currentPlay(), null);
  assert.equal(db.getPlay(p.id), null);
  assert.deepEqual(db.listSkipVotes(p.id), []);
  const q = db.listQueue();
  assert.deepEqual(q.map((x) => [x.id, x.trackId]), [[a.id, 'A'], [b.id, 'B']]);
  assert.equal(q[0].addedAt, new Date(T).toISOString());
  assert.equal(q[0].requestedBy, 'Ann');
});
