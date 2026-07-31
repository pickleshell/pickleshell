const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-runtime-test-'));

const fakeWrapper = path.join(tempDir, 'fake-wrapper.sh');
fs.writeFileSync(
  fakeWrapper,
  [
    '#!/bin/bash',
    'case "$1" in',
    '  *"__ERR__"*) printf \'%s\\n\' \'{"type":"error","error":{"message":"boom"}}\'; exit 1;;',
    '  *"__SLEEP__"*) sleep 30;;',
    '  *"__SESSION__"*) printf \'%s\\n\' \'{"sessionID":"ses_abc","type":"text","part":{"text":"hi"}}\';;',
    '  *) printf \'%s\\n\' \'{"type":"text","part":{"text":"ok"}}\';;',
    'esac',
  ].join('\n'),
  { mode: 0o700 }
);
process.env.OPENCODE_WRAPPER_SCRIPT = fakeWrapper;

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

async function main() {
  const { RUNTIME_OPENCODE } = require('./src/runtime/contract');
  const registry = require('./src/runtime/registry');
  const { createAgentEvent } = require('./src/runtime/normalize');
  const { supervise } = require('./src/runtime/supervisor');
  const adapter = require('./src/runtime/adapters/opencode');

  console.log('\n=== contract ===');
  assert(RUNTIME_OPENCODE === 'opencode', 'RUNTIME_OPENCODE is "opencode"');

  console.log('\n=== normalize ===');
  {
    const ev = createAgentEvent('text', { text: 'hi' });
    assert(ev.type === 'text' && ev.text === 'hi' && typeof ev.timestamp === 'number', 'createAgentEvent builds canonical event');
    const bare = createAgentEvent('status');
    assert(bare.type === 'status' && bare.text === undefined && typeof bare.timestamp === 'number', 'createAgentEvent omits absent fields');
  }

  console.log('\n=== registry ===');
  assert(registry.isRuntimeRegistered('opencode') === false, 'registry starts empty');
  {
    const dummy = { name: 'test-fake', buildArgs: () => [] };
    registry.registerRuntime('test-fake', dummy);
    assert(registry.getRuntime('test-fake') === dummy, 'registerRuntime/getRuntime round trip');
    assert(registry.isRuntimeRegistered('test-fake'), 'isRuntimeRegistered true after register');
    assert(registry.getRuntime('missing') === null, 'getRuntime unknown returns null');
    assert(registry.availableRuntimes().includes('test-fake'), 'availableRuntimes lists registered adapter');
  }
  {
    let threw = false;
    try { registry.registerRuntime('', {}); } catch (e) { threw = true; }
    assert(threw, 'registerRuntime rejects empty name');
  }

  console.log('\n=== supervisor ===');
  {
    const lines = [];
    const outcome = await supervise({
      command: '/bin/bash',
      args: ['-c', 'printf "a\\nb\\n\\nc\\n"'],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    }).promise;
    assert(outcome.code === 0, 'supervisor resolves on clean exit');
    assert(JSON.stringify(lines) === JSON.stringify(['a', 'b', 'c']), 'supervisor streams non-empty lines');
    assert(outcome.cancelled === false && outcome.timedOut === false, 'outcome flags false on clean exit');
    assert(outcome.spawnError === null, 'no spawnError on clean exit');
  }
  {
    const outcome = await supervise({
      command: '/bin/bash',
      args: ['-c', 'sleep 30'],
      timeoutMs: 100,
      onLine: () => {},
    }).promise;
    assert(outcome.timedOut === true, 'supervisor times out and SIGKILLs child');
    assert(outcome.cancelled === false, 'timeout is not a cancellation');
  }
  {
    const exec = supervise({
      command: '/bin/bash',
      args: ['-c', 'sleep 30'],
      timeoutMs: 5000,
      onLine: () => {},
    });
    assert(exec.cancel() === true, 'cancel() returns true on first call');
    assert(exec.cancel() === false, 'cancel() returns false on second call');
    const outcome = await exec.promise;
    assert(outcome.cancelled === true, 'supervisor resolves cancelled outcome');
  }
  {
    const outcome = await supervise({
      command: '/nonexistent-pickleshell-runtime-bin',
      args: [],
      timeoutMs: 5000,
      onLine: () => {},
    }).promise;
    assert(outcome.spawnError !== null, 'supervisor reports spawn error');
    assert(outcome.code === null, 'no exit code on spawn error');
  }

  console.log('\n=== opencode adapter ===');
  {
    const args = adapter.buildArgs('prompt', '/ws', 'ses_1', 'm');
    assert(args.length === 5, 'buildArgs returns wrapper + 4 arguments');
    assert(args[0] === fakeWrapper, 'buildArgs uses configured WRAPPER_SCRIPT');
    assert(args[1] === 'prompt' && args[2] === '/ws' && args[3] === 'ses_1' && args[4] === 'm', 'buildArgs passes every value exactly');
    const empty = adapter.buildArgs('p', '/ws', null, null);
    assert(empty[3] === '' && empty[4] === '', 'buildArgs emits empty placeholders for missing session/model');
  }
  {
    const sample = [
      '{"sessionID":"ses_1","type":"text","part":{"text":"one"}}',
      '{"type":"tool_use","part":{"tool":"bash","state":{"title":"run","output":"done"}}}',
      'not json at all',
      '{"type":"text","part":{"text":"two"}}',
    ].join('\n');
    const parsed = adapter.parseJsonOutput(sample);
    assert(parsed.sessionId === 'ses_1', 'parseJsonOutput extracts sessionID');
    assert(parsed.text === 'one\n[run]: done\ntwo', 'parseJsonOutput joins text and tool output, skips junk');
  }
  {
    const ev = adapter.normalizeEvent({ type: 'text', part: { text: 'hi' } });
    assert(ev && ev.type === 'text' && ev.text === 'hi', 'normalizeEvent maps text events');
    const tool = adapter.normalizeEvent({ type: 'tool_use', part: { tool: 'bash', state: { status: 'running', title: 'cmd', output: 'out' } } });
    assert(tool && tool.type === 'tool' && tool.tool === 'bash' && tool.status === 'running', 'normalizeEvent maps tool_use events');
    const err = adapter.normalizeEvent({ type: 'error', error: { message: 'boom' } });
    assert(err && err.type === 'error' && err.details === 'boom', 'normalizeEvent maps error events');
    assert(adapter.normalizeEvent({ type: 'status', part: {} }) === null, 'normalizeEvent ignores unmapped events');
    assert(adapter.normalizeEvent(null) === null, 'normalizeEvent ignores non-events');
  }
  {
    const raw = [];
    const handler = adapter.createStreamHandler({ chatId: 'pickleshell-main', onProgress: (ev) => raw.push(ev) });
    handler.handleLine('{"sessionID":"ses_abc","type":"text","part":{"text":"one"}}');
    handler.handleLine('{"type":"tool_use","part":{"tool":"bash","state":{"title":"run","output":"done"}}}');
    handler.handleLine('{"type":"error","error":{"message":"boom"}}');
    handler.handleLine('not json');
    assert(handler.getSessionId() === 'ses_abc', 'stream handler tracks sessionID');
    assert(handler.getError() === 'boom', 'stream handler tracks agent error');
    assert(handler.getReply('fallback') === 'one\n[run]: done', 'stream handler assembles reply');
    assert(raw.length === 3, 'stream handler forwards raw events to onProgress');
    assert(raw[0].type === 'text' && raw[1].type === 'tool_use', 'onProgress receives raw OpenCode events');
    const events = handler.getEvents();
    assert(events.length === 3 && events[0].type === 'text' && events[1].type === 'tool' && events[2].type === 'error', 'stream handler collects normalized AgentEvents');
    const bare = adapter.createStreamHandler({ chatId: 'x', onProgress: null });
    assert(bare.getReply('fallback') === 'fallback', 'stream handler falls back when no text output');
  }

  console.log('\n=== agent facade ===');
  const agent = require('./src/agent');
  assert(typeof agent.sendMessage === 'function' && typeof agent.buildChildEnv === 'function' && typeof agent.parseJsonOutput === 'function', 'facade keeps legacy exports');

  {
    const result = await agent.sendMessage('pickleshell-main', 'hello', { workspace: tempDir }, 10, null, 'opencode/big-pickle', null, null).promise;
    assert(result.reply === 'ok', 'facade resolves parsed reply');
    assert(result.state === 'completed', 'facade reports completed state');
    assert(result.runtime === 'opencode', 'facade result includes runtime');
    assert(Array.isArray(result.events) && result.events.length >= 1, 'facade result includes normalized events');
  }
  {
    const progress = [];
    const result = await agent.sendMessage('pickleshell-main', '__SESSION__', { workspace: tempDir }, 10, 'ses_existing', null, null, (ev) => progress.push(ev)).promise;
    assert(result.reply === 'hi', 'facade resolves session reply');
    assert(result.session_id === 'ses_abc', 'facade returns runtime session_id');
    assert(result.sessionId === 'ses_abc', 'facade keeps legacy sessionId alias');
    assert(progress.length >= 1 && progress[0].type === 'text', 'facade forwards progress events');
  }
  {
    let rejected = null;
    try {
      await agent.sendMessage('pickleshell-main', 'do __ERR__ now', { workspace: tempDir }, 10, null, null, null, null).promise;
    } catch (e) {
      rejected = e;
    }
    assert(rejected && rejected.message === 'boom', 'facade rejects on agent error event');
  }
  {
    let rejected = null;
    try {
      await agent.sendMessage('pickleshell-main', '__SLEEP__', { workspace: tempDir }, 0.05, null, null, null, null).promise;
    } catch (e) {
      rejected = e;
    }
    assert(rejected && rejected.message.includes('timeout'), 'facade rejects on timeout');
  }
  {
    const execution = agent.sendMessage('pickleshell-main', '__SLEEP__', { workspace: tempDir }, 5, null, null, null, null);
    assert(execution.cancel() === true, 'facade cancel returns true on first call');
    const result = await execution.promise;
    assert(result.cancelled === true && result.reply === null, 'facade resolves cancelled result');
    assert(result.state === 'cancelled', 'facade reports cancelled state');
  }

  console.log('\n=== default wrapper resolution ===');
  {
    const saved = process.env.OPENCODE_WRAPPER_SCRIPT;
    delete process.env.OPENCODE_WRAPPER_SCRIPT;
    const resPath = require.resolve('./src/runtime/adapters/opencode.js');
    delete require.cache[resPath];
    const fresh = require(resPath);
    assert(fresh.WRAPPER_SCRIPT === path.join(__dirname, 'opencode-run.sh'), 'default WRAPPER_SCRIPT resolves to gateway/opencode-run.sh');
    process.env.OPENCODE_WRAPPER_SCRIPT = saved;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = failed > 0 ? 1 : 0;
  });
