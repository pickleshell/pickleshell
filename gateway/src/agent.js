// Gateway entry point for agent execution.
//
// The process lifecycle (spawn, timeout, cancellation) and the runtime-neutral
// contract live in src/runtime. OpenCode-specific behavior lives in the
// OpenCode adapter. This module keeps the legacy public surface intact:
// sendMessage(), buildChildEnv(), and parseJsonOutput().

const { RUNTIME_OPENCODE } = require('./runtime/contract');
const { registerRuntime, getRuntime } = require('./runtime/registry');
const { supervise } = require('./runtime/supervisor');
const opencodeAdapter = require('./runtime/adapters/opencode');

registerRuntime(RUNTIME_OPENCODE, opencodeAdapter);

const sendMessage = (chatId, message, chatConfig, timeoutSec, sessionId, model, fileSummary, onProgress) => {
  const adapter = getRuntime(RUNTIME_OPENCODE);

  const prompt = adapter.buildPrompt(message, fileSummary);
  const args = adapter.buildArgs(prompt, chatConfig.workspace, sessionId, model);

  console.log(
    `[OPENCODE] request chat=${chatId}` +
    ` session=${sessionId ? 'existing' : 'new'}` +
    ` model=${model || 'default'}` +
    ` files=${fileSummary?.length || 0}` +
    ` message_len=${message.length}`
  );

  const handler = adapter.createStreamHandler({ chatId, onProgress });

  const { promise: procPromise, cancel } = supervise({
    command: 'bash',
    args,
    cwd: chatConfig.workspace,
    env: adapter.buildChildEnv(),
    timeoutMs: timeoutSec * 1000,
    onLine: handler.handleLine,
  });

  const promise = procPromise.then(({ code, cancelled, timedOut, spawnError }) => {
    if (cancelled) {
      console.log(`[OPENCODE] Cancelled for ${chatId} session=${handler.getSessionId() || '(none)'} code=${code}`);
      const result = {
        runtime: RUNTIME_OPENCODE,
        session_id: handler.getSessionId(),
        state: 'cancelled',
        reply: null,
        events: handler.getEvents(),
        sessionId: handler.getSessionId(),
      };
      result.cancelled = true;
      return result;
    }

    if (timedOut) {
      throw new Error('timeout');
    }

    if (spawnError) {
      console.error(`[OPENCODE] Spawn error for ${chatId}:`, spawnError.message);
      throw spawnError;
    }

    const agentError = handler.getError();
    if (agentError) {
      throw new Error(agentError);
    }

    const reply = handler.getReply(`Message received and processed for ${chatId}. No output generated.`);
    console.log(`[OPENCODE] Completed for ${chatId} session=${handler.getSessionId() || '(none)'} code=${code}`);
    return {
      runtime: RUNTIME_OPENCODE,
      session_id: handler.getSessionId(),
      state: 'completed',
      reply,
      events: handler.getEvents(),
      sessionId: handler.getSessionId(),
    };
  });

  return { promise, cancel };
};

module.exports = {
  buildChildEnv: opencodeAdapter.buildChildEnv,
  parseJsonOutput: opencodeAdapter.parseJsonOutput,
  sendMessage,
};
