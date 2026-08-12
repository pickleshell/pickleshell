// Native Codex runtime adapter selector.

const execAdapter = require('./codex-exec');
const mcpAdapter = require('./codex-mcp');
const { buildMetadata } = require('../normalize');

const TRANSPORT_EXEC = 'exec';
const TRANSPORT_MCP = 'mcp';

function normalizeTransport(value) {
  if (value === undefined || value === null) return TRANSPORT_EXEC;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === TRANSPORT_EXEC || normalized === TRANSPORT_MCP ? normalized : null;
}

function getTransportAdapter(transport) {
  const normalized = normalizeTransport(transport);
  if (!normalized) return null;
  if (normalized === TRANSPORT_MCP) return mcpAdapter;
  return execAdapter;
}

function isAvailable() {
  return execAdapter.isAvailable() || mcpAdapter.isAvailable();
}

function isTransportAvailable(transport) {
  const normalized = normalizeTransport(transport);
  if (!normalized) return false;
  return getTransportAdapter(normalized).isAvailable();
}

function runRequest(options) {
  const adapter = getTransportAdapter(options.transport);
  if (!adapter) {
    const now = new Date().toISOString();
    return {
      promise: Promise.resolve({
        ok: false,
        runtime: 'codex',
        request_id: options.request_id || null,
        session_id: options.session_id || null,
        state: 'error',
        reply: null,
        events: [],
        metadata: buildMetadata([], 'codex_transport_invalid'),
        error: {
          class: 'codex_transport_invalid',
          message: 'Invalid Codex transport configured',
          exit_code: null,
          signal: null,
        },
        started_at: now,
        completed_at: now,
        duration_ms: 0,
        sessionId: options.session_id || null,
        cancelled: false,
      }),
      cancel: () => false,
    };
  }
  if (adapter.runRequest) return adapter.runRequest(options);
  return null;
}

module.exports = {
  ...execAdapter,
  name: 'codex',
  normalizeTransport,
  isAvailable,
  isTransportAvailable,
  getTransportAdapter,
  runRequest,
  transports: {
    exec: execAdapter,
    mcp: mcpAdapter,
  },
};
