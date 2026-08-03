'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { TerminalClient } = require('../../gateway/src/terminal-client');
const { start } = require('../src/server');
const { TerminalService } = require('../src/service');

const waitFor = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for terminal output');
};

function makeCgroups() {
  return {
    launcherPath: null,
    initialize: async () => {},
    create: (id) => ({ name: `terminal-${id}`, path: id }),
    killAndRemove: async () => {},
  };
}

async function listen(server, port = 0) {
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port }, resolve));
  return server.address().port;
}

function makeTransportProxy(serviceSocket) {
  let server;
  let port;
  const sockets = new Set();
  const create = () => {
    server = net.createServer((downstream) => {
      sockets.add(downstream);
      const upstream = net.createConnection(serviceSocket);
      sockets.add(upstream);
      downstream.once('close', () => { sockets.delete(downstream); upstream.destroy(); });
      upstream.once('close', () => sockets.delete(upstream));
      downstream.pipe(upstream).pipe(downstream);
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
    });
    return listen(server, port).then((nextPort) => { port = nextPort; });
  };
  return {
    async start() { await create(); },
    async restart() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await create();
    },
    address() { return { host: '127.0.0.1', port }; },
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-terminal-reconnect-'));
  const serviceSocket = path.join(root, 'terminal.sock');
  const previousSocket = process.env.PICKLESHELL_TERMINAL_SOCKET;
  const previousAuth = process.env.PICKLESHELL_TERMINAL_AUTH;
  process.env.PICKLESHELL_TERMINAL_SOCKET = serviceSocket;
  process.env.PICKLESHELL_TERMINAL_AUTH = 'reconnect-test';
  const service = new TerminalService({
    cgroupManager: makeCgroups(),
    roots: [root],
    executables: ['/bin/sh'],
    reaperIntervalMs: 0,
  });
  const runtime = start({ service });
  const proxy = makeTransportProxy(serviceSocket);
  await Promise.all([
    new Promise((resolve) => runtime.server.once('listening', resolve)),
    proxy.start(),
  ]);
  const client = () => new TerminalClient({
    socketPath: 'simulated-gateway-transport',
    authToken: 'reconnect-test',
    timeoutMs: 1000,
    connect: () => net.createConnection(proxy.address()),
  });
  try {
    const first = await client().request('spawn', {
      chat_id: 'reconnect-chat',
      executable: '/bin/sh',
      argv: ['-c', 'stty -echo; printf before; IFS= read line; printf "after:%s" "$line"; exit 0'],
      cwd: '.',
    }, 'reconnect-scope');
    const initial = await waitFor(async () => {
      const result = await client().request('output', {
        chat_id: 'reconnect-chat', terminal_id: first.terminal_id, cursor: 0, max_bytes: 128,
      }, 'reconnect-scope');
      return Buffer.from(result.data, 'base64').toString() === 'before' ? result : null;
    });
    assert.equal(initial.next_cursor, 6);
    const cursor = initial.next_cursor;

    await proxy.restart();
    const afterReconnect = await client().request('output', {
      chat_id: 'reconnect-chat', terminal_id: first.terminal_id, cursor, wait_ms: 50,
    }, 'reconnect-scope');
    assert.equal(afterReconnect.terminal_id, first.terminal_id);
    assert.equal(afterReconnect.next_cursor, cursor);
    assert.equal(afterReconnect.data, '');

    await client().request('write', {
      chat_id: 'reconnect-chat', terminal_id: first.terminal_id, data: 'bGluZQo=',
    }, 'reconnect-scope');
    const continued = await waitFor(async () => {
      const result = await client().request('output', {
        chat_id: 'reconnect-chat', terminal_id: first.terminal_id, cursor, max_bytes: 128,
      }, 'reconnect-scope');
      return Buffer.from(result.data, 'base64').toString() === 'after:line' ? result : null;
    });
    assert.equal(continued.next_cursor, cursor + 10);
    const closed = await client().request('close', {
      chat_id: 'reconnect-chat', terminal_id: first.terminal_id, reason: 'e2e_complete',
    }, 'reconnect-scope');
    assert.equal(closed.close_reason, 'e2e_complete');
    console.log('terminal reconnect E2E passed');
  } finally {
    await proxy.stop();
    await new Promise((resolve) => runtime.server.close(resolve));
    await runtime.service.stop();
    try { fs.unlinkSync(serviceSocket); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSocket === undefined) delete process.env.PICKLESHELL_TERMINAL_SOCKET; else process.env.PICKLESHELL_TERMINAL_SOCKET = previousSocket;
    if (previousAuth === undefined) delete process.env.PICKLESHELL_TERMINAL_AUTH; else process.env.PICKLESHELL_TERMINAL_AUTH = previousAuth;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
