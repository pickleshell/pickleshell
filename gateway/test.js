const baseUrl = process.env.PICKLESHELL_GATEWAY_URL || 'http://127.0.0.1:18092';
const apiKey =
  process.env.PICKLESHELL_API_KEY ||
  process.env.LOCAL_AGENT_API_KEY;
const chatId = process.env.PICKLESHELL_SMOKE_CHAT_ID;
const runAgent = process.env.PICKLESHELL_RUN_AGENT_SMOKE === '1';

if (!apiKey) {
  console.error('PICKLESHELL_API_KEY is required');
  process.exit(2);
}
if (!chatId) {
  console.error('PICKLESHELL_SMOKE_CHAT_ID is required');
  process.exit(2);
}

let failed = 0;

async function request(path, { method = 'GET', token, body, rawBody } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function check(name, expectedStatus, action, expectedError) {
  try {
    const result = await action();
    const errorMatches =
      expectedError === undefined || result.payload.error === expectedError;
    if (result.status === expectedStatus && errorMatches) {
      console.log(`PASS: ${name}`);
    } else {
      failed++;
      console.error(
        `FAIL: ${name} (status=${result.status}, error=${result.payload.error || 'none'})`
      );
    }
    return result;
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name} (${error.message})`);
    return null;
  }
}

async function run() {
  await check('health', 200, () => request('/health'));
  await check(
    'missing authentication',
    401,
    () => request('/chat', { method: 'POST', body: { chat_id: 'test', message: 'ping' } }),
    'unauthorized'
  );
  await check(
    'wrong authentication',
    401,
    () =>
      request('/chat', {
        method: 'POST',
        token: 'wrong-token',
        body: { chat_id: 'test', message: 'ping' },
      }),
    'unauthorized'
  );
  await check(
    'invalid JSON',
    400,
    () => request('/chat', { method: 'POST', token: apiKey, rawBody: '{' }),
    'invalid_json'
  );
  await check(
    'missing chat_id',
    400,
    () => request('/chat', { method: 'POST', token: apiKey, body: { message: 'ping' } }),
    'invalid_request'
  );
  await check(
    'unknown chat_id',
    404,
    () =>
      request('/chat', {
        method: 'POST',
        token: apiKey,
        body: { chat_id: '__pickleshell_missing__', message: 'ping' },
      }),
    'unknown_chat_id'
  );
  await check(
    'forbidden model',
    403,
    () =>
      request('/chat', {
        method: 'POST',
        token: apiKey,
        body: {
          chat_id: chatId,
          message: 'ping',
          model: '__forbidden__/model',
        },
      }),
    'forbidden_model'
  );

  if (runAgent) {
    const result = await check('agent ping', 200, () =>
      request('/chat', {
        method: 'POST',
        token: apiKey,
        body: {
          chat_id: chatId,
          message: 'Reply with exactly: pong. Do not use tools or modify files.',
        },
      })
    );
    if (result && !result.payload.reply?.includes('pong')) {
      failed++;
      console.error('FAIL: agent reply does not contain pong');
    }
  }

  console.log(`Smoke tests: ${failed === 0 ? 'passed' : `${failed} failed`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run();
