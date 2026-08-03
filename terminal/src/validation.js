'use strict';

const crypto = require('node:crypto');

const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP', 'SIGCONT']);
const CLOSE_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error('invalid_request', `${name} is out of range`);
  return value;
}
function text(value, min, max, name) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw error('invalid_request', `${name} is invalid`);
  return value;
}
function error(code, details = code) { const e = new Error(details); e.code = code; return e; }
function closeReason(value) {
  text(value, 1, 64, 'reason');
  if (!CLOSE_REASON_PATTERN.test(value)) throw error('invalid_request', 'reason is invalid');
  return value;
}
function terminalId() { return `term_${crypto.randomBytes(24).toString('base64url')}`; }
function validateId(value) { text(value, 6, 80, 'terminal_id'); if (!/^term_[A-Za-z0-9_-]+$/.test(value)) throw error('invalid_request'); return value; }
function decodeData(value) {
  text(value, 1, 87384, 'data');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw error('invalid_request', 'data is invalid base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1) throw error('invalid_request', 'data is empty');
  if (bytes.length > 65536) throw error('input_too_large');
  return bytes;
}
function isValidUtf8(bytes) { return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes); }
function spawnRequest(req, policy) {
  text(req.chat_id, 1, 128, 'chat_id');
  const executable = req.executable === undefined ? policy.defaultExecutable : text(req.executable, 1, 4096, 'executable');
  if (!policy.executables.has(executable)) throw error('executable_not_allowed');
  const argv = req.argv === undefined ? ['--noprofile', '--norc', '-i'] : req.argv;
  if (!Array.isArray(argv) || argv.length > 32 || argv.some((x) => typeof x !== 'string' || Buffer.byteLength(x) > 4096)) throw error('invalid_request', 'argv is invalid');
  const cols = req.cols === undefined ? 80 : integer(req.cols, 1, 500, 'cols');
  const rows = req.rows === undefined ? 24 : integer(req.rows, 1, 200, 'rows');
  if (req.idempotency_key !== undefined) text(req.idempotency_key, 1, 128, 'idempotency_key');
  const env = req.env === undefined ? {} : req.env;
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 32) throw error('environment_not_allowed');
  for (const [key, value] of Object.entries(env)) {
    if (!policy.environment.has(key) || typeof value !== 'string' || Buffer.byteLength(value) > 4096 || /(?:TOKEN|SECRET|KEY|PASSWORD)/i.test(key)) throw error('environment_not_allowed');
  }
  return { chat_id: req.chat_id, executable, argv, cwd: req.cwd, env, cols, rows, idempotency_key: req.idempotency_key };
}
function validateOutput(req) { validateId(req.terminal_id); integer(req.cursor === undefined ? 0 : req.cursor, 0, 9223372036854775807, 'cursor'); integer(req.max_bytes === undefined ? 16384 : req.max_bytes, 1, 65536, 'max_bytes'); integer(req.wait_ms === undefined ? 0 : req.wait_ms, 0, 30000, 'wait_ms'); }
module.exports = { SIGNALS, error, integer, text, closeReason, terminalId, validateId, decodeData, isValidUtf8, spawnRequest, validateOutput };
