# Terminal PTY Design

Status: design only. This document does not authorize or include runtime,
MCP, package, systemd, or deployment changes.

## Purpose and Scope

Terminal is a persistent interactive terminal for ChatGPT. It is equivalent to
a human terminal window: a client starts one PTY-backed process, writes exact
stdin bytes, reads incremental output, changes the window size, sends selected
signals, and explicitly closes the terminal.

The minimal release includes exactly these MCP tools:

- `terminal-spawn`
- `terminal-write`
- `terminal-output`
- `terminal-resize`
- `terminal-signal`
- `terminal-close`

It does not include recording, collaboration, a web UI, Settings integration,
privilege management, command queues, or one-shot command execution.

The public path remains ChatGPT -> Secure MCP Tunnel -> MCP server ->
authenticated loopback Gateway. The Gateway is not a public endpoint.

## Decisions

### Separate runtime

Use a separate `pickleshell-terminal` runtime process and systemd service. The
MCP server should expose the six tools and call the Gateway; the Gateway should
authenticate, validate ownership and policy, and proxy terminal operations to a
Terminal service over a private Unix-domain socket. The socket is preferable to
another TCP listener: it is local, not routable, and can be permissioned to the
Terminal service user.

The Terminal service owns PTYs, process groups, output buffers, TTL reaping,
and terminal state. The Gateway remains the policy and authentication boundary.
No PTY child is managed by the Agent supervisor. Agent requests are
line-oriented, finite, and request-scoped; terminals are byte-oriented,
long-lived, and interactive.

### PTY implementation

Prefer `node-pty` if it can be installed and supported by the repository's
Node 20 CI and target Linux ABI. It supplies a real pseudoterminal, merged
terminal output, resize handling, and child process-group behavior. Do not add
it merely as an incidental dependency: first prove native build availability
on CI and ACE.

If `node-pty` cannot meet that requirement, use a small reviewed native PTY
helper with a narrow argv/stdin/stdout protocol over a Unix socket. Do not use
`script` as the service implementation; it is useful for host smoke testing
but adds an extra wrapper and makes signal, exit, and process-group ownership
less explicit. In either implementation, the service must use an argv array,
`shell: false` or its native equivalent, a new session/process group, and a
real PTY master.

### `terminal-status` decision

Do not add `terminal-status`. `terminal-output` is the single read operation:
it returns current process state, exit information, timestamps, cursor, and
available output, and it can optionally long-poll. A separate status operation
would duplicate state and encourage races between status and output reads.

## Ownership and Identifiers

`terminal_id` is a cryptographically random, opaque identifier with the form
`term_<base64url>`, maximum 80 characters. It is generated once at spawn and
never reused while the service is running.

Every request carries `chat_id`. The service binds a terminal to the resolved
chat configuration and an owner scope supplied by the authenticated Gateway.
The owner scope is not client-controlled. A terminal is usable only by the
same configured chat and owner scope; cross-chat access returns
`terminal_not_found` rather than revealing that a terminal exists. The initial
owner scope is the local authenticated MCP/Gateway installation, not a
multi-tenant identity system.

The service has no durable session database. Terminal state is in memory and
the PTY process is the authority for liveness. A Terminal service restart
terminates all child process groups and discards all terminal IDs and buffered
output. Clients must spawn a new terminal after `service_restarted` or
`terminal_not_found`; terminal IDs must never be silently resurrected.

## State Machine and Lifecycle

The externally visible states are:

```text
starting -> running -> exited
starting -> failed
running -> closing -> closed
running -> closed       (service shutdown/reaper after process termination)
exited -> closed        (explicit close or retention cleanup)
```

`starting` is brief and can be returned by output. `running` means the child
has not exited. `exited` is terminal-process completion and includes `exit_code`
or `signal`. `closing` means close has begun and the process group is being
terminated. `closed` means no future input is accepted and resources are
released. `failed` means spawn or PTY setup failed and has no process.

`terminal-close` is explicit and idempotent. If the child has already exited,
it records the exit and releases resources, returning `already_closed` only on
subsequent calls. Close sends SIGHUP to the process group, waits a configured
short grace period, sends SIGTERM, then SIGKILL if required. The response is
not successful until the child and its process group have been reaped.

The service also reaps abandoned terminals after an operator-configured TTL
(default 30 minutes, bounds 60 seconds to 24 hours). Any successful operation
refreshes `last_activity_at`; `terminal-output` long-polling refreshes only
when it returns data or observes a state change. A reaper closes the process
group and marks the terminal `closed` with reason `ttl_expired`.

An MCP connection disappearing cannot reliably be inferred from a tool call.
There is therefore no unsafe immediate kill on disconnect; the TTL is the
automatic disconnect cleanup mechanism. A future transport-level lease is out
of scope.

The service enforces a small global limit, default 8 concurrent terminals,
configurable between 1 and 32. `terminal-spawn` over the limit returns
`terminal_limit`. There is no queue.

## Byte and Output Semantics

PTY output is one merged stream, as seen by a human terminal. stdout and
stderr are not separately recoverable. The service reads raw bytes from the
PTY master and appends them to a bounded ring buffer (default 1 MiB, maximum
16 MiB). It never decodes, normalizes, trims, or line-buffers the stream.

The cursor is a monotonically increasing byte offset, not a character count.
`cursor` is the exclusive end offset of data already consumed. The first
cursor is `0`; a returned chunk covers `[cursor, next_cursor)`. Data is encoded
as standard Base64 in JSON, so arbitrary terminal bytes and control sequences
are preserved. A UTF-8 character split across two PTY reads is legal. Clients
must concatenate decoded bytes before UTF-8 decoding; replacement characters
must not be introduced by the service.

Each retained output record also has a monotonic `sequence` number, starting
at 1, for diagnostics and ordering. Cursor offsets are authoritative. A
record may contain a partial UTF-8 sequence and records do not imply lines.

When the ring evicts old bytes, `truncated` becomes true and
`oldest_cursor` advances. If a request's cursor is below `oldest_cursor`, the
response returns the currently retained bytes from `oldest_cursor`, sets
`next_cursor` to their end, and includes `truncated_from` equal to the
requested cursor. The client must report or otherwise accept the lost prefix,
then continue from `next_cursor`; retrying the old cursor will repeat the same
truncation response. The service never pretends missing bytes were delivered.

Repeated `terminal-output` calls with the same cursor are safe and return the
same currently retained bytes unless the buffer has changed. They do not
advance server-side reader state. Multiple clients in the same owner scope
therefore see the same stream and must maintain independent cursors.

Long polling is optional per request: `wait_ms` defaults to 0 and is bounded
to 30,000 ms. A request waits until bytes, a state change, or the timeout. A
timeout with no event returns an empty chunk, unchanged cursor, and
`timed_out: true`; it is not an error and does not extend the process lifetime.

## Exact MCP Schemas

The MCP tools use the following JSON request and response shapes. Types use
JSON notation: `string`, `integer`, `boolean`, `object`, `array`, and `null`.
All timestamps are ISO 8601 UTC strings with millisecond precision.

### `terminal-spawn`

Request:

```json
{
  "chat_id": "string, required, 1-128 characters",
  "executable": "string, optional, configured executable allowlist; default /bin/bash",
  "argv": "string[], optional, 0-32 items, each 0-4096 bytes; default [\"--noprofile\",\"--norc\",\"-i\"]",
  "cwd": "string, optional, relative path under an allowed root; default configured workspace root",
  "env": "object<string,string>, optional, at most 32 allowlisted keys",
  "cols": "integer, optional, 1-500; default 80",
  "rows": "integer, optional, 1-200; default 24",
  "idempotency_key": "string, optional, 1-128 characters"
}
```

`argv` excludes `argv[0]`; the service constructs the child argv from the
validated executable and this array. No field is interpolated into a shell
command. `cwd` is validated before spawning. `env` values are bounded and
merged with a sanitized profile environment; callers cannot pass secrets or
replace the complete environment.

Response (`201`):

```json
{
  "ok": true,
  "terminal_id": "term_abc123",
  "chat_id": "chat-main",
  "state": "running",
  "created_at": "2026-08-02T12:00:00.000Z",
  "started_at": "2026-08-02T12:00:00.012Z",
  "last_activity_at": "2026-08-02T12:00:00.012Z",
  "cursor": 0,
  "oldest_cursor": 0,
  "cols": 80,
  "rows": 24,
  "expires_at": "2026-08-02T12:30:00.012Z"
}
```

An identical `idempotency_key` with the same normalized spawn parameters
returns the original response with `idempotent: true`. Reuse with different
parameters returns `idempotency_conflict`. Without a key, every spawn creates
a new terminal.

### `terminal-write`

Request:

```json
{
  "chat_id": "string, required",
  "terminal_id": "string, required, term_ identifier",
  "data": "string, required, Base64 of 1-65536 bytes",
  "idempotency_key": "string, optional, 1-128 characters"
}
```

The decoded bytes are written exactly as provided. No newline is added. An
explicit `\n` or control byte must be included by the client when wanted.

Response (`200`):

```json
{
  "ok": true,
  "terminal_id": "term_abc123",
  "state": "running",
  "bytes_written": 7,
  "last_activity_at": "2026-08-02T12:00:04.000Z"
}
```

Writes are deliberately not idempotent: retrying can duplicate input. A
provided write idempotency key is rejected with `idempotency_unsupported`,
unless a later implementation defines durable byte-operation deduplication.
Writes to `exited`, `closing`, or `closed` return `terminal_not_writable`.

### `terminal-output`

Request:

```json
{
  "chat_id": "string, required",
  "terminal_id": "string, required",
  "cursor": "integer, optional, 0-9223372036854775807; default 0",
  "max_bytes": "integer, optional, 1-65536; default 16384",
  "wait_ms": "integer, optional, 0-30000; default 0"
}
```

Response (`200`):

```json
{
  "ok": true,
  "terminal_id": "term_abc123",
  "state": "running",
  "data": "b3B0aW9uJDE=",
  "encoding": "base64",
  "bytes": 8,
  "cursor": 0,
  "next_cursor": 8,
  "oldest_cursor": 0,
  "sequence_start": 1,
  "sequence_end": 1,
  "truncated": false,
  "truncated_from": null,
  "timed_out": false,
  "exit_code": null,
  "exit_signal": null,
  "close_reason": null,
  "created_at": "2026-08-02T12:00:00.000Z",
  "started_at": "2026-08-02T12:00:00.012Z",
  "exited_at": null,
  "closed_at": null,
  "last_activity_at": "2026-08-02T12:00:04.000Z"
}
```

The response always includes state and exit fields, even with no data. For an
empty timeout, `next_cursor` equals the request cursor. For a failed or
unknown terminal, no output cursor is fabricated. `terminal-output` is also
the supported way to learn normal exit and non-zero exit information.

### `terminal-resize`

Request:

```json
{
  "chat_id": "string, required",
  "terminal_id": "string, required",
  "cols": "integer, required, 1-500",
  "rows": "integer, required, 1-200"
}
```

Response (`200`):

```json
{
  "ok": true,
  "terminal_id": "term_abc123",
  "state": "running",
  "cols": 120,
  "rows": 40,
  "last_activity_at": "2026-08-02T12:00:05.000Z"
}
```

Resize uses the PTY window-size ioctl and does not send input. Repeating the
same resize is harmless; no idempotency key is needed. Resize after exit is
accepted only as a no-op response while retained metadata exists, and resize
after close returns `terminal_closed`.

### `terminal-signal`

Request:

```json
{
  "chat_id": "string, required",
  "terminal_id": "string, required",
  "signal": "string, required, one of SIGINT, SIGTERM, SIGHUP, SIGTSTP, SIGCONT"
}
```

Response (`200`):

```json
{
  "ok": true,
  "terminal_id": "term_abc123",
  "state": "running",
  "signal": "SIGINT",
  "last_activity_at": "2026-08-02T12:00:06.000Z"
}
```

The allowlist is intentionally small. Signals are sent to the terminal's
process group, not an arbitrary PID. `SIGKILL`, `SIGSTOP`, arbitrary numeric
signals, and signals that could not be safely scoped are not exposed. Signal
delivery is best effort: a successful response means it was requested for the
group, not that the process has already exited. Read output for the resulting
state. Repeating a signal is harmless at the API level but is not declared
idempotent.

### `terminal-close`

Request:

```json
{
  "chat_id": "string, required",
  "terminal_id": "string, required",
  "reason": "string, optional, 1-64 characters"
}
```

Response (`200`):

```json
{
  "ok": true,
  "terminal_id": "term_abc123",
  "state": "closed",
  "close_reason": "client_requested",
  "exit_code": 0,
  "exit_signal": null,
  "exited_at": "2026-08-02T12:00:08.000Z",
  "closed_at": "2026-08-02T12:00:08.030Z"
}
```

The service ignores client text that attempts to select a privileged reason.
Allowed reasons are `client_requested`, `ttl_expired`, `service_shutdown`,
and `process_exited`; unknown reasons are `invalid_request`. A repeated close
returns `200` with `ok: true`, `state: "closed"`, and `already_closed: true`.

## Errors and Transport Mapping

The MCP adapter returns a JSON error object in an MCP tool result with
`isError: true`. The same object is used by the authenticated internal HTTP
Gateway. `details` is short, stable, and never contains environment values,
credentials, command output, or arbitrary request text.

| HTTP | Error code | Meaning |
|---:|---|---|
| 400 | `invalid_request` | Missing, malformed, out-of-range, or invalid Base64 field |
| 400 | `invalid_working_directory` | `cwd` is outside an allowed root or fails symlink-safe validation |
| 400 | `executable_not_allowed` | Executable is not in the configured profile allowlist |
| 400 | `environment_not_allowed` | Environment key/value violates the profile allowlist or limit |
| 400 | `signal_not_allowed` | Signal is outside the explicit allowlist |
| 401 | `unauthorized` | Gateway authentication failed |
| 403 | `terminal_forbidden` | Authenticated owner scope cannot use this terminal |
| 404 | `terminal_not_found` | Unknown, expired, restarted, or foreign terminal ID |
| 409 | `idempotency_conflict` | Same spawn key has different parameters |
| 409 | `terminal_not_writable` | Process is exited, closing, or closed |
| 409 | `terminal_closed` | Operation cannot apply to a closed terminal |
| 409 | `idempotency_unsupported` | A non-idempotent operation was given a key |
| 413 | `input_too_large` | Decoded write exceeds 64 KiB |
| 413 | `output_limit` | Configured output buffer or requested maximum exceeds policy |
| 429 | `terminal_limit` | Concurrent terminal limit reached |
| 502 | `terminal_spawn_failed` | PTY or executable spawn failed; safe error only |
| 503 | `terminal_unavailable` | Gateway cannot reach the Terminal service |
| 500 | `internal_error` | Unexpected service failure; no raw internals returned |

HTTP status is an internal mapping, not a replacement for the stable error
code. MCP callers should branch on `error`, not on prose or HTTP wording.

## Security and Isolation

- Run the Terminal service as a dedicated unprivileged `pickleshell-terminal`
  user, separate from the tunnel user and preferably separate from the Agent
  user. It must not have sudo, production credentials, SSH agent sockets,
  private keys, or unrelated repositories.
- Use a separate systemd unit with `NoNewPrivileges=true`, `PrivateDevices=true`,
  `ProtectSystem=strict`, restricted `ProtectHome`, `RestrictSUIDSGID`,
  `RestrictNamespaces`, `ProtectProc`, `ProcSubset=pid`, bounded `TasksMax`,
  bounded memory, a private runtime directory, and only the required
  `AF_UNIX`/local address families. The exact unit is an implementation and
  deployment change, not part of this design-only task.
- Keep the Terminal HTTP-facing Gateway on loopback. Authenticate each
  Gateway request with the existing bearer-token mechanism; authenticate the
  Gateway-to-service socket by filesystem ownership and a short internal
  protocol, with no public listener.
- Ordinary profile is the only enabled profile in the minimal release. It
  permits configured unprivileged executables and configured workspace roots.
  A privileged profile is only a named policy boundary for future review and
  is not enabled, selectable, or silently substituted.
- Validate `cwd` relative to an allowed configured root using directory file
  descriptors, `O_DIRECTORY|O_NOFOLLOW`, and component-by-component checks.
  Reject symlink components, absolute paths, `..`, missing directories, and
  paths outside the root. Do not rely on string prefix checks.
- Represent executable and argv separately internally and spawn without a
  shell. Never concatenate request fields into a command or shell script.
- Build a runtime-specific environment from a fixed allowlist. At minimum,
  permit safe locale, terminal, path, home, temporary, XDG, and configured
  proxy variables only when explicitly approved. Reject API keys, tunnel keys,
  service tokens, `.env` values, and arbitrary inherited variables. Set
  `TERM` to a configured terminal type such as `xterm-256color` rather than
  accepting it from the request.
- Bound executable length, argv count and item size, environment count and
  value size, input writes, output retention, terminal count, and TTL. The
  PTY process group is always terminated during close, TTL expiry, restart,
  and service shutdown.
- Never log input bytes, output bytes, environment values, cwd, full argv, or
  production paths. Logs may include terminal ID, chat ID only if policy
  permits, state transition, byte counts, safe exit code, and error code.

## Storage, Restart, and Concurrency

The service stores a bounded in-memory record per terminal: owner binding,
validated cwd/profile metadata, PTY handle, process-group identity, state,
timestamps, dimensions, exit information, cursor bounds, and the output ring.
It stores no terminal transcript on disk. Buffer eviction is observable only
through the truncation fields in `terminal-output`.

Spawn, state transitions, ring append/eviction, and close are serialized per
terminal. Independent terminals run concurrently up to the configured global
limit. Output reads do not consume bytes and therefore do not need a reader
lock beyond a consistent snapshot.

On service stop, stop accepting new requests, close all process groups, wait
for child reaping, then exit. On unexpected restart, systemd restarts the
service but no session recovery is attempted. The Gateway maps a missing
socket to `terminal_unavailable`; after the service is back, old IDs remain
invalid. This is intentionally simpler and safer than persisting live PTYs.

## Tests

### Unit

- Validate identifiers, field bounds, Base64, argv separation, signal allowlist,
  profile environment allowlist, and safe cwd resolution.
- Exercise byte cursors, repeated reads, empty reads, `max_bytes`, UTF-8 split
  across chunks, control bytes, ring eviction, `oldest_cursor`, and exact
  truncation recovery metadata.
- Test every state transition, timestamps, close idempotency, unsupported
  write idempotency, spawn idempotency conflicts, and bounded TTL calculations.
- Test process-group signal escalation and that child/grandchild PIDs are
  reaped, including failure paths.

### Integration

- Spawn `/bin/bash` in a temporary allowed workspace and verify prompt input,
  exact bytes, incremental output, no implicit newline, normal exit, and
  non-zero exit.
- Run an interactive prompt that waits for input; verify output appears in
  multiple reads and that a read can long-poll until output arrives.
- Resize and run a program that reports terminal dimensions.
- Send SIGINT to a foreground command and verify interrupt behavior; verify
  close sends group termination and leaves no orphan.
- Force TTL expiry, output truncation, concurrent spawns over and under the
  configured limit, and service restart with old ID rejection.
- Reject invalid cwd, absolute/parent traversal, symlink traversal,
  disallowed executable, disallowed environment, oversized input, and unsafe
  signal.
- Run under the systemd sandbox and verify the service user cannot read
  configured Gateway/tunnel secrets or unrelated paths.

### E2E

- Register all six MCP tools through the MCP server and exercise a normal
  shell, interactive prompt, incremental output, resize, Ctrl-C, normal exit,
  non-zero exit, explicit close, and repeated output cursors from ChatGPT.
- Verify MCP error objects preserve stable error codes and do not expose
  credentials or raw command output.
- Verify two terminals are independent, the ownership boundary rejects a
  different `chat_id`, and a service restart requires a fresh spawn.
- Repeat the same scenarios through an ACE test tunnel before any BOS
  production deployment.

## Deployment Sequence

1. Implement the Terminal service, Gateway adapter/routes, MCP schemas, limits,
   and tests in small reviewable changes; add CI coverage for the PTY backend
   and native build prerequisites.
2. Deploy the implementation to the ACE test tunnel only, using a dedicated
   unprivileged test profile and no production credentials. Verify the service
   unit sandbox and the complete MCP contract.
3. Run real ChatGPT interaction tests through ACE, including incremental
   output, prompt input, resize, Ctrl-C, close, TTL, truncation, restart, and
   concurrent terminals.
4. Fix findings on ACE and repeat the full test matrix. Do not infer success
   from local tests alone.
5. Only after ACE verification is clean, deploy to BOS production with an
   operator-reviewed limit/profile configuration and a rollback plan.

## Inspected Evidence and Open Questions

The canonical repository is clean at `origin/main`. Existing contracts use an
authenticated loopback Gateway, Secure MCP Tunnel, configured chat workspaces,
bounded concurrency, and detached process groups for finite Agent requests.
The existing Agent environment allowlist and systemd isolation are useful
precedents, but are not copied blindly because Terminal needs PTY-specific
state and byte semantics.

On BOS, read-only checks found Linux x86_64, Node `20.20.2`, npm `10.8.2`,
systemd `255`, `/dev/ptmx`, and `/usr/bin/script`, `/usr/bin/setsid`, and
`/usr/bin/stty`. The active Gateway runs as `pickleshell` with 256 tasks and a
4 GiB memory maximum; the active tunnel runs as `pickleshell-tunnel` with 128
tasks and a 1 GiB memory maximum. Both units report the documented systemd
hardening properties.

ACE is not independently verified. The configured SSH host alias resolves to
`ace`, but the read-only connection probe was blocked by SSH host-key
verification before remote facts could be collected. No SSH configuration or
access was changed. ACE verification is therefore a required pre-deployment
checklist item, not a blocker for this contract: confirm Node ABI, PTY backend
availability, service users, systemd restrictions, allowed roots, and the
full test tunnel before deployment.

Genuinely blocking questions for implementation are limited to operator
configuration choices: the final allowed workspace roots/executable allowlist,
the production terminal count and memory limits, and whether CI/ACE can build
the selected `node-pty` version. None changes the protocol above.

## Implementation Phases

1. Add policy/config validation and pure cursor, ring-buffer, error, and state
   modules with unit tests.
2. Add the isolated PTY service with argv spawning, environment construction,
   cwd validation, process-group cleanup, resize, signals, TTL, and integration
   tests.
3. Add the authenticated Gateway Unix-socket adapter and six internal routes,
   preserving the existing Agent and Browser paths and adding concurrency
   limits without a queue.
4. Add the six MCP tools and exact schemas, errors, examples, and MCP client
   tests; verify the generated tool surface through the tunnel.
5. Add systemd/CI/deployment changes in a separate implementation review, run
   ACE tests and real ChatGPT tests, fix ACE, then perform the BOS release gate.
