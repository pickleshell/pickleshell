const { buildChildEnv } = require('./src/agent');

const ALLOWED = [
  'PATH', 'HOME', 'LANG', 'LC_ALL',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'NPM_CONFIG_CACHE', 'PLAYWRIGHT_BROWSERS_PATH',
  'TMPDIR', 'TMP', 'TEMP',
  'NODE_ENV',
  'TZ', 'USER', 'LOGNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

const BLOCKED = [
  'PICKLESHELL_API_KEY',
  'PICKLESHELL_API_KEY_SHA256',
  'LOCAL_AGENT_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'OPENCODE_WRAPPER_SCRIPT',
  'SHELL',
  'TERM',
  'ARBITRARY_SECRET',
];

let passed = 0;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
}

// 1. All allowed keys pass unchanged
{
  const source = {};
  for (const k of ALLOWED) source[k] = 'val_' + k;
  const env = buildChildEnv(source);
  for (const k of ALLOWED) assert(env[k] === source[k], k + ' passes unchanged');
  assert(Object.keys(env).length === ALLOWED.length, 'all allowed keys present');
}

// 2. All blocked keys absent
{
  const source = {};
  for (const k of BLOCKED) source[k] = 'secret_' + k;
  const env = buildChildEnv(source);
  for (const k of BLOCKED) assert(!(k in env), k + ' absent');
}

// 3. Undefined allowed key omitted
{
  const source = { PATH: '/bin', HOME: undefined };
  const env = buildChildEnv(source);
  assert(env.PATH === '/bin', 'PATH present when defined');
  assert(!('HOME' in env), 'HOME omitted when undefined');
}

// 4. Source not mutated
{
  const source = { PATH: '/bin', PICKLESHELL_API_KEY: 'key' };
  const orig = JSON.stringify(source);
  buildChildEnv(source);
  assert(JSON.stringify(source) === orig, 'source unchanged');
}

// 5. No keys beyond allowed set
{
  const source = {};
  for (const k of ALLOWED) source[k] = 'v_' + k;
  source.PICKLESHELL_API_KEY = 'leak';
  source.OPENAI_API_KEY = 'leak';
  const env = buildChildEnv(source);
  for (const k of Object.keys(env)) {
    assert(ALLOWED.includes(k), k + ' is in allowlist');
  }
}

console.log('PASS: env-isolation ' + passed + ' assertions');
process.exit(0);
