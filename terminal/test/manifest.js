'use strict';

function parseManifestText(text, records = []) {
  const lines = text.split('\n');
  const remainder = lines.pop();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value.pid && !records.some((record) => record.pid === value.pid)) records.push(value);
    } catch (_) {}
  }
  return { records, remainder };
}

function missingRoles(records, expectedRoles) {
  return expectedRoles.filter((role) => !records.some((record) => record.role === role));
}

module.exports = { parseManifestText, missingRoles };
