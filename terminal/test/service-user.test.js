'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '..', 'systemd', 'configure-service-user.sh');
const passwd = spawnSync('getent', ['passwd'], { encoding: 'utf8' }).stdout;
const serviceUser = passwd.split('\n').map((line) => line.split(':', 1)[0]).find((name) => name && name !== 'root' && /^[a-z_][a-z0-9_-]{0,31}\$?$/.test(name));
assert.ok(serviceUser, 'test requires a valid non-root local account');
function check(...args) {
  return spawnSync(script, ['--check', ...args], { encoding: 'utf8' });
}

assert.equal(check(serviceUser).status, 0);
assert.notEqual(check('root').status, 0);
assert.notEqual(check('bad/name').status, 0);
assert.notEqual(check('missing-pickleshell-terminal-user').status, 0);
assert.notEqual(check(serviceUser, 'bad/name').status, 0);
assert.notEqual(check(serviceUser, 'root').status, 0);
console.log('service-user tests passed');
