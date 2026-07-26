const crypto = require('crypto');

const auth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      details: 'Missing or invalid Authorization header'
    });
  }

  const token = authHeader.substring(7);
  const expectedToken =
    process.env.PICKLESHELL_API_KEY ||
    process.env.LOCAL_AGENT_API_KEY;

  if (!expectedToken) {
    console.error('PICKLESHELL_API_KEY not configured');
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      details: 'Server configuration error'
    });
  }

  // Constant-time comparison: pad shorter buffer to expected length
  const tokenBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  const maxLen = Math.max(tokenBuf.length, expectedBuf.length);
  const tokenPadded = Buffer.alloc(maxLen, 0);
  const expectedPadded = Buffer.alloc(maxLen, 0);

  tokenBuf.copy(tokenPadded);
  expectedBuf.copy(expectedPadded);

  const isValid = crypto.timingSafeEqual(tokenPadded, expectedPadded) &&
    tokenBuf.length === expectedBuf.length;

  if (!isValid) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      details: 'Invalid token'
    });
  }

  next();
};

module.exports = auth;
