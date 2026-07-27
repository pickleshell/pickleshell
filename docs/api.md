# API Reference

## MCP tool: `send-chat`

This is the public PickleShell interface exposed to ChatGPT.

```json
{
  "chat_id": "pickleshell-main",
  "message": "Review the attached file",
  "session_id": "ses_example",
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

`chat_id` and `message` are required. Other fields are optional.

File limits:

- 20 files per request;
- 2 MiB decoded per file;
- 10 MiB decoded total.

Destination resolution:

1. `files[].dest_dir`;
2. request-level `destination_dir`;
3. `.inbox/<request-id>/`.

All destinations are relative to the configured workspace. `overwrite`
defaults to false.

When an explicit session is already active, `send-chat` returns a short
notification containing the current task and elapsed time. It does not queue
the second request.

## Internal HTTP Gateway

The MCP server sends authenticated requests to `POST /chat`. This interface is
for same-host component communication and must not be exposed publicly.

The internal request uses `file_paths`, not Base64 `files`:

```json
{
  "chat_id": "pickleshell-main",
  "message": "Review the delivered file",
  "session_id": "ses_example",
  "model": "opencode/big-pickle",
  "destination_dir": "docs",
  "file_paths": [
    {
      "name": "notes.txt",
      "path": "/home/pickleshell/.mcp-temp/request/notes.txt",
      "mime_type": "text/plain",
      "dest_dir": "docs",
      "overwrite": false
    }
  ]
}
```

Common errors:

| Status | Error |
|---|---|
| 400 | `invalid_request`, `invalid_json`, `file_transfer_error` |
| 401 | `unauthorized` |
| 403 | `forbidden_model` |
| 404 | `unknown_chat_id` |
| 409 | `session_busy` |
| 413 | `payload_too_large` |
| 429 | `rate_limit` |
| 502 | `agent_error` |
| 504 | `agent_timeout` |

`GET /health` requires Bearer token authentication (same as POST /chat) and returns service
identity, uptime, configured chat IDs, active work, and concurrency policy.

`GET /status?chat_id=<id>&session_id=<id>` is an authenticated preflight check for
one session. It returns `state: "ready"` for a free explicit session,
`state: "new_session"` when `session_id` is omitted (the next request creates a
new OpenCode session), `state: "busy"` with the current task and progress while
running, or `state: "completed"` with the buffered reply and trace after the
last command finishes. The completed buffer is cleared when the next command
for that explicit session starts and expires automatically after one hour.
This check is advisory; callers must still handle `409 session_busy` from
`POST /chat` because another request can start between the check and the command.

The MCP `session-output` tool reads this same buffer. Read it after observing
`ready`/`completed` and before sending the next command; sessions without an
explicit `session_id` do not have a readable persistent buffer.
