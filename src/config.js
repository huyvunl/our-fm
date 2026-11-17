export const MAX_QUEUED_PER_PERSON = 3;
export const SKIP_VOTES = 3;
export const SKIP_VOTES_WITH_REQUESTER = 2;
export const TICK_MS = 3000;
export const START_GRACE_MS = 5000;
export const LOOKAHEAD_MS = 3500;

const REQUIRED = ['OFFICE_PASSCODE', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.OFFICE_PASSCODE.length < 8) {
    throw new Error('OFFICE_PASSCODE must be at least 8 characters');
  }
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    officePasscode: env.OFFICE_PASSCODE,
    dbPath: env.DB_PATH || './data/our-fm.db',
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID,
      clientSecret: env.SPOTIFY_CLIENT_SECRET,
      redirectUri: env.SPOTIFY_REDIRECT_URI,
      deviceName: env.SPOTIFY_DEVICE_NAME || null,
    },
  };
}
