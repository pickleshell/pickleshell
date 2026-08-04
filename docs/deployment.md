# Deployment

## Requirements

- Linux;
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
sudo install -d -o pickleshell -g pickleshell /srv/pickleshell/workspace
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

## Terminal Runtime

The Terminal runtime is a separate service. The shipped
`terminal/systemd/pickleshell-terminal.service` runs by default as the dedicated,
unprivileged `pickleshell-terminal` user and group. Install `terminal/` with its
lockfile, copy `terminal/config.example.json` to an operator-managed
configuration, and set a random `auth_token` with mode 0600. Configure only
ordinary-profile workspace roots and executable paths.

Build the non-setuid cgroup launcher as part of the Terminal installation:

```bash
sudo -u pickleshell-terminal npm --prefix /opt/pickleshell/terminal ci
sudo -u pickleshell-terminal npm --prefix /opt/pickleshell/terminal run build
```

The unit uses `Delegate=yes` and `ProtectControlGroups=false`. No controller
delegation is required for `cgroup.kill`; do not add unrelated controllers.
Verify the unit and delegated parent without killing any cgroup:

```bash
systemctl show pickleshell-terminal.service -p Delegate -p ControlGroup
CGROUP="/sys/fs/cgroup$(systemctl show pickleshell-terminal.service -p ControlGroup --value)"
test -e "$CGROUP/cgroup.kill"
test -e "$CGROUP/cgroup.events"
grep '^populated ' "$CGROUP/cgroup.events"
find "$CGROUP" -maxdepth 1 -type d -name 'terminal-term_*' -print
```

After an ordinary `terminal-close`, verify the corresponding child directory
is gone and `populated 0` was observed before removal. The launcher joins only
the exact validated child cgroup before `execve`; it never targets the service
parent. A configured sudo-capable or root identity can deliberately escape
cgroup containment, so cgroups provide lifecycle cleanup, not authorization.

If deployment must use an existing account, select it explicitly at install
time. The account and optional group must already exist; the helper validates
names and refuses `root`, grants no memberships or sudo rights, and does not
edit sudoers:

```bash
sudo /opt/pickleshell/terminal/systemd/configure-service-user.sh \
  --user existing-service-user --group existing-service-group
sudo systemctl daemon-reload
sudo systemctl restart pickleshell-terminal.service
```

Omitting `--group` uses the selected account's primary group. Ensure that the
selected group has the required access to the private socket and configured
workspace, and that the Gateway can access the socket. Linux user/group
permissions, sudoers, and systemd are the source of truth: an explicitly
selected account that already has sudo rights will naturally have those rights
in Terminal. The explicit drop-in also disables `NoNewPrivileges` so sudo is not
silently blocked; it grants no privilege itself. PickleShell's executable, path,
environment, input, output, PTY, and process-group safeguards remain
defense-in-depth only. Selecting a privileged account increases the impact of
commands ChatGPT can run.

Install the unit, then verify the private socket is accessible only to the
Gateway service group. Do not deploy to production until the complete test
tunnel and live MCP matrix pass.

The privileged lifecycle integration is opt-in only and must run in a temporary
isolated systemd service, never inside the Gateway/OpenCode worker group:

```bash
PICKLESHELL_RUN_CGROUP_INTEGRATION=1 \
  npm --prefix /opt/pickleshell/terminal run test:cgroup-integration
```

It skips with status 77 unless root and `systemd-run` are available. The runner
covers stale startup cleanup, close, TTL, shutdown, concurrent terminals,
process trees, separate PGIDs, `setsid`, and double-fork manifests using
cgroup-authoritative cleanup.

## Configure the MCP runtime

Create `/etc/pickleshell/mcp.env`:

```dotenv
PICKLESHELL_GATEWAY_URL=http://127.0.0.1:18092
PICKLESHELL_API_KEY=lag_v1_<same-secret>
PICKLESHELL_TIMEOUT_MS=420000
MCP_TEMP_DIR=/var/lib/pickleshell/mcp-temp
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
PICKLESHELL_SMOKE_CHAT_ID=example-chat \
PICKLESHELL_RUN_AGENT_SMOKE=1 \
npm run test:smoke
```
