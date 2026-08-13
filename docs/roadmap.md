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

Full trace is intentional: it is valuable for file edits, tests, and
diagnostics. Settings remain limited to their documented four mutable names.

## Basic product scope

PickleShell has three mandatory core services: **Agent**, **Browser**, and
**Terminal**. The Agent protocol shipped with v1; the Browser and Terminal are
implemented, and the scoped Settings API is implemented with the Agent path.

- **Agent:** retain `send-chat` → `session-status` → `session-output` →
  `cancel-request`. OpenCode is the supported default; Codex is implemented as
  a first-class alternative behind the same MCP interface. Both are replaceable
  provider adapters with the same schema, session continuity, idempotency,
  cancellation, and task semantics. The Codex runtime has passed the production
  MCP/Gateway smoke path through the reference test tunnel.
- **Browser:** Playwright is implemented and validated as the browser execution
  layer (52 tools registered on the PickleShell MCP server).
- **Terminal:** implemented and E2E verified across ordinary and privileged
    reference profiles across all six operations. It uses a separate
    node-pty runtime with a dedicated unprivileged identity by default, supports
    explicit deployment-time selection of an existing Linux service user,
    delegated cgroup-v2 lifecycle cleanup, and exposes the six-tool MCP contract.
    The immutable release-installation and production smoke gates are complete.
- **Settings:** implemented for `runtime`, `model`, `agent_timeout_sec`, and
  `codex_transport` through global defaults and optional per-chat overrides.
  Operator allowlists and runtime capabilities remain immutable; descriptions
  are redacted and never expose secrets or workspace paths. Future mutable
  settings require a separate contract.
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
- [ ] Verify tunnel restart and MCP schema refresh behavior separately; the
      automated reconnect test covers only a local Gateway/proxy transport
      reconnect, not a generic tunnel restart.
- [x] Verify Terminal reconnect through a restartable local Gateway/proxy
      transport: the Terminal service retains the PTY, terminal ID, and cursor;
      output and writes continue after reconnect.
- [x] Complete ordinary and privileged reference-profile E2E across all six
      Terminal operations.
- [x] Complete reference test-tunnel Terminal E2E across all six MCP operations.
- [x] Pass a clean installation on a separate machine with isolated Gateway,
      Tunnel, Browser, Agent, and Terminal end-to-end smoke tests.
- [x] Pass Linux Node 20/22/24 CI with a forced node-pty source rebuild and native PTY smoke test.
- [x] Pass the separately delegated systemd cgroup integration gate; standard CI explicitly skips it.
- [x] Add an isolated-tested immutable release migration with deterministic rollback.
- [x] Complete ordinary immutable production activation with structural checks:
      active/current SHA, root-owned read-only release tree, unit/profile path
      invariants, no restart deltas, and unchanged separately managed services.
- [x] Run the complete production smoke gate before release: OpenCode/Codex
      exact `PONG`, Terminal exact `PONG` with close and cgroup cleanup,
      Browser navigate/snapshot/close, and no restart deltas or pids saturation.

### Correctness and reliability

- [ ] Add an idempotency mechanism for retried `send-chat` requests, or document
      the exact retry guarantee provided by the tunnel.
- [ ] Ensure dangerous commands cannot execute twice after connector/network retry.
- [ ] Keep explicit-session locking atomic and preserve the cancelling state until
      the child process has actually exited.
- [ ] Classify agent failures, provider failures, timeouts, and cancellations
      without exposing secrets or raw credentials.
- [ ] Define and test retention/cleanup behavior for completed request buffers.
- [ ] Target the next patch release for the confirmed production file-transfer
      isolation bug: MCP/tunnel stages files under `/run/pickleshell-mcp` as
      `pickleshell-tunnel` with restrictive permissions, while Gateway runs as
      `pickleshell` and receives temp source paths but hits `EACCES` before the
      destination copy. Implement a secure cross-service handoff using a
      dedicated shared group/ACL or equivalent, without world-readable
      permissions; update systemd/deployment templates and clean-install
      behavior; add regression/integration coverage with distinct service users
      and a live transfer matrix for explicit destinations and default
      `.inbox`; preserve cleanup, symlink protections, and least privilege.
- [ ] Continue investigating practical file-transfer paths that avoid embedding
      Base64 payloads in ChatGPT MCP arguments. Document the current manual
      fallback and revisit the design if OpenAI adds native file references or
      binary MCP input; OpenAI has been notified about this platform limitation.

### Deferred features

These are intentionally out of scope for the next production cut unless a
separate design is approved:

- configurable progress verbosity;
- request queues;
- richer progress event normalization.

### Possible Terminal improvements

These are future options, not current contract changes:

- optional `terminal-output` plain mode; raw/lossless Base64 remains the default;
- possible screen-rendered mode through a headless VT emulator, only if real TUI use cases justify it;
- optional noninteractive environment profile for `PAGER`, `GIT_PAGER`, and `NO_COLOR`; never force `CI=true`;
- do not add automatic `SIGINT` -> `SIGTERM` -> `SIGKILL` escalation or an arbitrary maximum execution timeout;
- preserve explicit model control over signals and the existing security boundaries.

## Release gate

Do not create a release or tag for the Codex integration alone. Create the next
release only after a clean installation on a separate machine confirms
end-to-end Agent, Browser, and Terminal functionality.
The production verification checklist must pass, retry/idempotency behavior
must be documented, and restart semantics must be honest and tested. Keep the
full trace as the default output mode.

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
