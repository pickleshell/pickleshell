'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { OutputRing } = require('../src/ring');
const { makePolicy, safeCwd } = require('../src/policy');
const { spawnRequest, decodeData, isValidUtf8 } = require('../src/validation');
const { TerminalService } = require('../src/service');
const { start } = require('../src/server');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await wait(10); } throw new Error('timed out'); }
function socketRequest(socketPath, request) { return new Promise((resolve, reject) => { const socket = net.createConnection(socketPath); let data = ''; socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`)); socket.on('data', (chunk) => { data += chunk; if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data)); } }); socket.on('error', reject); }); }

async function main() {
  const ring = new OutputRing(5); ring.append(Buffer.from([0, 1, 2])); assert.equal(ring.read(0, 10).nextCursor, 3); assert.deepEqual([...ring.read(1, 1).data], [1]); ring.append(Buffer.from([3, 4, 5])); const lost = ring.read(0, 20); assert.equal(lost.truncated, true); assert.equal(lost.truncatedFrom, 0); assert.deepEqual([...lost.data], [1, 2, 3, 4, 5]);
  assert.throws(() => decodeData('!'), /invalid/); assert.equal(isValidUtf8(Buffer.from('€')), true); assert.equal(isValidUtf8(Buffer.from([0xff])), false); assert.throws(() => spawnRequest({ chat_id: 'x', executable: '/bin/false' }, makePolicy()), (e) => e.code === 'executable_not_allowed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-terminal-')); fs.mkdirSync(path.join(root, 'sub')); fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link')); const policy = makePolicy({ roots: [root], executables: ['/bin/sh'] }); assert.equal(safeCwd('sub', policy), path.join(root, 'sub')); assert.throws(() => safeCwd('link', policy), (e) => e.code === 'invalid_working_directory'); assert.throws(() => safeCwd('../', policy), (e) => e.code === 'invalid_working_directory');
  const testCgroups = { launcherPath: null, initialize: async () => {}, create: (id) => ({ name: `terminal-${id}`, path: path.join(root, `terminal-${id}`) }), killAndRemove: async () => {} };
  const service = new TerminalService({ roots: [root], executables: ['/bin/sh'], maxTerminals: 1, ringBytes: 128, ttlMs: 60000, cgroupManager: testCgroups });
  const spawned = service.spawn({ owner_scope: 'scope', chat_id: 'chat-test', executable: '/bin/sh', argv: ['-c', 'stty -echo; printf ready; read x; stty echo; printf exact; exit 3'], cwd: 'sub', cols: 80, rows: 24 }); assert.match(spawned.terminal_id, /^term_/); await eventually(async () => { const result = await service.output({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id, cursor: 0, max_bytes: 128 }); return Buffer.from(result.data, 'base64').toString() === 'ready' ? result : null; }); assert.throws(() => service.write({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id, data: 'YQ==', idempotency_key: 'write-1' }), (e) => e.code === 'idempotency_unsupported'); assert.throws(() => service.write({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id, data: '/w==' }), (e) => e.code === 'invalid_request'); assert.equal(service.write({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id, data: 'eAo=' }).bytes_written, 2); assert.throws(() => service.spawn({ owner_scope: 'scope', chat_id: 'other', executable: '/bin/sh', argv: [], cwd: 'sub' }), (e) => e.code === 'terminal_limit');
  const output = await eventually(async () => { const result = await service.output({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id, cursor: 0, max_bytes: 128 }); return result.state === 'exited' ? result : null; }); assert.equal(Buffer.from(output.data, 'base64').toString(), 'readyexact'); assert.equal(output.exit_code, 3); assert.equal((await service.output({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id, cursor: 0 })).data, output.data);
  const closed = await service.closeRequest({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id }); assert.equal(closed.state, 'closed'); assert.equal((await service.closeRequest({ owner_scope: 'scope', chat_id: 'chat-test', terminal_id: spawned.terminal_id })).already_closed, true); await service.stop(); fs.rmSync(root, { recursive: true, force: true });
  const socketPath = path.join(os.tmpdir(), `pickleshell-terminal-${process.pid}.sock`); process.env.PICKLESHELL_TERMINAL_SOCKET = socketPath; process.env.PICKLESHELL_TERMINAL_AUTH = 'test-auth-token'; const runtime = start({ cgroupManager: testCgroups }); await eventually(async () => fs.existsSync(socketPath)); assert.equal((await socketRequest(socketPath, { auth: 'wrong', op: 'terminal-output' })).error, 'unauthorized'); assert.equal((await socketRequest(socketPath, { auth: 'test-auth-token', op: 'unknown' })).error, 'invalid_request'); runtime.server.close(); await runtime.service.stop(); try { fs.unlinkSync(socketPath); } catch (_) {}
  console.log('terminal tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
