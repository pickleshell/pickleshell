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
const { TerminalClient, TerminalUnavailableError } = require('./terminal-client');
const terminalClient = new TerminalClient({
  socketPath: config.getTerminalConfig().socket_path,
  authToken: config.getTerminalConfig().auth_token,
});

const TERMINAL_OPERATIONS = {
  spawn: { method: 'POST', path: '/terminal/spawn', status: 201 },
  write: { method: 'POST', path: '/terminal/write', status: 200 },
  output: { method: 'POST', path: '/terminal/output', status: 200 },
  resize: { method: 'POST', path: '/terminal/resize', status: 200 },
  signal: { method: 'POST', path: '/terminal/signal', status: 200 },
  close: { method: 'POST', path: '/terminal/close', status: 200 },
};

function terminalStatus(error) {
  return {
    invalid_request: 400, invalid_working_directory: 400, executable_not_allowed: 400,
    environment_not_allowed: 400, signal_not_allowed: 400, terminal_forbidden: 403,
    terminal_not_found: 404, idempotency_conflict: 409, terminal_not_writable: 409,
    terminal_closed: 409, idempotency_unsupported: 409, input_too_large: 413,
    output_limit: 413, terminal_limit: 429, terminal_spawn_failed: 502,
    terminal_unavailable: 503, internal_error: 500,
  }[error] || 500;
}

const TERMINAL_DETAILS = {
  invalid_request: 'Terminal request is invalid',
  invalid_working_directory: 'Working directory is not allowed',
  executable_not_allowed: 'Executable is not allowed',
  environment_not_allowed: 'Environment is not allowed',
  signal_not_allowed: 'Signal is not allowed',
  terminal_forbidden: 'Terminal access is forbidden',
  terminal_not_found: 'Terminal was not found',
  idempotency_conflict: 'Idempotency key conflicts with an earlier request',
  terminal_not_writable: 'Terminal is not writable',
  terminal_closed: 'Terminal is closed',
  idempotency_unsupported: 'Idempotency is not supported for this operation',
  input_too_large: 'Input is too large',
  output_limit: 'Output exceeds the configured limit',
  terminal_limit: 'Terminal limit reached',
  terminal_spawn_failed: 'Terminal could not be started',
  terminal_unavailable: 'Terminal service is unavailable',
  internal_error: 'Terminal request failed',
};

function terminalHandler(operation) {
  return async (req, res) => {
    const body = req.body || {};
    const chatId = body.chat_id;
    if (typeof chatId !== 'string' || chatId.length < 1 || chatId.length > 128) {
      return res.status(400).json({ ok: false, error: 'invalid_request', details: 'chat_id is required' });
    }
    const policy = config.getTerminalPolicy(chatId);
    if (!policy) {
      return res.status(404).json({ ok: false, error: 'terminal_not_found', details: 'Terminal is not available for this chat' });
    }
    try {
      const result = await terminalClient.request(operation, body, policy.ownerScope);
      return res.status(TERMINAL_OPERATIONS[operation].status).json(result);
    } catch (error) {
      const code = error instanceof TerminalUnavailableError ? 'terminal_unavailable' : (error.code || 'internal_error');
      return res.status(terminalStatus(code)).json({ ok: false, error: code, details: TERMINAL_DETAILS[code] || TERMINAL_DETAILS.internal_error });
    }
  };
}

for (const [operation, definition] of Object.entries(TERMINAL_OPERATIONS)) {
  app[definition.method.toLowerCase()](definition.path, auth, terminalHandler(operation));
}

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
