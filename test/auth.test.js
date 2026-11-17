import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieValueFor, parseCookies, passcodeMatches, createLoginLimiter } from '../src/auth.js';

test('cookieValueFor is stable and depends on the passcode', () => {
  assert.equal(cookieValueFor('secret-pass'), cookieValueFor('secret-pass'));
  assert.notEqual(cookieValueFor('secret-pass'), cookieValueFor('other-pass'));
  assert.match(cookieValueFor('secret-pass'), /^[0-9a-f]{64}$/);
});

test('passcodeMatches compares exactly, including different lengths', () => {
  assert.equal(passcodeMatches('abcdefgh', 'abcdefgh'), true);
  assert.equal(passcodeMatches('abcdefgx', 'abcdefgh'), false);
  assert.equal(passcodeMatches('abc', 'abcdefgh'), false);
  assert.equal(passcodeMatches('', 'abcdefgh'), false);
  assert.equal(passcodeMatches(undefined, 'abcdefgh'), false);
});

test('login limiter blocks after 10 failures and unblocks after the window', () => {
  let t = 1000;
  const lim = createLoginLimiter({ now: () => t });
  for (let i = 0; i < 10; i++) {
    assert.equal(lim.isBlocked('1.1.1.1'), false);
    lim.recordFailure('1.1.1.1');
  }
  assert.equal(lim.isBlocked('1.1.1.1'), true);
  assert.equal(lim.isBlocked('2.2.2.2'), false);
  t += 900000 + 1;
  assert.equal(lim.isBlocked('1.1.1.1'), false);
});

test('limiter reset clears failures', () => {
  const lim = createLoginLimiter({});
  for (let i = 0; i < 10; i++) lim.recordFailure('x');
  lim.reset('x');
  assert.equal(lim.isBlocked('x'), false);
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; ofm=x'), { a: '1', ofm: 'x' });
  assert.deepEqual(parseCookies(undefined), {});
});
