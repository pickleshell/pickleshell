# PickleShell Gateway

Authenticated loopback HTTP Gateway that runs OpenCode for a configured
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

### Runtime configuration (preparatory)

The Gateway validates a runtime per chat and a global default before execution.
This is preparatory configuration only: Codex execution is not implemented in
this build, and `config.json` must not select it.

- `default_runtime`: the runtime used when a chat does not specify one.
  Defaults to `opencode` when absent.
- Per-chat `runtime`: selects the runtime for a single chat. The legacy
  per-chat `agent` field (e.g. `"agent": "opencode"`) remains accepted as a
  compatibility alias; the `runtime` field takes precedence when both are set.
- `allowed_runtimes`: policy allowlist for runtimes. Defaults to `["opencode"]`
  when absent.

Configurations without any of these fields behave exactly as before and resolve
to `opencode`. Selecting a runtime that is not allowed, invalid, or not yet
available (such as `codex`) is rejected at request time — the Gateway never
silently runs OpenCode when another runtime was explicitly configured.

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
PICKLESHELL_SMOKE_CHAT_ID=pickleshell-main \
npm run test:smoke
```

Set `PICKLESHELL_RUN_AGENT_SMOKE=1` to include a real, non-mutating agent ping.
