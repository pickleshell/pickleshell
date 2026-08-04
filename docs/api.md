# API Reference

## Identifier terminology

| Identifier | Meaning |
|---|---|
| `chat_id` | Workspace/configuration identifier (maps to a directory on disk) |
| `session_id` | Real OpenCode conversation identifier (`ses_...`), used to continue context |
| `request_id` | Single command execution identifier (`req_...`), returned by send-chat |

Rules:
- `request_id` cannot be used instead of `session_id` (or vice versa);
- for a new command without `session_id`, use `request_id` to track progress;
- after completion, the real `session_id` is read from `session-output`;
- errors clearly indicate which identifier is expected.

## Interface layers

ChatGPT sees MCP tools exposed by the PickleShell plugin. The Gateway HTTP
endpoints are an internal authenticated interface used by the MCP wrapper;
they are not separate ChatGPT tools and must not be exposed publicly.

```text
ChatGPT
  -> MCP tool: send-chat       -> POST /chat -> OpenCode (async)
  -> MCP tool: session-status  -> GET  /status  (lightweight polling)
  -> MCP tool: session-output  -> GET  /output  (full result reading)
  -> MCP tool: cancel-request  -> POST /cancel  (abort in-flight task)
  -> MCP tools: terminal-*     -> Gateway -> private Terminal PTY service

Gateway health check           -> GET  /health
```

Terminal spawn requires the Terminal systemd unit's delegated cgroup-v2
subtree. If delegation or `cgroup.kill` is unavailable, the stable
`terminal_cgroup_unavailable` error is returned; the service never silently
falls back to process-group cleanup.

After an upgrade that adds tools or changes schemas, use **Refresh** if the
updated tools are not visible. ChatGPT may cache tool definitions. A Gateway
endpoint change alone does not require a plugin refresh.

## Async workflow

```
POST /chat { chat_id, message }
  -> { request_id, state: "busy", next_action: "session-status", retry_after_ms: 2000 }

GET /status?request_id=req_...
  -> { state: "busy", progress: [...], next_action: "session-status", retry_after_ms: 2000 }

GET /status?request_id=req_...
  -> { state: "completed", next_action: "session-output", retry_after_ms: 0 }

GET /output?request_id=req_...
  -> { state: "completed", output: { reply, trace, session_id, error }, next_action: null }
```

## Response fields

### next_action

Tells the client which tool to call next:

| State | next_action | Meaning |
|---|---|---|
| `busy` | `"session-status"` | Keep polling |
| `completed` (status) | `"session-output"` | Read the result |
| `completed` (output) | `null` | Done |
| `rejected` (409) | `"session-status"` | Wait and retry |
| `unknown` | `null` | No action |

### retry_after_ms

Suggested polling interval in milliseconds:

| State | retry_after_ms |
|---|---|
| `busy` | 2000 |
| `completed` | 0 |
| `rejected` (409) | 2000 |

### Timestamps (ISO 8601 UTC)

| Field | Meaning | busy | completed |
|---|---|---|---|
| `created_at` | Request accepted by Gateway | present | present |
| `started_at` | OpenCode process launched | null or present | present |
| `completed_at` | Execution finished | null | present |
| `queue_ms` | `started_at - created_at` | null or number | number |
| `execution_ms` | `completed_at - started_at` | null or number | number |

## MCP tool: `send-chat`

Submit a command asynchronously. The response returns immediately with
`request_id` and `state: "busy"`. For a new conversation, `session_id` may be
null until execution completes. After completion, the real runtime
`session_id` appears in the session-output response.

```json
{
  "chat_id": "example-chat",
  "message": "Review the attached file",
  "session_id": "ses_example",
  "runtime": "opencode",
  "model": "opencode/big-pickle",
  "destination_dir": "docs/images",
  "files": [
    {
      "name": "diagram.png",
      "content": "<base64>",
      "mime_type": "image/png",
      "dest_dir": "docs/images",
      "overwrite": false
    }
  ]
}
```

`chat_id` and `message` are required. Other fields are optional. `runtime`
selects `opencode` or `codex` for this request; when omitted, the Gateway uses
the chat runtime and then `default_runtime`. OpenCode remains the default. The
deprecated `agent` field is accepted as a compatibility alias. `model` must be
allowed by the operator and compatible with the selected runtime; Codex model
IDs are unqualified (for example, `gpt-5.3-codex`) rather than provider-prefixed.

File limits: 20 files per request, 2 MiB per file, 10 MiB total.

Destination resolution: `files[].dest_dir` > `destination_dir` > `.inbox/<request-id>/`.

### Response (async)

```json
{
  "ok": true,
  "chat_id": "example-chat",
  "request_id": "req_abc123",
  "session_id": null,
  "state": "busy",
  "next_action": "session-status",
  "retry_after_ms": 2000
}
```

### Error: session busy (409)

```json
{
  "ok": false,
  "state": "rejected",
  "error": "session_busy",
  "current_task": "Build forecast widget",
  "elapsed_s": 42,
  "next_action": "session-status",
  "retry_after_ms": 2000
}
```

## MCP tool: `session-status`

Lightweight status check (no output included). Use `request_id` to track a
specific async execution, or `chat_id` + `session_id` to check a runtime
session.

States: `new_session`, `busy`, `completed`, `ready`, `unknown`.

Poll with the `retry_after_ms` interval from the response.

## MCP tool: `session-output`

Read the full output of a completed task. Provide `request_id` for an async
task, or `chat_id` + `session_id` for a runtime session. Returns the agent's
reply, execution trace, errors, and timestamps. Call after session-status
reports `state: "completed"`.

## MCP tool: `cancel-request`

Cancel an in-flight task by `request_id`. Returns: `cancelled`,
`already_completed`, or `not_found`.

## Terminal lifetime and close reasons

`terminal-close` accepts an optional operator/user-provided reason token. The
token defaults to `client_requested` and must be 1-64 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`. For example, `e2e_complete` is valid; whitespace,
control characters, and arbitrary text are rejected. The value is stored in the
terminal response as `close_reason`.

Gateway, tunnel, or MCP client reconnects do not destroy a PTY. The Terminal
service owns the PTY and its in-memory session, so a client can reconnect and
continue using the same `terminal_id` and output `cursor`. Restarting the
Terminal service is different: it terminates PTY process groups, discards
in-memory sessions and buffered output, and makes old terminal IDs invalid.

## Internal HTTP Gateway

The MCP server sends authenticated requests to the Gateway endpoints. This
interface is for same-host component communication and must not be exposed
publicly.

### POST /chat

Internal request uses `file_paths` (not Base64 `files`).

### GET /status

`?request_id=req_...` — lightweight status by request (no output).
`?chat_id=<id>&session_id=<id>` — lightweight status by session.

### GET /output

`?request_id=req_...` — full output by request.
`?chat_id=<id>&session_id=<id>` — full output by session.

### POST /cancel

Body: `{ "request_id": "req_..." }`. Returns `cancelled`, `already_completed`,
or `not_found`.

### GET /health

Requires Bearer token authentication. Returns service identity, uptime,
configured chat IDs, active work, and concurrency policy.

### Error responses

| Status | Error |
|---|---|
| 400 | `invalid_request`, `invalid_json`, `file_transfer_error`, `runtime_invalid`, `runtime_model_invalid` |
| 401 | `unauthorized` |
| 403 | `forbidden_model`, `runtime_not_allowed` |
| 404 | `unknown_chat_id` |
| 409 | `session_busy` |
| 413 | `payload_too_large` |
| 429 | `rate_limit` |
| 502 | `agent_error` |
| 503 | `runtime_unavailable` |
| 504 | `agent_timeout` |

## Playwright Browser Tools

The same MCP connection also exposes 52 Playwright browser automation tools.
They are registered automatically at startup when `@playwright/mcp` is
installed and a compatible Chromium revision is available.

```text
ChatGPT
  -> MCP tool: browser_navigate
  -> MCP tool: browser_click
  -> MCP tool: browser_fill
  -> MCP tool: browser_snapshot
  -> MCP tool: browser_screenshot
  -> ... 47 more tools
```

The browser tools use an in-process Chromium instance (headless). The browser
is launched lazily on the first tool call. All tools are available in the same
MCP connector — no separate plugin or tunnel is needed.

### Test checklist

After creating a connector with the Playwright tools enabled:

1. `browser_navigate` to a known URL (e.g. `about:blank` or any public site);
2. `browser_snapshot` to capture the page DOM;
3. `browser_screenshot` to capture a visual screenshot;
4. `browser_click` and `browser_fill` to interact with page elements.

### System requirements

- Chromium revision matching the `playwright-core` version
  (`node_modules/playwright-core/browsers.json`)
- Writable runtime directories for browser profile and output
- `chromiumSandbox: false` in launch options when running headless without
  kernel user namespace sandboxing
