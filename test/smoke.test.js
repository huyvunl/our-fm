import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('server boots, serves the page, logs in and reports needs_auth', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ourfm-smoke-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: {
      ...process.env,
      OFFICE_PASSCODE: 'smoke-pass-123',
      SPOTIFY_CLIENT_ID: 'dummy-id',
      SPOTIFY_CLIENT_SECRET: 'dummy-secret',
      SPOTIFY_REDIRECT_URI: 'http://127.0.0.1/auth/callback',
      DB_PATH: path.join(dir, 'smoke.db'),
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.once('exit', r));
  t.after(async () => {
    child.kill();
    await exited;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold the file */ }
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 15000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/listening on port (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`server exited early: ${buf}`)); });
  });
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /app\.js/);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: 'smoke-pass-123' }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const st = await fetch(`${base}/api/state`, { headers: { cookie, 'x-client-id': 'smoke-client-1' } });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).status, 'needs_auth');
});
