const { staleTimeoutMs } = require('./timeout');
const crypto = require('crypto');

const slots = new Map();
const activeSessions = new Map();
const completedByRequestId = new Map();
const completedBySessionKey = new Map();
const requestIdToSlotKey = new Map();
const activeByIdempotencyKey = new Map();
const completedByIdempotencyKey = new Map();
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
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
  if (entry.idempotencyKey) activeByIdempotencyKey.delete(entry.idempotencyKey);
  slots.delete(slotKey);
  if (entry.sessionKey && activeSessions.get(entry.sessionKey) === slotKey) {
    activeSessions.delete(entry.sessionKey);
  }
}

function checkIdempotency(idempotencyKey) {
  const activeSlotKey = activeByIdempotencyKey.get(idempotencyKey);
  if (activeSlotKey) {
    const entry = slots.get(activeSlotKey);
    if (entry) {
      return {
        type: 'active',
        request_id: entry.requestId,
        chat_id: entry.chatId,
        session_id: entry.sessionId || null,
        current_task: entry.task || 'Задача запускается',
        elapsed_s: Math.max(0, Math.round((Date.now() - entry.started) / 1000)),
        next_action: 'session-status',
        retry_after_ms: RETRY_MS,
      };
    }
  }

  const completed = completedByIdempotencyKey.get(idempotencyKey);
  if (completed) {
    return {
      type: 'completed',
      request_id: completed.request_id || null,
      chat_id: completed.chat_id || null,
      session_id: completed.session_id || null,
      output: completed,
    };
  }

  return null;
}

function reapStale() {
  const now = Date.now();
  for (const [key, result] of completedByRequestId) {
    if (now - result.completedAt > COMPLETED_TTL_MS) completedByRequestId.delete(key);
  }
  for (const [key, result] of completedBySessionKey) {
    if (now - result.completedAt > COMPLETED_TTL_MS) completedBySessionKey.delete(key);
  }
  for (const [key, result] of completedByIdempotencyKey) {
    if (now - result.completedAt > COMPLETED_TTL_MS) completedByIdempotencyKey.delete(key);
  }
  for (const [key, entry] of slots) {
    if (now - entry.started > staleTimeoutMs) {
      console.warn(`[CONCURRENCY] Reaping stale slot ${key} (held ${Math.round((now - entry.started) / 1000)}s)`);
      release(key);
    }
  }
}

function acquire(chatId, sessionId, idempotencyKey) {
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
    idempotencyKey: idempotencyKey || null,
    task: null,
    progress: [],
    metadata: {
      files_modified: [],
      tools_used: new Set(),
      test_result: null,
      git_commit: null,
      error_class: null,
    },
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
  if (idempotencyKey) {
    activeByIdempotencyKey.set(idempotencyKey, key);
  }

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

function setErrorClass(slotKey, errorClass) {
  const entry = slots.get(slotKey);
  if (entry) entry.metadata.error_class = errorClass;
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

function serializeMetadata(meta) {
  return {
    files_modified: [...meta.files_modified],
    tools_used: [...meta.tools_used],
    test_result: meta.test_result,
    git_commit: meta.git_commit,
    error_class: meta.error_class,
  };
}

function complete(slotKey, output) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  const completedAt = isoNow();
  const record = {
    ...output,
    request_id: entry.requestId,
    chat_id: entry.chatId,
    metadata: serializeMetadata(entry.metadata),
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

  if (entry.idempotencyKey) {
    completedByIdempotencyKey.set(entry.idempotencyKey, record);
    activeByIdempotencyKey.delete(entry.idempotencyKey);
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
    request_id: entry.requestId,
    chat_id: entry.chatId,
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

  if (entry.idempotencyKey) {
    completedByIdempotencyKey.set(entry.idempotencyKey, record);
  }

  release(slotKey);
}

function setTask(slotKey, task) {
  const entry = slots.get(slotKey);
  if (entry) {
    entry.task = task;
  }
}

// Consume canonical AgentEvents (see src/runtime/contract.js). The event
// stream is runtime-neutral: 'tool' events carry tool/status/title/input/
// output, 'text' events carry text, 'error' events carry details and
// error_class. Raw runtime JSONL never reaches this function.
function updateProgress(slotKey, event) {
  const entry = slots.get(slotKey);
  if (!entry) return;

  const progress = entry.progress;
  const meta = entry.metadata;
  const now = Date.now();

  if (event.type === 'tool') {
    const tool = event.tool || 'tool';
    const status = event.status === 'done' ? 'done' : 'running';
    const title = event.title || '';
    const filePath = event.input?.filePath || '';
    const inputCmd = event.input?.command || '';
    const output = event.output || '';

    meta.tools_used.add(tool);

    if (status === 'done') {
      // Track file modifications
      if ((tool === 'write' || tool === 'edit' || tool === 'file_edit' || tool === 'file_write') && filePath) {
        if (!meta.files_modified.includes(filePath)) {
          meta.files_modified.push(filePath);
        }
      }

      // Extract git commit hash
      if ((tool === 'bash' || tool === 'terminal') && inputCmd) {
        if (inputCmd.includes('git commit') && !inputCmd.includes('git commit --amend')) {
          const hashMatch = output.match(/\[[\w]+\s+([0-9a-f]{7,40})\]/);
          if (hashMatch && !meta.git_commit) {
            meta.git_commit = hashMatch[1];
          }
        }

        // Detect test results
        if (inputCmd.match(/\b(test|jest|vitest|mocha|pytest|go test|cargo test|npm test|npx test)\b/)) {
          const passMatch = output.match(/(\d+)\s+pass/);
          const failMatch = output.match(/(\d+)\s+fail/);
          const totalMatch = output.match(/(\d+)\s+test/);
          if (passMatch || failMatch || totalMatch) {
            meta.test_result = {
              passed: passMatch ? parseInt(passMatch[1], 10) : null,
              failed: failMatch ? parseInt(failMatch[1], 10) : null,
              total: totalMatch ? parseInt(totalMatch[1], 10) : null,
            };
          }
        }
      }

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
  } else if (event.type === 'text' && event.text) {
    progress.push({
      type: 'text',
      text: event.text.substring(0, 300),
      ts: now,
    });
  } else if (event.type === 'error') {
    if (event.error_class) {
      meta.error_class = event.error_class;
    }
    progress.push({
      type: 'error',
      details: event.details || 'Agent error',
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
        metadata: completed.metadata || null,
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
        metadata: completed.metadata || null,
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
  setCancelFn, setErrorClass, cancelRequest,
  checkIdempotency,
};
