# PickleShell Gateway

Authenticated loopback HTTP Gateway that runs OpenCode or Codex for a configured
workspace. This process is an internal component; ChatGPT connects through the
MCP server and Secure MCP Tunnel.

## Configure

```bash
cp .env.example .env
cp config.example.json config.json
```

Generate `PICKLESHELL_API_KEY` with:

```bash
printf 'lag_v1_'
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

Set each workspace in `config.json` and keep the file untracked.

### Runtime configuration

The Gateway validates a runtime per chat and a global default before execution.
OpenCode remains the supported default. The Codex runtime is implemented and
has been verified through the reference test tunnel.

- `default_runtime`: the runtime used when a chat does not specify one.
  Defaults to `opencode` when absent.
- Per-chat `runtime`: selects the runtime for a single chat. The legacy
  per-chat `agent` field (e.g. `"agent": "opencode"`) remains accepted as a
  compatibility alias; the `runtime` field takes precedence when both are set.
- `allowed_runtimes`: policy allowlist for runtimes. Defaults to `["opencode"]`
  when absent.
- `codex.transport`: internal Codex transport selector. It accepts `exec` or
  `mcp` and defaults to `exec`. A chat can override it with
  `chats.<chat_id>.codex.transport`.

Configurations without any of these fields behave exactly as before and resolve
to `opencode`. Selecting a runtime that is not allowed, invalid, or unavailable
on the host is rejected at request time. Selecting an invalid or unavailable
Codex transport is also rejected. The Gateway never silently runs OpenCode or
Codex exec when another runtime or Codex transport was explicitly configured.

The default Codex transport uses `codex exec --json`. The experimental MCP
transport uses `codex mcp-server` over newline-delimited JSON-RPC and currently
requires the Codex `0.143.0` MCP tool surface: `codex` for initial turns and
`codex-reply` for continuations. Initial MCP turns pass `prompt`, `cwd`,
`model`, `approval-policy: "never"`, and `sandbox: "danger-full-access"`.
Continuation turns pass `prompt` and `threadId`; Codex MCP stores the remaining
session configuration with the thread. `structuredContent.threadId` is returned
as PickleShell `session_id`.

The MCP transport keeps ready workers alive for reuse and creates additional
workers for independent concurrent sessions. Cancellation and request timeouts
send MCP cancellation when possible, then recycle the affected worker instead of
reusing a possibly poisoned process.

Set `CODEX_COMMAND` to an explicit executable when Codex is not on `PATH`.
`CODEX_HOME` is passed explicitly to the child after the runtime environment is
filtered; arbitrary secret-bearing environment variables are not inherited.

Example MCP enablement:

```json
{
  "default_runtime": "codex",
  "allowed_runtimes": ["opencode", "codex"],
  "codex": { "transport": "mcp" },
  "chats": {
    "codex-chat": {
      "workspace": "/srv/pickleshell/workspace",
      "runtime": "codex"
    },
    "codex-exec-chat": {
      "workspace": "/srv/pickleshell/workspace",
      "runtime": "codex",
      "codex": { "transport": "exec" }
    }
  }
}
```

`LOCAL_AGENT_API_KEY` remains accepted as a deprecated compatibility alias.
New deployments should use `PICKLESHELL_API_KEY`.

## Run

```bash
npm ci
npm start
```

The safe default is `HOST=127.0.0.1`.

## Test

```bash
npm test

PICKLESHELL_API_KEY=... \
PICKLESHELL_SMOKE_CHAT_ID=example-chat \
npm run test:smoke
```

Set `PICKLESHELL_RUN_AGENT_SMOKE=1` to include a real, non-mutating agent ping.
