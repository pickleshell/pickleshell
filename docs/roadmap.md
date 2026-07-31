# PickleShell Roadmap

## v1 production baseline

The first production release keeps the protocol small and explicit:

- `send-chat` starts an asynchronous task and returns `request_id`;
- `session-status` polls a request or explicit OpenCode session;
- `session-output` reads the complete reply and trace;
- `cancel-request` stops an active request without releasing a session early;
- `chat_id` selects the workspace;
- `session_id` continues an OpenCode conversation;
- small-file transfer, safe paths, size limits, and workspace isolation;
- states: `new_session`, `busy`, `completed`, `ready`, `unknown`, `cancelling`;
- authenticated Gateway, bounded timeouts, safe errors, and bounded result buffers.

Do not add settings or summary modes to v1. Full trace is intentional: it is
valuable for file edits, tests, and diagnostics.

## Basic product scope

PickleShell has three mandatory core services: **Agent**, **Browser**, and
**Terminal**. The Agent protocol shipped with v1; the Browser is implemented
after that baseline; Terminal and Settings complete the next milestone
(Agent + Browser + Terminal + Settings).

- **Agent:** retain `send-chat` → `session-status` → `session-output` →
  `cancel-request`. OpenCode is the current backend; plan first-class Codex
  parity as an alternative backend behind the same MCP interface. OpenCode and
  Codex are replaceable provider adapters, and Codex must match OpenCode's
  schema, session continuity, idempotency, cancellation, and task semantics.
- **Browser:** Playwright is implemented and validated as the browser execution
  layer (52 tools registered on the PickleShell MCP server).
- **Terminal:** planned. Must emulate an interactive terminal used by a human —
  a live PTY session the operator drives like a real terminal (spawn, keystroke
  input, streamed output, resize), not one-shot shell command execution.
  Proposed minimal async API: `terminal-spawn`, `terminal-write`,
  `terminal-output`, `terminal-resize`, `terminal-close`. Follow existing
  idempotency/task semantics where they apply.
- **Settings:** planned. `settings-get` and `settings-update` manage
  policy-controlled mutable defaults such as the agent backend
  (OpenCode/Codex), the model allowlist, file-transfer limits (files per
  request, size per file, total payload), output mode full/summary, Browser and
  Terminal enablement, timeout/output limits, risky-capability permissions, and
  possible autonomy modes `observe`/`workspace-write`/`operator`. Attempts to
  change forbidden or immutable settings are rejected or leave values
  unchanged. Never return secrets; return only configured state. Before
  implementation, define scope (global, workspace, session, or request),
  persistence, defaults, validation, restart behavior, and secret redaction.
- **Product framing:** a universal local runtime for ChatGPT — Agent, Browser,
  and Terminal on any connected machine.

## Next release checklist

### Production verification

- [ ] New request without `session_id`: `request_id` → `busy` → `completed`.
- [ ] Read the completed result through `session-output`.
- [ ] Continue a conversation using the returned real `ses_...` ID.
- [ ] Send a parallel request to a busy session and verify `409 session_busy`.
- [ ] Verify an independent workspace can run concurrently without state mixing.
- [ ] Verify file transfer, destination validation, overwrite protection, and limits.
- [ ] Verify agent error is exposed as a safe structured error.
- [ ] Verify timeout state and result retention.
- [ ] Verify Gateway restart behavior and document whether in-flight requests are lost.
- [ ] Verify tunnel restart and MCP schema refresh behavior.
- [ ] Run the complete production smoke test before creating a release tag.

### Correctness and reliability

- [ ] Add an idempotency mechanism for retried `send-chat` requests, or document
      the exact retry guarantee provided by the tunnel.
- [ ] Ensure dangerous commands cannot execute twice after connector/network retry.
- [ ] Keep explicit-session locking atomic and preserve the cancelling state until
      the child process has actually exited.
- [ ] Classify agent failures, provider failures, timeouts, and cancellations
      without exposing secrets or raw credentials.
- [ ] Define and test retention/cleanup behavior for completed request buffers.

### Deferred features

These are intentionally out of scope for the next production cut unless a
separate design is approved:

- configurable progress verbosity;
- request queues;
- richer progress event normalization.

## Release gate

Create the next release only when the production verification checklist passes,
the retry/idempotency behavior is documented, and restart semantics are honest
and tested. Keep the full trace as the default output mode.

## v1.1 — Playwright Browser Automation

Integrated Playwright MCP (52 tools) into the PickleShell MCP server:

### Completed

- [x] `@playwright/mcp` installed and bridged via `InMemoryTransport`
- [x] Chromium revision 1232 (Chrome 151) installed
- [x] All 52 Playwright tools registered on the PickleShell MCP server
- [x] `chromiumSandbox: false` for headless runtime
- [x] Tunnel restart preserves the Playwright integration
- [x] `browser_navigate` → `about:blank` → snapshot — verified end-to-end

### Remaining

- [ ] Document browser tool schema in the API reference
- [ ] Test with real-world sites and form interactions
- [ ] Test concurrent browser sessions
- [ ] Evaluate persistent browser profile (`userDataDir`) for session cookies
- [ ] Add vision-based interaction testing (`browser_move`, `browser_click` by coordinates)
