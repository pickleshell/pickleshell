const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-agent-test-'));
const capturePath = path.join(tempDir, 'args.bin');
const messageSentinel = path.join(tempDir, 'message-injection-ran');
const sessionSentinel = path.join(tempDir, 'session-injection-ran');
const fakeWrapper = path.join(tempDir, 'fake-wrapper.sh');
const fakeBin = path.join(tempDir, 'bin');
const fakeOpenCode = path.join(fakeBin, 'opencode');
const wrapperCapturePath = path.join(tempDir, 'opencode-args.bin');
const testWrapper = path.join(tempDir, 'opencode-run-test.sh');

fs.writeFileSync(
  fakeWrapper,
  [
    '#!/bin/bash',
    `printf "%s\\0" "$@" > '${capturePath}'`,
    'printf \'%s\\n\' \'{"type":"text","part":{"text":"ok"}}\'',
  ].join('\n'),
  { mode: 0o700 }
);
fs.mkdirSync(fakeBin);
fs.writeFileSync(
  fakeOpenCode,
  [
    '#!/bin/bash',
    'printf "%s\\0" "$@" > "$WRAPPER_CAPTURE_FILE"',
  ].join('\n'),
  { mode: 0o700 }
);

process.env.OPENCODE_WRAPPER_SCRIPT = fakeWrapper;

const agent = require('./src/agent');

let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

async function run() {
  const message =
    `Review \`touch ${messageSentinel}\` ` +
    `and "$(touch ${messageSentinel})"; do not execute either.`;
  const sessionId = `session"; touch ${sessionSentinel}; #`;
  const model = 'opencode/big-pickle';

  const execution = agent.sendMessage(
    'pickleshell-main',
    message,
    { workspace: tempDir },
    10,
    sessionId,
    model,
    null
  );
  const result = await execution.promise;

  const args = fs
    .readFileSync(capturePath)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

  assert(result.reply === 'ok', 'agent reply is parsed');
  assert(args.length === 4, 'wrapper receives exactly four arguments');
  assert(args[0].includes(message), 'message remains literal inside prompt');
  assert(args[1] === tempDir, 'workspace remains an exact argument');
  assert(args[2] === sessionId, 'session_id remains an exact argument');
  assert(args[3] === model, 'model remains an exact argument');
  assert(!fs.existsSync(messageSentinel), 'message command substitution is not executed');
  assert(!fs.existsSync(sessionSentinel), 'session_id shell injection is not executed');

  const wrapperSource = fs.readFileSync(path.join(__dirname, 'opencode-run.sh'), 'utf8');
  if (!wrapperSource.includes('/usr/local/bin/opencode')) {
    throw new Error('opencode-run.sh does not contain /usr/local/bin/opencode');
  }
  const fakeOpenCodeEscaped = fakeOpenCode.replace(/'/g, "'\\''");
  const patchedSource = wrapperSource.split('/usr/local/bin/opencode').join("'" + fakeOpenCodeEscaped + "'");
  fs.writeFileSync(testWrapper, patchedSource, { mode: 0o700 });

  const wrapperResult = spawnSync(
    '/bin/bash',
    [
      testWrapper,
      message,
      tempDir,
      sessionId,
      model,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WRAPPER_CAPTURE_FILE: wrapperCapturePath,
      },
    }
  );
  const wrapperArgs = fs
    .readFileSync(wrapperCapturePath)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

  assert(wrapperResult.status === 0, 'PTY wrapper exits successfully');
  assert(
    JSON.stringify(wrapperArgs) ===
      JSON.stringify([
        'run',
        message,
        '--dir',
        tempDir,
        '--format',
        'json',
        '--auto',
        '-s',
        sessionId,
        '-m',
        model,
      ]),
    'PTY wrapper preserves every OpenCode argument literally'
  );
  assert(!fs.existsSync(messageSentinel), 'PTY wrapper does not execute message payload');
  assert(!fs.existsSync(sessionSentinel), 'PTY wrapper does not execute session payload');
}

run()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = failed > 0 ? 1 : 0;
  });
