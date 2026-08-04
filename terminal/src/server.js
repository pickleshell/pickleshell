'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { TerminalService } = require('./service');
const { error } = require('./validation');

function config() {
  const file = process.env.PICKLESHELL_TERMINAL_CONFIG;
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.auth_token || typeof parsed.auth_token !== 'string') throw new Error('terminal auth token is required');
  return parsed;
}
function terminalRootOverride(value = process.env.PICKLESHELL_TERMINAL_ROOT_OVERRIDE) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw new Error('PICKLESHELL_TERMINAL_ROOT_OVERRIDE must be a specific absolute path');
  const normalized = path.normalize(value);
  const broad = new Set(['/', '/home', '/run', '/tmp', '/var', '/srv', '/etc', '/opt', '/usr']);
  if (normalized !== value || broad.has(normalized)) throw new Error('PICKLESHELL_TERMINAL_ROOT_OVERRIDE must be a specific absolute path');
  return normalized;
}
function runtimeConfig() {
  const cfg = config();
  const override = terminalRootOverride();
  // The systemd release binds the configured host workspace to this private path.
  // When set, the override replaces configured roots instead of widening them.
  return override ? { ...cfg, roots: [override] } : cfg;
}
function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function start(options = {}) {
  const cfg = runtimeConfig(); const token = process.env.PICKLESHELL_TERMINAL_AUTH || cfg.auth_token;
  if (!token) throw new Error('PICKLESHELL_TERMINAL_AUTH or config auth_token is required');
  const socketPath = process.env.PICKLESHELL_TERMINAL_SOCKET || cfg.socket || '/run/pickleshell-terminal/service.sock';
  const service = options.service || new TerminalService({ ...cfg, ...(options.cgroupManager ? { cgroupManager: options.cgroupManager } : {}) });
  try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch (_) { throw new Error('cannot replace terminal socket'); }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => {
    let buffer = ''; let disconnected = false; const disconnectController = new AbortController(); socket.setEncoding('utf8');
    socket.on('error', () => { disconnected = true; socket.destroy(); });
    socket.on('close', () => { disconnected = true; disconnectController.abort(); });
    const send = (response) => {
      if (disconnected || socket.destroyed || socket.writableEnded || !socket.writable) return;
      try { socket.write(`${JSON.stringify(response)}\n`); } catch (_) { disconnected = true; socket.destroy(); }
    };
    socket.on('data', async (chunk) => {
      if (disconnected) return;
      buffer += chunk;
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
        let response;
        try {
          const req = JSON.parse(line); if (!sameSecret(req.auth, token)) throw error('unauthorized');
          if (typeof req.op !== 'string') throw error('invalid_request');
          const operation = req.op.replace(/^terminal-/, '');
          if (!['spawn', 'write', 'output', 'resize', 'signal', 'close'].includes(operation)) throw error('invalid_request');
          await service.ready;
          const result = operation === 'spawn' ? service.spawn(req) : operation === 'write' ? service.write(req) : operation === 'output' ? await service.output(req, { signal: disconnectController.signal }) : operation === 'resize' ? service.resize(req) : operation === 'signal' ? service.signal(req) : await service.closeRequest(req);
          response = result.ok === undefined ? { ok: true, ...result } : result;
        } catch (e) { response = { ok: false, error: e.code || 'internal_error', details: ['unauthorized', 'invalid_request', 'invalid_working_directory', 'executable_not_allowed', 'environment_not_allowed', 'signal_not_allowed', 'terminal_not_found', 'idempotency_conflict', 'terminal_not_writable', 'terminal_closed', 'idempotency_unsupported', 'input_too_large', 'output_limit', 'terminal_limit', 'terminal_spawn_failed', 'terminal_unavailable', 'terminal_cgroup_unavailable'].includes(e.code) ? e.message : 'request failed' }; }
        send(response);
      }
    });
  });
  server.listen(socketPath, () => { try { fs.chmodSync(socketPath, 0o660); } catch (_) {} });
  const shutdown = async () => { server.close(); let code = 0; try { await service.stop(); } catch (_) { code = 1; } try { fs.unlinkSync(socketPath); } catch (_) {} process.exit(code); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  return { server, service, socketPath };
}
if (require.main === module) start();
module.exports = { start, config, runtimeConfig, terminalRootOverride };
