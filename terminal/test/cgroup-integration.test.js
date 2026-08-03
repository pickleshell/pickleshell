'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalService } = require('../src/service');
const { CgroupManager } = require('../src/cgroup');

if (process.env.PICKLESHELL_CGROUP_INTEGRATION_INNER !== '1') {
  console.error('cgroup integration requires the isolated systemd runner');
  process.exitCode = 77;
} else {
  const node = process.execPath;
  const helper = path.join(__dirname, 'cgroup-integration-helper.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-cgroup-integration-'));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = (ms) => Date.now() + ms;
  async function until(fn, timeoutMs = 10000) {
    const end = deadline(timeoutMs);
    while (Date.now() < end) { const value = await fn(); if (value) return value; await wait(20); }
    throw new Error('cgroup integration polling deadline exceeded');
  }
  async function outputUntil(service, id, minimumRecords = 1) {
    let cursor = 0; let text = ''; const records = [];
    await until(async () => {
      const response = await service.output({ owner_scope: 'integration', chat_id: 'integration', terminal_id: id, cursor, max_bytes: 65536, wait_ms: 100 });
      cursor = response.next_cursor; text += Buffer.from(response.data, 'base64').toString('utf8');
      for (const line of text.split('\n').slice(0, -1)) { try { const value = JSON.parse(line); if (value.pid && !records.some((item) => item.pid === value.pid)) records.push(value); } catch (_) {} }
      text = text.slice(text.lastIndexOf('\n') + 1);
      return records.length >= minimumRecords;
    });
    return records;
  }
  async function close(service, id) { const response = await service.closeRequest({ owner_scope: 'integration', chat_id: 'integration', terminal_id: id }); assert.equal(response.state, 'closed'); }
  async function main() {
    const manager = new CgroupManager();
    await manager.initialize();
    const stale = manager.create('term_stale');
    await manager.initialize();
    assert.equal(fs.existsSync(stale.path), false, 'startup cleanup removes stale child cgroups');
    const service = new TerminalService({ roots: [root], executables: [node], maxTerminals: 8, ttlMs: 60000, cgroupManager: manager });
    await service.ready;
    for (const [scenario, count] of [['foreground', 1], ['background', 2], ['pipeline', 3], ['nested', 2], ['separate', 2], ['double-fork', 2]]) {
      const terminal = service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, scenario], cwd: '.' });
      const records = await outputUntil(service, terminal.terminal_id, count);
      for (const record of records) {
        assert.match(String(record.pid), /^\d+$/); assert.match(String(record.ppid), /^\d+$/); assert.match(String(record.pgrp), /^\d+$/); assert.match(String(record.sid), /^\d+$/); assert.match(String(record.starttime), /^\d+$/);
      }
      const childPath = service.terminals.get(terminal.terminal_id).cgroup.path;
      await close(service, terminal.terminal_id);
      assert.equal(fs.existsSync(childPath), false, `${scenario} cgroup removed after close`);
    }
    const concurrent = [0, 1].map(() => service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, 'foreground'], cwd: '.' }));
    assert.equal(new Set(concurrent.map((item) => service.terminals.get(item.terminal_id).cgroup.path)).size, 2);
    await Promise.all(concurrent.map((item) => close(service, item.terminal_id)));
    const ttl = service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, 'foreground'], cwd: '.' });
    const ttlResult = await until(async () => { const result = await service.output({ owner_scope: 'integration', chat_id: 'integration', terminal_id: ttl.terminal_id, cursor: 0, wait_ms: 100 }); return result.state === 'closed' ? result : null; }, 70000);
    assert.equal(ttlResult.close_reason, 'ttl_expired');
    const shutdown = service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, 'foreground'], cwd: '.' });
    const shutdownPath = service.terminals.get(shutdown.terminal_id).cgroup.path;
    await service.stop();
    assert.equal(fs.existsSync(shutdownPath), false, 'service shutdown removes terminal cgroup');
    console.log('isolated cgroup integration passed');
  }
  main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
