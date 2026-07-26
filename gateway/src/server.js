require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');
const chatHandler = require('./chat');

const app = express();
const PORT = process.env.PORT || 18092;
const HOST = process.env.HOST || '127.0.0.1';

// Security middleware
app.use(helmet());

// Body parsing
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' }));

const config = require('./config');
const concurrency = require('./concurrency');

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  message: {
    ok: false,
    error: 'rate_limit',
    details: 'Too many requests'
  }
});

// Health check (authenticated)
app.get('/health', auth, (req, res) => {
  const cfg = config.loadConfig();
  res.json({
    ok: true,
    service: 'pickleshell-gateway',
    agent: 'opencode',
    uptime_s: Math.round(process.uptime()),
    configured_chats: Object.keys(cfg.chats || {}),
    concurrency: concurrency.status()
  });
});

// Chat endpoint
app.post('/chat', limiter, auth, chatHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'not_found',
    details: 'Endpoint not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'payload_too_large',
      details: 'Request body exceeds the configured JSON limit'
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_json',
      details: 'Request body is not valid JSON'
    });
  }

  res.status(500).json({
    ok: false,
    error: 'internal_error',
    details: 'Internal server error'
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
