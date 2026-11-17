import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const full = {
  OFFICE_PASSCODE: 'passcode1',
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'sec',
  SPOTIFY_REDIRECT_URI: 'http://x/cb',
  SPOTIFY_DEVICE_NAME: 'iPhone',
  DB_PATH: '/tmp/a.db',
  PORT: '4000',
};

test('loadConfig reads all vars', () => {
  assert.deepEqual(loadConfig(full), {
    port: 4000,
    officePasscode: 'passcode1',
    dbPath: '/tmp/a.db',
    spotify: { clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://x/cb', deviceName: 'iPhone' },
  });
});

test('defaults and null device name', () => {
  const c = loadConfig({ ...full, SPOTIFY_DEVICE_NAME: undefined, DB_PATH: undefined, PORT: undefined });
  assert.equal(c.spotify.deviceName, null);
  assert.equal(c.port, 3000);
  assert.equal(c.dbPath, './data/our-fm.db');
});

test('missing vars are all listed', () => {
  assert.throws(
    () => loadConfig({ ...full, SPOTIFY_CLIENT_ID: undefined, OFFICE_PASSCODE: '' }),
    (e) => e.message.includes('SPOTIFY_CLIENT_ID') && e.message.includes('OFFICE_PASSCODE'),
  );
});

test('short passcode is rejected', () => {
  assert.throws(() => loadConfig({ ...full, OFFICE_PASSCODE: '1234567' }), /at least 8/);
});
