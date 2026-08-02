// Internal runtime contract for agent execution.
//
// These shapes are INTERNAL to the gateway and are consumed only by the
// runtime layer (gateway/src/runtime), its dependents (agent.js facade,
// chat.js dispatcher) and the progress/metadata aggregator (concurrency.js).
// The public MCP/HTTP schema lives in mcp-server/src/types.ts and is
// intentionally not changed by this contract.

const RUNTIME_OPENCODE = 'opencode';
const RUNTIME_CODEX = 'codex';

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
//
// 'internal_error' is reserved for gateway-side failures that are NOT the
// agent's fault: synchronous adapter preparation (buildPrompt/buildArgs/
// buildChildEnv/createStreamHandler/supervisor setup) throwing, and parser/
// normalizer failures inside the adapter's onLine stream handler.

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
//
// The dispatcher (chat.js) persists the full AgentResult through
// concurrency.complete()/completeCancel() and reports the outcome under
// session-output as output.execution_state, using the PUBLIC vocabulary
// done|error|timeout|cancelled|exit_error (AgentResult.state 'completed' is
// exposed as 'done'). The top-level session-status/session-output state is a
// DIFFERENT automaton — the request lifecycle (new_session|busy|completed).
// A finished timeout/error/cancelled request therefore still reports
// state:'completed' with next_action:'session-output'; the failure lives in
// output.execution_state + output.error, never in the top-level state.

// Isolation rules that adapters and the supervisor MUST honor:
//   - onProgress (the progress consumer) may throw; the adapter must catch,
//     log, and continue streaming. A consumer failure must never kill a
//     healthy agent.
//   - onLine (the parser/normalizer) throwing means the gateway cannot trust
//     the stream; the supervisor SIGKILLs the process group, stops further
//     delivery, and reports onLineError. The facade classifies it as
//     internal_error.

// Adapter interface (implemented by runtime/adapters/*):
//   name: string
//   command?: string       // executable passed to supervisor; defaults to bash
//   isAvailable?: () => boolean
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
  RUNTIME_CODEX,
};
