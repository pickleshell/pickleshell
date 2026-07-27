const { staleTimeoutMs } = require('./timeout');
const crypto = require('crypto');

const slots = new Map();
const activeSessions = new Map();
const completedByRequestId = new Map();
const completedBySessionKey = new Map();
const requestIdToSlotKey = new Map();
const COMPLETED_TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 2000;

let slotCounter = 0;

function getSessionKey(chatId, sessionId) {
  return sessionId ? `${chatId}\0${sessionId}` : null;
}

function generateRequestId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `req_${ts}-${rand}`;
}

function isoNow() {
  return new Date().toISOString();
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
      next_action: 'session-status',
      retry_after_ms: RETRY_MS,
    };
  }

  if (sessionKey) {
    completedBySessionKey.delete(sessionKey);
  }

  const requestId = generateRequestId();
  const createdAt = isoNow();
  const key = `slot:${++slotCounter}`;
  slots.set(key, {
    chatId,
    sessionId,
    sessionKey,
    requestId,
    task: null,
    progress: [],
    started: Date.now(),
    createdAt,
    startedAt: null,
    cancelFn: null,
    cancelling: false,
  });
  if (sessionKey) {
    activeSessions.set(sessionKey, key);
  }
  requestIdToSlotKey.set(requestId, key);

  return { ok: true, slotKey: key, request_id: requestId };
}

function setStarted(slotKey) {
  const entry = slots.get(slotKey);
  if (entry && !entry.startedAt) {
    entry.startedAt = isoNow();
  }
}

function setCancelFn(slotKey, fn) {
  const entry = slots.get(slotKey);
  if (entry) entry.cancelFn = fn;
}

function cancelRequest(requestId) {
  const slotKey = requestIdToSlotKey.get(requestId);
  const active = slotKey ? slots.get(slotKey) : null;

  if (active) {
    if (active.cancelling) {
      return { ok: false, status: 'already_cancelling', request_id: requestId };
    }
    active.cancelling = true;
    if (active.cancelFn) {
      try { active.cancelFn(); } catch (_) {}
    }
    return { ok: true, status: 'cancelling', request_id: requestId };
  }

  const completed = completedByRequestId.get(requestId);
  if (completed) {
    return { ok: false, status: 'already_completed', request_id: requestId };
  }

  return { ok: false, status: 'not_found', request_id: requestId };
}

function complete(slotKey, output) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  const completedAt = isoNow();
  const record = {
    ...output,
    completedAt,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    queue_ms: entry.startedAt
      ? Math.max(0, new Date(entry.startedAt) - new Date(entry.createdAt))
      : null,
    execution_ms: entry.startedAt
      ? Math.max(0, new Date(completedAt) - new Date(entry.startedAt))
      : null,
  };

  if (entry.requestId) {
    completedByRequestId.set(entry.requestId, record);
  }

  if (entry.sessionKey) {
    completedBySessionKey.set(entry.sessionKey, record);
  }
}

function completeCancel(slotKey, output) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  const completedAt = isoNow();
  const record = {
    reply: null,
    trace: [],
    cancelled: true,
    ...output,
    completedAt,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    queue_ms: entry.startedAt
      ? Math.max(0, new Date(entry.startedAt) - new Date(entry.createdAt))
      : null,
    execution_ms: entry.startedAt
      ? Math.max(0, new Date(completedAt) - new Date(entry.startedAt))
      : null,
  };

  if (entry.requestId) {
    completedByRequestId.set(entry.requestId, record);
  }

  if (entry.sessionKey) {
    completedBySessionKey.set(entry.sessionKey, record);
  }

  release(slotKey);
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

function busyTimestamps(entry) {
  const now = isoNow();
  return {
    created_at: entry.createdAt,
    started_at: entry.startedAt,
    completed_at: null,
    queue_ms: entry.startedAt
      ? Math.max(0, new Date(entry.startedAt) - new Date(entry.createdAt))
      : null,
    execution_ms: entry.startedAt
      ? Math.max(0, new Date(now) - new Date(entry.startedAt))
      : null,
  };
}

// Lightweight: state + progress only (no output) — for polling
function getRequestStatus(requestId) {
  reapStale();

  const slotKey = requestIdToSlotKey.get(requestId);
  const active = slotKey ? slots.get(slotKey) : null;
  if (active) {
    const state = active.cancelling ? 'cancelling' : 'busy';
    return {
      ready: false,
      state,
      chat_id: active.chatId,
      session_id: active.sessionId || null,
      request_id: requestId,
      current_task: active.task || 'Задача запускается',
      elapsed_s: Math.max(0, Math.round((Date.now() - active.started) / 1000)),
      progress: getProgress(slotKey),
      next_action: 'session-status',
      retry_after_ms: RETRY_MS,
      ...busyTimestamps(active),
    };
  }

  if (completedByRequestId.has(requestId)) {
    return {
      ready: true,
      state: 'completed',
      request_id: requestId,
      next_action: 'session-output',
      retry_after_ms: 0,
    };
  }

  return { ready: true, state: 'unknown', request_id: requestId, next_action: null, retry_after_ms: 0 };
}

// Full output — for reading results
function getRequestOutput(requestId) {
  reapStale();

  const slotKey = requestIdToSlotKey.get(requestId);
  const active = slotKey ? slots.get(slotKey) : null;
  if (active) {
    const state = active.cancelling ? 'cancelling' : 'busy';
    return {
      ready: false,
      state,
      chat_id: active.chatId,
      session_id: active.sessionId || null,
      request_id: requestId,
      current_task: active.task || 'Задача запускается',
      elapsed_s: Math.max(0, Math.round((Date.now() - active.started) / 1000)),
      progress: getProgress(slotKey),
      next_action: 'session-status',
      retry_after_ms: RETRY_MS,
      ...busyTimestamps(active),
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
        cancelled: completed.cancelled || false,
      },
      next_action: null,
      retry_after_ms: 0,
      created_at: completed.createdAt,
      started_at: completed.startedAt,
      completed_at: completed.completedAt,
      queue_ms: completed.queue_ms,
      execution_ms: completed.execution_ms,
    };
  }

  return { ready: true, state: 'unknown', request_id: requestId, next_action: null, retry_after_ms: 0 };
}

function sessionStatus(chatId, sessionId) {
  reapStale();
  const sessionKey = getSessionKey(chatId, sessionId);
  if (!sessionKey) {
    return {
      ready: true,
      state: 'new_session',
      session_id: null,
      next_action: null,
      retry_after_ms: 0,
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
        next_action: 'session-output',
        retry_after_ms: 0,
      };
    }
    return { ready: true, state: 'ready', session_id: sessionId, next_action: null, retry_after_ms: 0 };
  }

  return {
    ready: false,
    state: active.cancelling ? 'cancelling' : 'busy',
    session_id: sessionId,
    request_id: active.requestId,
    current_task: active.task || 'Задача запускается',
    elapsed_s: Math.max(0, Math.round((Date.now() - active.started) / 1000)),
    progress: getProgress(slotKey),
    next_action: 'session-status',
    retry_after_ms: RETRY_MS,
    ...busyTimestamps(active),
  };
}

function sessionOutput(chatId, sessionId) {
  reapStale();
  const sessionKey = getSessionKey(chatId, sessionId);
  if (!sessionKey) {
    return { ready: true, state: 'new_session', session_id: null, next_action: null, retry_after_ms: 0 };
  }

  const slotKey = activeSessions.get(sessionKey);
  const active = slotKey ? slots.get(slotKey) : null;
  if (active) {
    return {
      ready: false,
      state: active.cancelling ? 'cancelling' : 'busy',
      session_id: sessionId,
      request_id: active.requestId,
      progress: getProgress(slotKey),
      next_action: 'session-status',
      retry_after_ms: RETRY_MS,
      ...busyTimestamps(active),
    };
  }

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
        cancelled: completed.cancelled || false,
      },
      next_action: null,
      retry_after_ms: 0,
      created_at: completed.createdAt,
      started_at: completed.startedAt,
      completed_at: completed.completedAt,
      queue_ms: completed.queue_ms,
      execution_ms: completed.execution_ms,
    };
  }

  return { ready: true, state: 'ready', session_id: sessionId, next_action: null, retry_after_ms: 0 };
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
  acquire, setTask, complete, completeCancel, release, status, setStarted,
  updateProgress, getProgress, getProgressBySession,
  sessionStatus, sessionOutput,
  getRequestStatus, getRequestOutput,
  setCancelFn, cancelRequest,
};
