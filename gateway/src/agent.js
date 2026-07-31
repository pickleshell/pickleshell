// Gateway entry point for agent execution.
//
// The process lifecycle (spawn, timeout, cancellation) and the runtime-neutral
// contract live in src/runtime. Runtime-specific behavior lives in the
// adapters registered in src/runtime/registry. This module provides the
// canonical runAgentRequest() entry point and keeps the legacy sendMessage()
// surface for backward compatibility.
//
// runAgentRequest() returns { promise, cancel }, like supervise() and the
// legacy sendMessage(). Its promise NEVER rejects: every failure (spawn,
// timeout, agent error, non-zero exit, cancellation, unavailable runtime) is
// represented in the returned AgentResult.

const crypto = require('crypto');
const { RUNTIME_OPENCODE } = require('./runtime/contract');
const { registerRuntime, getRuntime } = require('./runtime/registry');
const { supervise } = require('./runtime/supervisor');
const { buildMetadata } = require('./runtime/normalize');
const opencodeAdapter = require('./runtime/adapters/opencode');

registerRuntime(RUNTIME_OPENCODE, opencodeAdapter);

function generateRequestId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `req_${ts}-${rand}`;
}

function classifyOutcome({ cancelled, timedOut, spawnError, exitCode, exitSignal, agentError }) {
  if (cancelled) {
    return {
      state: 'cancelled',
      errorClass: 'cancelled',
      error: { class: 'cancelled', message: 'Cancelled', exit_code: exitCode, signal: exitSignal },
    };
  }
  if (timedOut) {
    return {
      state: 'timeout',
      errorClass: 'timeout',
      error: { class: 'timeout', message: 'Agent response timeout', exit_code: exitCode, signal: exitSignal },
    };
  }
  if (spawnError) {
    return {
      state: 'error',
      errorClass: 'spawn_error',
      error: { class: 'spawn_error', message: spawnError.message, exit_code: exitCode, signal: exitSignal },
    };
  }
  if (agentError) {
    return {
      state: 'error',
      errorClass: 'agent_error',
      error: { class: 'agent_error', message: agentError, exit_code: exitCode, signal: exitSignal },
    };
  }
  if (exitCode !== 0) {
    return {
      state: 'exit_error',
      errorClass: 'exit_error',
      error: { class: 'exit_error', message: `Agent exited with code ${exitCode}`, exit_code: exitCode, signal: exitSignal },
    };
  }
  return { state: 'completed', errorClass: null, error: null };
}

function buildAgentResult({ ok, runtime, request_id, session_id, state, reply, events, errorClass, error, startedAt, startedMs }) {
  return {
    ok,
    runtime,
    request_id,
    session_id,
    state,
    reply,
    events,
    metadata: buildMetadata(events, errorClass),
    error: error || null,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    sessionId: session_id,
    cancelled: state === 'cancelled',
  };
}

function runAgentRequest({ runtime, request_id, chatId, message, workspace, timeoutSec, session_id, model, fileSummary, onProgress }) {
  const runtimeName = runtime || RUNTIME_OPENCODE;
  const requestId = request_id || generateRequestId();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const adapter = getRuntime(runtimeName);
  if (!adapter) {
    const error = { class: 'unavailable', message: `Runtime "${runtimeName}" is not available`, exit_code: null, signal: null };
    const promise = Promise.resolve(buildAgentResult({
      ok: false,
      runtime: runtimeName,
      request_id: requestId,
      session_id: session_id || null,
      state: 'error',
      reply: null,
      events: [],
      errorClass: 'unavailable',
      error,
      startedAt,
      startedMs,
    }));
    return { promise, cancel: () => false };
  }

  const prompt = adapter.buildPrompt(message, fileSummary);
  const args = adapter.buildArgs(prompt, workspace, session_id, model);

  console.log(
    `[${runtimeName.toUpperCase()}] request chat=${chatId}` +
    ` request_id=${requestId}` +
    ` session=${session_id ? 'existing' : 'new'}` +
    ` model=${model || 'default'}` +
    ` files=${fileSummary?.length || 0}` +
    ` message_len=${message.length}`
  );

  const handler = adapter.createStreamHandler({ chatId, onProgress });

  const { promise: procPromise, cancel } = supervise({
    command: 'bash',
    args,
    cwd: workspace,
    env: adapter.buildChildEnv(),
    timeoutMs: timeoutSec * 1000,
    onLine: handler.handleLine,
  });

  const promise = procPromise.then(({ code, signal, cancelled, timedOut, spawnError }) => {
    const classification = classifyOutcome({
      cancelled,
      timedOut,
      spawnError,
      exitCode: code,
      exitSignal: signal,
      agentError: handler.getError(),
    });

    if (classification.state === 'completed') {
      const reply = handler.getReply(`Message received and processed for ${chatId}. No output generated.`);
      console.log(
        `[${runtimeName.toUpperCase()}] Completed for ${chatId} request=${requestId}` +
        ` session=${handler.getSessionId() || '(none)'} code=${code}`
      );
      return buildAgentResult({
        ok: true,
        runtime: runtimeName,
        request_id: requestId,
        session_id: handler.getSessionId(),
        state: 'completed',
        reply,
        events: handler.getEvents(),
        errorClass: null,
        error: null,
        startedAt,
        startedMs,
      });
    }

    console.error(
      `[${runtimeName.toUpperCase()}] ${classification.state} for ${chatId} request=${requestId}:` +
      ` ${classification.error.message}`
    );
    return buildAgentResult({
      ok: false,
      runtime: runtimeName,
      request_id: requestId,
      session_id: handler.getSessionId(),
      state: classification.state,
      reply: null,
      events: handler.getEvents(),
      errorClass: classification.errorClass,
      error: classification.error,
      startedAt,
      startedMs,
    });
  });

  return { promise, cancel };
}

const sendMessage = (chatId, message, chatConfig, timeoutSec, sessionId, model, fileSummary, onProgress) => {
  return runAgentRequest({
    runtime: RUNTIME_OPENCODE,
    chatId,
    message,
    workspace: chatConfig.workspace,
    timeoutSec,
    session_id: sessionId,
    model,
    fileSummary,
    onProgress,
  });
};

module.exports = {
  buildChildEnv: opencodeAdapter.buildChildEnv,
  parseJsonOutput: opencodeAdapter.parseJsonOutput,
  classifyOutcome,
  generateRequestId,
  runAgentRequest,
  sendMessage,
};
