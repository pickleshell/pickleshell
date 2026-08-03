'use strict';

const crypto = require('node:crypto');
const pty = require('node-pty');
const { OutputRing } = require('./ring');
const { makePolicy, safeCwd, buildEnv } = require('./policy');
const { error, integer, text, terminalId, validateId, decodeData, isValidUtf8, spawnRequest, validateOutput, SIGNALS, CLOSE_REASONS } = require('./validation');
const { CgroupManager } = require('./cgroup');

const now = () => new Date().toISOString();
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

class TerminalService {
  constructor(options = {}) { this.policy = makePolicy(options); this.clock = options.clock || (() => Date.now()); this.cgroups = options.cgroupManager || new CgroupManager(options); this.terminals = new Map(); this.idempotency = new Map(); this.stopped = false; this.ready = this.cgroups.initialize(); this.ready.catch(() => {}); this.reaper = options.reaperIntervalMs === 0 ? null : setInterval(() => this.reap(), options.reaperIntervalMs ?? 1000); if (this.reaper) this.reaper.unref(); }
  async stop() { this.stopped = true; if (this.reaper) clearInterval(this.reaper); await this.ready.catch(() => {}); return Promise.all([...this.terminals.values()].map((t) => this.close(t, 'service_shutdown'))); }
  lookup(req) {
    text(req.chat_id, 1, 128, 'chat_id'); validateId(req.terminal_id);
    const t = this.terminals.get(req.terminal_id);
    if (!t || t.chatId !== req.chat_id) throw error('terminal_not_found');
    if (t.ownerScope !== req.owner_scope) throw error('terminal_forbidden');
    return t;
  }
  touch(t) { t.lastActivityAt = new Date(this.clock()).toISOString(); }
  notify(t) { for (const fn of t.waiters.splice(0)) fn(); }
  metadata(t) { return { terminal_id: t.id, chat_id: t.chatId, state: t.state, created_at: t.createdAt, started_at: t.startedAt, last_activity_at: t.lastActivityAt, cursor: t.ring.end, oldest_cursor: t.ring.start, cols: t.cols, rows: t.rows, expires_at: new Date(Date.parse(t.lastActivityAt) + this.policy.ttlMs).toISOString() }; }
  spawn(raw) {
    if (this.stopped) throw error('terminal_unavailable');
    text(raw.owner_scope, 1, 128, 'owner_scope');
    const req = spawnRequest(raw, this.policy);
    const cwd = safeCwd(req.cwd, this.policy); const normalized = { ...req, cwd, env: req.env };
    if (req.idempotency_key) {
      const prior = this.idempotency.get(`${req.chat_id}:${req.idempotency_key}`);
      if (prior) { if (prior.hash !== hash(normalized)) throw error('idempotency_conflict'); return { ...prior.response, idempotent: true }; }
    }
    if ([...this.terminals.values()].filter((terminal) => terminal.state === 'starting' || terminal.state === 'running' || terminal.state === 'closing').length >= this.policy.maxTerminals) throw error('terminal_limit');
    const t = { id: terminalId(), chatId: req.chat_id, ownerScope: raw.owner_scope, state: 'starting', createdAt: new Date(this.clock()).toISOString(), startedAt: null, exitedAt: null, closedAt: null, lastActivityAt: new Date(this.clock()).toISOString(), exitCode: null, exitSignal: null, closeReason: null, cols: req.cols, rows: req.rows, ring: new OutputRing(this.policy.ringBytes), waiters: [], closePromise: null, pty: null, cgroup: null };
    this.terminals.set(t.id, t);
    try {
      t.cgroup = this.cgroups.create(t.id);
      const executable = this.cgroups.launcherPath ? this.cgroups.launcherPath : req.executable;
      const argv = this.cgroups.launcherPath ? [t.cgroup.path, req.executable, ...req.argv] : req.argv;
      t.pty = pty.spawn(executable, argv, { name: this.policy.terminalType, cols: req.cols, rows: req.rows, cwd, env: buildEnv(req, this.policy, cwd) });
      t.pid = t.pty.pid; t.startedAt = new Date(this.clock()).toISOString(); t.lastActivityAt = t.startedAt; t.state = 'running';
      t.pty.onData((data) => { t.ring.append(Buffer.from(data, 'utf8')); this.notify(t); });
      t.pty.onExit(({ exitCode, signal }) => { if (t.state === 'closed') return; t.exitCode = Number.isInteger(exitCode) ? exitCode : null; t.exitSignal = signal || null; t.exitedAt = new Date(this.clock()).toISOString(); if (t.state !== 'closing') t.state = 'exited'; this.notify(t); });
    } catch (cause) { this.terminals.delete(t.id); if (t.cgroup) this.cgroups.killAndRemove(t.cgroup).catch(() => {}); if (cause.code === 'terminal_cgroup_unavailable') throw cause; throw error('terminal_spawn_failed'); }
    const response = this.metadata(t); if (req.idempotency_key) this.idempotency.set(`${req.chat_id}:${req.idempotency_key}`, { hash: hash(normalized), response }); return response;
  }
  write(raw) { const t = this.lookup(raw); if (raw.idempotency_key !== undefined) throw error('idempotency_unsupported'); if (t.state !== 'running') throw error('terminal_not_writable'); const bytes = decodeData(raw.data); if (!isValidUtf8(bytes)) throw error('invalid_request', 'data must be valid UTF-8 terminal input'); t.pty.write(bytes.toString('utf8')); this.touch(t); return { ok: true, terminal_id: t.id, state: t.state, bytes_written: bytes.length, last_activity_at: t.lastActivityAt }; }
  async output(raw, { signal } = {}) {
    validateOutput(raw); const t = this.lookup(raw); const cursor = raw.cursor === undefined ? 0 : raw.cursor; const max = raw.max_bytes === undefined ? 16384 : raw.max_bytes; const wait = raw.wait_ms === undefined ? 0 : raw.wait_ms;
    let result = t.ring.read(cursor, max); let timedOut = false;
    if (!result.data.length && t.state === 'running' && wait) {
      await new Promise((resolve) => {
        let settled = false;
        const wake = () => finish();
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          const index = t.waiters.indexOf(wake);
          if (index >= 0) t.waiters.splice(index, 1);
          resolve();
        };
        const timer = setTimeout(finish, wait);
        t.waiters.push(wake);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
      result = t.ring.read(cursor, max); timedOut = !result.data.length && t.state === 'running';
    }
    if (result.data.length || t.state !== 'running') this.touch(t);
    return { ok: true, terminal_id: t.id, state: t.state, data: result.data.toString('base64'), encoding: 'base64', bytes: result.data.length, cursor, next_cursor: result.nextCursor, oldest_cursor: result.oldestCursor, sequence_start: result.sequenceStart, sequence_end: result.sequenceEnd, truncated: result.truncated, truncated_from: result.truncatedFrom, timed_out: timedOut, exit_code: t.exitCode, exit_signal: t.exitSignal, close_reason: t.closeReason, created_at: t.createdAt, started_at: t.startedAt, exited_at: t.exitedAt, closed_at: t.closedAt, last_activity_at: t.lastActivityAt };
  }
  resize(raw) { const t = this.lookup(raw); const cols = integer(raw.cols, 1, 500, 'cols'); const rows = integer(raw.rows, 1, 200, 'rows'); if (t.state === 'closed') throw error('terminal_closed'); if (t.state === 'running') t.pty.resize(cols, rows); t.cols = cols; t.rows = rows; this.touch(t); return { ok: true, terminal_id: t.id, state: t.state, cols, rows, last_activity_at: t.lastActivityAt }; }
  signal(raw) { const t = this.lookup(raw); if (!SIGNALS.has(raw.signal)) throw error('signal_not_allowed'); if (t.state !== 'running') throw error('terminal_closed'); try { process.kill(-t.pid, raw.signal); } catch (e) { if (e.code !== 'ESRCH') throw error('internal_error'); } this.touch(t); return { ok: true, terminal_id: t.id, state: t.state, signal: raw.signal, last_activity_at: t.lastActivityAt }; }
  close(t, reason = 'client_requested') {
    if (!CLOSE_REASONS.has(reason)) throw error('invalid_request');
    if (t.state === 'closed') return Promise.resolve({ ok: true, terminal_id: t.id, state: 'closed', already_closed: true, close_reason: t.closeReason, exit_code: t.exitCode, exit_signal: t.exitSignal, exited_at: t.exitedAt, closed_at: t.closedAt });
    if (t.closePromise) return t.closePromise;
    t.closeReason = reason; t.state = t.state === 'exited' ? 'closing' : 'closing'; this.notify(t);
    t.closePromise = new Promise((resolve, reject) => {
      const finish = () => { if (t.state === 'closed') return; t.state = 'closed'; t.closedAt = new Date(this.clock()).toISOString(); this.notify(t); resolve({ ok: true, terminal_id: t.id, state: 'closed', close_reason: reason, exit_code: t.exitCode, exit_signal: t.exitSignal, exited_at: t.exitedAt, closed_at: t.closedAt }); };
      this.cgroups.killAndRemove(t.cgroup).then(finish).catch(reject);
    });
    return t.closePromise;
  }
  async closeRequest(raw) { const t = this.lookup(raw); return this.close(t, raw.reason || 'client_requested'); }
  reap(referenceMs = this.clock()) { const cutoff = referenceMs - this.policy.ttlMs; for (const t of this.terminals.values()) if (Date.parse(t.lastActivityAt) < cutoff && t.state !== 'closed') this.close(t, 'ttl_expired').catch(() => {}); }
}
module.exports = { TerminalService };
