const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-config-test-'));
const configPath = path.join(tempDir, 'config.json');

fs.writeFileSync(
  configPath,
  JSON.stringify({
    chats: {
      test: {
        workspace: tempDir,
        agent: 'opencode',
      },
    },
    allowed_models: ['opencode/big-pickle'],
    default_model: 'opencode/big-pickle',
  })
);
process.env.CONFIG_PATH = configPath;

const config = require('./src/config');

let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

assert(config.getChatConfig('test')?.workspace === tempDir, 'loads CONFIG_PATH');
assert(config.resolveModel() === 'opencode/big-pickle', 'uses configured default model');
assert(
  config.resolveModel('opencode/big-pickle') === 'opencode/big-pickle',
  'accepts allowlisted model'
);
assert(config.resolveModel('other/model') === null, 'rejects non-allowlisted model');

fs.rmSync(tempDir, { recursive: true, force: true });
process.exitCode = failed > 0 ? 1 : 0;
