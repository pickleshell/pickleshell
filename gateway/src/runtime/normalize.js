// Canonical AgentEvent builder shared by runtime adapters.

function createAgentEvent(type, fields = {}) {
  const event = { type, timestamp: Date.now() };
  if (fields.text !== undefined) event.text = fields.text;
  if (fields.tool !== undefined) event.tool = fields.tool;
  if (fields.status !== undefined) event.status = fields.status;
  if (fields.title !== undefined) event.title = fields.title;
  if (fields.input !== undefined) event.input = fields.input;
  if (fields.output !== undefined) event.output = fields.output;
  if (fields.details !== undefined) event.details = fields.details;
  if (fields.error_class !== undefined) event.error_class = fields.error_class;
  return event;
}

// Derive the AgentResult.metadata object from a list of canonical AgentEvents.
// Shared by the agent facade so its metadata matches what concurrency.js
// accumulates incrementally from the same event stream.
function buildMetadata(events, fallbackErrorClass) {
  const files = [];
  const tools = new Set();
  let testResult = null;
  let gitCommit = null;
  let errorClass = null;

  for (const ev of events || []) {
    if (ev.type === 'error' && ev.error_class) {
      errorClass = ev.error_class;
    }

    if (ev.type !== 'tool') continue;
    if (ev.tool) tools.add(ev.tool);
    if (ev.status !== 'done') continue;

    const input = ev.input || {};
    const output = ev.output || '';

    if (
      (ev.tool === 'write' || ev.tool === 'edit' || ev.tool === 'file_edit' || ev.tool === 'file_write') &&
      input.filePath
    ) {
      if (!files.includes(input.filePath)) {
        files.push(input.filePath);
      }
    }

    if ((ev.tool === 'bash' || ev.tool === 'terminal') && input.command) {
      if (input.command.includes('git commit') && !input.command.includes('git commit --amend')) {
        const hashMatch = output.match(/\[[\w]+\s+([0-9a-f]{7,40})\]/);
        if (hashMatch && !gitCommit) {
          gitCommit = hashMatch[1];
        }
      }

      if (input.command.match(/\b(test|jest|vitest|mocha|pytest|go test|cargo test|npm test|npx test)\b/)) {
        const passMatch = output.match(/(\d+)\s+pass/);
        const failMatch = output.match(/(\d+)\s+fail/);
        const totalMatch = output.match(/(\d+)\s+test/);
        if (passMatch || failMatch || totalMatch) {
          testResult = {
            passed: passMatch ? parseInt(passMatch[1], 10) : null,
            failed: failMatch ? parseInt(failMatch[1], 10) : null,
            total: totalMatch ? parseInt(totalMatch[1], 10) : null,
          };
        }
      }
    }
  }

  return {
    files_modified: files,
    tools_used: [...tools],
    test_result: testResult,
    git_commit: gitCommit,
    error_class: errorClass || fallbackErrorClass || null,
  };
}

module.exports = {
  createAgentEvent,
  buildMetadata,
};
