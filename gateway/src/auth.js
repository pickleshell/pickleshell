const crypto = require('crypto');

const serverError = () => ({
  ok: false,
  error: 'internal_error',
  details: 'Server configuration error'
});

const unauthorized = () => ({
  ok: false,
  error: 'unauthorized',
  details: 'Invalid token'
});

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function parseAuthConfig(env) {
  const hash = env.PICKLESHELL_API_KEY_SHA256;
  const raw = env.PICKLESHELL_API_KEY || env.LOCAL_AGENT_API_KEY;

  if (hash !== undefined) {
    if (!SHA256_HEX_RE.test(hash)) return { error: 'malformed_hash' };
    return { hash };
  }

  if (raw !== undefined) return { raw };
  return { error: 'missing' };
}

function verifyHashToken(token, hash) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const digest = crypto.createHash('sha256').update(token, 'utf8').digest();
  const expected = Buffer.from(hash, 'hex');
  // Both are always 32 bytes at this point (hash validated by parseAuthConfig)
  try {
    return crypto.timingSafeEqual(digest, expected);
  } catch {
    return false;
  }
}

function verifyRawToken(token, expectedRaw) {
  if (typeof token !== 'string' || typeof expectedRaw !== 'string') return false;
  const tokenBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expectedRaw, 'utf8');
  if (tokenBuf.length !== expectedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(tokenBuf, expectedBuf);
  } catch {
    return false;
  }
}

const auth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      details: 'Missing or invalid Authorization header'
    });
  }

  const cfg = parseAuthConfig(process.env);

  if (cfg.error === 'malformed_hash') {
    console.error('PICKLESHELL_API_KEY_SHA256 is malformed (must be 64 lowercase hex chars)');
    return res.status(500).json(serverError());
  }

  if (cfg.error === 'missing') {
    console.error('PICKLESHELL_API_KEY not configured');
    return res.status(500).json(serverError());
  }

  const token = authHeader.substring(7);

  if (cfg.hash) {
    if (!verifyHashToken(token, cfg.hash)) {
      return res.status(401).json(unauthorized());
    }
    return next();
  }

  if (!verifyRawToken(token, cfg.raw)) {
    return res.status(401).json(unauthorized());
  }

  next();
};

module.exports = auth;
module.exports.parseAuthConfig = parseAuthConfig;
module.exports.verifyHashToken = verifyHashToken;
module.exports.verifyRawToken = verifyRawToken;
