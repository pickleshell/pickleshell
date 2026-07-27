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

- `get-settings` / `update-settings`;
- summary output modes or a summary model;
- configurable progress verbosity;
- request queues;
- richer progress event normalization.

If settings are revisited, first define scope (global, workspace, session, or
request), persistence, defaults, validation, and restart behavior.

## Release gate

Create the next release only when the production verification checklist passes,
the retry/idempotency behavior is documented, and restart semantics are honest
and tested. Keep the full trace as the default output mode.
