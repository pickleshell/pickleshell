const net = require('net');

class TerminalUnavailableError extends Error {
  constructor() {
    super('Terminal service is unavailable');
    this.name = 'TerminalUnavailableError';
    this.code = 'terminal_unavailable';
  }
}

class TerminalWriteOutcomeUnknownError extends Error {
  constructor() {
    super('Terminal write outcome is unknown');
    this.name = 'TerminalWriteOutcomeUnknownError';
    this.code = 'terminal_write_outcome_unknown';
  }
}

function requestTimeoutMs(operation, payload = {}, baseTimeoutMs = 10000, outputTimeoutMarginMs = 1000) {
  if (operation !== 'output') return baseTimeoutMs;
  const waitMs = Number.isSafeInteger(payload.wait_ms) ? payload.wait_ms : 0;
  return Math.max(baseTimeoutMs, waitMs + outputTimeoutMarginMs);
}

const SERVICE_ERRORS = new Set([
  'invalid_request', 'invalid_working_directory', 'executable_not_allowed',
  'environment_not_allowed', 'signal_not_allowed', 'terminal_forbidden',
  'terminal_not_found', 'idempotency_conflict', 'terminal_not_writable',
  'terminal_closed', 'idempotency_unsupported', 'input_too_large',
  'output_limit', 'terminal_limit', 'terminal_spawn_failed', 'terminal_cgroup_unavailable', 'terminal_write_outcome_unknown', 'internal_error',
]);

class TerminalClient {
  constructor({ socketPath, authToken, timeoutMs = 10000, outputTimeoutMarginMs = 1000, connect = null } = {}) {
    this.socketPath = socketPath || process.env.PICKLESHELL_TERMINAL_SOCKET || '/run/pickleshell-terminal/service.sock';
    this.timeoutMs = timeoutMs;
    this.outputTimeoutMarginMs = outputTimeoutMarginMs;
    this.authToken = authToken || process.env.PICKLESHELL_TERMINAL_AUTH || '';
    this.connect = connect || ((path) => net.createConnection(path));
  }

  request(operation, payload, ownerScope) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = false;
      let buffer = '';
      const socket = this.connect(this.socketPath);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const timeoutMs = requestTimeoutMs(operation, payload, this.timeoutMs, this.outputTimeoutMarginMs);
      const timer = setTimeout(() => finish(operation === 'write' && sent ? new TerminalWriteOutcomeUnknownError() : new TerminalUnavailableError()), timeoutMs);
      socket.on('error', () => finish(operation === 'write' && sent ? new TerminalWriteOutcomeUnknownError() : new TerminalUnavailableError()));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let response;
        try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish(new TerminalUnavailableError()); }
        if (response && response.ok === false && response.error) {
          const error = new Error(response.details || response.error);
          error.code = SERVICE_ERRORS.has(response.error) ? response.error : 'internal_error';
          error.payload = { ...response, error: error.code };
          error.status = response.status;
          return finish(error);
        }
        finish(null, response);
      });
      socket.on('connect', () => {
        sent = true;
        socket.write(`${JSON.stringify({ op: `terminal-${operation}`, auth: this.authToken, owner_scope: ownerScope, ...payload })}\n`);
      });
    });
  }
}

module.exports = { TerminalClient, TerminalUnavailableError, TerminalWriteOutcomeUnknownError, requestTimeoutMs };
