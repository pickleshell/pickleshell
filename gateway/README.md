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
