# Deployment

## Requirements

- Linux with `/proc` mounted;
- Node.js 20 or newer;
- OpenCode installed for a dedicated unprivileged user;
- official OpenAI `tunnel-client`;
- outbound HTTPS access to `api.openai.com:443`.

The default deployment uses one host and no inbound public port.

## Install files

Examples below use:

- service user: `pickleshell`;
- application root: `/opt/pickleshell`;
- runtime configuration: `/etc/pickleshell`.

```bash
sudo useradd --create-home --shell /bin/bash pickleshell
sudo install -d -o pickleshell -g pickleshell /opt/pickleshell
sudo install -d -m 700 -o pickleshell -g pickleshell /etc/pickleshell
sudo git clone https://github.com/pickleshell/pickleshell.git /opt/pickleshell
sudo chown -R pickleshell:pickleshell /opt/pickleshell

sudo -u pickleshell npm --prefix /opt/pickleshell/gateway ci --omit=dev
sudo -u pickleshell npm --prefix /opt/pickleshell/mcp-server ci
sudo -u pickleshell npm --prefix /opt/pickleshell/mcp-server run build
```

Install OpenCode for the `pickleshell` user and verify:

```bash
sudo -u pickleshell -H opencode --version
```

## Configure the Gateway

```bash
sudo install -m 600 -o pickleshell -g pickleshell \
  /opt/pickleshell/gateway/.env.example \
  /etc/pickleshell/gateway.env
sudo install -m 600 -o pickleshell -g pickleshell \
  /opt/pickleshell/gateway/config.example.json \
  /etc/pickleshell/config.json
```

Edit `gateway.env`:

```dotenv
PICKLESHELL_API_KEY=lag_v1_<random-secret>
HOST=127.0.0.1
PORT=18092
CONFIG_PATH=/etc/pickleshell/config.json
MESSAGE_MAX_CHARS=300000
JSON_BODY_LIMIT=5mb
AGENT_TIMEOUT_SEC=300
RATE_LIMIT_MAX=100
```

Edit `config.json` with real workspace paths and the smallest required model
allowlist.

Install the unit:

```bash
sudo cp /opt/pickleshell/gateway/systemd/pickleshell-gateway.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pickleshell-gateway.service
sudo -u pickleshell bash -c \
  'set -a; source /etc/pickleshell/gateway.env; \
   curl -fsS http://127.0.0.1:18092/health -H "Authorization: Bearer $PICKLESHELL_API_KEY"'
```

Tune `MemoryHigh`, `MemoryMax`, and `TasksMax` for the host.

## Configure the MCP runtime

Create `/etc/pickleshell/mcp.env`:

```dotenv
PICKLESHELL_GATEWAY_URL=http://127.0.0.1:18092
PICKLESHELL_API_KEY=lag_v1_<same-secret>
PICKLESHELL_TIMEOUT_MS=420000
MCP_TEMP_DIR=/home/pickleshell/.mcp-temp
```

```bash
sudo chown pickleshell:pickleshell /etc/pickleshell/mcp.env
sudo chmod 600 /etc/pickleshell/mcp.env
```

Store the restricted tunnel control-plane key in
`/etc/pickleshell/control-plane.key`, owned by `pickleshell` with mode `0600`.

Create the tunnel profile using the tunnel ID from the OpenAI Platform:

```bash
sudo -u pickleshell -H tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile pickleshell \
  --tunnel-id "tunnel_..." \
  --mcp-command "node /opt/pickleshell/mcp-server/dist/index.js" \
  --health-listen-addr "127.0.0.1:18093" \
  --control-plane-api-key-ref "file:/etc/pickleshell/control-plane.key"

sudo -u pickleshell -H tunnel-client doctor \
  --profile pickleshell \
  --explain
```

Install the tunnel unit:

```bash
sudo cp /opt/pickleshell/mcp-server/systemd/pickleshell-tunnel.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pickleshell-tunnel.service

curl -fsS http://127.0.0.1:18093/healthz
curl -fsS http://127.0.0.1:18093/readyz
```

Expected responses are `live` and `ready`.

## Smoke test

```bash
cd /opt/pickleshell/gateway
PICKLESHELL_API_KEY=lag_v1_... \
PICKLESHELL_SMOKE_CHAT_ID=pickleshell-main \
PICKLESHELL_RUN_AGENT_SMOKE=1 \
npm run test:smoke
```
