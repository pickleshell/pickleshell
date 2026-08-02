'use strict';

class OutputRing {
  constructor(limit = 1024 * 1024) { this.limit = limit; this.start = 0; this.end = 0; this.parts = []; this.sequence = 0; }
  append(data) {
    if (!data.length) return;
    const max = this.limit;
    let value = data.length > max ? data.subarray(data.length - max) : data;
    this.parts.push({ start: this.end, data: value, sequence: ++this.sequence });
    this.end += value.length;
    let excess = this.end - (this.parts[0]?.start ?? this.end) - max;
    while (this.parts.length && excess > 0) {
      const part = this.parts[0];
      if (excess >= part.data.length) { this.parts.shift(); excess -= part.data.length; }
      else { part.data = part.data.subarray(excess); part.start += excess; excess = 0; }
    }
    this.start = this.parts[0]?.start ?? this.end;
  }
  read(cursor, maxBytes) {
    const truncated = cursor < this.start;
    const from = truncated ? this.start : cursor;
    const result = []; let bytes = 0; let first; let last;
    for (const part of this.parts) {
      if (part.start + part.data.length <= from) continue;
      const offset = Math.max(0, from - part.start);
      const chunk = part.data.subarray(offset, offset + maxBytes - bytes);
      if (!chunk.length) break;
      result.push(chunk); bytes += chunk.length; first ??= part.sequence; last = part.sequence;
      if (bytes >= maxBytes) break;
    }
    return { data: Buffer.concat(result), nextCursor: from + bytes, oldestCursor: this.start, truncated, truncatedFrom: truncated ? cursor : null, sequenceStart: first ?? null, sequenceEnd: last ?? null };
  }
}
module.exports = { OutputRing };
