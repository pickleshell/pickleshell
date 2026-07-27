const DEFAULT_TIMEOUT_SEC = 3600;
const STALE_BUFFER_SEC = 30;

function parseAgentTimeoutSec(raw) {
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return n;
}

const timeoutSec = parseAgentTimeoutSec(process.env.AGENT_TIMEOUT_SEC);
const agentTimeoutMs = timeoutSec * 1000;
const staleTimeoutMs = agentTimeoutMs + STALE_BUFFER_SEC * 1000;

module.exports = { parseAgentTimeoutSec, timeoutSec, agentTimeoutMs, staleTimeoutMs };
