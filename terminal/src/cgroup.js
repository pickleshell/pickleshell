'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { error, validateId } = require('./validation');

const CHILD_PREFIX = 'terminal-';
const CHILD_NAME = /^terminal-term_[A-Za-z0-9_-]+$/;

function unavailable(message) { return error('terminal_cgroup_unavailable', message); }

function childName(terminalId) {
  validateId(terminalId);
  const name = `${CHILD_PREFIX}${terminalId}`;
  if (!CHILD_NAME.test(name)) throw unavailable('invalid terminal cgroup name');
  return name;
}

function parsePopulated(events) {
  const match = String(events).match(/(?:^|\n)populated\s+([01])(?:\s|$)/);
  if (!match) throw unavailable('cgroup.events has no populated field');
  return match[1] === '1';
}

function discoverRoot(fsImpl = fs, fsRoot = '/sys/fs/cgroup') {
  let line;
  try { line = fsImpl.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((value) => value.startsWith('0::')); } catch (_) { throw unavailable('cannot inspect the unified cgroup'); }
  if (!line) throw unavailable('unified cgroup v2 is required');
  const relative = line.slice(3);
  if (!relative.startsWith('/')) throw unavailable('invalid unified cgroup path');
  const root = path.resolve(fsRoot, `.${relative}`);
  if (root !== path.resolve(fsRoot) && !root.startsWith(`${path.resolve(fsRoot)}${path.sep}`)) throw unavailable('unified cgroup escaped cgroupfs');
  return root;
}

class CgroupManager {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.fsRoot = options.fsRoot || '/sys/fs/cgroup';
    this.root = options.root || discoverRoot(this.fs, this.fsRoot);
    this.pollMs = options.pollMs ?? 10;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 5000;
    this.launcherPath = options.launcherPath === undefined ? path.join(__dirname, '..', 'bin', 'cgroup-launcher') : options.launcherPath;
  }

  childPath(terminalId) {
    const name = childName(terminalId);
    const target = path.resolve(this.root, name);
    if (path.dirname(target) !== path.resolve(this.root) || path.basename(target) !== name) throw unavailable('terminal cgroup escaped its parent');
    return { name, path: target };
  }

  ensureCgroupAvailable() {
    try {
      if (!path.isAbsolute(this.root) || path.resolve(this.root) === path.parse(this.root).root) throw new Error('invalid cgroup parent');
      for (const file of ['cgroup.events', 'cgroup.kill']) if (!this.fs.existsSync(path.join(this.root, file))) throw new Error(`${file} is unavailable`);
    } catch (cause) { throw unavailable(cause.message); }
  }

  ensureAvailable() {
    this.ensureCgroupAvailable();
    try { if (this.launcherPath && (!this.fs.existsSync(this.launcherPath) || (this.fs.statSync(this.launcherPath).mode & 0o111) === 0)) throw new Error('cgroup launcher is unavailable'); } catch (cause) { throw unavailable(cause.message); }
  }

  async initialize() {
    this.ensureCgroupAvailable();
    await this.cleanupStale();
    this.ensureAvailable();
  }

  create(terminalId) {
    this.ensureAvailable();
    const child = this.childPath(terminalId);
    try {
      this.fs.mkdirSync(child.path, { mode: 0o700 });
      if (!this.fs.existsSync(path.join(child.path, 'cgroup.events')) || !this.fs.existsSync(path.join(child.path, 'cgroup.kill'))) throw new Error('child cgroup is incomplete');
      return child;
    } catch (cause) {
      try { this.fs.rmdirSync(child.path); } catch (_) {}
      throw unavailable(`cannot create terminal cgroup: ${cause.message}`);
    }
  }

  async waitEmpty(childPath) {
    const end = Date.now() + this.pollTimeoutMs;
    while (Date.now() < end) {
      let populated;
      try { populated = parsePopulated(this.fs.readFileSync(path.join(childPath, 'cgroup.events'), 'utf8')); } catch (cause) { throw unavailable(`cannot read terminal cgroup state: ${cause.message}`); }
      if (!populated) return;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    throw unavailable('terminal cgroup did not become empty');
  }

  async killAndRemove(child) {
    if (!child || typeof child.name !== 'string' || !CHILD_NAME.test(child.name) || path.dirname(path.resolve(child.path)) !== path.resolve(this.root) || path.basename(path.resolve(child.path)) !== child.name) throw unavailable('invalid terminal cgroup target');
    try {
      const stat = this.fs.lstatSync(child.path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('terminal cgroup is not a real directory');
      this.fs.writeFileSync(path.join(child.path, 'cgroup.kill'), '1\n');
    } catch (cause) { throw unavailable(`cannot kill terminal cgroup: ${cause.message}`); }
    await this.waitEmpty(child.path);
    try { this.fs.rmdirSync(child.path); } catch (cause) { throw unavailable(`cannot remove terminal cgroup: ${cause.message}`); }
  }

  async cleanupStale() {
    let entries;
    try { entries = this.fs.readdirSync(this.root, { withFileTypes: true }); } catch (cause) { throw unavailable(`cannot list terminal cgroups: ${cause.message}`); }
    for (const entry of entries) {
      if (!entry.isDirectory() || !CHILD_NAME.test(entry.name)) continue;
      await this.killAndRemove({ name: entry.name, path: path.join(this.root, entry.name) });
    }
  }
}

module.exports = { CHILD_NAME, childName, parsePopulated, discoverRoot, CgroupManager };
