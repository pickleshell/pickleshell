const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-config-test-'));
const configPath = path.join(tempDir, 'config.json');
process.env.CONFIG_PATH = configPath;

// Register runtime adapters (as chat.js does) so availability checks consult
// the real registry instead of a static list.
require('./src/agent');
const concurrency = require('./src/concurrency');
const registry = require('./src/runtime/registry');

let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function loadConfig(configObject) {
  fs.writeFileSync(configPath, JSON.stringify(configObject));
  delete require.cache[require.resolve('./src/config')];
  return require('./src/config');
}

function mockReq(body) {
  return { body };
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

async function runChatHandler(configObject, chatId) {
  loadConfig(configObject);
  delete require.cache[require.resolve('./src/chat')];
  const chatHandler = require('./src/chat');
  const res = mockRes();
  await chatHandler(mockReq({ chat_id: chatId, message: 'run' }), res);
  return res;
}

async function main() {
  // ==============================================
  // 1. Legacy config: no new runtime fields
  // ==============================================
  {
    const config = loadConfig({
      chats: {
        test: {
          workspace: tempDir,
          agent: 'opencode',
        },
      },
      allowed_models: ['opencode/big-pickle'],
      default_model: 'opencode/big-pickle',
    });

    assert(config.getChatConfig('test')?.workspace === tempDir, 'loads CONFIG_PATH');
    assert(config.resolveModel() === 'opencode/big-pickle', 'uses configured default model');
    assert(
      config.resolveModel('opencode/big-pickle') === 'opencode/big-pickle',
      'accepts allowlisted model'
    );
    assert(config.resolveModel('other/model') === null, 'rejects non-allowlisted model');

    assert(config.getDefaultRuntime() === 'opencode', 'legacy config defaults to opencode');
    assert(config.getChatRuntime('test') === 'opencode', 'legacy agent field maps to opencode runtime');
    assert(deepEqual(config.getAllowedRuntimes(), ['opencode']), 'legacy config allowed runtimes defaults to [opencode]');
    const resolved = config.resolveRuntime('test');
    assert(resolved.status === 'ok' && resolved.runtime === 'opencode', 'legacy config resolves to opencode for execution');
  }

  // ==============================================
  // 2. Defaults: minimal config with no runtime fields
  // ==============================================
  {
    const config = loadConfig({
      chats: {
        test: { workspace: tempDir },
      },
    });

    assert(config.getDefaultRuntime() === 'opencode', 'no default_runtime -> opencode');
    assert(config.getChatRuntime('test') === null, 'no per-chat runtime -> null');
    assert(deepEqual(config.getAllowedRuntimes(), ['opencode']), 'no allowed_runtimes -> [opencode]');
    const resolved = config.resolveRuntime('test');
    assert(resolved.status === 'ok' && resolved.runtime === 'opencode', 'unconfigured chat resolves to opencode');
  }

  // ==============================================
  // 3. Aliases / compatibility
  // ==============================================
  {
    const config = loadConfig({
      chats: {
        legacy: { workspace: tempDir, agent: 'opencode' },
        both: { workspace: tempDir, agent: 'opencode', runtime: 'opencode' },
        canonical: { workspace: tempDir, runtime: 'OpenCode' },
        codexWins: { workspace: tempDir, agent: 'opencode', runtime: 'codex' },
      },
      allowed_runtimes: ['opencode', 'codex'],
    });

    assert(config.getChatRuntime('legacy') === 'opencode', 'agent field is a compatibility alias');
    assert(config.getChatRuntime('both') === 'opencode', 'runtime field wins over agent alias');
    assert(config.getChatRuntime('canonical') === 'opencode', 'runtime names are case-insensitive');
    assert(config.getChatRuntime('codexWins') === 'codex', 'runtime field takes precedence over agent');

    assert(config.normalizeRuntime('  OpenCode ') === 'opencode', 'normalizeRuntime trims and lowercases');
    assert(config.normalizeRuntime('Codex') === 'codex', 'normalizeRuntime recognizes codex');
  }

  // ==============================================
  // 4. Invalid values
  // ==============================================
  {
    const config = loadConfig({
      chats: {
        badRuntime: { workspace: tempDir, runtime: 'foobar' },
        badType: { workspace: tempDir, runtime: 123 },
        badAgent: { workspace: tempDir, agent: null },
      },
      default_runtime: 'foobar',
    });

    assert(config.normalizeRuntime('foobar') === null, 'unknown runtime name -> null');
    assert(config.normalizeRuntime(null) === null, 'non-string runtime -> null');
    assert(config.getDefaultRuntime() === 'opencode', 'invalid default_runtime falls back to opencode for getDefaultRuntime');

    assert(config.resolveRuntime('badRuntime').status === 'invalid', 'invalid per-chat runtime -> invalid');
    assert(config.resolveRuntime('badType').status === 'invalid', 'non-string per-chat runtime -> invalid');
    assert(config.resolveRuntime('badAgent').status === 'invalid', 'null agent value -> invalid');
    assert(config.resolveRuntime('missing').status === 'invalid', 'invalid global default_runtime -> invalid');
  }

  // ==============================================
  // 5. Allowed runtimes policy
  // ==============================================
  {
    const config = loadConfig({
      chats: {
        test: { workspace: tempDir, runtime: 'opencode' },
        codexChat: { workspace: tempDir, runtime: 'codex' },
      },
      allowed_runtimes: ['opencode'],
    });

    assert(deepEqual(config.getAllowedRuntimes(), ['opencode']), 'reads configured allowed runtimes');
    assert(config.isRuntimeAllowed('opencode') === true, 'opencode is allowed');
    assert(config.isRuntimeAllowed('codex') === false, 'codex rejected when not allowed');
    assert(config.resolveRuntime('test').status === 'ok', 'allowed runtime resolves ok');
    assert(config.resolveRuntime('codexChat').status === 'not_allowed', 'runtime not in allowlist -> not_allowed');
  }

  {
    const config = loadConfig({
      chats: { test: { workspace: tempDir, runtime: 'opencode' } },
      allowed_runtimes: 'opencode',
    });

    assert(config.getAllowedRuntimes() === null, 'non-array allowed_runtimes -> null');
    assert(config.resolveRuntime('test').status === 'not_allowed', 'invalid allowed_runtimes config rejects execution');
  }

  {
    const config = loadConfig({
      chats: { test: { workspace: tempDir, runtime: 'opencode' } },
      allowed_runtimes: ['codex'],
    });

    assert(config.resolveRuntime('test').status === 'not_allowed', 'opencode rejected when allowlist omits it');
  }

  // ==============================================
  // 6. Unavailable runtime behavior
  // ==============================================
  {
    const config = loadConfig({
      chats: {
        codexChat: { workspace: tempDir, runtime: 'codex' },
        defaultCodex: { workspace: tempDir },
      },
      default_runtime: 'codex',
      allowed_runtimes: ['opencode', 'codex'],
    });

    assert(config.isRuntimeAvailable('opencode') === true, 'opencode is available');
    const codexAvailable = config.isRuntimeAvailable('codex');
    assert(
      config.resolveRuntime('codexChat').status === (codexAvailable ? 'ok' : 'unavailable'),
      `codex runtime resolves ${codexAvailable ? 'ok' : 'unavailable'} based on host availability`
    );
    assert(
      config.resolveRuntime('defaultCodex').status === (codexAvailable ? 'ok' : 'unavailable'),
      `global codex runtime resolves ${codexAvailable ? 'ok' : 'unavailable'} based on host availability`
    );
  }

  // ==============================================
  // 7. Chat endpoint rejects non-openCode runtimes
  // ==============================================
  const codexAdapter = registry.getRuntime('codex');
  registry.registerRuntime('codex', { name: 'codex-unavailable', isAvailable: () => false });
  const res = await runChatHandler(
    {
      chats: { codexChat: { workspace: tempDir, runtime: 'codex' } },
      allowed_runtimes: ['opencode', 'codex'],
    },
    'codexChat'
  );
  assert(res._status === 503, 'codex chat -> 503 runtime_unavailable');
  assert(res._body?.error === 'runtime_unavailable', 'codex chat rejected with runtime_unavailable');
  assert(res._body?.details.includes('codex'), 'codex chat rejection names the runtime');
  assert(
    concurrency.status().active_count === 0,
    'unavailable runtime is rejected before any slot is acquired'
  );
  registry.registerRuntime('codex', codexAdapter);

  {
    const res = await runChatHandler(
      {
        chats: { test: { workspace: tempDir, runtime: 'opencode' } },
        allowed_runtimes: ['codex'],
      },
      'test'
    );
    assert(res._status === 403, 'not-allowed runtime chat -> 403 runtime_not_allowed');
    assert(res._body?.error === 'runtime_not_allowed', 'not-allowed chat rejected with runtime_not_allowed');
  }

  {
    const res = await runChatHandler(
      {
        chats: { test: { workspace: tempDir, runtime: 'bogus' } },
      },
      'test'
    );
    assert(res._status === 400, 'invalid runtime chat -> 400 runtime_invalid');
    assert(res._body?.error === 'runtime_invalid', 'invalid chat rejected with runtime_invalid');
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FAIL: test harness error:', err);
  process.exitCode = 1;
});
