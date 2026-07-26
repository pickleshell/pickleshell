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

  // Constant-time comparison (must be same length)
  const tokenBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  if (tokenBuf.length !== expectedBuf.length) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      details: 'Invalid token'
    });
  }

  const isValid = crypto.timingSafeEqual(tokenBuf, expectedBuf);

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
