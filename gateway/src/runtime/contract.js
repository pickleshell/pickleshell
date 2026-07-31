// Internal runtime contract for agent execution.
//
// These shapes are INTERNAL to the gateway and are consumed only by the
// runtime layer (gateway/src/runtime), its dependents (agent.js facade,
// chat.js dispatcher) and the progress/metadata aggregator (concurrency.js).
// The public MCP/HTTP schema lives in mcp-server/src/types.ts and is
// intentionally not changed by this contract.

const RUNTIME_OPENCODE = 'opencode';

// AgentRequest — options accepted by runAgentRequest().
// {
//   runtime: string,
//   request_id: string,
//   chatId: string,
//   message: string,
//   workspace: string,
//   timeoutSec: number,
//   session_id?: string|null,
//   model?: string|null,
//   fileSummary?: Array<{ path: string, mime_type: string, size: number }>|null,
//   onProgress?: (event: AgentEvent) => void,
// }

// AgentEvent — canonical runtime-neutral progress/result event emitted by
// adapters and consumed by concurrency.js. No runtime-specific fields leak
// through this shape.
// {
//   type: 'text'|'tool'|'status'|'error',
//   timestamp: number,           // epoch ms
//   text?: string,               // text events
//   tool?: string,               // tool events: tool name
//   status?: 'running'|'done',   // tool events
//   title?: string,              // tool events: display title
//   input?: { filePath?: string, command?: string }|null,  // tool events
//   output?: string,             // tool events: full output
//   details?: string,            // error events
//   error_class?: string,        // error events
// }

// AgentError — structured error embedded in AgentResult. runAgentRequest()
// never rejects; failures are represented here.
// {
//   class: string,   // 'agent_error'|'spawn_error'|'internal_error'
//                    // |'unavailable'|'timeout'|'cancelled'|'exit_error'
//   message: string,
//   exit_code?: number|null,
//   signal?: string|null,
// }

// AgentResult — unified outcome; runAgentRequest() always resolves with one.
// {
//   ok: boolean,
//   runtime: string,
//   request_id: string|null,
//   session_id: string|null,
//   state: 'completed'|'cancelled'|'timeout'|'exit_error'|'error',
//   reply: string|null,
//   events: AgentEvent[],
//   metadata: {
//     files_modified: string[],
//     tools_used: string[],
//     test_result: { passed: number|null, failed: number|null, total: number|null }|null,
//     git_commit: string|null,
//     error_class: string|null,
//   },
//   error: AgentError|null,
//   started_at: string|null,     // ISO 8601
//   completed_at: string|null,   // ISO 8601
//   duration_ms: number|null,
// }

// Adapter interface (implemented by runtime/adapters/*):
//   name: string
//   buildPrompt(message, fileSummary) -> string
//   buildArgs(prompt, workspace, sessionId, model) -> string[]
//   buildChildEnv(sourceEnv?) -> object
//   createStreamHandler({ chatId, onProgress }) -> handler
//     handleLine(line)      parse one stdout line, accumulate state, forward
//                           the canonical event to onProgress
//     getSessionId()        string|null
//     getError()            string|null
//     getReply(fallback)    string
//     getEvents()           AgentEvent[]
//   parseJsonOutput(stdout) -> { text, sessionId }

module.exports = {
  RUNTIME_OPENCODE,
};
