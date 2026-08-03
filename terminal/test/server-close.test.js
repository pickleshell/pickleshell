'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { start } = require('../src/server');

function request(socketPath, body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.end(`${JSON.stringify({ auth: 'close-test', ...body })}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline >= 0) { socket.destroy(); resolve(JSON.parse(data.slice(0, newline))); }
    });
  });
}

async function main() {
  const socketPath = path.join(os.tmpdir(), `pickleshell-terminal-close-${process.pid}.sock`);
  const previousSocket = process.env.PICKLESHELL_TERMINAL_SOCKET;
  const previousAuth = process.env.PICKLESHELL_TERMINAL_AUTH;
  let resolveClose;
  let closeCalls = 0;
  const service = {
    ready: Promise.resolve(),
    closeRequest: async (request) => {
      closeCalls += 1;
      if (request.terminal_id === 'term_reject') {
        const failure = new Error('cleanup unavailable');
        failure.code = 'terminal_cgroup_unavailable';
        throw failure;
      }
      if (closeCalls === 1) return new Promise((resolve) => { resolveClose = resolve; });
      return { ok: true, terminal_id: request.terminal_id, state: 'closed', already_closed: true, close_reason: 'client_requested', exit_code: 0, exit_signal: null, exited_at: '2026-08-03T10:00:00.000Z', closed_at: '2026-08-03T10:00:00.010Z' };
    },
    stop: async () => {},
  };
  process.env.PICKLESHELL_TERMINAL_SOCKET = socketPath;
  process.env.PICKLESHELL_TERMINAL_AUTH = 'close-test';
  const runtime = start({ service });
  try {
    await new Promise((resolve) => runtime.server.once('listening', resolve));
    let settled = false;
    const firstPromise = request(socketPath, { op: 'terminal-close', owner_scope: 'scope', chat_id: 'chat', terminal_id: 'term_close' }).then((value) => { settled = true; return value; });
    await new Promise((resolve, reject) => {
      const end = Date.now() + 1000;
      const poll = () => { if (resolveClose) return resolve(); if (Date.now() >= end) return reject(new Error('close dispatch did not reach fake cleanup')); setImmediate(poll); };
      poll();
    });
    assert.equal(settled, false, 'close response must wait for async cleanup');
    resolveClose({ ok: true, terminal_id: 'term_close', state: 'closed', close_reason: 'client_requested', exit_code: 0, exit_signal: null, exited_at: '2026-08-03T10:00:00.000Z', closed_at: '2026-08-03T10:00:00.010Z' });
    const first = await firstPromise;
    assert.equal(first.state, 'closed');
    assert.equal(first.close_reason, 'client_requested');
    assert.equal(first.exit_code, 0);
    assert.equal(first.exit_signal, null);
    assert.equal(first.exited_at, '2026-08-03T10:00:00.000Z');
    assert.equal(first.closed_at, '2026-08-03T10:00:00.010Z');
    const repeated = await request(socketPath, { op: 'terminal-close', owner_scope: 'scope', chat_id: 'chat', terminal_id: 'term_close' });
    assert.equal(repeated.already_closed, true);
    const rejected = await request(socketPath, { op: 'terminal-close', owner_scope: 'scope', chat_id: 'chat', terminal_id: 'term_reject' });
    assert.deepEqual(rejected, { ok: false, error: 'terminal_cgroup_unavailable', details: 'cleanup unavailable' });
    assert.equal(closeCalls, 3);
    console.log('server close boundary tests passed');
  } finally {
    runtime.server.close();
    await runtime.service.stop();
    try { fs.unlinkSync(socketPath); } catch (_) {}
    if (previousSocket === undefined) delete process.env.PICKLESHELL_TERMINAL_SOCKET; else process.env.PICKLESHELL_TERMINAL_SOCKET = previousSocket;
    if (previousAuth === undefined) delete process.env.PICKLESHELL_TERMINAL_AUTH; else process.env.PICKLESHELL_TERMINAL_AUTH = previousAuth;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
