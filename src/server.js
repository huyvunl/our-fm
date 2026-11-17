import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createSpotify } from './spotify.js';
import { createPlayer } from './player.js';
import { pick } from './autopick.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const store = openDb(config.dbPath);
const spotify = createSpotify({
  clientId: config.spotify.clientId,
  clientSecret: config.spotify.clientSecret,
  redirectUri: config.spotify.redirectUri,
  store,
});
const player = createPlayer({ store, spotify, deviceName: config.spotify.deviceName, autopick: { pick } });
const app = createApp({ config, store, spotify, player });

const server = app.listen(config.port, () => {
  console.log(`Our FM listening on port ${server.address().port}`);
  player.start();
});

function shutdown() {
  player.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
