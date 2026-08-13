# PickleShell MCP Server

MCP stdio adapter for the PickleShell Gateway. Exposes two tool families:

- **Local Agent** — `send-chat`, `settings`, `session-status`, `session-output`, `cancel-request`
- **Playwright Browser** — 52 browser automation tools (`browser_navigate`,
  `browser_click`, `browser_snapshot`, `browser_fill`, `browser_screenshot`,
  etc.)

## Configure

The process requires:

```dotenv
PICKLESHELL_GATEWAY_URL=http://127.0.0.1:18092
PICKLESHELL_API_KEY=lag_v1_...
PICKLESHELL_TIMEOUT_MS=420000
MCP_TEMP_DIR=/var/lib/pickleshell/mcp-temp
```

Optional (required for Playwright tools):

```dotenv
PLAYWRIGHT_BROWSERS_PATH=/var/cache/pickleshell/ms-playwright
```

The MCP timeout must exceed the Gateway agent timeout.

The `settings` tool manages instance-global defaults or an optional per-chat
override for `runtime`, `model`, `agent_timeout_sec`, and `codex_transport`. Its
resolution precedence is explicit `send-chat` request > persisted chat override
> persisted global setting > static chat-specific config > static global config
> built-in default. Operator model/runtime allowlists and runtime
capabilities remain immutable hard boundaries. `exec` is the default Codex
transport; `mcp` must be explicitly selected.

The legacy `LOCALAGENT_GATEWAY_URL`, `LOCALAGENT_API_KEY`, and
`LOCALAGENT_TIMEOUT_MS` names remain accepted as deprecated compatibility
aliases. New deployments should use the `PICKLESHELL_*` names.

## Build and test

```bash
npm ci
npm run build
npm test
npm audit --omit=dev
```

Run over stdio:

```bash
node dist/index.js
```

## Playwright browser integration

Playwright tools are loaded at startup via `@playwright/mcp` and bridged
in-process to the PickleShell MCP server using `InMemoryTransport`.

### System requirements

- Chromium revision matching `playwright-core` version (see
  `node_modules/playwright-core/browsers.json`)
- Linux kernel with user namespace cloning enabled
  (`kernel.unprivileged_userns_clone = 1`) or `chromiumSandbox: false`
  in launch options
- Playwright runtime directories writable by the MCP server user:
  - `/run/pickleshell-mcp/playwright-data` — browser profile
  - `/run/pickleshell-mcp/playwright-output` — snapshots, screenshots

### Installing / updating browsers

```bash
PLAYWRIGHT_BROWSERS_PATH=/var/cache/pickleshell/ms-playwright \
  npx playwright install chromium
```

Alternatively, download manually from Google Chrome for Testing and
extract to `$PLAYWRIGHT_BROWSERS_PATH/chromium-<revision>/chrome-linux64/`.

See the root [API reference](../docs/api.md) for the complete tool schema.
