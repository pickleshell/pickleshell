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
- [x] Fix the production file-transfer isolation bug: MCP/tunnel stages files
      in `MCP_TEMP_DIR` as `pickleshell-tunnel`, while Gateway runs as
      `pickleshell`. The release installs a `0710` staging root owned by the
      MCP user/group; Gateway receives that group only through
      `SupplementaryGroups`. Per-request directories are `0710` and staged
      files are `0640`, giving Gateway known-path traverse/read access without
      directory listing or write permission. Preserve cleanup, symlink
      protections, and least privilege; validate the live transfer matrix for
      explicit destinations and default `.inbox` at deployment.
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

### Optional workstation memory

The Mem0 spike has graduated into an optional `pickleshell-memory-mcp` vertical
slice. It remains independently installed and supervised; Gateway startup and
readiness never depend on memory. The package provides stdio transport,
backend authentication, explicit admin versus fixed agent authorization,
content-free auditing, structured errors, and discovery while preserving Mem0
semantics and metadata. Assistant Notebook and associative memory remain
complementary rather than synchronized.

The next memory milestone is an independently reviewed deployment profile for
the sidecar and MCP process, including operator-owned credentials, log
rotation/retention, readiness, rollback, and a clean-host end-to-end test. It
must remain optional and may not weaken agent scope policy.

## Path to a 10/10 agent platform

These are long-term production-hardening milestones. They extend the current
trusted single-operator model without implying that PickleShell already provides
multi-tenant or hostile-agent containment. Promote an item into a release only
after its design, migration, rollback, and end-to-end verification are defined.

### Short-lived workload identity

- Replace long-lived inter-host SSH keys with short-lived SSH certificates or
  an equivalent workload-identity exchange.
- Bind issued credentials to the intended service identity, destination,
  principals, permitted operations, and a narrow lifetime.
- Keep signing authority outside Agent, Browser, Terminal, Gateway, and
  workspace processes; never expose it through MCP tools.
- Test expiry, clock skew, renewal, issuer unavailability, host-key validation,
  and emergency revocation without falling back to a broader credential.

### Capability policy per chat and session

- Evaluate authorization using `chat_id`, `session_id`, tool, workspace, path,
  destination host, runtime, model, and operation class. Default to deny when a
  required policy attribute is absent or unknown.
- Produce an immutable effective-policy snapshot for every request so later
  configuration changes cannot silently broaden an in-flight task.
- Keep workspace, model, host, file-transfer, Terminal, Browser, and privileged
  operation capabilities independently restrictable.
- Add negative end-to-end tests proving that one chat or session cannot reuse
  another chat's workspace, credentials, terminal, browser state, or remote-host
  capability.

### Tamper-evident end-to-end audit trail

- Correlate the ChatGPT/MCP request, tunnel, `chat_id`, `request_id`,
  `session_id`, Gateway action, Agent/Browser/Terminal operation, handoff, and
  remote execution under one trace identifier.
- Record actor, effective policy, decision, timestamps, destination, outcome,
  and redacted command metadata without recording secrets or unrestricted file
  contents.
- Make audit records append-only and tamper-evident through hash chaining,
  signatures, or an external write-once sink with explicit retention policy.
- Verify dropped, duplicated, reordered, and replayed events and make audit
  pipeline failure observable without leaking credentials into fallback logs.

### Approval gates for dangerous operations

- Define explicit operation classes that require operator approval, including
  destructive filesystem actions, privilege escalation, credential changes,
  production deployment, external publication, and policy modification.
- Use single-use approval grants bound to the exact request, arguments,
  destination, approver, and expiration. A textual model claim that approval
  exists is never sufficient.
- Fail closed when approval is absent, expired, mismatched, or cannot be
  verified, and include the decision in the audit trail.
- Test argument substitution, path changes, retries, cancellation, and replay
  after approval consumption.

### Signed task and result handoffs

- Define versioned task/result envelopes containing task ID, request/session
  correlation, source and destination identities, timestamps, content hashes,
  schema version, and declared attachments.
- Sign envelopes with workload identities, verify them before processing, and
  reject unknown signers, altered content, expired tasks, and reused delivery
  identifiers.
- Publish handoffs atomically into a controlled inbox and record a durable
  acknowledgement so retries cannot execute the same task twice.
- Preserve human-readable Markdown payloads while keeping integrity and replay
  metadata machine-verifiable.

### Credential inventory, rotation, and revocation

- Maintain an operator-visible inventory of tunnel keys, Gateway keys, SSH
  identities, provider credentials, signing keys, owners, scopes, creation
  dates, maximum ages, and last-use timestamps.
- Automate rotation with a bounded overlap window and prove that the old
  credential stops working after cutover.
- Provide an emergency revocation procedure that does not require access
  through the credential being revoked.
- Test partial rollout, rollback, stale service processes, and recovery without
  printing secret material.

### Clean external installation and upgrade gate

- Provision an empty disposable Linux host from published artifacts and public
  documentation, without reusing developer homes, caches, credentials, or
  unpublished repository state.
- Exercise ChatGPT plugin registration through the Secure MCP Tunnel and run
  Agent, Browser, Terminal, file-transfer, cancellation, continuation, and
  remote-handoff smoke tests.
- Test immutable upgrade, schema refresh, credential migration, failed
  activation, deterministic rollback, and uninstall/cleanup.
- Treat this external gate as mandatory for a production tag; archive the exact
  release digest and sanitized evidence.

### Continuous security and threat-model verification

- Maintain explicit trust-boundary and data-flow models for the tunnel, MCP
  server, Gateway, runtime adapters, Browser, Terminal, file transfer, and
  inter-host handoff.
- Add adversarial tests for authentication bypass, confused-deputy behavior,
  cross-chat access, request replay, symlink and path races, terminal escape,
  cgroup/process cleanup, output exhaustion, malicious archives, and secret
  disclosure through errors or traces.
- Run dependency, release-provenance, artifact-integrity, and secret-scanning
  checks in CI; pin and verify externally downloaded runtime artifacts.
- Require independent review of changes that modify authentication,
  authorization, process isolation, file publication, credential handling, or
  the public MCP schema.

### 10/10 completion gate

This milestone is complete only when every section above has an implemented
contract, negative tests, operational documentation, recovery procedure, and
evidence from the clean external installation gate. Passing happy-path demos or
documenting a residual risk is not sufficient to mark an item complete.

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
