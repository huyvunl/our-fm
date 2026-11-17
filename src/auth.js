import crypto from 'node:crypto';

export const COOKIE_NAME = 'ofm';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function cookieValueFor(passcode) {
  return crypto.createHmac('sha256', passcode).update('our-fm-v1').digest('hex');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// Compare SHA-256 digests so both buffers have equal length.
export function passcodeMatches(given, expected) {
  if (typeof given !== 'string') return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

export function createLoginLimiter({ max = 10, windowMs = 900000, now = Date.now } = {}) {
  const failures = new Map(); // ip -> timestamps
  const recent = (ip) => {
    const cutoff = now() - windowMs;
    const list = (failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  };
  return {
    isBlocked: (ip) => recent(ip).length >= max,
    recordFailure(ip) {
      const list = recent(ip);
      list.push(now());
      failures.set(ip, list);
    },
    reset: (ip) => { failures.delete(ip); },
  };
}

export function requireAuth(cookieValue) {
  return (req, res, next) => {
    const given = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (typeof given === 'string' && passcodeMatches(given, cookieValue)) return next();
    res.status(401).json({ error: 'Passcode required' });
  };
}

export function requireJson(req, res, next) {
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
}

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' https://i.scdn.co; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  next();
}
