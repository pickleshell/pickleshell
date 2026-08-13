const DEFAULT_TIMEOUT_SEC = 3600;
const STALE_GRACE_MS = 30 * 1000;

function parseAgentTimeoutSec(raw) {
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return n;
}

const timeoutSec = parseAgentTimeoutSec(process.env.AGENT_TIMEOUT_SEC);
const agentTimeoutMs = timeoutSec * 1000;
const staleTimeoutMs = agentTimeoutMs + STALE_GRACE_MS;
const staleTimeoutForAgentMs = (requestAgentTimeoutMs) => requestAgentTimeoutMs + STALE_GRACE_MS;

module.exports = { parseAgentTimeoutSec, timeoutSec, agentTimeoutMs, staleTimeoutMs, STALE_GRACE_MS, staleTimeoutForAgentMs };
