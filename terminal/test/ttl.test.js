'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalService } = require('../src/service');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await wait(10); } throw new Error('TTL test timed out'); }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-ttl-'));
  let now = Date.now();
  const cgroups = { launcherPath: null, initialize: async () => {}, create: (id) => ({ name: `terminal-${id}`, path: path.join(root, `terminal-${id}`) }), killAndRemove: async () => {} };
  const service = new TerminalService({ roots: [root], executables: ['/bin/sh'], ttlMs: 60000, clock: () => now, reaperIntervalMs: 0, cgroupManager: cgroups });
  try {
    const active = service.spawn({ owner_scope: 'ttl', chat_id: 'ttl', executable: '/bin/sh', argv: ['-c', 'stty -echo; printf ready; read x; exit 0'], cwd: '.' });
    await eventually(async () => (await service.output({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id, cursor: 0, max_bytes: 64 })).data === Buffer.from('ready').toString('base64'));
    const terminal = service.terminals.get(active.terminal_id);
    now += 1000;
    const output = await service.output({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id, cursor: 0, max_bytes: 64 });
    assert.equal(Date.parse(output.last_activity_at), now);
    now += 1000;
    assert.equal(service.resize({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id, cols: 100, rows: 30 }).last_activity_at, new Date(now).toISOString());
    now += 1000;
    assert.equal(service.signal({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id, signal: 'SIGCONT' }).last_activity_at, new Date(now).toISOString());
    now += 1000;
    assert.equal(service.write({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id, data: 'eAo=' }).last_activity_at, new Date(now).toISOString());
    await eventually(async () => (await service.output({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id, cursor: 0, max_bytes: 64 })).state === 'exited');
    await service.closeRequest({ owner_scope: 'ttl', chat_id: 'ttl', terminal_id: active.terminal_id });

    const abandoned = service.spawn({ owner_scope: 'ttl', chat_id: 'ttl', executable: '/bin/sh', argv: ['-c', 'read x'], cwd: '.' });
    const abandonedTerminal = service.terminals.get(abandoned.terminal_id);
    now += 60001;
    service.reap();
    const expired = await abandonedTerminal.closePromise;
    assert.equal(expired.close_reason, 'ttl_expired');
    assert.equal(abandonedTerminal.state, 'closed');
    abandonedTerminal.pty.kill();
    console.log('TTL tests passed');
  } finally {
    await service.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
