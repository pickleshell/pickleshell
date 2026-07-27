const concurrency = require('./src/concurrency');
const { parseAgentTimeoutSec, timeoutSec, staleTimeoutMs } = require('./src/timeout');

let passed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  passed++;
}

const first = concurrency.acquire('pickleshell-main', 'session-a');
assert(first.ok && first.slotKey, 'first session request acquires a slot');
concurrency.setTask(first.slotKey, 'Build forecast widget');

const sameSession = concurrency.acquire('pickleshell-main', 'session-a');
assert(!sameSession.ok, 'same session is rejected immediately');
assert(sameSession.error === 'session_busy', 'same session returns session_busy');
assert(sameSession.current_task === 'Build forecast widget', 'busy response includes task');
assert(typeof sameSession.elapsed_s === 'number', 'busy response includes elapsed time');

for (let i = 0; i < 25; i++) {
  const request = concurrency.acquire('pickleshell-main', `session-${i}`);
  assert(request.ok, `independent session ${i} is not globally limited`);
}

const anonymousA = concurrency.acquire('pickleshell-main');
const anonymousB = concurrency.acquire('pickleshell-main');
assert(anonymousA.ok && anonymousB.ok, 'requests without session_id are independent');

concurrency.release(first.slotKey);
const afterRelease = concurrency.acquire('pickleshell-main', 'session-a');
assert(afterRelease.ok, 'session can run again after release');

const status = concurrency.status();
assert(status.max === null, 'status reports no global maximum');
assert(status.policy === 'one_active_request_per_session', 'status reports policy');

const STALE_BUFFER_SEC = 30;
assert(
  staleTimeoutMs >= timeoutSec * 1000 + STALE_BUFFER_SEC * 1000,
  `staleTimeoutMs (${staleTimeoutMs}) must >= agentTimeout (${timeoutSec * 1000}) + ${STALE_BUFFER_SEC * 1000}ms buffer`
);
assert(
  timeoutSec > 0,
  `timeoutSec (${timeoutSec}) must be positive (AGENT_TIMEOUT_SEC=0 falls back to 300)`
);

console.log(`Concurrency tests: ${passed} passed`);

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
  passed++;
}

assertEq(parseAgentTimeoutSec(undefined), 300, 'undefined → 300');
assertEq(parseAgentTimeoutSec(''), 300, 'empty string → 300');
assertEq(parseAgentTimeoutSec('0'), 300, '"0" → 300 (zero falls back)');
assertEq(parseAgentTimeoutSec('-5'), 300, '"-5" → 300 (negative falls back)');
assertEq(parseAgentTimeoutSec('NaN'), 300, '"NaN" → 300 (NaN falls back)');
assertEq(parseAgentTimeoutSec('abc'), 300, '"abc" → 300 (non-numeric falls back)');
assertEq(parseAgentTimeoutSec('300'), 300, '"300" → 300');
assertEq(parseAgentTimeoutSec('60'), 60, '"60" → 60');
assertEq(parseAgentTimeoutSec('999'), 999, '"999" → 999');
assertEq(parseAgentTimeoutSec('Infinity'), 300, '"Infinity" → 300 (Infinity falls back)');
assertEq(parseAgentTimeoutSec('-Infinity'), 300, '"-Infinity" → 300 (negative Infinity falls back)');

console.log(`parseAgentTimeoutSec tests: ${passed} passed`);

// === Progress tracking tests ===
concurrency.release(afterRelease.slotKey);

const progressSession = concurrency.acquire('progress-test', 'sess-prog');
assert(progressSession.ok, 'progress session acquires');
concurrency.setTask(progressSession.slotKey, 'Create file');

concurrency.updateProgress(progressSession.slotKey, {
  type: 'tool_use',
  part: { tool: 'write', state: { status: 'running', input: { filePath: '/tmp/test.txt' }, title: 'test.txt' } }
});

let progress = concurrency.getProgress(progressSession.slotKey);
assert(progress !== null, 'getProgress returns data');
assert(progress.task === 'Create file', 'progress includes task');
assert(progress.events.length === 1, 'progress has 1 running event');
assert(progress.events[0].status === 'running', 'event status is running');
assert(progress.events[0].tool === 'write', 'event tool is write');

concurrency.updateProgress(progressSession.slotKey, {
  type: 'tool_use',
  part: { tool: 'write', state: { status: 'completed', input: { filePath: '/tmp/test.txt' }, output: 'OK', title: 'test.txt' } }
});

progress = concurrency.getProgress(progressSession.slotKey);
assert(progress.events.length === 1, 'completed replaces running event');
assert(progress.events[0].status === 'done', 'event status is done');
assert(progress.events[0].output === 'OK', 'event has output');

concurrency.updateProgress(progressSession.slotKey, {
  type: 'text',
  part: { text: 'Created test.txt' }
});

progress = concurrency.getProgress(progressSession.slotKey);
assert(progress.events.length === 2, 'text event added alongside completed tool');
assert(progress.events[1].type === 'text', 'second event is text');

const bySession = concurrency.getProgressBySession('progress-test', 'sess-prog');
assert(bySession !== null, 'getProgressBySession returns data');
assert(bySession.events.length === 2, 'getProgressBySession returns same events');

const noProgress = concurrency.getProgressBySession('progress-test', 'nonexistent');
assert(noProgress === null, 'getProgressBySession returns null for unknown session');

const readyStatus = concurrency.sessionStatus('status-test', 'sess-ready');
assert(readyStatus.ready === true && readyStatus.state === 'ready', 'free session reports ready');
const busyStatus = concurrency.sessionStatus('progress-test', 'sess-prog');
assert(busyStatus.ready === false && busyStatus.state === 'busy', 'active session reports busy');
const newStatus = concurrency.sessionStatus('status-test');
assert(newStatus.ready === true && newStatus.state === 'new_session', 'missing session reports new_session');

concurrency.complete(progressSession.slotKey, { reply: 'Done', trace: ['✓ write: test.txt'] });
concurrency.release(progressSession.slotKey);
const completedStatus = concurrency.sessionStatus('progress-test', 'sess-prog');
assert(completedStatus.state === 'completed', 'completed session exposes buffered output');
assert(completedStatus.output.reply === 'Done', 'completed buffer includes reply');
assert(completedStatus.output.trace.length === 1, 'completed buffer includes trace');

const nextCommand = concurrency.acquire('progress-test', 'sess-prog');
assert(nextCommand.ok, 'same session accepts next command');
assert(concurrency.sessionStatus('progress-test', 'sess-prog').state === 'busy', 'new command clears completed buffer');
concurrency.release(nextCommand.slotKey);

console.log(`All tests: ${passed} passed`);

// === request_id flow tests ===

// Test: acquire returns request_id
const reqTest = concurrency.acquire('req-test', 'sess-req');
assert(reqTest.ok, 'acquire returns ok');
assert(typeof reqTest.request_id === 'string', 'acquire returns request_id');
assert(reqTest.request_id.startsWith('req_'), 'request_id starts with req_');
concurrency.setTask(reqTest.slotKey, 'Test request_id');

// Test: getRequestStatus returns busy for active request
const reqBusy = concurrency.getRequestStatus(reqTest.request_id);
assert(reqBusy.state === 'busy', 'getRequestStatus returns busy for active request');
assert(reqBusy.chat_id === 'req-test', 'getRequestStatus includes chat_id');
assert(reqBusy.session_id === 'sess-req', 'getRequestStatus includes session_id');
assert(reqBusy.current_task === 'Test request_id', 'getRequestStatus includes task');

// Test: getRequestStatus returns unknown for nonexistent request_id
const reqUnknown = concurrency.getRequestStatus('req_nonexistent');
assert(reqUnknown.state === 'unknown', 'getRequestStatus returns unknown for nonexistent request_id');

// Test: complete + release stores by request_id
concurrency.complete(reqTest.slotKey, { reply: 'Request done', trace: ['✓ done'], session_id: 'sess-req' });
concurrency.release(reqTest.slotKey);

const reqCompleted = concurrency.getRequestStatus(reqTest.request_id);
assert(reqCompleted.state === 'completed', 'getRequestStatus returns completed after completion');
assert(reqCompleted.output.reply === 'Request done', 'completed output includes reply');
assert(reqCompleted.output.session_id === 'sess-req', 'completed output includes session_id');

// Test: sessionStatus also has the result (backward compat via sessionKey)
const sessCompleted = concurrency.sessionStatus('req-test', 'sess-req');
assert(sessCompleted.state === 'completed', 'sessionStatus also returns completed for same session');
assert(sessCompleted.output.reply === 'Request done', 'sessionStatus output matches');

// === Critical: no-session-id flow ===
// Simulates: POST /chat without session_id → busy → complete → status by request_id
const noSession = concurrency.acquire('fire-and-forget');
assert(noSession.ok, 'acquire without session_id succeeds');
assert(typeof noSession.request_id === 'string', 'acquire without session_id returns request_id');
concurrency.setTask(noSession.slotKey, 'Quick ping');

// Status by request_id while busy
const noSessionBusy = concurrency.getRequestStatus(noSession.request_id);
assert(noSessionBusy.state === 'busy', 'no-session request shows busy by request_id');
assert(noSessionBusy.session_id === null, 'no-session request has null session_id');

// Complete and check by request_id
concurrency.complete(noSession.slotKey, { reply: 'pong', trace: [], session_id: null });
concurrency.release(noSession.slotKey);

const noSessionDone = concurrency.getRequestStatus(noSession.request_id);
assert(noSessionDone.state === 'completed', 'no-session request shows completed by request_id');
assert(noSessionDone.output.reply === 'pong', 'no-session completed output includes reply');
assert(noSessionDone.output.session_id === null, 'no-session completed has null session_id');

// sessionStatus without session_id returns new_session (no data for anonymous)
const noSessionStatus = concurrency.sessionStatus('fire-and-forget');
assert(noSessionStatus.state === 'new_session', 'sessionStatus without session_id still returns new_session');

console.log(`request_id tests: ${passed} passed`);
