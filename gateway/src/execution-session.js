// Persistent write-once authority bindings, independent of expiring result buffers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ExecutionProfileError } = require('./execution-profile');
function bindingFile(sessionId) {
  const settingsPath = require('./settings').storePath();
  const digest = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(path.dirname(settingsPath), 'execution-sessions', `${digest}.json`);
}
function tuple(chatId, workspace, context) {
  return JSON.stringify({ chat_id: chatId, workspace_hash: crypto.createHash('sha256').update(workspace).digest('hex'), runtime: context.runtime, execution_profile: context.execution_profile, boundary: context.boundary, boundary_provider: context.boundary_provider });
}
function check(sessionId, expected, { bind = false, legacy = false } = {}) {
  const file = bindingFile(sessionId);
  try {
    if (bind || legacy) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(file, expected, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (fs.readFileSync(file, 'utf8') !== expected) {
      throw new ExecutionProfileError('session_authority_mismatch', 'Session authority or workspace changed; start a new session', 409);
    }
  } catch (error) {
    if (error instanceof ExecutionProfileError) throw error;
    if (error.code === 'ENOENT') throw new ExecutionProfileError('session_authority_unknown', 'Session has no authority binding; start a new session', 409);
    throw new ExecutionProfileError('session_authority_unavailable', 'Session authority store is unavailable', 503);
  }
}
module.exports = { tuple, check };
