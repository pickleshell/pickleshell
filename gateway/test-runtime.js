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
    '  *"__EXIT3__"*) printf \'%s\\n\' \'{"type":"text","part":{"text":"partial"}}\'; exit 3;;',
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
  const { createAgentEvent, buildMetadata } = require('./src/runtime/normalize');
  const { supervise, TERM_GRACE_MS } = require('./src/runtime/supervisor');
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
  {
    const meta = buildMetadata([
      createAgentEvent('tool', { tool: 'write', status: 'running', input: { filePath: '/a.js' } }),
      createAgentEvent('tool', { tool: 'write', status: 'done', title: 'A', input: { filePath: '/a.js' } }),
      createAgentEvent('tool', { tool: 'write', status: 'done', title: 'B', input: { filePath: '/b.js' } }),
      createAgentEvent('tool', { tool: 'bash', status: 'done', input: { command: 'npm test' }, output: '181 passed, 0 failed, 181 tests' }),
      createAgentEvent('tool', { tool: 'bash', status: 'done', input: { command: 'git commit -m "feat: x"' }, output: '[main abc1234] feat: x' }),
      createAgentEvent('error', { details: 'boom', error_class: 'agent_error' }),
    ], null);
    assert(meta.files_modified.length === 2 && meta.files_modified[0] === '/a.js', 'buildMetadata tracks files once');
    assert(meta.tools_used.includes('write') && meta.tools_used.includes('bash'), 'buildMetadata tracks tools');
    assert(meta.test_result && meta.test_result.passed === 181 && meta.test_result.failed === 0, 'buildMetadata extracts test results');
    assert(meta.git_commit === 'abc1234', 'buildMetadata extracts git commit');
    assert(meta.error_class === 'agent_error', 'buildMetadata picks error_class from error events');
  }

  console.log('\n=== registry ===');
  assert(registry.isRuntimeRegistered('opencode') === false, 'registry starts empty');
  {
    const dummy = { name: 'test-fake', buildArgs: () => [] };
    registry.registerRuntime('test-fake', dummy);
    assert(registry.getRuntime('test-fake') === dummy, 'registerRuntime/getRuntime round trip');
    assert(registry.isRuntimeRegistered('test-fake'), 'isRuntimeRegistered true after register');
    assert(registry.isRuntimeAvailable('test-fake'), 'isRuntimeAvailable true after register');
    assert(registry.isRuntimeAvailable('missing') === false, 'isRuntimeAvailable false for unknown runtime');
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
    assert(outcome.signal === null, 'no signal on clean exit');
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
    assert(outcome.code === null, 'killed-by-signal child reports no exit code');
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
    // Regression: a grandchild holding the stdout pipe open must not be
    // orphaned. Signals go to the whole process group, so the backgrounded
    // `sleep` dies with the group and the promise resolves on real close.
    const marker = path.join(tempDir, 'grandchild.pid');
    const exec = supervise({
      command: '/bin/bash',
      args: ['-c', `sleep 30 & echo $! > '${marker}'; wait`],
      timeoutMs: 10000,
      onLine: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(exec.cancel() === true, 'cancel() returns true with open grandchild');
    const outcome = await exec.promise;
    assert(outcome.cancelled === true, 'cancel resolves only after the group actually closed');
    const pid = parseInt(fs.readFileSync(marker, 'utf8').trim(), 10);
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert(alive === false, 'grandchild process is killed with the process group');
  }
  {
    // Regression: a child that ignores SIGTERM must be SIGKILLed after the
    // grace period; the promise must NOT resolve from `proc.killed` alone.
    // The child prints "ready" only after installing its SIGTERM handler so
    // the signal cannot race node's startup default.
    let execRef = null;
    const ready = new Promise((resolve) => {
      execRef = supervise({
        command: process.execPath,
        args: ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
        timeoutMs: 10000,
        onLine: (line) => { if (line === 'ready') resolve(); },
      });
    });
    await ready;
    const startedAt = Date.now();
    assert(execRef.cancel() === true, 'cancel() returns true for SIGTERM-ignoring child');
    const outcome = await execRef.promise;
    const elapsed = Date.now() - startedAt;
    assert(outcome.cancelled === true, 'SIGTERM-ignoring child resolves as cancelled');
    assert(outcome.signal === 'SIGKILL', 'escalation delivers SIGKILL after grace period');
    assert(elapsed >= TERM_GRACE_MS, 'cancellation waits for the SIGTERM grace period before SIGKILL');
  }
  {
    // Regression: a throw inside onLine must not crash the supervisor or
    // leave the child running. The process group is SIGKILLed, no further
    // lines are delivered, and the error is reported via onLineError.
    const lines = [];
    const outcome = await supervise({
      command: '/bin/bash',
      args: ['-c', 'printf "good\\n"; sleep 30'],
      timeoutMs: 10000,
      onLine: (line) => {
        lines.push(line);
        if (line === 'good') throw new Error('onLine exploded');
      },
    }).promise;
    assert(outcome.onLineError !== null, 'supervisor reports onLineError');
    assert(outcome.onLineError.message === 'onLine exploded', 'onLineError carries the thrown message');
    assert(outcome.cancelled === false && outcome.timedOut === false, 'onLine failure is neither cancel nor timeout');
    assert(outcome.code === null && outcome.signal === 'SIGKILL', 'onLine failure SIGKILLs the process group');
    assert(lines.length === 1 && lines[0] === 'good', 'no further onLine deliveries after failure');
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
    assert(outcome.signal === null, 'no signal on spawn error');
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
    assert(tool && tool.type === 'tool' && tool.tool === 'bash' && tool.status === 'running', 'normalizeEvent maps running tool_use events');
    assert(tool.input === null, 'tool event without input carries input:null');
    const done = adapter.normalizeEvent({ type: 'tool_use', part: { tool: 'write', state: { status: 'completed', title: 't', input: { filePath: '/a' } } } });
    assert(done && done.status === 'done' && done.input && done.input.filePath === '/a', 'completed tool_use maps to done with input extracted');
    const err = adapter.normalizeEvent({ type: 'error', error: { message: 'boom' } });
    assert(err && err.type === 'error' && err.details === 'boom' && err.error_class === 'agent_error', 'normalizeEvent maps error events');
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
    assert(raw.length === 3, 'stream handler forwards events to onProgress');
    assert(raw[0].type === 'text' && raw[1].type === 'tool' && raw[2].type === 'error', 'onProgress receives canonical AgentEvents, not raw JSONL');
    const events = handler.getEvents();
    assert(events.length === 3 && events[0].type === 'text' && events[1].type === 'tool' && events[2].type === 'error', 'stream handler collects normalized AgentEvents');
    const bare = adapter.createStreamHandler({ chatId: 'x', onProgress: null });
    assert(bare.getReply('fallback') === 'fallback', 'stream handler falls back when no text output');
  }

  console.log('\n=== agent facade ===');
  const agent = require('./src/agent');
  assert(typeof agent.sendMessage === 'function' && typeof agent.runAgentRequest === 'function', 'facade exports runAgentRequest');
  assert(typeof agent.buildChildEnv === 'function' && typeof agent.parseJsonOutput === 'function', 'facade keeps legacy exports');

  {
    const result = await agent.sendMessage('pickleshell-main', 'hello', { workspace: tempDir }, 10, null, 'opencode/big-pickle', null, null).promise;
    assert(result.reply === 'ok', 'facade resolves parsed reply');
    assert(result.state === 'completed', 'facade reports completed state');
    assert(result.runtime === 'opencode', 'facade result includes runtime');
    assert(result.ok === true && result.error === null, 'completed result has ok=true and no error');
    assert(Array.isArray(result.events) && result.events.length >= 1, 'facade result includes normalized events');
    assert(typeof result.request_id === 'string' && result.request_id.startsWith('req_'), 'facade result includes generated request_id');
    assert(typeof result.started_at === 'string' && typeof result.completed_at === 'string', 'facade result includes timestamps');
    assert(typeof result.duration_ms === 'number' && result.duration_ms >= 0, 'facade result includes duration_ms');
    assert(result.metadata && Array.isArray(result.metadata.tools_used), 'facade result includes metadata');
    assert(result.session_id === null && result.sessionId === null, 'facade result carries session fields');
  }
  {
    const progress = [];
    const result = await agent.sendMessage('pickleshell-main', '__SESSION__', { workspace: tempDir }, 10, 'ses_existing', null, null, (ev) => progress.push(ev)).promise;
    assert(result.reply === 'hi', 'facade resolves session reply');
    assert(result.session_id === 'ses_abc', 'facade returns runtime session_id');
    assert(result.sessionId === 'ses_abc', 'facade keeps legacy sessionId alias');
    assert(progress.length >= 1 && progress[0].type === 'text', 'facade forwards canonical progress events');
  }
  {
    const result = await agent.sendMessage('pickleshell-main', 'do __ERR__ now', { workspace: tempDir }, 10, null, null, null, null).promise;
    assert(result.ok === false && result.state === 'error', 'facade never rejects on agent error; state=error');
    assert(result.error && result.error.message === 'boom', 'facade embeds agent error message');
    assert(result.error && result.error.class === 'agent_error', 'facade classifies agent error');
    assert(result.metadata.error_class === 'agent_error', 'facade metadata carries error_class');
    assert(result.reply === null, 'failed facade result has no reply');
  }
  {
    const result = await agent.sendMessage('pickleshell-main', '__EXIT3__', { workspace: tempDir }, 10, null, null, null, null).promise;
    assert(result.ok === false && result.state === 'exit_error', 'facade classifies non-zero exit as exit_error');
    assert(result.error && result.error.class === 'exit_error', 'exit_error error class set');
    assert(result.error && result.error.exit_code === 3, 'exit_error carries the exit code');
    assert(result.metadata.error_class === 'exit_error', 'exit_error metadata error_class');
  }
  {
    const result = await agent.sendMessage('pickleshell-main', '__SLEEP__', { workspace: tempDir }, 0.05, null, null, null, null).promise;
    assert(result.ok === false && result.state === 'timeout', 'facade never rejects on timeout; state=timeout');
    assert(result.error && result.error.class === 'timeout', 'facade classifies timeout');
    assert(result.metadata.error_class === 'timeout', 'timeout metadata error_class');
  }
  {
    const execution = agent.sendMessage('pickleshell-main', '__SLEEP__', { workspace: tempDir }, 5, null, null, null, null);
    assert(execution.cancel() === true, 'facade cancel returns true on first call');
    const result = await execution.promise;
    assert(result.cancelled === true && result.reply === null, 'facade resolves cancelled result');
    assert(result.state === 'cancelled', 'facade reports cancelled state');
    assert(result.error && result.error.class === 'cancelled', 'facade classifies cancellation');
    assert(result.metadata.error_class === 'cancelled', 'cancelled metadata error_class');
  }
  {
    // runAgentRequest never rejects even when the runtime is unknown.
    const result = await agent.runAgentRequest({
      runtime: 'missing-runtime',
      chatId: 'pickleshell-main',
      message: 'hi',
      workspace: tempDir,
      timeoutSec: 10,
    }).promise;
    assert(result.ok === false && result.state === 'error', 'unavailable runtime resolves as error');
    assert(result.error && result.error.class === 'unavailable', 'unavailable runtime error class');
    assert(result.metadata.error_class === 'unavailable', 'unavailable metadata error_class');
  }
  {
    // runAgentRequest accepts an explicit request_id and echoes it back.
    const result = await agent.runAgentRequest({
      runtime: 'opencode',
      request_id: 'req_custom-abc123',
      chatId: 'pickleshell-main',
      message: 'hello',
      workspace: tempDir,
      timeoutSec: 10,
    }).promise;
    assert(result.request_id === 'req_custom-abc123', 'runAgentRequest echoes the provided request_id');
  }
  {
    // Never-reject boundary: synchronous adapter preparation must not throw.
    // A broken adapter whose buildPrompt throws yields an internal_error
    // AgentResult instead of a synchronous exception.
    registry.registerRuntime('prepboom', {
      name: 'prepboom',
      buildPrompt() { throw new Error('prep exploded'); },
      buildArgs() { return []; },
      buildChildEnv() { return {}; },
      createStreamHandler() {
        return { handleLine() {}, getSessionId() { return null; }, getError() { return null; }, getReply(f) { return f; }, getEvents() { return []; } };
      },
    });
    const prepResult = await agent.runAgentRequest({
      runtime: 'prepboom',
      chatId: 'pickleshell-main',
      message: 'hi',
      workspace: tempDir,
      timeoutSec: 10,
    }).promise;
    assert(prepResult.ok === false && prepResult.state === 'error', 'sync adapter prep failure resolves as error');
    assert(prepResult.error && prepResult.error.class === 'internal_error', 'sync adapter prep failure classifies as internal_error');
    assert(prepResult.error.message.includes('prep exploded'), 'sync adapter prep failure embeds the message');
    assert(prepResult.metadata.error_class === 'internal_error', 'sync adapter prep failure metadata error_class');
  }
  {
    // Never-reject boundary: a parser/normalizer (onLine) failure must kill
    // the process group and surface as internal_error, not crash the facade.
    registry.registerRuntime('lineboom', {
      name: 'lineboom',
      buildPrompt() { return 'prompt'; },
      buildArgs() { return ['-c', 'printf "__THROW__\\n"']; },
      buildChildEnv() { return { PATH: process.env.PATH || '/usr/bin:/bin' }; },
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
    const lineResult = await agent.runAgentRequest({
      runtime: 'lineboom',
      chatId: 'pickleshell-main',
      message: 'hi',
      workspace: tempDir,
      timeoutSec: 10,
    }).promise;
    assert(lineResult.ok === false && lineResult.state === 'error', 'onLine failure resolves as error');
    assert(lineResult.error && lineResult.error.class === 'internal_error', 'onLine failure classifies as internal_error');
    assert(lineResult.error.message.includes('Failed to process agent output'), 'onLine failure message names the parser');
    assert(lineResult.error.message.includes('parser exploded'), 'onLine failure embeds the thrown message');
    assert(lineResult.metadata.error_class === 'internal_error', 'onLine failure metadata error_class');
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
