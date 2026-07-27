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

concurrency.release(progressSession.slotKey);

console.log(`All tests: ${passed} passed`);
