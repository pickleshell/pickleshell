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
  windowMs: 15 * 60 * 1000,
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

// Lightweight status — state + progress only (no output). For polling.
app.get('/status', auth, (req, res) => {
  const { chat_id: chatId, session_id: sessionId, request_id: requestId } = req.query;

  if (requestId) {
    if (typeof requestId !== 'string' || !/^req_[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'invalid_request', details: 'request_id is invalid' });
    }
    return res.json({ ok: true, ...concurrency.getRequestStatus(requestId) });
  }

  if (!chatId || typeof chatId !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_request', details: 'chat_id or request_id is required' });
  }
  if (sessionId !== undefined &&
      (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))) {
    return res.status(400).json({ ok: false, error: 'invalid_request', details: 'session_id is invalid' });
  }
  if (!config.getChatConfig(chatId)) {
    return res.status(404).json({ ok: false, error: 'unknown_chat_id', details: `No workspace configured for chat_id: ${chatId}` });
  }
  return res.json({ ok: true, chat_id: chatId, ...concurrency.sessionStatus(chatId, sessionId) });
});

// Full output — reply + trace + error. For reading results.
app.get('/output', auth, (req, res) => {
  const { chat_id: chatId, session_id: sessionId, request_id: requestId } = req.query;

  if (requestId) {
    if (typeof requestId !== 'string' || !/^req_[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'invalid_request', details: 'request_id is invalid' });
    }
    return res.json({ ok: true, ...concurrency.getRequestOutput(requestId) });
  }

  if (!chatId || typeof chatId !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_request', details: 'chat_id or request_id is required' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_request', details: 'session_id is required for session-based output' });
  }
  if (!config.getChatConfig(chatId)) {
    return res.status(404).json({ ok: false, error: 'unknown_chat_id', details: `No workspace configured for chat_id: ${chatId}` });
  }
  return res.json({ ok: true, chat_id: chatId, ...concurrency.sessionOutput(chatId, sessionId) });
});

// Cancel an in-flight request
app.post('/cancel', auth, (req, res) => {
  const { request_id: requestId } = req.body || {};
  if (!requestId || typeof requestId !== 'string' || !/^req_[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    return res.status(400).json({ ok: false, error: 'invalid_request', details: 'request_id is required' });
  }
  const result = concurrency.cancelRequest(requestId);
  if (!result.ok) {
    const status = result.status === 'already_completed' ? 200 : 404;
    return res.status(status).json({ ok: false, ...result });
  }
  return res.json({ ok: true, ...result });
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
