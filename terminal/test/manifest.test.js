'use strict';

const assert = require('node:assert/strict');
const { parseManifestText, missingRoles } = require('./manifest');

const parent = JSON.stringify({ role: 'pipeline-parent', pid: 10 });
const hold = JSON.stringify({ role: 'hold', pid: 11 });
const parsed = parseManifestText(`${parent}\n${hold}\npartial`);
assert.deepEqual(parsed.records.map((record) => record.role), ['pipeline-parent', 'hold']);
assert.equal(parsed.remainder, 'partial');
assert.deepEqual(missingRoles(parsed.records, ['pipeline-parent', 'hold']), []);
assert.deepEqual(missingRoles(parsed.records, ['pipeline-parent', 'first-pipeline-stage']), ['first-pipeline-stage']);
console.log('manifest tests passed');
