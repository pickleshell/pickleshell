'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { start } = require('../src/server');

const waitFor = (predicate, timeoutMs = 1000) => new Promise((resolve, reject) => {
  const end = Date.now() + timeoutMs;
  const poll = () => { if (predicate()) return resolve(); if (Date.now() >= end) return reject(new Error('disconnect test polling timed out')); setImmediate(poll); };
  poll();
});

function healthyRequest(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.end(`${JSON.stringify({ auth: 'disconnect-test', op: 'terminal-output', owner_scope: 'scope', chat_id: 'chat', terminal_id: 'term_healthy' })}\n`));
    socket.on('data', (chunk) => { data += chunk; if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data)); } });
  });
}

function abortClient(socketPath, sendRequest) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', () => resolve());
    socket.once('connect', () => {
      if (sendRequest) socket.write(`${JSON.stringify({ auth: 'disconnect-test', op: 'terminal-output', owner_scope: 'scope', chat_id: 'chat', terminal_id: 'term_aborted' })}\n`);
      socket.destroy();
      resolve();
    });
    socket.once('close', () => resolve());
  });
}

async function main() {
  const socketPath = path.join(os.tmpdir(), `pickleshell-terminal-disconnect-${process.pid}.sock`);
  const previousSocket = process.env.PICKLESHELL_TERMINAL_SOCKET;
  const previousAuth = process.env.PICKLESHELL_TERMINAL_AUTH;
  let outputCalls = 0;
  let resolveAbortedOutput;
  const service = {
    ready: Promise.resolve(),
    output: async () => {
      outputCalls += 1;
      if (outputCalls === 1) return new Promise((resolve) => { resolveAbortedOutput = resolve; });
      return { ok: true, terminal_id: 'term_healthy', state: 'running', data: '', encoding: 'base64', bytes: 0, cursor: 0, next_cursor: 0, oldest_cursor: 0, timed_out: false };
    },
    stop: async () => {},
  };
  process.env.PICKLESHELL_TERMINAL_SOCKET = socketPath;
  process.env.PICKLESHELL_TERMINAL_AUTH = 'disconnect-test';
  const runtime = start({ service });
  try {
    await new Promise((resolve) => runtime.server.once('listening', resolve));
    await abortClient(socketPath, false);
    const aborted = abortClient(socketPath, true);
    await waitFor(() => resolveAbortedOutput !== undefined);
    await aborted;
    resolveAbortedOutput({ ok: true, terminal_id: 'term_aborted', state: 'running', data: '', encoding: 'base64', bytes: 0, cursor: 0, next_cursor: 0, oldest_cursor: 0, timed_out: false });
    const healthy = await healthyRequest(socketPath);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.terminal_id, 'term_healthy');
    assert.equal(outputCalls, 2);
    console.log('server disconnect tests passed');
  } finally {
    runtime.server.close();
    await runtime.service.stop();
    try { fs.unlinkSync(socketPath); } catch (_) {}
    if (previousSocket === undefined) delete process.env.PICKLESHELL_TERMINAL_SOCKET; else process.env.PICKLESHELL_TERMINAL_SOCKET = previousSocket;
    if (previousAuth === undefined) delete process.env.PICKLESHELL_TERMINAL_AUTH; else process.env.PICKLESHELL_TERMINAL_AUTH = previousAuth;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
