// Canonical AgentEvent builder shared by runtime adapters.

function createAgentEvent(type, fields = {}) {
  const event = { type, timestamp: Date.now() };
  if (fields.text !== undefined) event.text = fields.text;
  if (fields.tool !== undefined) event.tool = fields.tool;
  if (fields.status !== undefined) event.status = fields.status;
  if (fields.title !== undefined) event.title = fields.title;
  if (fields.output !== undefined) event.output = fields.output;
  if (fields.details !== undefined) event.details = fields.details;
  return event;
}

module.exports = {
  createAgentEvent,
};
