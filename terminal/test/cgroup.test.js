'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { childName, parsePopulated, CgroupManager } = require('../src/cgroup');

assert.equal(childName('term_abc-123'), 'terminal-term_abc-123');
assert.throws(() => childName('../term_x'), (e) => e.code === 'invalid_request');
assert.equal(parsePopulated('populated 0\n'), false);
assert.equal(parsePopulated('foo 1\npopulated 1\n'), true);
assert.throws(() => parsePopulated(''), (e) => e.code === 'terminal_cgroup_unavailable');

const root = path.resolve('/tmp/pickleshell-cgroup-unit');
const directories = new Set([root]);
const files = new Map([[path.join(root, 'cgroup.events'), 'populated 0\n'], [path.join(root, 'cgroup.kill'), '']]);
const writes = [];
const fakeFs = {
  existsSync: (file) => files.has(file) || directories.has(file),
  statSync: () => ({ mode: 0o100755 }),
  lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
  mkdirSync: (dir) => { directories.add(dir); files.set(path.join(dir, 'cgroup.events'), 'populated 0\n'); files.set(path.join(dir, 'cgroup.kill'), ''); },
  rmdirSync: (dir) => { directories.delete(dir); for (const file of [...files.keys()]) if (file.startsWith(`${dir}/`)) files.delete(file); },
  writeFileSync: (file, value) => { writes.push([file, value]); },
  readFileSync: (file) => files.get(file),
  readdirSync: () => [],
};
const manager = new CgroupManager({ root, fs: fakeFs, launcherPath: null, pollMs: 1 });
manager.ensureAvailable();
const child = manager.create('term_unit');
assert.equal(child.name, 'terminal-term_unit');
manager.killAndRemove(child).then(() => {
  assert.deepEqual(writes, [[path.join(child.path, 'cgroup.kill'), '1\n']]);
  assert.equal(directories.has(child.path), false);
  console.log('cgroup tests passed');
}).catch((error) => { console.error(error); process.exitCode = 1; });
