const STALE_TIMEOUT_MS = (parseInt(process.env.AGENT_TIMEOUT_SEC) || 300) * 1000 + 30000;

const slots = new Map();
const activeSessions = new Map();

let slotCounter = 0;

function getSessionKey(chatId, sessionId) {
  return sessionId ? `${chatId}\0${sessionId}` : null;
}

function release(slotKey) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  slots.delete(slotKey);
  if (entry.sessionKey && activeSessions.get(entry.sessionKey) === slotKey) {
    activeSessions.delete(entry.sessionKey);
  }
}

function reapStale() {
  const now = Date.now();
  for (const [key, entry] of slots) {
    if (now - entry.started > STALE_TIMEOUT_MS) {
      console.warn(`[CONCURRENCY] Reaping stale slot ${key} (held ${Math.round((now - entry.started) / 1000)}s)`);
      release(key);
    }
  }
}

function acquire(chatId, sessionId) {
  reapStale();

  const sessionKey = getSessionKey(chatId, sessionId);
  const activeSlotKey = sessionKey ? activeSessions.get(sessionKey) : null;
  if (activeSlotKey) {
    const active = slots.get(activeSlotKey);
    const elapsedS = active
      ? Math.max(0, Math.round((Date.now() - active.started) / 1000))
      : 0;
    return {
      ok: false,
      error: 'session_busy',
      notification: 'Сессия занята.',
      current_task: active?.task || 'Задача запускается',
      elapsed_s: elapsedS,
    };
  }

  const key = `slot:${++slotCounter}`;
  slots.set(key, {
    chatId,
    sessionId,
    sessionKey,
    task: null,
    started: Date.now(),
  });
  if (sessionKey) {
    activeSessions.set(sessionKey, key);
  }

  return { ok: true, slotKey: key };
}

function setTask(slotKey, task) {
  const entry = slots.get(slotKey);
  if (entry) {
    entry.task = task;
  }
}

function status() {
  reapStale();
  return {
    active_count: slots.size,
    max: null,
    policy: 'one_active_request_per_session',
    sessions: Array.from(slots.entries()).map(([k, v]) => ({
      key: k,
      chat_id: v.chatId,
      session_id: v.sessionId,
      task: v.task,
      elapsed_s: Math.round((Date.now() - v.started) / 1000),
    })),
  };
}

module.exports = { acquire, setTask, release, status };
