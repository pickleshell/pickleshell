// End-to-end tests: chat handler -> agent runtime -> concurrency buffer ->
// session-status/session-output. Exercises the full never-reject boundary and
// the canonical outcome persistence (runtime, execution_state, events,
// structured error, metadata) while the top-level polling state stays the
// request-lifecycle 'completed'.
//
// Scenarios: success, agent-reported error, non-zero exit, timeout,
// cancellation, synchronous adapter preparation error, onLine/parser error.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-e2e-test-'));

const fakeWrapper = path.join(tempDir, 'fake-wrapper.sh');
fs.writeFileSync(
  fakeWrapper,
  [
    '#!/bin/bash',
    'case "$1" in',
    '  *"__THROW_LINE__"*) printf \'%s\\n\' \'__THROW__\';;',
    '  *"__ERR__"*) printf \'%s\\n\' \'{"type":"error","error":{"message":"boom"}}\'; exit 1;;',
    '  *"__EXIT3__"*) printf \'%s\\n\' \'{"type":"text","part":{"text":"partial"}}\'; exit 3;;',
    '  *"__SLEEP__"*) sleep 30;;',
    '  *) printf \'%s\\n\' \'{"type":"text","part":{"text":"e2e ok"}}\';;',
    'esac',
  ].join('\n'),
  { mode: 0o700 }
);
process.env.OPENCODE_WRAPPER_SCRIPT = fakeWrapper;

const configPath = path.join(tempDir, 'config.json');
process.env.CONFIG_PATH = configPath;

const concurrency = require('./src/concurrency');
const registry = require('./src/runtime/registry');
// Load the production registry wiring first; the fake replaces only Codex
// for this network-free E2E process.
require('./src/agent');

// Register opencode (chat.js will too, via ./src/agent) and a fake 'codex'
// adapter used ONLY to exercise gateway failure handling for a registered but
// broken runtime: synchronous buildPrompt throw and onLine throw. This is a
// test double, not a Codex implementation.
registry.registerRuntime('codex', {
  name: 'codex',
  buildPrompt(message) {
    if (message.includes('__PREP_THROW__')) {
      throw new Error('prep exploded');
    }
    return message;
  },
  buildArgs(prompt) {
    return [fakeWrapper, prompt.includes('anything') ? '__THROW_LINE__' : 'codex-test-success', '', ''];
  },
  buildChildEnv() {
    return { PATH: process.env.PATH || '/usr/bin:/bin' };
  },
  createStreamHandler() {
    return {
      handleLine(line) {
        if (line === '__THROW__') throw new Error('parser exploded');
      },
      getSessionId() { return null; },
      getError() { return null; },
      getReply(f) { return f; },
      getEvents() { return []; },
    };
  },
});

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

function mockReq(body) {
  return { body };
}

function mockRes() {
  const res = {
    _status: null,
    _body: null,
    status(s) { res._status = s; return res; },
    json(b) { res._body = b; return res; },
  };
  return res;
}

function waitForCompletion(requestId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const status = concurrency.getRequestStatus(requestId);
      if (status.state === 'completed') {
        resolve(concurrency.getRequestOutput(requestId));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`waitForCompletion timed out for ${requestId} (state ${status.state})`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Reload config + timeout + chat with fresh settings so each scenario starts
// from a clean module state (timeoutSec is captured at chat load time).
async function runScenario({ chatId, chats, allowedRuntimes, message, sessionId, agent, agentTimeoutSec, cancelAfterMs, beforeWait }) {
  const config = { chats };
  if (allowedRuntimes !== undefined) config.allowed_runtimes = allowedRuntimes;
  fs.writeFileSync(configPath, JSON.stringify(config));

  if (agentTimeoutSec !== undefined) {
    process.env.AGENT_TIMEOUT_SEC = String(agentTimeoutSec);
  } else {
    delete process.env.AGENT_TIMEOUT_SEC;
  }
  delete require.cache[require.resolve('./src/timeout')];
  delete require.cache[require.resolve('./src/config')];
  delete require.cache[require.resolve('./src/chat')];

  const chatHandler = require('./src/chat');
  const res = mockRes();
  await chatHandler(mockReq({ chat_id: chatId, message, agent, session_id: sessionId }), res);

  const requestId = res._body.request_id;
  if (cancelAfterMs !== undefined) {
    setTimeout(() => concurrency.cancelRequest(requestId), cancelAfterMs);
  }
  if (beforeWait) beforeWait(requestId);

  const output = await waitForCompletion(requestId);
  return { res, requestId, output };
}

async function main() {
  const opencodeChat = { workspace: tempDir, runtime: 'opencode' };
  const codexChat = { workspace: tempDir, runtime: 'codex' };

  // === 1. success ===
  {
    console.log('\n=== e2e: success ===');
    const { res, requestId, output } = await runScenario({
      chatId: 'e2e-ok',
      chats: { 'e2e-ok': opencodeChat },
      message: 'hello',
      sessionId: 'e2e-sess-ok',
    });
    assert(res._body.ok === true && res._body.state === 'busy', 'chat handler responds busy immediately');
    assert(typeof requestId === 'string' && requestId.startsWith('req_'), 'chat handler returns request_id');
    assert(output.state === 'completed', 'success: top-level lifecycle state is completed');
    assert(output.output.execution_state === 'done', 'success: execution_state is done');
    assert(output.output.request_id === requestId, 'success: output preserves request_id');
    assert(output.output.runtime === 'opencode', 'success: runtime persisted');
    assert(output.output.reply === 'e2e ok', 'success: reply persisted');
    assert(output.output.error === null, 'success: no error');
    assert(Array.isArray(output.output.events) && output.output.events.length >= 1, 'success: events persisted');
    assert(output.output.metadata.error_class === null, 'success: metadata persisted');
    assert(typeof output.output.started_at === 'string', 'success: started_at persisted');
    assert(typeof output.output.completed_at === 'string', 'success: completed_at persisted');
    assert(typeof output.output.duration_ms === 'number', 'success: duration_ms persisted');
    assert(concurrency.getRequestStatus(requestId).next_action === 'session-output', 'success: next_action is session-output');
    assert(concurrency.status().active_count === 0, 'success: slot released');
  }

  // === 2. agent-reported error ===
  {
    console.log('\n=== e2e: agent error ===');
    const { requestId, output } = await runScenario({
      chatId: 'e2e-err',
      chats: { 'e2e-err': opencodeChat },
      message: 'do __ERR__ now',
      sessionId: 'e2e-sess-err',
    });
    assert(output.state === 'completed', 'agent error: top-level lifecycle state stays completed');
    assert(output.output.execution_state === 'error', 'agent error: execution_state is error');
    assert(output.output.error && output.output.error.class === 'agent_error', 'agent error: structured error class');
    assert(output.output.error.message === 'boom', 'agent error: error message persisted');
    assert(output.output.reply === null, 'agent error: no reply');
    assert(output.output.cancelled === false, 'agent error: not a cancellation');
    assert(output.output.metadata.error_class === 'agent_error', 'agent error: metadata error_class');
  }

  // An explicit request agent overrides the configured OpenCode backend.
  {
    console.log('\n=== e2e: explicit agent selection ===');
    const { output } = await runScenario({
      chatId: 'e2e-explicit-agent',
      chats: { 'e2e-explicit-agent': opencodeChat },
      allowedRuntimes: ['opencode', 'codex'],
      agent: 'codex',
      message: 'hello',
      sessionId: 'e2e-sess-explicit-agent',
    });
    assert(output.state === 'completed', 'explicit agent: lifecycle state is completed');
    assert(output.output.runtime === 'codex', 'explicit agent: request selects Codex over config');
    assert(output.output.execution_state === 'done', 'explicit agent: canonical outcome is preserved');
  }

  // === 3. non-zero exit ===
  {
    console.log('\n=== e2e: exit_error ===');
    const { requestId, output } = await runScenario({
      chatId: 'e2e-exit',
      chats: { 'e2e-exit': opencodeChat },
      message: 'run __EXIT3__',
      sessionId: 'e2e-sess-exit',
    });
    assert(output.state === 'completed', 'exit_error: top-level lifecycle state stays completed');
    assert(output.output.execution_state === 'exit_error', 'exit_error: execution_state is exit_error');
    assert(output.output.error && output.output.error.class === 'exit_error', 'exit_error: structured error class');
    assert(output.output.error.exit_code === 3, 'exit_error: exit code persisted');
    assert(output.output.reply === null, 'exit_error: no reply');
  }

  // === 4. cancellation ===
  {
    console.log('\n=== e2e: cancellation ===');
    const { requestId, output } = await runScenario({
      chatId: 'e2e-cancel',
      chats: { 'e2e-cancel': opencodeChat },
      message: 'run __SLEEP__',
      sessionId: 'e2e-sess-cancel',
      cancelAfterMs: 100,
    });
    assert(output.state === 'completed', 'cancel: top-level lifecycle state stays completed');
    assert(output.output.execution_state === 'cancelled', 'cancel: execution_state is cancelled');
    assert(output.output.cancelled === true, 'cancel: cancelled flag persisted');
    assert(output.output.error && output.output.error.class === 'cancelled', 'cancel: structured error class');
    assert(output.output.runtime === 'opencode', 'cancel: runtime persisted');
    assert(concurrency.status().active_count === 0, 'cancel: slot released via completeCancel');
  }

  // === 5. timeout ===
  {
    console.log('\n=== e2e: timeout ===');
    const { requestId, output } = await runScenario({
      chatId: 'e2e-timeout',
      chats: { 'e2e-timeout': opencodeChat },
      message: 'run __SLEEP__',
      sessionId: 'e2e-sess-timeout',
      agentTimeoutSec: 1,
    });
    assert(output.state === 'completed', 'timeout: top-level lifecycle state stays completed');
    assert(output.output.execution_state === 'timeout', 'timeout: execution_state is timeout');
    assert(output.output.error && output.output.error.class === 'timeout', 'timeout: structured error class');
    assert(output.output.error.message === 'Agent response timeout', 'timeout: error message persisted');
    assert(concurrency.getRequestStatus(requestId).next_action === 'session-output', 'timeout: next_action is session-output');
    assert(concurrency.status().active_count === 0, 'timeout: slot released');
  }

  // === 6. synchronous adapter preparation error ===
  {
    console.log('\n=== e2e: sync adapter prep error ===');
    const { res, output } = await runScenario({
      chatId: 'e2e-prep',
      chats: { 'e2e-prep': codexChat },
      allowedRuntimes: ['opencode', 'codex'],
      message: '__PREP_THROW__',
      sessionId: 'e2e-sess-prep',
    });
    assert(res._body.ok === true && res._body.state === 'busy', 'prep error: request accepted before prep runs');
    assert(output.state === 'completed', 'prep error: top-level lifecycle state stays completed');
    assert(output.output.runtime === 'codex', 'prep error: runtime persisted');
    assert(output.output.execution_state === 'error', 'prep error: execution_state is error');
    assert(output.output.error && output.output.error.class === 'internal_error', 'prep error: internal_error class');
    assert(output.output.error.message.includes('prep exploded'), 'prep error: message embedded');
    assert(output.output.events.length === 0, 'prep error: no events');
    assert(concurrency.status().active_count === 0, 'prep error: slot released');
  }

  // === 7. onLine/parser error ===
  {
    console.log('\n=== e2e: onLine/parser error ===');
    const { output } = await runScenario({
      chatId: 'e2e-online',
      chats: { 'e2e-online': codexChat },
      allowedRuntimes: ['opencode', 'codex'],
      message: 'anything',
      sessionId: 'e2e-sess-online',
    });
    assert(output.state === 'completed', 'onLine error: top-level lifecycle state stays completed');
    assert(output.output.runtime === 'codex', 'onLine error: runtime persisted');
    assert(output.output.execution_state === 'error', 'onLine error: execution_state is error');
    assert(output.output.error && output.output.error.class === 'internal_error', 'onLine error: internal_error class');
    assert(output.output.error.message.includes('Failed to process agent output'), 'onLine error: parser failure named');
    assert(output.output.error.message.includes('parser exploded'), 'onLine error: thrown message embedded');
    assert(concurrency.status().active_count === 0, 'onLine error: slot released');
  }

  // === 8. stale slot/process lifecycle ===
  {
    console.log('\n=== e2e: stale slot cancellation ===');
    let realNow;
    const stale = await runScenario({
      chatId: 'e2e-stale',
      chats: { 'e2e-stale': opencodeChat },
      message: 'run __SLEEP__',
      sessionId: 'e2e-sess-stale',
      beforeWait(requestId) {
        const { staleTimeoutMs } = require('./src/timeout');
        realNow = Date.now;
        Date.now = () => realNow() + staleTimeoutMs + 1000;
        const status = concurrency.getRequestStatus(requestId);
        assert(status.state === 'cancelling', 'stale slot triggers cancellation before release');
        const blocked = concurrency.acquire('e2e-stale', 'e2e-sess-stale');
        assert(!blocked.ok && blocked.error === 'session_busy', 'stale slot remains locked while process settles');
        Date.now = realNow;
      },
    });
    assert(stale.output.state === 'completed', 'stale slot: lifecycle state is completed');
    assert(stale.output.output.execution_state === 'cancelled', 'stale slot: execution_state is cancelled');
    assert(stale.output.output.error?.class === 'cancelled', 'stale slot: structured cancellation error');
    assert(concurrency.status().active_count === 0, 'stale slot: released after process settlement');
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\nE2E tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FAIL: e2e harness error:', err);
  process.exitCode = 1;
});
