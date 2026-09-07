// JSON.parse discards duplicate keys. Reject ambiguity before using static policy,
// including escaped spellings of the same key and repeated enclosing objects.
const { ExecutionProfileError } = require('../execution-profile');
module.exports = function parseConfig(text) {
  const parsed = JSON.parse(text);
  const stack = [];
  for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g) || []) {
    const frame = stack[stack.length - 1];
    if (token === '{' || token === '[') stack.push({ object: token === '{', keys: new Set(), key: true });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (frame) frame.key = true; }
    else if (token === ':') { if (frame) frame.key = false; }
    else if (frame?.object && frame.key) {
      const key = JSON.parse(token);
      if (frame.keys.has(key)) throw new ExecutionProfileError('execution_policy_invalid', 'Duplicate configuration keys are forbidden');
      frame.keys.add(key);
      frame.key = false;
    }
  }
  return parsed;
};
