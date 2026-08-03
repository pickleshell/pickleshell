'use strict';

const assert = require('node:assert/strict');
const pty = require('node-pty');

const env = { PATH: process.env.PATH || '/usr/bin:/bin', TERM: 'xterm-256color' };
function waitFor(term, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`PTY smoke timeout: ${output}`)), timeoutMs);
    const subscription = term.onData((chunk) => {
      output += chunk;
      if (predicate(output)) { clearTimeout(timer); subscription.dispose(); resolve(output); }
    });
  });
}
function waitForExit(term, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY smoke exit timeout')), timeoutMs);
    let output = '';
    const subscription = term.onData((chunk) => { output += chunk; });
    term.onExit((result) => { clearTimeout(timer); subscription.dispose(); resolve({ ...result, output }); });
  });
}

async function main() {
  const interactive = pty.spawn('/bin/sh', ['-c', 'stty -echo; printf READY; read input; printf DONE; exit 0'], { name: 'xterm-256color', cols: 80, rows: 24, env });
  const ready = await waitFor(interactive, (output) => output.includes('READY'));
  assert.match(ready, /READY/);
  interactive.resize(100, 30);
  interactive.write('input\n');
  const interactiveExit = await waitForExit(interactive);
  assert.equal(interactiveExit.exitCode, 0);
  assert.match(interactiveExit.output, /DONE/);

  const signalled = pty.spawn('/bin/sh', ['-c', "trap 'printf SIGINT; exit 0' INT; printf READY; while :; do :; done"], { name: 'xterm-256color', cols: 80, rows: 24, env });
  await waitFor(signalled, (output) => output.includes('READY'));
  signalled.kill('SIGINT');
  const signalExit = await waitForExit(signalled);
  assert.equal(signalExit.exitCode, 0);
  assert.match(signalExit.output, /SIGINT/);
  console.log('native PTY smoke passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
