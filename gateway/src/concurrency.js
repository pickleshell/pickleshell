const { staleTimeoutMs } = require('./timeout');
const crypto = require('crypto');

const slots = new Map();
const activeSessions = new Map();
const completedByRequestId = new Map();
const completedBySessionKey = new Map();
const requestIdToSlotKey = new Map();
const COMPLETED_TTL_MS = 60 * 60 * 1000;

let slotCounter = 0;

function getSessionKey(chatId, sessionId) {
  return sessionId ? `${chatId}\0${sessionId}` : null;
}

function generateRequestId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `req_${ts}-${rand}`;
}

function release(slotKey) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  if (entry.requestId) requestIdToSlotKey.delete(entry.requestId);
  slots.delete(slotKey);
  if (entry.sessionKey && activeSessions.get(entry.sessionKey) === slotKey) {
    activeSessions.delete(entry.sessionKey);
  }
}

function reapStale() {
  const now = Date.now();
  for (const [key, result] of completedByRequestId) {
    if (now - result.completedAt > COMPLETED_TTL_MS) completedByRequestId.delete(key);
  }
  for (const [key, result] of completedBySessionKey) {
    if (now - result.completedAt > COMPLETED_TTL_MS) completedBySessionKey.delete(key);
  }
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

  if (sessionKey) {
    completedBySessionKey.delete(sessionKey);
  }

  const requestId = generateRequestId();
  const key = `slot:${++slotCounter}`;
  slots.set(key, {
    chatId,
    sessionId,
    sessionKey,
    requestId,
    task: null,
    progress: [],
    started: Date.now(),
  });
  if (sessionKey) {
    activeSessions.set(sessionKey, key);
  }
  requestIdToSlotKey.set(requestId, key);

  return { ok: true, slotKey: key, request_id: requestId };
}

function complete(slotKey, output) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  const record = {
    ...output,
    completedAt: Date.now(),
  };

  // Store by request_id (primary)
  if (entry.requestId) {
    completedByRequestId.set(entry.requestId, record);
  }

  // Store by sessionKey (backward compat for sync callers)
  if (entry.sessionKey) {
    completedBySessionKey.set(entry.sessionKey, record);
  }
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
    events: entry.progress.slice(-10),
  };
}

function getProgressBySession(chatId, sessionId) {
  const sessionKey = getSessionKey(chatId, sessionId);
  if (!sessionKey) return null;
  const slotKey = activeSessions.get(sessionKey);
  if (!slotKey) return null;
  return getProgress(slotKey);
}

function getRequestStatus(requestId) {
  reapStale();

  const slotKey = requestIdToSlotKey.get(requestId);
  const active = slotKey ? slots.get(slotKey) : null;
  if (active) {
    return {
      ready: false,
      state: 'busy',
      chat_id: active.chatId,
      session_id: active.sessionId || null,
      request_id: requestId,
      error: 'session_busy',
      notification: 'Задача выполняется.',
      current_task: active.task || 'Задача запускается',
      elapsed_s: Math.max(0, Math.round((Date.now() - active.started) / 1000)),
      progress: getProgress(slotKey),
    };
  }

  const completed = completedByRequestId.get(requestId);
  if (completed) {
    return {
      ready: true,
      state: 'completed',
      request_id: requestId,
      output: {
        reply: completed.reply,
        trace: completed.trace || [],
        session_id: completed.session_id || null,
        error: completed.error || null,
      },
    };
  }

  return { ready: true, state: 'unknown', request_id: requestId };
}

function sessionStatus(chatId, sessionId) {
  reapStale();
  const sessionKey = getSessionKey(chatId, sessionId);
  if (!sessionKey) {
    return {
      ready: true,
      state: 'new_session',
      session_id: null,
    };
  }

  const slotKey = activeSessions.get(sessionKey);
  const active = slotKey ? slots.get(slotKey) : null;
  if (!active) {
    const completed = completedBySessionKey.get(sessionKey);
    if (completed) {
      return {
        ready: true,
        state: 'completed',
        session_id: sessionId,
        output: {
          reply: completed.reply,
          trace: completed.trace || [],
          error: completed.error || null,
        },
      };
    }
    return { ready: true, state: 'ready', session_id: sessionId };
  }

  return {
    ready: false,
    state: 'busy',
    session_id: sessionId,
    request_id: active.requestId,
    error: 'session_busy',
    notification: 'Сессия занята.',
    current_task: active.task || 'Задача запускается',
    elapsed_s: Math.max(0, Math.round((Date.now() - active.started) / 1000)),
    progress: getProgress(slotKey),
  };
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
      request_id: v.requestId,
      task: v.task,
      elapsed_s: Math.round((Date.now() - v.started) / 1000),
      progress_count: v.progress.length,
    })),
  };
}

module.exports = {
  acquire, setTask, complete, release, status,
  updateProgress, getProgress, getProgressBySession,
  sessionStatus, getRequestStatus,
};
