'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalService } = require('../src/service');
const { CgroupManager } = require('../src/cgroup');
const { parseManifestText, missingRoles } = require('./manifest');

if (process.env.PICKLESHELL_CGROUP_INTEGRATION_INNER !== '1') {
  console.error('cgroup integration requires the isolated systemd runner');
  process.exitCode = 77;
} else {
  const node = process.execPath;
  const helper = path.join(__dirname, 'cgroup-integration-helper.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-cgroup-integration-'));
  let now = Date.now();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = (ms) => Date.now() + ms;
  async function until(fn, timeoutMs = 10000) {
    const end = deadline(timeoutMs);
    while (Date.now() < end) { const value = await fn(); if (value) return value; await wait(20); }
    throw new Error('cgroup integration polling deadline exceeded');
  }
  async function outputUntil(service, id, expectedRoles, scenario) {
    let cursor = 0; let text = ''; const records = [];
    try {
      await until(async () => {
      const response = await service.output({ owner_scope: 'integration', chat_id: 'integration', terminal_id: id, cursor, max_bytes: 65536, wait_ms: 100 });
      cursor = response.next_cursor;
      const parsed = parseManifestText(text + Buffer.from(response.data, 'base64').toString('utf8'), records);
      text = parsed.remainder;
      return missingRoles(records, expectedRoles).length === 0;
      });
    } catch (error) {
      error.message = `${error.message}; scenario=${scenario}; observed_roles=${records.map((record) => record.role).join(',') || 'none'}`;
      throw error;
    }
    return records;
  }
  async function close(service, id) { const response = await service.closeRequest({ owner_scope: 'integration', chat_id: 'integration', terminal_id: id }); assert.equal(response.state, 'closed'); }
  async function main() {
    const manager = new CgroupManager();
    let service;
    const active = new Set();
    const closeActive = async () => { if (!service) return; await Promise.all([...active].map(async (id) => { try { await close(service, id); } catch (_) {} finally { active.delete(id); } })); };
    try {
      await manager.initialize();
      const stale = manager.create('term_stale');
      await manager.initialize();
      assert.equal(fs.existsSync(stale.path), false, 'startup cleanup removes stale child cgroups');
      service = new TerminalService({ roots: [root], executables: [node], maxTerminals: 8, ttlMs: 60000, clock: () => now, reaperIntervalMs: 0, cgroupManager: manager });
      await service.ready;
      for (const [scenario, roles] of [['foreground', ['foreground']], ['background', ['background-parent', 'hold']], ['pipeline', ['pipeline-parent', 'hold']], ['nested', ['nested-parent', 'hold']], ['separate', ['separate-parent', 'hold']], ['double-fork', ['double-fork-parent', 'double-fork-grandchild']]]) {
        const terminal = service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, scenario], cwd: '.' });
        active.add(terminal.terminal_id);
        const records = await outputUntil(service, terminal.terminal_id, roles, scenario);
        assert.deepEqual([...new Set(records.map((record) => record.role))].sort(), [...roles].sort());
        for (const record of records) {
          assert.match(String(record.pid), /^\d+$/); assert.match(String(record.ppid), /^\d+$/); assert.match(String(record.pgrp), /^\d+$/); assert.match(String(record.sid), /^\d+$/); assert.match(String(record.starttime), /^\d+$/);
        }
        const childPath = service.terminals.get(terminal.terminal_id).cgroup.path;
        await close(service, terminal.terminal_id); active.delete(terminal.terminal_id);
        assert.equal(fs.existsSync(childPath), false, `${scenario} cgroup removed after close`);
      }
      const concurrent = [0, 1].map(() => service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, 'foreground'], cwd: '.' }));
      concurrent.forEach((item) => active.add(item.terminal_id));
      assert.equal(new Set(concurrent.map((item) => service.terminals.get(item.terminal_id).cgroup.path)).size, 2);
      await Promise.all(concurrent.map((item) => close(service, item.terminal_id).finally(() => active.delete(item.terminal_id))));
      const ttl = service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, 'foreground'], cwd: '.' }); active.add(ttl.terminal_id);
      const ttlTerminal = service.terminals.get(ttl.terminal_id);
      const ttlRecords = await outputUntil(service, ttl.terminal_id, ['foreground'], 'ttl');
      const ttlPath = ttlTerminal.cgroup.path;
      now += 60001;
      service.reap();
      const ttlResult = await ttlTerminal.closePromise;
      assert.equal(ttlResult.close_reason, 'ttl_expired');
      assert.equal(fs.existsSync(ttlPath), false, 'TTL removes the exact child cgroup');
      for (const record of ttlRecords) {
        await until(() => {
          try {
            const stat = fs.readFileSync(`/proc/${record.pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
            assert.equal(fields[19], record.starttime, 'PID was reused before TTL cleanup verification');
            return fields[0] === 'Z';
          } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        }, 1000);
      }
      active.delete(ttl.terminal_id);
      const shutdown = service.spawn({ owner_scope: 'integration', chat_id: 'integration', executable: node, argv: [helper, 'foreground'], cwd: '.' }); active.add(shutdown.terminal_id);
      const shutdownPath = service.terminals.get(shutdown.terminal_id).cgroup.path;
      await service.stop(); active.delete(shutdown.terminal_id);
      assert.equal(fs.existsSync(shutdownPath), false, 'service shutdown removes terminal cgroup');
      console.log('isolated cgroup integration passed');
    } finally {
      await closeActive();
      if (service) await service.stop().catch(() => {});
    }
  }
  main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
