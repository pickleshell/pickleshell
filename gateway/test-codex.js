const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-codex-test-'));
const fakeCodex = path.join(tempDir, 'codex');
const capturePath = path.join(tempDir, 'args.bin');
const envCapturePath = path.join(tempDir, 'env.bin');
const codexHome = path.join(tempDir, 'codex-home');
fs.mkdirSync(codexHome);

fs.writeFileSync(
  fakeCodex,
  [
    '#!/bin/bash',
    'if [ "$1" = "--version" ]; then printf "%s\\n" "codex-cli 0.143.0"; exit 0; fi',
    `printf "%s\\0" "$@" > '${capturePath}'`,
    `printf "%s\\0%s\\0" "$CODEX_HOME" "\${CODEX_API_KEY-}" > '${envCapturePath}'`,
    'case "$*" in',
    '  *"__ERROR__"*) printf \'%s\\n\' \'{"type":"error","message":"provider down"}\'; exit 0;;',
    '  *"__EXIT3__"*) printf \'%s\\n\' \'{"type":"thread.started","thread_id":"codex-exit"}\'; exit 3;;',
    '  *"__MALFORMED__"*) printf \'%s\\n\' \'not-json\'; sleep 30;;',
    '  *"__SLEEP__"*) sleep 30;;',
    '  *"__RESUME__"*) printf \'%s\\n\' \'{"type":"thread.started","thread_id":"codex-resumed"}\'; printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"continued"}}\';;',
    '  *) printf \'%s\\n\' \'{"type":"thread.started","thread_id":"codex-thread-1"}\'; printf \'%s\\n\' \'{"type":"item.started","item":{"type":"command_execution","command":"printf ok"}}\'; printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"command_execution","command":"printf ok","aggregated_output":"ok","exit_code":0}}\'; printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"README.md","kind":"update","diff":"diff"}]}}\'; printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"finished"}}\';;',
    'esac',
  ].join('\n'),
  { mode: 0o700 }
);

process.env.CODEX_COMMAND = fakeCodex;
process.env.CODEX_HOME = codexHome;
process.env.CODEX_API_KEY = 'must-not-leak';

const adapter = require('./src/runtime/adapters/codex');
const agent = require('./src/agent');
const registry = require('./src/runtime/registry');
const concurrency = require('./src/concurrency');

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

function readArgs() {
  return fs.readFileSync(capturePath).toString('utf8').split('\0').filter(Boolean);
}

function mockReq(body) {
  return { body };
}

function mockRes() {
  const res = {
    _status: null,
    _body: null,
    status(status) { res._status = status; return res; },
    json(body) { res._body = body; return res; },
  };
  return res;
}

function waitForCompletion(requestId) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (concurrency.getRequestStatus(requestId).state === 'completed') {
        resolve(concurrency.getRequestOutput(requestId));
        return;
      }
      if (Date.now() - startedAt > 10000) {
        reject(new Error(`Codex integration timed out: ${requestId}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function main() {
  console.log('\n=== codex adapter argv ===');
  const initialArgs = adapter.buildArgs('initial prompt', '/workspace', null, 'gpt-5.3-codex');
  assert(initialArgs[0] === 'exec' && initialArgs.includes('--json'), 'initial args use codex exec --json');
  assert(initialArgs.includes('--cd') && initialArgs[initialArgs.indexOf('--cd') + 1] === '/workspace', 'initial args propagate workspace');
  assert(initialArgs.includes('--model') && initialArgs[initialArgs.indexOf('--model') + 1] === 'gpt-5.3-codex', 'initial args propagate model');
  assert(!initialArgs.includes('resume'), 'initial args do not resume a session');

  const resumeArgs = adapter.buildArgs('continued prompt', '/workspace', 'thread-old', 'gpt-5.3-codex');
  assert(resumeArgs.includes('resume'), 'resume args use codex resume syntax');
  assert(resumeArgs[resumeArgs.indexOf('resume') + 1] === 'thread-old', 'resume args propagate session id');
  assert(resumeArgs[resumeArgs.indexOf('resume') + 2] === 'continued prompt', 'resume args append the prompt');
  assert(adapter.command === fakeCodex, 'adapter uses configured Codex executable');

  console.log('\n=== codex environment ===');
  const childEnv = adapter.buildChildEnv({ HOME: '/home/test', PATH: '/bin', CODEX_HOME: '/custom/codex', CODEX_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' });
  assert(childEnv.CODEX_HOME === '/custom/codex', 'CODEX_HOME is explicit');
  assert(childEnv.CODEX_API_KEY === undefined, 'API key is not inherited');
  assert(childEnv.AWS_SECRET_ACCESS_KEY === undefined, 'unlisted secrets are not inherited');
  assert(adapter.isAvailable() === true, 'configured Codex executable is available');

  console.log('\n=== codex normalization ===');
  const normalized = [
    ...adapter.normalizeEvent({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
    ...adapter.normalizeEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'ok' } }),
    ...adapter.normalizeEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js', kind: 'update', diff: 'diff' }] } }),
    ...adapter.normalizeEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    ...adapter.normalizeEvent({ type: 'error', message: 'provider down' }),
  ];
  assert(normalized[0].type === 'tool' && normalized[0].status === 'running', 'command start normalizes to running tool');
  assert(normalized[1].type === 'tool' && normalized[1].status === 'done', 'command completion normalizes to done tool');
  assert(normalized[2].tool === 'file_edit' && normalized[2].input.filePath === 'a.js', 'file change normalizes to file tool');
  assert(normalized[3].type === 'text' && normalized[3].text === 'done', 'agent message normalizes to text');
  assert(normalized[4].type === 'error' && normalized[4].error_class === 'agent_error', 'provider error normalizes to error');
  const parsed = adapter.parseJsonOutput('{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}');
  assert(parsed.sessionId === 't1' && parsed.text === 'ok', 'parseJsonOutput extracts session and reply');
  assert(adapter.validateModel('gpt-5.3-codex') === null, 'plain Codex model id is accepted');
  assert(adapter.validateModel('openai/gpt-5.3-codex')?.class === 'unsupported_model', 'provider-qualified model is rejected');

  console.log('\n=== codex agent lifecycle ===');
  const base = { runtime: 'codex', chatId: 'codex-test', workspace: tempDir, timeoutSec: 10 };
  let result = await agent.runAgentRequest({ ...base, request_id: 'req_codex_success', message: 'hello', model: 'gpt-5.3-codex' }).promise;
  assert(result.ok === true && result.state === 'completed', 'Codex success resolves completed');
  assert(result.runtime === 'codex' && result.session_id === 'codex-thread-1', 'success preserves Codex runtime and session');
  assert(result.reply === 'finished', 'success preserves agent reply');
  assert(result.events.some((event) => event.type === 'tool' && event.status === 'done'), 'success includes command event');
  assert(result.events.some((event) => event.type === 'tool' && event.tool === 'file_edit'), 'success includes file event');
  assert(result.metadata.files_modified.includes('README.md'), 'success metadata tracks file changes');
  const capturedEnv = fs.readFileSync(envCapturePath).toString('utf8').split('\0');
  assert(capturedEnv[0] === codexHome && capturedEnv[1] === '', 'child receives CODEX_HOME but not API key');
  const capturedArgs = readArgs();
  assert(capturedArgs.includes('--model') && capturedArgs.includes('gpt-5.3-codex'), 'child receives requested model');

  result = await agent.runAgentRequest({ ...base, message: 'hello', model: 'openai/gpt-5.3-codex' }).promise;
  assert(result.state === 'error' && result.error.class === 'unsupported_model', 'Codex rejects provider-qualified model');

  result = await agent.runAgentRequest({ ...base, request_id: 'req_codex_resume', message: '__RESUME__', session_id: 'thread-old' }).promise;
  assert(result.state === 'completed' && result.session_id === 'codex-resumed', 'resume returns continued session');
  assert(result.reply === 'continued' && readArgs().includes('resume'), 'resume reaches Codex CLI');

  let progressFailures = 0;
  result = await agent.runAgentRequest({ ...base, message: 'hello', onProgress: () => { progressFailures++; throw new Error('consumer'); } }).promise;
  assert(result.state === 'completed' && result.error === null, 'progress consumer failure does not fail agent');
  assert(progressFailures > 0, 'progress consumer was invoked');

  result = await agent.runAgentRequest({ ...base, message: '__ERROR__' }).promise;
  assert(result.state === 'error' && result.error.class === 'agent_error', 'provider error is agent_error');

  result = await agent.runAgentRequest({ ...base, message: '__EXIT3__' }).promise;
  assert(result.state === 'exit_error' && result.error.exit_code === 3, 'non-zero Codex exit is exit_error');

  const timeout = agent.runAgentRequest({ ...base, message: '__SLEEP__', timeoutSec: 0.05 });
  result = await timeout.promise;
  assert(result.state === 'timeout' && result.error.class === 'timeout', 'Codex timeout is structured');

  const cancellation = agent.runAgentRequest({ ...base, message: '__SLEEP__', timeoutSec: 10 });
  assert(cancellation.cancel() === true, 'Codex cancellation is accepted');
  result = await cancellation.promise;
  assert(result.state === 'cancelled' && result.error.class === 'cancelled', 'Codex cancellation is structured');

  result = await agent.runAgentRequest({ ...base, message: '__MALFORMED__' }).promise;
  assert(result.state === 'error' && result.error.class === 'internal_error', 'malformed JSONL is internal_error');

  registry.registerRuntime('codex-unavailable', {
    isAvailable: () => false,
    command: fakeCodex,
  });
  result = await agent.runAgentRequest({ ...base, runtime: 'codex-unavailable', message: 'hello' }).promise;
  assert(result.state === 'error' && result.error.class === 'unavailable', 'unavailable Codex runtime does not fall back');

  console.log('\n=== codex gateway integration ===');
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    chats: { codex: { workspace: tempDir, runtime: 'codex' } },
    allowed_runtimes: ['opencode', 'codex'],
    default_model: 'opencode/big-pickle',
  }));
  process.env.CONFIG_PATH = configPath;
  const chatHandler = require('./src/chat');
  const response = mockRes();
  await chatHandler(mockReq({ chat_id: 'codex', message: 'hello', session_id: 'codex-http-session' }), response);
  const output = await waitForCompletion(response._body.request_id);
  assert(response._body.state === 'busy', 'Codex HTTP path returns the standard busy response');
  assert(output.state === 'completed', 'Codex HTTP path preserves lifecycle state');
  assert(output.output.runtime === 'codex', 'Codex HTTP path persists runtime');
  assert(output.output.execution_state === 'done', 'Codex HTTP path persists done outcome');
  assert(output.output.request_id === response._body.request_id, 'Codex HTTP path preserves request_id');
  assert(output.output.reply === 'finished', 'Codex HTTP path persists reply');
  assert(Array.isArray(output.output.events) && output.output.events.length > 0, 'Codex HTTP path persists events');
  assert(output.output.error === null && output.output.metadata, 'Codex HTTP path has standard error/metadata shape');
  assert(!readArgs().includes('--model'), 'Codex without model does not receive OpenCode default_model');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\nCodex tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
