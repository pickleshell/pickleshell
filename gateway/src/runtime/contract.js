// Internal runtime contract for agent execution.
//
// These shapes are INTERNAL to the gateway and are consumed only by the
// runtime layer (gateway/src/runtime). The public MCP/HTTP schema lives in
// mcp-server/src/types.ts and is intentionally not changed by this contract.

const RUNTIME_OPENCODE = 'opencode';

// Adapter interface (implemented by runtime/adapters/*):
//
//   name: string
//     Runtime identifier; must match KNOWN_RUNTIMES in config.js.
//
//   buildPrompt(message, fileSummary) -> string
//     Compose the final prompt (system instruction + user instruction +
//     optional delivered-files summary).
//
//   buildArgs(prompt, workspace, sessionId, model) -> string[]
//     argv for the process supervisor, always ending with the runtime wrapper
//     script. Every value is passed as an exact argument (never concatenated
//     into a shell command).
//
//   buildChildEnv(sourceEnv?) -> object
//     Allowlisted child environment; may only contain allowlisted keys.
//
//   createStreamHandler({ chatId, onProgress }) -> handler
//     Returns a line handler with:
//       handleLine(line)      parse one stdout line, accumulate state, and
//                             forward the raw event to onProgress
//       getSessionId()        string|null
//       getError()            string|null
//       getReply(fallback)    string
//       getEvents()           AgentEvent[]
//
//   parseJsonOutput(stdout) -> { text, sessionId }
//     Pure stdout parser used for sync result extraction.

// @typedef {{
//   type: 'text'|'tool'|'status'|'error',
//   timestamp: number,
//   text?: string,
//   tool?: string,
//   status?: string,
//   title?: string,
//   output?: string,
//   details?: string,
// }} AgentEvent

// @typedef {{
//   runtime: string,
//   message: string,
//   workspace: string,
//   session_id?: string|null,
//   model?: string|null,
//   fileSummary?: Array<{ path: string, mime_type: string, size: number }>|null,
// }} AgentRequest

// @typedef {{
//   runtime: string,
//   session_id: string|null,
//   state: 'completed'|'cancelled',
//   reply: string|null,
//   events: AgentEvent[],
// }} AgentResult

module.exports = {
  RUNTIME_OPENCODE,
};
