# PickleShell MCP Server

MCP stdio adapter for the PickleShell Gateway. It exposes one tool:
`send-chat`.

## Configure

The process requires:

```dotenv
PICKLESHELL_GATEWAY_URL=http://127.0.0.1:18092
PICKLESHELL_API_KEY=lag_v1_...
PICKLESHELL_TIMEOUT_MS=420000
MCP_TEMP_DIR=/home/pickleshell/.mcp-temp
```

The MCP timeout must exceed the Gateway agent timeout.

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

See the root [API reference](../docs/api.md) for the complete tool schema.
