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
assert(completedStatus.state === 'completed', 'completed session reports completed');
assert(completedStatus.output === undefined, 'sessionStatus is lightweight — no output');

// sessionOutput returns full output
const completedOutput = concurrency.sessionOutput('progress-test', 'sess-prog');
assert(completedOutput.state === 'completed', 'sessionOutput reports completed');
assert(completedOutput.output.reply === 'Done', 'sessionOutput includes reply');
assert(completedOutput.output.trace.length === 1, 'sessionOutput includes trace');

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
assert(reqCompleted.output === undefined, 'getRequestStatus is lightweight — no output');

const reqOutput = concurrency.getRequestOutput(reqTest.request_id);
assert(reqOutput.state === 'completed', 'getRequestOutput returns completed');
assert(reqOutput.output.reply === 'Request done', 'getRequestOutput includes reply');
assert(reqOutput.output.session_id === 'sess-req', 'getRequestOutput includes session_id');

// Test: sessionStatus also reports completed (lightweight, no output)
const sessCompleted = concurrency.sessionStatus('req-test', 'sess-req');
assert(sessCompleted.state === 'completed', 'sessionStatus also returns completed for same session');
assert(sessCompleted.output === undefined, 'sessionStatus is lightweight — no output');

// Test: sessionOutput returns full output (backward compat via sessionKey)
const sessOutput = concurrency.sessionOutput('req-test', 'sess-req');
assert(sessOutput.state === 'completed', 'sessionOutput returns completed');
assert(sessOutput.output.reply === 'Request done', 'sessionOutput includes reply');

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

// getRequestStatus (lightweight) — NO output even when completed
const noSessionDone = concurrency.getRequestStatus(noSession.request_id);
assert(noSessionDone.state === 'completed', 'no-session request shows completed by request_id');
assert(noSessionDone.output === undefined, 'getRequestStatus does NOT include output');

// getRequestOutput (full) — HAS output
const noSessionOutput = concurrency.getRequestOutput(noSession.request_id);
assert(noSessionOutput.state === 'completed', 'getRequestOutput shows completed');
assert(noSessionOutput.output.reply === 'pong', 'getRequestOutput includes reply');
assert(noSessionOutput.output.session_id === null, 'getRequestOutput includes session_id');

// sessionStatus without session_id returns new_session (no data for anonymous)
const noSessionStatus = concurrency.sessionStatus('fire-and-forget');
assert(noSessionStatus.state === 'new_session', 'sessionStatus without session_id still returns new_session');

console.log(`request_id tests: ${passed} passed`);

// === status/output split tests ===
console.log('\n=== status/output split ===');

const splitTest = concurrency.acquire('split-test', 'sess-split');
assert(splitTest.ok, 'split test acquires');
concurrency.setTask(splitTest.slotKey, 'Split task');

// Busy: both have progress
const splitBusyStatus = concurrency.getRequestStatus(splitTest.request_id);
assert(splitBusyStatus.state === 'busy', 'split busy status');
assert(splitBusyStatus.progress !== undefined, 'split busy status has progress');

const splitBusyOutput = concurrency.getRequestOutput(splitTest.request_id);
assert(splitBusyOutput.state === 'busy', 'split busy output');
assert(splitBusyOutput.output === undefined, 'split busy output has no output yet');

// Complete
concurrency.complete(splitTest.slotKey, { reply: 'Split result', trace: ['✓ done'], session_id: 'sess-split' });
concurrency.release(splitTest.slotKey);

// Completed: status has NO output, output HAS output
const splitDoneStatus = concurrency.getRequestStatus(splitTest.request_id);
assert(splitDoneStatus.state === 'completed', 'split done status');
assert(splitDoneStatus.output === undefined, 'split done status has NO output');

const splitDoneOutput = concurrency.getRequestOutput(splitTest.request_id);
assert(splitDoneOutput.state === 'completed', 'split done output');
assert(splitDoneOutput.output.reply === 'Split result', 'split done output has reply');
assert(splitDoneOutput.output.trace.length === 1, 'split done output has trace');
assert(splitDoneOutput.output.session_id === 'sess-split', 'split done output has session_id');

console.log(`status/output split tests: ${passed} passed`);

// === cancel tests ===
console.log('\n=== cancel tests ===');

// Cancel active request — slot stays locked
const cancelTarget = concurrency.acquire('cancel-test', 'sess-cancel');
assert(cancelTarget.ok, 'cancel target acquires');
concurrency.setTask(cancelTarget.slotKey, 'Should be cancelled');
let cancelCalled = false;
concurrency.setCancelFn(cancelTarget.slotKey, () => { cancelCalled = true; });

const cancelResult = concurrency.cancelRequest(cancelTarget.request_id);
assert(cancelResult.ok, 'cancel returns ok');
assert(cancelResult.status === 'cancelling', 'cancel status is cancelling');
assert(cancelCalled, 'cancel function was called');

// Slot is still locked — new command to same session gets 409
const raceAttempt = concurrency.acquire('cancel-test', 'sess-cancel');
assert(!raceAttempt.ok, 'new command blocked during cancelling');
assert(raceAttempt.error === 'session_busy', 'blocked command returns session_busy');

// Status shows cancelling (not busy, not unknown)
const cancellingStatus = concurrency.getRequestStatus(cancelTarget.request_id);
assert(cancellingStatus.state === 'cancelling', 'status shows cancelling during cancel');
assert(cancellingStatus.next_action === 'session-status', 'cancelling next_action is session-status');

// Double cancel returns already_cancelling
const doubleCancel = concurrency.cancelRequest(cancelTarget.request_id);
assert(!doubleCancel.ok, 'double cancel returns not ok');
assert(doubleCancel.status === 'already_cancelling', 'double cancel status is already_cancelling');

// Simulate process settled — completeCancel releases the slot
concurrency.completeCancel(cancelTarget.slotKey, { session_id: 'sess-cancel' });

// After completeCancel, status shows completed with cancelled flag
const afterCancel = concurrency.getRequestStatus(cancelTarget.request_id);
assert(afterCancel.state === 'completed', 'cancelled request shows completed after settle');
const afterCancelOutput = concurrency.getRequestOutput(cancelTarget.request_id);
assert(afterCancelOutput.output.cancelled === true, 'cancelled output has cancelled:true');
assert(afterCancelOutput.output.session_id === 'sess-cancel', 'cancelled output preserves session_id');

// Session is now free
const afterCancelAcquire = concurrency.acquire('cancel-test', 'sess-cancel');
assert(afterCancelAcquire.ok, 'session free after completeCancel');
concurrency.release(afterCancelAcquire.slotKey);

// Cancel already completed
const cancelCompleted = concurrency.acquire('cancel-test', 'sess-cancel-completed');
assert(cancelCompleted.ok, 'cancel-completed acquires');
concurrency.complete(cancelCompleted.slotKey, { reply: 'Done', trace: [] });
concurrency.release(cancelCompleted.slotKey);

const cancelAlreadyDone = concurrency.cancelRequest(cancelCompleted.request_id);
assert(!cancelAlreadyDone.ok, 'cancel already completed returns not ok');
assert(cancelAlreadyDone.status === 'already_completed', 'cancel already_completed status');

// Cancel nonexistent
const cancelMissing = concurrency.cancelRequest('req_nonexistent');
assert(!cancelMissing.ok, 'cancel nonexistent returns not ok');
assert(cancelMissing.status === 'not_found', 'cancel not_found status');

console.log(`cancel tests: ${passed} passed`);

// === next_action + retry_after_ms tests ===
console.log('\n=== next_action + retry_after_ms ===');

// acquire returns next_action in busy response
const naTarget = concurrency.acquire('next-action-test', 'sess-na');
assert(naTarget.ok, 'next_action test acquires');
concurrency.setTask(naTarget.slotKey, 'NA task');

// Busy: next_action = session-status
const naBusy = concurrency.getRequestStatus(naTarget.request_id);
assert(naBusy.next_action === 'session-status', 'busy getRequestStatus next_action is session-status');
assert(naBusy.retry_after_ms === 2000, 'busy getRequestStatus retry_after_ms is 2000');

// Complete
concurrency.complete(naTarget.slotKey, { reply: 'NA done', trace: [] });
concurrency.release(naTarget.slotKey);

// Completed: next_action = session-output
const naCompleted = concurrency.getRequestStatus(naTarget.request_id);
assert(naCompleted.next_action === 'session-output', 'completed getRequestStatus next_action is session-output');
assert(naCompleted.retry_after_ms === 0, 'completed getRequestStatus retry_after_ms is 0');

// Output: next_action = null
const naOutput = concurrency.getRequestOutput(naTarget.request_id);
assert(naOutput.next_action === null, 'getRequestOutput next_action is null');
assert(naOutput.retry_after_ms === 0, 'getRequestOutput retry_after_ms is 0');

// Unknown: next_action = null
const naUnknown = concurrency.getRequestStatus('req_nonexistent_na');
assert(naUnknown.next_action === null, 'unknown next_action is null');

// sessionStatus busy: next_action = session-status
const naSessBusy = concurrency.acquire('na-session', 'sess-na-sess');
assert(naSessBusy.ok, 'na session busy acquires');
const naSessStatus = concurrency.sessionStatus('na-session', 'sess-na-sess');
assert(naSessStatus.next_action === 'session-status', 'sessionStatus busy next_action is session-status');
assert(naSessStatus.retry_after_ms === 2000, 'sessionStatus busy retry_after_ms is 2000');

// sessionStatus completed: next_action = session-output
concurrency.complete(naSessBusy.slotKey, { reply: 'done', trace: [] });
concurrency.release(naSessBusy.slotKey);
const naSessDone = concurrency.sessionStatus('na-session', 'sess-na-sess');
assert(naSessDone.next_action === 'session-output', 'sessionStatus completed next_action is session-output');

// sessionOutput completed: next_action = null
const naSessOut = concurrency.sessionOutput('na-session', 'sess-na-sess');
assert(naSessOut.next_action === null, 'sessionOutput completed next_action is null');

console.log(`next_action tests: ${passed} passed`);

// === timestamp tests ===
console.log('\n=== timestamps ===');

const tsTarget = concurrency.acquire('ts-test', 'sess-ts');
assert(tsTarget.ok, 'timestamp test acquires');
assert(typeof tsTarget.request_id === 'string', 'timestamp test has request_id');

// Busy timestamps: created_at present, started_at null
const tsBusy = concurrency.getRequestStatus(tsTarget.request_id);
assert(typeof tsBusy.created_at === 'string', 'busy has created_at');
assert(tsBusy.created_at.endsWith('Z'), 'created_at is ISO 8601');
assert(tsBusy.started_at === null, 'busy started_at is null');
assert(tsBusy.completed_at === null, 'busy completed_at is null');
assert(tsBusy.queue_ms === null, 'busy queue_ms is null');
assert(tsBusy.execution_ms === null, 'busy execution_ms is null before started');

// Set started and check
concurrency.setStarted(tsTarget.slotKey);
const tsBusyStarted = concurrency.getRequestStatus(tsTarget.request_id);
assert(typeof tsBusyStarted.started_at === 'string', 'busy started_at is string after setStarted');
assert(tsBusyStarted.started_at.endsWith('Z'), 'started_at is ISO 8601');
assert(typeof tsBusyStarted.queue_ms === 'number', 'busy has queue_ms after started');
assert(tsBusyStarted.queue_ms >= 0, 'busy queue_ms is non-negative');
assert(tsBusyStarted.completed_at === null, 'busy completed_at still null');
assert(typeof tsBusyStarted.execution_ms === 'number', 'busy has execution_ms after started');
assert(tsBusyStarted.execution_ms >= 0, 'busy execution_ms is non-negative');

// Complete and check
concurrency.complete(tsTarget.slotKey, { reply: 'ts done', trace: [], session_id: 'sess-ts' });
concurrency.release(tsTarget.slotKey);

const tsOutput = concurrency.getRequestOutput(tsTarget.request_id);
assert(typeof tsOutput.created_at === 'string', 'completed has created_at');
assert(typeof tsOutput.started_at === 'string', 'completed has started_at');
assert(typeof tsOutput.completed_at === 'string', 'completed has completed_at');
assert(tsOutput.completed_at.endsWith('Z'), 'completed_at is ISO 8601');
assert(typeof tsOutput.queue_ms === 'number', 'completed has queue_ms');
assert(tsOutput.queue_ms >= 0, 'completed queue_ms is non-negative');
assert(typeof tsOutput.execution_ms === 'number', 'completed has execution_ms');
assert(tsOutput.execution_ms >= 0, 'completed execution_ms is non-negative');

console.log(`timestamp tests: ${passed} passed`);
