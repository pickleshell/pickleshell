const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-codex-mcp-test-'));
const serverPath = path.join(tempDir, 'fake-mcp-server.js');

fs.writeFileSync(serverPath, `
const fs = require('fs');
const mode = process.argv[2];
const capturePath = process.argv[3];
const delay = Number(process.argv[4] || 0);

function append(entry) {
  fs.appendFileSync(capturePath, JSON.stringify(entry) + '\\n');
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function toolsForMode() {
  if (mode === 'bad-tools') return [{ name: 'codex' }];
  return [{ name: 'codex' }, { name: 'codex-reply' }];
}

if (mode === 'exit-before') process.exit(44);
if (mode === 'malformed') {
  process.stdout.write('not json\\n');
  setInterval(() => {}, 1000);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    append(message);
    if (message.method === 'initialize') {
      if (mode === 'hang-initialize' || (mode === 'hang-initialize-once' && readInitializeCount() === 1)) return;
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-codex', version: '0.143.0' } } });
    } else if (message.method === 'tools/list') {
      if (mode === 'hang-tools-list') return;
      send({ jsonrpc: '2.0', id: message.id, result: { tools: toolsForMode() } });
    } else if (message.method === 'tools/call') {
      const args = message.params.arguments || {};
      if (mode === 'approval') {
        send({ jsonrpc: '2.0', id: 1000 + message.id, method: 'sampling/createMessage', params: {} });
        return;
      }
      if (mode === 'unexpected-response') {
        send({ jsonrpc: '2.0', id: 999999, result: {} });
        return;
      }
      if (mode === 'exit-during') process.exit(45);
      if (mode === 'hang') return;
      const result = {
        content: [{ type: 'text', text: args.threadId ? 'continued reply' : 'initial reply' }],
        structuredContent: {
          threadId: args.threadId || 'thread-initial',
          content: args.threadId ? 'continued reply' : 'initial reply'
        }
      };
      setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result }), delay);
    }
  }
});

function readInitializeCount() {
  return fs.readFileSync(capturePath, 'utf8')
    .split(String.fromCharCode(10))
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === 'initialize')
    .length;
}

process.on('SIGTERM', () => {
  if (mode === 'ignore-term') return;
  process.exit(0);
});
setInterval(() => {}, 1000);
`);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

function makeCodexCommand(mode, name = mode, delay = 0) {
  const capturePath = path.join(tempDir, `${name}.json`);
  const commandPath = path.join(tempDir, `${name}-codex`);
  fs.writeFileSync(
    commandPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "%s\\n" "codex-cli 0.143.0"; exit 0; fi',
      'if [ "$1" = "mcp-server" ] && [ "$2" = "--help" ]; then printf "%s\\n" "fake mcp"; exit 0; fi',
      `if [ "$1" = "mcp-server" ]; then exec "${process.execPath}" "${serverPath}" "${mode}" "${capturePath}" "${delay}"; fi`,
      'exit 64',
    ].join('\n'),
    { mode: 0o700 }
  );
  return { commandPath, capturePath };
}

function freshMcp(commandPath) {
  try { require('./src/runtime/adapters/codex-mcp').shutdownAll(); } catch (_) {}
  process.env.CODEX_COMMAND = commandPath;
  delete require.cache[require.resolve('./src/runtime/adapters/codex-exec')];
  delete require.cache[require.resolve('./src/runtime/adapters/codex-mcp')];
  return require('./src/runtime/adapters/codex-mcp');
}

function readCapture(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function runMcp(mode, options = {}) {
  const fake = makeCodexCommand(mode, options.name || mode, options.delay || 0);
  const mcp = freshMcp(fake.commandPath);
  const run = mcp.runRequest({
    runtime: 'codex',
    request_id: options.requestId || `req_${mode}`,
    chatId: 'chat',
    message: options.message || 'hello',
    workspace: tempDir,
    timeoutSec: options.timeoutSec || 2,
    session_id: options.sessionId || null,
    model: options.model,
    fileSummary: null,
    onProgress: options.onProgress || null,
  });
  try {
    const result = await run.promise;
    return { result, capture: readCapture(fake.capturePath), mcp, run, fake };
  } finally {
    if (!options.keepAlive) mcp.shutdownAll();
  }
}

async function main() {
  console.log('\n=== mcp success and protocol ===');
  {
    const { result, capture } = await runMcp('success', { model: 'gpt-5.3-codex' });
    assert(result.ok === true && result.state === 'completed', 'initial MCP call completes');
    assert(result.session_id === 'thread-initial', 'structuredContent.threadId becomes session_id');
    assert(result.reply === 'initial reply', 'structuredContent.content becomes reply');
    assert(capture.some((m) => m.method === 'initialize'), 'initialize is sent');
    assert(capture.some((m) => m.method === 'notifications/initialized'), 'initialized notification is sent');
    assert(capture.some((m) => m.method === 'tools/list'), 'tools/list is sent');
    const call = capture.find((m) => m.method === 'tools/call');
    assert(call.params.name === 'codex', 'initial turn calls codex tool');
    assert(call.params.arguments.cwd === tempDir, 'cwd is explicit');
    assert(call.params.arguments.model === 'gpt-5.3-codex', 'model is explicit');
    assert(call.params.arguments['approval-policy'] === 'never', 'approval-policy is explicit');
    assert(call.params.arguments.sandbox === 'danger-full-access', 'sandbox is explicit');
    assert(call.params.arguments.prompt.includes('User instruction: hello'), 'prompt includes system/user instruction');
  }

  {
    const { result, capture } = await runMcp('success', { name: 'continue', sessionId: 'thread-initial' });
    assert(result.ok === true && result.session_id === 'thread-initial', 'continuation preserves thread id');
    const call = capture.find((m) => m.method === 'tools/call');
    assert(call.params.name === 'codex-reply', 'continuation calls codex-reply tool');
    assert(call.params.arguments.threadId === 'thread-initial', 'continuation passes threadId');
    assert(call.params.arguments.cwd === undefined, 'continuation omits cwd because codex-reply schema does not accept it');
    assert(call.params.arguments.model === undefined, 'continuation omits model because codex-reply schema does not accept it');
    assert(call.params.arguments['approval-policy'] === undefined, 'continuation omits approval-policy because codex-reply schema does not accept it');
    assert(call.params.arguments.sandbox === undefined, 'continuation omits sandbox because codex-reply schema does not accept it');
  }

  console.log('\n=== parallel independent sessions ===');
  {
    const fake = makeCodexCommand('success', 'parallel', 200);
    const mcp = freshMcp(fake.commandPath);
    const startedAt = Date.now();
    const first = mcp.runRequest({ runtime: 'codex', request_id: 'req_parallel_1', chatId: 'a', message: 'one', workspace: tempDir, timeoutSec: 3 });
    const second = mcp.runRequest({ runtime: 'codex', request_id: 'req_parallel_2', chatId: 'b', message: 'two', workspace: tempDir, timeoutSec: 3 });
    const results = await Promise.all([first.promise, second.promise]);
    assert(results.every((result) => result.ok), 'parallel independent MCP requests complete');
    assert(Date.now() - startedAt < 360, 'parallel calls avoid head-of-line blocking');
    assert(readCapture(fake.capturePath).filter((m) => m.method === 'tools/call').length === 2, 'parallel calls both dispatch');
    mcp.shutdownAll();
  }

  console.log('\n=== long-lived worker reuse ===');
  {
    const fake = makeCodexCommand('success', 'reuse');
    const mcp = freshMcp(fake.commandPath);
    const first = await mcp.runRequest({ runtime: 'codex', request_id: 'req_reuse_1', chatId: 'a', message: 'one', workspace: tempDir, timeoutSec: 2 }).promise;
    const second = await mcp.runRequest({ runtime: 'codex', request_id: 'req_reuse_2', chatId: 'a', message: 'two', workspace: tempDir, timeoutSec: 2 }).promise;
    const capture = readCapture(fake.capturePath);
    assert(first.ok === true && second.ok === true, 'sequential calls complete through reusable MCP worker');
    assert(capture.filter((m) => m.method === 'initialize').length === 1, 'idle MCP worker is reused after success');
    mcp.shutdownAll();
  }

  console.log('\n=== cancellation and timeout recycle ===');
  {
    const fake = makeCodexCommand('hang', 'cancel');
    const mcp = freshMcp(fake.commandPath);
    const run = mcp.runRequest({ runtime: 'codex', request_id: 'req_cancel', chatId: 'chat', message: 'hang', workspace: tempDir, timeoutSec: 5 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(run.cancel() === true, 'cancel returns true for hanging tools/call');
    const result = await run.promise;
    assert(result.state === 'cancelled' && result.error.class === 'cancelled', 'hanging tools/call resolves cancelled');
    const cancelled = readCapture(fake.capturePath).some((m) => m.method === 'notifications/cancelled');
    assert(cancelled, 'cancel sends notifications/cancelled');
    const { result: after } = await runMcp('success', { name: 'after-cancel' });
    assert(after.ok === true, 'new worker succeeds after cancelled worker recycle');
  }

  {
    const { result } = await runMcp('hang', { name: 'timeout', timeoutSec: 0.1 });
    assert(result.state === 'timeout' && result.error.class === 'timeout', 'unresolved tools/call times out');
    const { result: after } = await runMcp('success', { name: 'after-timeout' });
    assert(after.ok === true, 'new worker succeeds after timed-out worker recycle');
  }

  console.log('\n=== startup timeout and prompt failure ===');
  {
    const fake = makeCodexCommand('hang-initialize-once', 'startup-timeout');
    const mcp = freshMcp(fake.commandPath);
    const startedAt = Date.now();
    const first = await mcp.runRequest({ runtime: 'codex', request_id: 'req_startup_timeout', chatId: 'chat', message: 'hang', workspace: tempDir, timeoutSec: 0.1 }).promise;
    assert(first.state === 'timeout' && first.error.class === 'timeout', 'hung initialize resolves canonical timeout');
    assert(Date.now() - startedAt < 1000, 'hung initialize timeout stays within request bound');
    const second = await mcp.runRequest({ runtime: 'codex', request_id: 'req_startup_recovery', chatId: 'chat', message: 'recover', workspace: tempDir, timeoutSec: 1 }).promise;
    assert(second.ok === true, 'fresh worker succeeds after hung initialize cleanup');
    assert(readCapture(fake.capturePath).filter((m) => m.method === 'initialize').length === 2, 'hung initialize worker is not pooled or retried');
    mcp.shutdownAll();
  }
  {
    const { result } = await runMcp('hang-tools-list', { timeoutSec: 0.1 });
    assert(result.state === 'timeout' && result.error.class === 'timeout', 'hung tools/list resolves canonical timeout');
  }
  {
    const fake = makeCodexCommand('success', 'prompt-throw');
    const mcp = freshMcp(fake.commandPath);
    const execAdapter = require('./src/runtime/adapters/codex-exec');
    const originalBuildPrompt = execAdapter.buildPrompt;
    execAdapter.buildPrompt = () => { throw new Error('prompt build failed'); };
    let result;
    let rejected = false;
    try {
      result = await mcp.runRequest({ runtime: 'codex', request_id: 'req_prompt_throw', chatId: 'chat', message: 'bad', workspace: tempDir, timeoutSec: 1 }).promise;
    } catch (_) {
      rejected = true;
    } finally {
      execAdapter.buildPrompt = originalBuildPrompt;
      mcp.shutdownAll();
    }
    assert(!rejected && result?.ok === false && result.error.class === 'transport_error', 'synchronous buildPrompt throw resolves AgentResult without rejection');
    assert(!fs.existsSync(fake.capturePath), 'synchronous buildPrompt throw does not spawn a worker');
  }

  console.log('\n=== transport failures ===');
  {
    const { result } = await runMcp('malformed', { timeoutSec: 1 });
    assert(result.state === 'error' && result.error.class === 'mcp_malformed_json', 'malformed JSON is stable transport error');
  }
  {
    const { result } = await runMcp('exit-before', { timeoutSec: 1 });
    assert(result.state === 'error' && result.error.class === 'transport_exit', 'server exit before dispatch is transport_exit');
  }
  {
    const { result } = await runMcp('exit-during', { timeoutSec: 1 });
    assert(result.state === 'error' && result.error.class === 'transport_exit', 'server exit during call is ambiguous transport_exit');
  }
  {
    const { result, capture } = await runMcp('exit-during', { name: 'no-retry', timeoutSec: 1 });
    assert(result.error.class === 'transport_exit', 'in-flight failure reports transport error');
    assert(capture.filter((m) => m.method === 'tools/call').length === 1, 'in-flight failure is not blindly retried');
  }
  {
    const { result } = await runMcp('approval', { timeoutSec: 1 });
    assert(result.state === 'error' && result.error.class === 'approval_request_rejected', 'server approval request fails closed');
  }
  {
    const { result } = await runMcp('unexpected-response', { timeoutSec: 1 });
    assert(result.state === 'error' && result.error.class === 'mcp_unexpected_response', 'unexpected response id is rejected');
  }
  {
    const { result } = await runMcp('bad-tools', { timeoutSec: 1 });
    assert(result.state === 'error' && result.error.class === 'mcp_incompatible', 'incompatible tool list is rejected');
  }
  {
    const mcp = freshMcp(makeCodexCommand('success', 'sync-write').commandPath);
    const worker = new mcp.JsonRpcWorker({ requestTimeoutMs: 1000 });
    worker.proc = { stdin: { write() { throw new Error('stdin closed'); } } };
    const result = await worker.request('initialize', {}).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    assert(result.ok === false && result.error.code === 'transport_write_failed', 'synchronous stdin write failure rejects as transport error');
    assert(worker.pending.size === 0, 'synchronous stdin write failure clears pending request');
    mcp.shutdownAll();
  }

  console.log('\n=== clean shutdown ===');
  {
    const fake = makeCodexCommand('hang', 'shutdown');
    const mcp = freshMcp(fake.commandPath);
    const worker = new mcp.JsonRpcWorker({ command: fake.commandPath, env: mcp.buildChildEnv(), requestTimeoutMs: 2000 });
    await worker.initialize();
    const pending = worker.callTool('codex', { prompt: 'hang', cwd: tempDir, 'approval-policy': 'never', sandbox: 'danger-full-access' });
    mcp.shutdownAll();
    const result = await pending.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    assert(result.ok === false && result.error.code === 'transport_shutdown', 'shutdown rejects pending worker request');
  }
  {
    const fake = makeCodexCommand('ignore-term', 'shutdown-kill');
    const mcp = freshMcp(fake.commandPath);
    const worker = new mcp.JsonRpcWorker({ command: fake.commandPath, env: mcp.buildChildEnv(), requestTimeoutMs: 2000 });
    await worker.initialize();
    const pid = worker.proc.pid;
    mcp.shutdownAll();
    await new Promise((resolve) => setTimeout(resolve, 1900));
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert(alive === false, 'shutdown escalates SIGTERM-ignoring worker to SIGKILL');
  }

  console.log('\n=== config and agent integration ===');
  {
    const fake = makeCodexCommand('success', 'agent-integration');
    process.env.CODEX_COMMAND = fake.commandPath;
    delete require.cache[require.resolve('./src/runtime/adapters/codex-exec')];
    delete require.cache[require.resolve('./src/runtime/adapters/codex-mcp')];
    delete require.cache[require.resolve('./src/runtime/adapters/codex')];
    delete require.cache[require.resolve('./src/agent')];
    const agent = require('./src/agent');
    assert(agent.isRuntimeTransportAvailable('codex', 'mcp') === true, 'agent reports configured MCP transport available');
    assert(agent.isRuntimeTransportAvailable('codex', 'bogus') === false, 'agent rejects invalid Codex transport availability');
    const run = agent.runAgentRequest({
      runtime: 'codex',
      transport: 'mcp',
      request_id: 'req_agent_mcp',
      chatId: 'chat',
      message: 'hello',
      workspace: tempDir,
      timeoutSec: 2,
      model: 'gpt-5.3-codex',
    });
    const result = await run.promise;
    assert(result.ok === true && result.session_id === 'thread-initial', 'agent dispatches Codex MCP transport');
    const invalid = await agent.runAgentRequest({
      runtime: 'codex',
      transport: 'bogus',
      request_id: 'req_agent_bad_transport',
      chatId: 'chat',
      message: 'hello',
      workspace: tempDir,
      timeoutSec: 2,
    }).promise;
    assert(invalid.state === 'error' && invalid.error.class === 'codex_transport_invalid', 'invalid direct transport does not fall back to exec');
  }
  {
    const configPath = path.join(tempDir, 'config.json');
    process.env.CONFIG_PATH = configPath;
    delete require.cache[require.resolve('./src/config')];
    fs.writeFileSync(configPath, JSON.stringify({
      codex: { transport: 'mcp' },
      chats: {
        a: { workspace: tempDir, runtime: 'codex' },
        b: { workspace: tempDir, runtime: 'codex', codex: { transport: 'exec' } },
        bad: { workspace: tempDir, runtime: 'codex', codex: { transport: 'bogus' } }
      }
    }));
    const config = require('./src/config');
    assert(config.resolveCodexTransport('a').transport === 'mcp', 'global codex.transport is used');
    assert(config.resolveCodexTransport('b').transport === 'exec', 'per-chat codex.transport overrides global');
    assert(config.resolveCodexTransport('bad').status === 'invalid', 'invalid per-chat transport is rejected');
  }

  console.log(`\nCodex MCP tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { require('./src/runtime/adapters/codex-mcp').shutdownAll(); } catch (_) {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
