const { staleTimeoutMs } = require('./timeout');

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
    if (now - entry.started > staleTimeoutMs) {
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
    progress: [],
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

function updateProgress(slotKey, event) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  const progress = entry.progress;
  const now = Date.now();

  if (event.type === 'tool_use') {
    const tool = event.part?.tool || 'tool';
    const status = event.part?.state?.status;
    const title = event.part?.state?.title || '';
    const filePath = event.part?.state?.input?.filePath || '';
    const inputCmd = event.part?.state?.input?.command || '';
    const output = event.part?.state?.output || '';

    if (status === 'completed') {
      // Remove any pending entry for this tool, add completed
      const pendingIdx = progress.findIndex(p => p.type === 'tool' && p.tool === tool && p.status === 'running');
      if (pendingIdx !== -1) progress.splice(pendingIdx, 1);
      progress.push({
        type: 'tool',
        tool,
        status: 'done',
        title: title || filePath || inputCmd.substring(0, 60),
        output: output.substring(0, 200),
        ts: now,
      });
    } else {
      // Running — update or add
      const existing = progress.findIndex(p => p.type === 'tool' && p.tool === tool && p.status === 'running');
      const entry = {
        type: 'tool',
        tool,
        status: 'running',
        title: title || filePath || inputCmd.substring(0, 60),
        ts: now,
      };
      if (existing !== -1) {
        progress[existing] = entry;
      } else {
        progress.push(entry);
      }
    }
  } else if (event.type === 'text' && event.part?.text) {
    progress.push({
      type: 'text',
      text: event.part.text.substring(0, 300),
      ts: now,
    });
  }

  // Keep last 20 events max
  while (progress.length > 20) {
    progress.shift();
  }
}

function getProgress(slotKey) {
  const entry = slots.get(slotKey);
  if (!entry) return null;
  return {
    task: entry.task,
    elapsed_s: Math.round((Date.now() - entry.started) / 1000),
    events: entry.progress.slice(-10), // last 10 events
  };
}

function getProgressBySession(chatId, sessionId) {
  const sessionKey = getSessionKey(chatId, sessionId);
  if (!sessionKey) return null;
  const slotKey = activeSessions.get(sessionKey);
  if (!slotKey) return null;
  return getProgress(slotKey);
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
      progress_count: v.progress.length,
    })),
  };
}

module.exports = { acquire, setTask, release, status, updateProgress, getProgress, getProgressBySession };
