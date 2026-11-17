import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSkip, countVoters } from '../src/skip.js';

const req = { source: 'request', requesterId: 'r' };
const v = (id, name = id) => ({ voterId: id, voterName: name });

test('request play needs 3 votes', () => {
  assert.deepEqual(evaluateSkip(req, [v('a'), v('b')]), { votes: 2, needed: 3, passed: false });
  assert.equal(evaluateSkip(req, [v('a'), v('b'), v('c')]).passed, true);
});

test('requester vote lowers threshold to 2', () => {
  assert.deepEqual(evaluateSkip(req, [v('r'), v('a')]), { votes: 2, needed: 2, passed: true });
});

test('auto play needs 1 vote', () => {
  assert.equal(evaluateSkip({ source: 'auto', requesterId: null }, [v('a')]).passed, true);
});

test('same name with a new clientId does not count twice', () => {
  assert.equal(countVoters([v('a', 'Ann'), v('b', ' ann ')]), 1);
});
