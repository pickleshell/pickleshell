'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { TerminalService } = require('../src/service');
const { start } = require('../src/server');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate) { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await wait(5); } throw new Error('long-poll test timed out'); }

function makeService(root) {
  return new TerminalService({
    roots: [root], executables: ['/bin/sh'], reaperIntervalMs: 0,
    cgroupManager: {
      launcherPath: null,
      initialize: async () => {},
      create: (id) => ({ path: path.join(root, id) }),
      killAndRemove: async () => {},
    },
  });
}

function requestAndDisconnect(socketPath, body) {
  const socket = net.createConnection(socketPath);
  const closed = new Promise((resolve, reject) => { socket.once('error', reject); socket.once('close', resolve); });
  socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
  return { socket, closed };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-long-poll-'));
  const service = makeService(root);
  const terminal = service.spawn({ owner_scope: 'scope', chat_id: 'chat', executable: '/bin/sh', argv: ['-c', 'stty -echo; read value; printf woke; sleep 2'], cwd: '.' });
  const base = { owner_scope: 'scope', chat_id: 'chat', terminal_id: terminal.terminal_id, cursor: 0, max_bytes: 128 };
  try {
    const timeoutStart = Date.now();
    const timedOut = await service.output({ ...base, wait_ms: 100 });
    assert.ok(Date.now() - timeoutStart < 1000);
    assert.equal(timedOut.data, '');
    assert.equal(timedOut.next_cursor, 0);
    assert.equal(timedOut.timed_out, true);
    assert.equal(service.terminals.get(terminal.terminal_id).waiters.length, 0);

    for (let i = 0; i < 20; i += 1) {
      const repeated = await service.output({ ...base, wait_ms: 10 });
      assert.equal(repeated.timed_out, true);
    }
    assert.equal(service.terminals.get(terminal.terminal_id).waiters.length, 0);

    const waiting = service.output({ ...base, wait_ms: 1000 });
    await eventually(() => service.terminals.get(terminal.terminal_id).waiters.length === 1);
    service.write({ ...base, data: Buffer.from('x\n').toString('base64') });
    const woke = await waiting;
    assert.equal(Buffer.from(woke.data, 'base64').toString(), 'woke');
    assert.equal(woke.timed_out, false);
    assert.equal(service.terminals.get(terminal.terminal_id).waiters.length, 0);

    const socketPath = path.join(root, 'service.sock');
    const previousSocket = process.env.PICKLESHELL_TERMINAL_SOCKET;
    const previousAuth = process.env.PICKLESHELL_TERMINAL_AUTH;
    process.env.PICKLESHELL_TERMINAL_SOCKET = socketPath;
    process.env.PICKLESHELL_TERMINAL_AUTH = 'long-poll-test';
    const runtime = start({ service });
    try {
      await new Promise((resolve) => runtime.server.once('listening', resolve));
      const disconnected = requestAndDisconnect(socketPath, { auth: 'long-poll-test', op: 'terminal-output', ...base, cursor: woke.next_cursor, wait_ms: 1000 });
      await eventually(() => service.terminals.get(terminal.terminal_id).waiters.length === 1);
      disconnected.socket.destroy();
      await disconnected.closed;
      await eventually(() => service.terminals.get(terminal.terminal_id).waiters.length === 0);
    } finally {
      runtime.server.close();
      await service.stop();
      try { fs.unlinkSync(socketPath); } catch (_) {}
      if (previousSocket === undefined) delete process.env.PICKLESHELL_TERMINAL_SOCKET; else process.env.PICKLESHELL_TERMINAL_SOCKET = previousSocket;
      if (previousAuth === undefined) delete process.env.PICKLESHELL_TERMINAL_AUTH; else process.env.PICKLESHELL_TERMINAL_AUTH = previousAuth;
    }
    console.log('long-poll tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
