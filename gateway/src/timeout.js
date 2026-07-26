const DEFAULT_TIMEOUT_SEC = 300;
const STALE_BUFFER_SEC = 30;

const raw = process.env.AGENT_TIMEOUT_SEC;
const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;

let timeoutSec;
if (Number.isNaN(parsed) || parsed <= 0) {
  timeoutSec = DEFAULT_TIMEOUT_SEC;
} else {
  timeoutSec = parsed;
}

const agentTimeoutMs = timeoutSec * 1000;
const staleTimeoutMs = agentTimeoutMs + STALE_BUFFER_SEC * 1000;

module.exports = { timeoutSec, agentTimeoutMs, staleTimeoutMs };
