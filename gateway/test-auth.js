process.env.PICKLESHELL_API_KEY = 'test-secret-key-for-auth-unit-test';

const auth = require('./src/auth');

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

function mockReq(headers = {}) {
  return { headers };
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

function nextCalled() { return { called: true }; }

// Test 1: Missing Authorization header
{
  const req = mockReq();
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'missing header → 401');
  assert(res._body.error === 'unauthorized', 'missing body error = unauthorized');
  assert(!nextDone, 'missing header → next() not called');
}

// Test 2: Non-Bearer Authorization header
{
  const req = mockReq({ authorization: 'Basic abc123' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'non-Bearer → 401');
  assert(!nextDone, 'non-Bearer → next() not called');
}

// Test 3: Correct token → next() called
{
  const req = mockReq({ authorization: 'Bearer test-secret-key-for-auth-unit-test' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(nextDone, 'valid token → next() called');
  assert(res._status === null, 'valid token → no response sent');
}

// Test 4: Wrong token (same length) → 401
{
  const req = mockReq({ authorization: 'Bearer wrong-secret-key-for-auth-unit-test' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'wrong token same length → 401');
  assert(!nextDone, 'wrong token same length → next() not called');
}

// Test 5: Wrong token (shorter) → 401 (no timing oracle)
{
  const req = mockReq({ authorization: 'Bearer short' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'shorter token → 401');
  assert(!nextDone, 'shorter token → next() not called');
}

// Test 6: Wrong token (longer) → 401 (no timing oracle)
{
  const req = mockReq({ authorization: 'Bearer a'.repeat(100) });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'longer token → 401');
  assert(!nextDone, 'longer token → next() not called');
}

// Test 7: Empty token → 401
{
  const req = mockReq({ authorization: 'Bearer ' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'empty token → 401');
}

// Test 8: No PICKLESHELL_API_KEY configured → 500
{
  delete process.env.PICKLESHELL_API_KEY;
  delete process.env.LOCAL_AGENT_API_KEY;
  const req = mockReq({ authorization: 'Bearer anything' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 500, 'no key configured → 500');
  assert(res._body.error === 'internal_error', 'no key body error = internal_error');
  process.env.PICKLESHELL_API_KEY = 'test-secret-key-for-auth-unit-test';
}

console.log(`\nAuth tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
