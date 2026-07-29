const crypto = require('crypto');
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

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function test(name, env, bearer, expectedStatus) {
  withEnv(env, () => {
    const req = mockReq(bearer ? { authorization: 'Bearer ' + bearer } : {});
    const res = mockRes();
    let nextDone = false;
    auth(req, res, () => { nextDone = true; });
    if (expectedStatus === null) {
      assert(res._status === null, name + ' → no response (next() called)');
      assert(nextDone, name + ' → next() called');
    } else {
      assert(res._status === expectedStatus, name + ' → ' + expectedStatus);
      assert(!nextDone, name + ' → next() not called');
    }
  });
}

// ==============================================
// Hash of 'my-raw-key' for test use
// ==============================================
const RAW_KEY = 'my-raw-key';
const RAW_KEY_HASH = crypto.createHash('sha256').update(RAW_KEY, 'utf8').digest('hex');

// ==============================================
// 1. Missing Authorization header → 401
// ==============================================
{
  const req = mockReq();
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'missing header → 401');
  assert(res._body.error === 'unauthorized', 'missing body error = unauthorized');
  assert(!nextDone, 'missing header → next() not called');
}

// ==============================================
// 2. Non-Bearer Authorization header → 401
// ==============================================
{
  const req = mockReq({ authorization: 'Basic abc123' });
  const res = mockRes();
  let nextDone = false;
  auth(req, res, () => { nextDone = true; });
  assert(res._status === 401, 'non-Bearer → 401');
  assert(!nextDone, 'non-Bearer → next() not called');
}

// ==============================================
// 3. Preferred hash: correct raw token accepted
// ==============================================
test('hash: correct token',
  { PICKLESHELL_API_KEY_SHA256: RAW_KEY_HASH },
  RAW_KEY, null);

// ==============================================
// 4. Preferred hash: wrong token rejected
// ==============================================
test('hash: wrong token',
  { PICKLESHELL_API_KEY_SHA256: RAW_KEY_HASH },
  'wrong-token', 401);

// ==============================================
// 5. Configured hash string itself rejected as bearer
// ==============================================
test('hash: hash itself as bearer rejected',
  { PICKLESHELL_API_KEY_SHA256: RAW_KEY_HASH },
  RAW_KEY_HASH, 401);

// ==============================================
// 6. Malformed hash → 500 (uppercase)
// ==============================================
test('hash: uppercase rejected',
  { PICKLESHELL_API_KEY_SHA256: RAW_KEY_HASH.toUpperCase() },
  RAW_KEY, 500);

// ==============================================
// 7. Malformed hash → 500 (short)
// ==============================================
test('hash: short hex rejected',
  { PICKLESHELL_API_KEY_SHA256: 'abc123' },
  RAW_KEY, 500);

// ==============================================
// 8. Malformed hash → 500 (non-hex)
// ==============================================
test('hash: non-hex rejected',
  { PICKLESHELL_API_KEY_SHA256: 'z' + RAW_KEY_HASH.slice(1) },
  RAW_KEY, 500);

// ==============================================
// 9. Malformed hash does NOT fall back to raw key
// ==============================================
test('hash: malformed with valid raw key → 500 (no fallback)',
  {
    PICKLESHELL_API_KEY_SHA256: 'abc123',
    PICKLESHELL_API_KEY: 'my-raw-key',
  },
  'my-raw-key', 500);

// ==============================================
// 10. Both hash and raw configured: hash wins
// ==============================================
test('hash wins: raw-only token rejected',
  {
    PICKLESHELL_API_KEY_SHA256: crypto.createHash('sha256').update('hash-wins-key', 'utf8').digest('hex'),
    PICKLESHELL_API_KEY: 'raw-fallback-key',
  },
  'raw-fallback-key', 401);

test('hash wins: hash-matching token accepted',
  {
    PICKLESHELL_API_KEY_SHA256: crypto.createHash('sha256').update('hash-wins-key', 'utf8').digest('hex'),
    PICKLESHELL_API_KEY: 'raw-fallback-key',
  },
  'hash-wins-key', null);

// ==============================================
// 11. Legacy raw fallback still works
// ==============================================
test('legacy raw: correct token',
  { PICKLESHELL_API_KEY: 'legacy-raw-key' },
  'legacy-raw-key', null);

test('legacy raw: wrong token',
  { PICKLESHELL_API_KEY: 'legacy-raw-key' },
  'wrong', 401);

// ==============================================
// 12. Legacy LOCAL_AGENT_API_KEY fallback works
// ==============================================
test('legacy LOCAL_AGENT_API_KEY: correct token',
  { PICKLESHELL_API_KEY: undefined, LOCAL_AGENT_API_KEY: 'local-agent-key' },
  'local-agent-key', null);

test('legacy LOCAL_AGENT_API_KEY: wrong token',
  { PICKLESHELL_API_KEY: undefined, LOCAL_AGENT_API_KEY: 'local-agent-key' },
  'wrong', 401);

// ==============================================
// 13. No auth configured → 500
// ==============================================
test('no auth configured',
  { PICKLESHELL_API_KEY: undefined, LOCAL_AGENT_API_KEY: undefined, PICKLESHELL_API_KEY_SHA256: undefined },
  'anything', 500);

// ==============================================
// 14. Legacy raw: wrong token same length → 401
// ==============================================
test('legacy raw: wrong token same length',
  { PICKLESHELL_API_KEY: 'test-secret-key-for-auth-unit-test' },
  'wrong-secret-key-for-auth-unit-test', 401);

// ==============================================
// 15. Legacy raw: shorter token → 401
// ==============================================
test('legacy raw: shorter token',
  { PICKLESHELL_API_KEY: 'test-secret-key-for-auth-unit-test' },
  'short', 401);

// ==============================================
// 16. Legacy raw: longer token → 401
// ==============================================
test('legacy raw: longer token',
  { PICKLESHELL_API_KEY: 'test-secret-key-for-auth-unit-test' },
  'a'.repeat(100), 401);

// ==============================================
// 17. Empty token → 401
// ==============================================
test('empty token',
  { PICKLESHELL_API_KEY: 'any-key' },
  '', 401);

// ==============================================
// 18. parseAuthConfig unit tests
// ==============================================
{
  const cfg1 = auth.parseAuthConfig({});
  assert(cfg1.error === 'missing', 'parseAuthConfig empty → missing');

  const cfg2 = auth.parseAuthConfig({ PICKLESHELL_API_KEY_SHA256: RAW_KEY_HASH });
  assert(cfg2.hash === RAW_KEY_HASH, 'parseAuthConfig hash present');

  const cfg3 = auth.parseAuthConfig({ PICKLESHELL_API_KEY: 'raw' });
  assert(cfg3.raw === 'raw', 'parseAuthConfig raw present');

  const cfg4 = auth.parseAuthConfig({ PICKLESHELL_API_KEY_SHA256: 'xyz' });
  assert(cfg4.error === 'malformed_hash', 'parseAuthConfig malformed hash');

  const cfg5 = auth.parseAuthConfig({
    PICKLESHELL_API_KEY_SHA256: undefined,
    PICKLESHELL_API_KEY: 'raw',
  });
  assert(cfg5.raw === 'raw', 'parseAuthConfig hash=undefined falls to raw');

  const cfg6 = auth.parseAuthConfig({
    PICKLESHELL_API_KEY_SHA256: RAW_KEY_HASH,
    PICKLESHELL_API_KEY: 'raw',
  });
  assert(cfg6.hash === RAW_KEY_HASH, 'parseAuthConfig hash wins over raw');
  assert(cfg6.raw === undefined, 'parseAuthConfig raw not set when hash present');
}

// ==============================================
// 19. verifyHashToken / verifyRawToken unit tests
// ==============================================
{
  const key = 'my-test-key';
  const h = crypto.createHash('sha256').update(key, 'utf8').digest('hex');

  assert(auth.verifyHashToken(key, h) === true, 'verifyHashToken correct');
  assert(auth.verifyHashToken('wrong', h) === false, 'verifyHashToken wrong');
  assert(auth.verifyHashToken(h, h) === false, 'verifyHashToken hash itself rejected');
  assert(auth.verifyHashToken('', h) === false, 'verifyHashToken empty token');
  assert(auth.verifyHashToken(key, 'nothex') === false, 'verifyHashToken non-hex hash');

  assert(auth.verifyRawToken(key, key) === true, 'verifyRawToken correct');
  assert(auth.verifyRawToken('wrong', key) === false, 'verifyRawToken wrong');
  assert(auth.verifyRawToken('', key) === false, 'verifyRawToken empty token');
  assert(auth.verifyRawToken('short', key) === false, 'verifyRawToken length mismatch');
}

console.log(`\nAuth tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
