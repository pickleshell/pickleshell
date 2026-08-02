'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { error } = require('./validation');

const SAFE_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'COLORTERM', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
function makePolicy(options = {}) {
  const roots = (options.roots || [process.cwd()]).map((root) => fs.realpathSync(root));
  const executables = new Set(options.executables || ['/bin/bash', '/bin/sh']);
  const maxTerminals = options.maxTerminals ?? 8;
  const ringBytes = options.ringBytes ?? 1024 * 1024;
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  if (!Number.isInteger(maxTerminals) || maxTerminals < 1 || maxTerminals > 32 || !Number.isInteger(ringBytes) || ringBytes < 1 || ringBytes > 16 * 1024 * 1024 || !Number.isInteger(ttlMs) || ttlMs < 60000 || ttlMs > 86400000) throw new Error('invalid terminal policy');
  return { roots, executables, environment: new Set(options.environment || SAFE_ENV), defaultExecutable: options.defaultExecutable || '/bin/bash', terminalType: options.terminalType || 'xterm-256color', maxTerminals, ringBytes, ttlMs, graceMs: options.graceMs ?? 250 };
}
function safeCwd(requested, policy) {
  if (requested === undefined) return policy.roots[0];
  if (typeof requested !== 'string' || requested.length === 0 || path.isAbsolute(requested) || requested.split(/[\\/]/).includes('..')) throw error('invalid_working_directory');
  for (const root of policy.roots) {
    const target = path.resolve(root, requested);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const components = relative ? relative.split(path.sep) : [];
    let current = root;
    try {
      for (const component of components) {
        current = path.join(current, component);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw error('invalid_working_directory');
        const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        fs.closeSync(fd);
      }
      return current;
    } catch (e) { if (e.code === 'invalid_working_directory') throw e; }
  }
  throw error('invalid_working_directory');
}
function buildEnv(request, policy, cwd) {
  const env = {};
  for (const key of policy.environment) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, request.env); env.TERM = policy.terminalType; env.PWD = cwd;
  return env;
}
module.exports = { SAFE_ENV, makePolicy, safeCwd, buildEnv };
