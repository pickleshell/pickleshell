'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const mode = process.argv[2];
function manifest(role) {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  return { role, pid: process.pid, ppid: Number(fields[1]), pgrp: Number(fields[2]), sid: Number(fields[3]), starttime: fields[19] };
}
function report(role) { process.stdout.write(`${JSON.stringify(manifest(role))}\n`); }
function hold(role = 'hold') { report(role); process.stdin.resume(); }
function child(args, options = {}) { const result = spawn(process.execPath, [__filename, ...args], { stdio: 'inherit', ...options }); result.unref(); return result; }

if (mode === 'foreground') hold('foreground');
else if (mode === 'background') { report('background-parent'); child(['hold']); process.stdin.resume(); }
else if (mode === 'pipeline') { report('pipeline-parent'); /* The first hold's stdout is intentionally consumed by the second hold's stdin. */ spawn('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} hold | ${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} hold`], { stdio: 'inherit' }); process.stdin.resume(); }
else if (mode === 'nested') { report('nested-parent'); spawn('/bin/sh', ['-c', `/bin/sh -c ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} hold`)}`], { stdio: 'inherit' }); process.stdin.resume(); }
else if (mode === 'separate') { report('separate-parent'); child(['hold'], { detached: true }); process.stdin.resume(); }
else if (mode === 'setsid') { report('setsid-parent'); const result = spawn('/usr/bin/setsid', [process.execPath, __filename, 'hold'], { stdio: 'inherit' }); result.unref(); process.stdin.resume(); }
else if (mode === 'double-fork') { report('double-fork-parent'); child(['grandchild'], { detached: true }); process.exit(0); }
else if (mode === 'grandchild') hold('double-fork-grandchild');
else if (mode === 'hold') hold();
else process.exitCode = 2;
