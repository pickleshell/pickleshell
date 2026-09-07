# Deployment

## Requirements

- Linux;
- Node.js 20 or newer;
- OpenCode installed for a dedicated unprivileged user;
- official OpenAI `tunnel-client`;
- outbound HTTPS access to `api.openai.com:443`.

The default deployment uses one host and no inbound public port.

## Immutable releases

Use `deploy/release.sh` for upgrades. Run it from a clean checkout as the
deployment owner, supplying the exact commit and the host's existing component
users. It creates `releases/<full-sha>`, installs dependencies and builds
Gateway, MCP, and Terminal with Node 20 or newer, then atomically updates
`active`. The script never copies `/etc/operator` configuration, service homes,
caches, workspaces, tunnel/plugin profiles, runtime files, or other operator
state into a release. Existing mutable component directories are left in place
on the first migration and are not used after `active` is installed.

```bash
sudo /path/to/checkout/deploy/release.sh \
  --source /path/to/clean/checkout \
  --root /opt/pickleshell \
  --commit <full-git-sha> \
  --gateway-user gateway-service \
  --mcp-user tunnel-service \
  --terminal-user terminal-service
```

The shipped Gateway and MCP units execute from `active`; Terminal unit changes
are opt-in with `--include-terminal`. This keeps a separately managed Terminal
profile or ChatGPT terminal runtime explicitly untouched. The script restarts
only Gateway then MCP, and includes Terminal in that sequence only when opted
in. It records the previous target in `state/previous-target` and restores it
automatically if activation, service restart, or readiness verification fails.
Use `--rollback` to repeat the recorded rollback. `--dry-run` validates inputs
without staging, and `--no-systemd --root <temporary-root>` supports isolated
tests without host systemd. Do not pass production paths to an isolated test.

For an isolated systemd rehearsal, use the built-in `isolated` profile. It
renders every selected unit with the dedicated test roots, users, runtime
directories, executable paths, and service dependency; the three test users
and groups must already exist. Use a fake or temporary systemctl contour and
keep the units directory separate from `/etc/systemd/system`:

```bash
deploy/release.sh \
  --source /path/to/clean/checkout \
  --profile isolated \
  --root /opt/pickleshell-test \
  --commit <full-git-sha> \
  --include-terminal \
  --systemctl /path/to/fake-systemctl \
  --units-dir /tmp/pickleshell-test-units
```

The isolated profile uses `/opt/pickleshell-test`, `/etc/pickleshell-test`,
`/var/lib/pickleshell-test`, `/var/cache/pickleshell-test`,
`/srv/pickleshell-test/workspace`, `/run/pickleshell-test-mcp`, and
`/run/pickleshell-test-terminal/service.sock`, with `pickleshell-test`,
`pickleshell-test-tunnel`, and `pickleshell-test-terminal` identities and
`pickleshell-test-gateway.service` as the MCP dependency. Remove
`--no-systemd` for a rehearsal using the supplied fake systemctl. Service
names must be distinct safe `.service` basenames. The profile refuses paths
outside its dedicated prefixes and never selects the production or separately
managed ChatGPT terminal units.

The script refuses dirty source, unresolved or mismatched commits, missing
files/users, unsafe roots or symlinks, incomplete builds, and invalid rollback
targets. It does not print environment files, credentials, profiles, or other
secret contents. Backups of replaced unit files are kept under the deployment
state directory before `daemon-reload`.

The optional Memory deployment stages its repository-owned Python Mem0 backend
and pinned dependency lock inside the independent Memory release. Its managed
launcher is transactionally installed at
`/usr/local/bin/pickleshell-memory-backend`; Gateway does not depend on it.
Production Memory uses an authenticated backend on loopback port 8766 and a
separate fixed-scope credential broker on loopback port 8767. Only explicitly
wired Codex MCP clients connect to the broker. Shared/admin
MCP keeps the authenticated 8766 backend and bearer auth. The distinct broker
service reads a systemd credential projected from operator-only `0600`
`backend.env`, rejects client authorization, and injects the configured fixed `user_id`.
The backend uses `/var/lib/pickleshell-memory/backend` as its persistence root. Port 8765 and any older host-specific
spike data remain outside this lifecycle. Review
`pickleshell-memory-backend/README.md` and
`pickleshell-memory-mcp/README.md` before provisioning.

### Immutable migration notes

- Back up operator-managed unit files, environment files, and tunnel profiles
  separately before the first immutable activation. The release tree excludes
  operator state by design.
- The ordinary tunnel profile's MCP command must resolve through
  `ROOT/active/mcp-server/dist/index.js`, not a mutable component directory.
- Release builds run `npm` for each component as that component's service user
  with an isolated writable `HOME`, `TMPDIR`, and `NPM_CONFIG_CACHE`; these
  build-only directories are removed before final root-owned read-only
  hardening.
- Before restarting services, the installer creates every cache, state, and
  runtime path referenced by the rendered units, including browser/MCP cache
  paths and private runtime bind targets.
- Terminal keeps `ProtectHome=true`. When the configured workspace source is
  under a protected home, the installer grants the terminal service user access
  with user-specific ACLs and binds that source read-write at
  `TERMINAL_RUNTIME_DIR/workspace`. `setfacl` and `getfacl` are required; the
  release fails closed if they are unavailable.
- First immutable activation has no recorded immutable previous target, so keep
  the ordinary unit/profile backup for manual rollback. Later activations use
  the recorded `state/previous-target` rollback.

Use the deployment owner for repository operations. Avoid ad hoc recursive ACL
repairs outside the release installer; if ownership drifts, repair the specific
files or directories instead. For any remote maintenance, verify the SSH
identity, host key policy, target account, and authorized sudo route before
changing services. Never print credential contents, private keys, tunnel
profiles, or secret-bearing environment files.

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

sudo -u pickleshell env PATH=/opt/pickleshell/runtime/node-v20.20.2/bin:$PATH \
  npm --prefix /opt/pickleshell/gateway ci --omit=dev
sudo -u pickleshell env PATH=/opt/pickleshell/runtime/node-v20.20.2/bin:$PATH \
  npm --prefix /opt/pickleshell/mcp-server ci
sudo -u pickleshell env PATH=/opt/pickleshell/runtime/node-v20.20.2/bin:$PATH \
  npm --prefix /opt/pickleshell/mcp-server run build
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
SETTINGS_PATH=/var/lib/pickleshell-settings/settings.json
MESSAGE_MAX_CHARS=300000
JSON_BODY_LIMIT=5mb
AGENT_TIMEOUT_SEC=300
RATE_LIMIT_MAX=100
```

Edit `config.json` with real workspace paths and the smallest required model
allowlist.

The Gateway unit provisions `/var/lib/pickleshell-settings` as a mode `0700` systemd
state directory owned by the Gateway service and grants the service write
access there for the separate `settings.json` store. The store is never written
to `config.json`; do not grant other services access to it.

OpenCode and Codex resolve credentials from the Gateway service environment,
not from an interactive shell. Keep the unit-level `HOME`, `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `OPENCODE_CONFIG_DIR`, and
`CODEX_HOME` values explicit. Verify OpenCode with a non-mutating exact `PONG`
through the Gateway. Verify Codex with `codex doctor` and an exact `PONG` as the
OS user that will run DevOps tasks; auth/config files must be owned by that user
and mode `0600`. If a model requires a newer CLI, upgrade the CLI before
retrying the smoke test.

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

Keep ordinary Terminal isolation separate from any privileged DevOps account. Do
not disable `NoNewPrivileges` or give the ordinary Terminal service sudo just to
perform host administration; use a separate, explicitly authorized DevOps route
for that work.

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

File transfer uses this directory as a one-way handoff between the MCP/tunnel
service and Gateway. The release installer owns it as
`pickleshell-tunnel:pickleshell-tunnel` with mode `0710`; Gateway receives that
group only as a systemd supplementary group. Each request directory is `0710`
and each staged file is `0640`, so Gateway can traverse and read a known staged
path but cannot list, create, replace, or delete MCP staging files. Do not
change these modes to world-readable or grant Gateway write access.

On a host with the deployed service accounts, run the optional real-identity
handoff test after an installation or unit change:

```bash
sudo env PICKLESHELL_RUN_FILE_HANDOFF_INTEGRATION=1 \
  bash /path/to/clean/checkout/test/file-transfer-handoff.test.sh
```

It verifies both default `.inbox` and explicit destinations, confirms that
Gateway can read a known staged file, and confirms it cannot list or modify the
MCP staging root.

The `chatgpt` deployment profile keeps its tunnel control-plane credential in
`/etc/pickleshell/tunnel-client/control-plane.key`, owned by `root` and readable
only by the dedicated `pickleshell-chatgpt-tunnel` group. Do not point that
profile back to a key under `/home/chatgpt`.

```bash
sudo chown pickleshell-tunnel:pickleshell-tunnel /etc/pickleshell/mcp.env
sudo chmod 600 /etc/pickleshell/mcp.env
```

Store the restricted tunnel control-plane key in
`/etc/pickleshell/control-plane.key`, owned by the OS user that runs the tunnel
service (`pickleshell-tunnel` in the shipped unit) with mode `0600`.

Install the Chromium revision that matches the deployed MCP package. Run the
install with the same `PLAYWRIGHT_BROWSERS_PATH` used by the tunnel service,
and repeat it after Playwright package upgrades:

```bash
sudo install -d -m 700 -o pickleshell-tunnel -g pickleshell-tunnel \
  /var/lib/pickleshell/mcp-home \
  /var/cache/pickleshell/mcp \
  /var/cache/pickleshell/ms-playwright
sudo -u pickleshell-tunnel -H env \
  HOME=/var/lib/pickleshell/mcp-home \
  XDG_CACHE_HOME=/var/cache/pickleshell/mcp \
  PLAYWRIGHT_BROWSERS_PATH=/var/cache/pickleshell/ms-playwright \
  PATH=/opt/pickleshell/runtime/node-v20.20.2/bin:$PATH \
  npm --prefix /opt/pickleshell/mcp-server exec -- playwright install chromium
```

The tunnel unit must expose the same stable `HOME`, `XDG_CACHE_HOME`, and
`PLAYWRIGHT_BROWSERS_PATH` values, with writable paths for MCP runtime state.

Create the tunnel profile using the tunnel ID from the OpenAI Platform:

```bash
sudo -u pickleshell-tunnel -H tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile pickleshell \
  --tunnel-id "tunnel_..." \
  --mcp-command "node /path/to/pickleshell/mcp-server/dist/index.js" \
  --health-listen-addr "127.0.0.1:18093" \
  --control-plane-api-key-ref "file:/etc/pickleshell/control-plane.key"

sudo -u pickleshell-tunnel -H tunnel-client doctor \
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

### Multiple instances on one host

The default deployment assumes one PickleShell MCP runtime per host and uses
`/run/pickleshell-mcp`. An additional isolated test or multi-instance deployment
must give each instance a separate runtime directory and map it into the default
MCP path inside that tunnel service's private mount namespace. For example:

```systemd
RuntimeDirectory=pickleshell-test-mcp
RuntimeDirectoryMode=0700
BindPaths=/run/pickleshell-test-mcp:/run/pickleshell-mcp
```

Do not share the runtime directory between instances. Keep their users, ports,
configuration, caches, state directories, and systemd units separate as well.

Terminal keeps `ProtectHome=true`. For a workspace source below a protected
home, the release unit binds the configured host workspace read-write to a
private path below the terminal runtime directory and sets
`PICKLESHELL_TERMINAL_ROOT_OVERRIDE` to that private path. When this override is
set, it replaces all configured terminal roots instead of adding another root,
so service policy never has to traverse the protected host home path.

After any unit or drop-in change, back up the affected files, run
`systemctl daemon-reload`, restart only the changed service, and verify:

```bash
systemctl is-active pickleshell-gateway.service pickleshell-terminal.service pickleshell-tunnel.service
systemctl show pickleshell-gateway.service pickleshell-terminal.service pickleshell-tunnel.service -p NRestarts
curl -fsS http://127.0.0.1:18093/healthz
curl -fsS http://127.0.0.1:18093/readyz
```

Also run end-to-end checks through the deployed path or exact service-user
equivalent: Agent exact `PONG`, Browser navigate/snapshot, and Terminal
spawn/write/output/close. If the ChatGPT plugin still shows stale tools after a
tunnel restart or schema upgrade, refresh the plugin registration in ChatGPT and
start a new conversation.

## Optional memory profile

Authenticated multi-principal Memory uses one broker endpoint, per-principal
credentials, and explicit private/shared policies. See [the principal deployment
and rollback contract](memory-principals.md) before adding `--broker-policy`.
The historical single-principal configuration remains a compatibility mode.

The optional memory sidecar and Memory MCP are deployed independently with
`deploy/memory-release.sh`; they are not inputs to Gateway, tunnel, Browser, or
Terminal startup/readiness. Follow the complete configuration, credential,
audit-retention, readiness, upgrade, and rollback contract in
`pickleshell-memory-mcp/README.md`. Shared/admin identities launching the installed MCP
wrapper need its dedicated service group to read `mcp.env`. Audit writers use
a separate audit group for the managed `0660` file inside its `0750` directory.
Codex gets audit access and explicit tokenless 8767 wiring only; never grant it
the admin config group or read access to `backend.env`. Do not add memory
dependencies to the core release units. Validate changes without privileges or host writes with:

```bash
npm run test:memory-deployment
```

This isolated test deliberately proves the core Gateway tree and services are
neither staged nor required.

## Upgrade checklist

1. Read the live unit state with `systemctl show` for `ExecStart`, `User`,
   `Environment`, `WorkingDirectory`, and `NRestarts`.
2. Confirm the Node executable and installed Gateway/MCP package paths used by
   the service.
3. Back up affected unit files, drop-ins, and operator configs without copying
   secrets into logs.
4. Run package installs/builds with Node.js 20 or newer.
5. Reinstall Playwright Chromium when the deployed Playwright package version
   changes, using the tunnel service cache path.
6. Verify OpenCode and Codex credentials under the service or DevOps OS user
   that actually runs them.
7. Run `systemctl daemon-reload`, restart only affected services, and confirm
   health/readiness plus `NRestarts`.
8. Run Agent, Browser, and Terminal smoke tests through the deployed path.
9. Refresh the ChatGPT plugin only when MCP tools or schemas changed, or when
   ChatGPT continues showing stale tools after a tunnel restart.

## Troubleshooting

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| Browser says Chromium is not installed even though files exist | Service is missing `PLAYWRIGHT_BROWSERS_PATH`, cache ownership blocks traversal, or the installed browser revision does not match the deployed Playwright package | Compare `systemctl show pickleshell-tunnel.service -p Environment` with `node_modules/playwright-core/browsers.json`; run a Chromium launch as the tunnel service user | Install Chromium with the deployed package version into the stable cache, set `HOME`, `XDG_CACHE_HOME`, and `PLAYWRIGHT_BROWSERS_PATH` in the tunnel unit/drop-in, then restart only the tunnel |
| OpenCode exits `127` or cannot find provider config | Gateway service XDG paths differ from the interactive shell where OpenCode was configured | Inspect Gateway `Environment`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`; run an exact `PONG` through Gateway | Move or recreate OpenCode config under the service XDG paths with correct ownership, then restart Gateway only if the unit changed |
| Codex returns `401` or stale refresh-token errors | Codex auth belongs to the wrong OS user or stored ChatGPT tokens are stale | Run `codex doctor` as the intended DevOps OS user without printing auth files | Reauthenticate that user, or copy only explicitly authorized Codex auth/config with mode `0600` and correct ownership |
| Codex rejects the configured model | CLI version is older than the selected model metadata or entitlement | Check `codex --version`, `codex doctor`, and the exact model smoke-test error | Upgrade Codex CLI or choose an allowlisted model supported by the installed CLI and provider account |
| Terminal becomes unavailable after config change | Socket path, auth token, service identity, or workspace path changed without matching Gateway/systemd permissions | Check Terminal service state, private socket ownership, Gateway terminal config, and a spawn/write/output smoke test | Restore matching socket/auth settings, keep ordinary `NoNewPrivileges=true`, daemon-reload, and restart only affected services |
| Services are healthy locally but ChatGPT still shows stale tools | ChatGPT cached the MCP tool registration before the tunnel restart or schema change | Compare local MCP tools with the plugin tool list | Refresh the plugin registration, enable new tools if prompted, and start a new conversation |

## Terminal capacity profiles

The project default is intentionally conservative: `maxTerminals: 8`,
`ringBytes: 1048576`, and `ttlMs: 1800000`. Operators who need sustained
parallel DevOps sessions can opt into a high-capacity profile up to the current
policy ceiling: `maxTerminals: 32`, `ringBytes: 16777216`, and
`ttlMs: 86400000`. Treat that profile as a deliberate resource and retention decision,
not a baseline default.

## Smoke test

```bash
cd /opt/pickleshell/gateway
PICKLESHELL_API_KEY=lag_v1_... \
PICKLESHELL_SMOKE_CHAT_ID=example-chat \
PICKLESHELL_RUN_AGENT_SMOKE=1 \
npm run test:smoke
```

## Execution Profile Contract

PickleShell represents execution as `runtime + execution_profile + boundary + boundary_provider`.
Authority describes what an agent may do; boundary describes where that authority
stops. The existing path stays ChatGPT → MCP → Gateway → runtime adapter → agent
process. Profiles do not create another dispatcher or expose service controls.

| profile | typical authority | network | root/sudo | intended boundary |
|---|---|---|---|---|
| isolated | minimal | none/local | no | host |
| agent | workspace/runtime | controlled | no | host/container/vm |
| privileged | elevated | controlled | limited | explicit |
| full-control | environment root | enabled | yes | vm/container by default |

`root inside VM != root of host`. Root may intentionally install packages and
manage services inside an explicitly provisioned VM or container. Containers
still share a host kernel: Docker socket access, privileged containers, host
device mounts and broad capabilities can defeat containment. `full-control +
host` is highest-risk and requires both explicit allowlists and
`allow_full_control_host: true`. No unrestricted host unit or sudo escalation is
provided. Privileged execution is a contract only until the operator provisions
and reviews a suitable surface. Operator/admin routes are not agent profiles.

Static `execution_profiles` maps known profile names to `allowed_boundaries`.
Each chat has `allowed_execution_profiles` and `allowed_boundaries`; requests
may select `execution_profile` and `boundary` only within both policies.
`execution_surface: {"execution_profile":"agent","boundary":"host"}` declares
the authority of the enclosing service. Selection must exactly match its profile
and boundary: a lower-authority label cannot make a running process less privileged.
The declaration alone cannot enable VM/container execution. Boundary is not a
descriptive label: a boundary value is valid only when a concrete execution
provider enforces it. A different surface requires operator provisioning, never
automatic upward fallback. Model output is not
parsed for escalation instructions; denied operations remain denied.

Exact compatibility defaults: absent global policy allows only agent/host;
absent chat allowlists allow only agent and host. Selection uses request, then
chat, then global `default_execution_profile`/`default_boundary`, then agent/host.
Absent `execution_surface` means agent/host. Existing installations retain their
OS behavior; the compatibility label does not certify their account permissions
or retrofit a sandbox. Operators must audit existing identities before asserting
agent isolation. Explicit null, unknown names, malformed policy and disallowed
selections fail closed. Configured defaults are validated even when overridden;
chat allowlists must reference defined profiles. Duplicate JSON keys (including
escaped equivalent keys) are rejected rather than resolved by last-key-wins.

The small provider layer is `gateway/src/execution/providers.js`. Dispatch resolves
policy and provider before runtime availability probes, session execution or slot
acquisition. Runtime adapters format commands; providers own process launch. The
host provider reuses the existing supervisor for OpenCode/Codex exec and owns the
Codex MCP worker spawn. MCP workers are reused only for the same authority context.

| boundary / provider | current support | behavior |
|---|---|---|
| host | implemented | local process under the configured service identity and restrictions |
| container | contract defined, provider unavailable | structured `boundary_provider_unavailable`; no process or slot |
| vm | contract defined, provider unavailable | structured `boundary_provider_unavailable`; no process or slot |

Optional static `execution_surface.boundary_provider` defaults to the selected
boundary and must name that same boundary's provider. It is not a request or
Settings field. Unknown providers return `boundary_provider_invalid`; mismatched
provider/boundary pairs return `execution_authority_unavailable`. Optional static
`boundary_providers` is a map of known provider names to `{ "enabled": boolean }`.
If supplied, the selected provider must be explicitly enabled. No commands, paths,
credentials or additional provider options are accepted. For example:

```json
{
  "boundary_providers": { "host": { "enabled": true } },
  "execution_surface": {
    "execution_profile": "agent",
    "boundary": "host",
    "boundary_provider": "host"
  }
}
```

Missing provider configuration preserves the existing host path only. Enabling a
VM/container entry cannot install or implement that provider: both remain
unavailable, even with matching policy/surface declarations. A host provider can
never satisfy `boundary=vm` or `boundary=container`; there is no fallback.
`full-control + host` still requires exact boolean `allow_full_control_host: true`
and matching explicit profile/boundary permissions. Host launch does not grant
root or sudo. Root inside VM/container is acceptable only after the corresponding
provider has established that boundary. This release implements no such provider
and claims no VM/container isolation, including for an externally enclosed Gateway.

Profiles and boundaries deliberately remain outside mutable Settings. Settings
cannot expand execution policy and responses contain none of its paths,
credentials or service configuration. Runtime changes selected through Settings
still pass execution policy at dispatch.

Session IDs are bound to runtime, profile, boundary, provider identity, chat and workspace in a
write-once store beside the settings file (`execution-sessions/`). Changes return
`session_authority_mismatch`; unknown sessions under explicit policy return
`session_authority_unknown` and require a new session. Bindings survive Gateway
restarts and result-buffer expiry. For compatibility only, configurations without
any profile policy may adopt an old session on first continuation as agent/host;
after adoption its binding is fixed. Bindings from the prior contract without a
provider identity mismatch and require a new session; they are not silently
upgraded. Explicit policy migration requires new sessions for previously unbound IDs. Retain bindings with runtime session data;
do not delete them to bypass a mismatch. The store and runtime state share the
existing trusted service identity; this is not tamper protection against that OS
principal. Execution result metadata records runtime, execution_profile, boundary and
boundary_provider from the resolved provider context, without paths.

The opt-in `deploy/release.sh --opencode-agent` selects the repository-owned
`pickleshell-opencode-agent.service.in` template for the existing Gateway service.
It uses the dedicated unprivileged `--gateway-user`/group, empty capabilities,
`NoNewPrivileges=true`, private devices/tmp, hidden homes and masked unrelated
configuration/state/socket trees. Only assigned workspace and runtime/settings
state are writable, plus private temporary storage. AF_UNIX, AF_INET and AF_INET6
support local IPC and provider access; egress destinations require operator
network policy. This unit supports OpenCode agent/host only. Use a dedicated
account with no sudo, administrative groups or unrelated credentials, one
assigned workspace per surface, and a matching static config. The service's
Gateway and child agent deliberately share this identity, as in the existing
architecture; chat directories are not separate OS security principals.

Prepare OpenCode and assigned provider credentials in the rendered runtime
config/data directories. Never put a backend Memory bearer token in this service
environment or these directories. Hidden host configuration and credential
sockets are not projected into the unit, and the adapter retains its explicit
child-environment allowlist. Later per-principal Memory credentials may be
projected separately; this feature neither injects nor alters Memory credentials.
The installer renders through the existing immutable release, backup, activation,
readiness and rollback path. `--settings-root` supports isolated rehearsals.
This is an alternative template for the existing service, not another Gateway.
Once installed, the release installer preserves this template on subsequent
upgrades and rollback even when the flag is omitted. Rollback to a release
without the hardened template fails closed; it does not substitute the ordinary
Gateway unit. Automatic failed-activation recovery retains the backed-up unit.

Ordinary Terminal remains a separate, more restricted service with
`RestrictAddressFamilies=AF_UNIX` and `NoNewPrivileges=true`; this feature gives it
neither network access nor sudo. The installer's `--profile isolated` means an
isolated release rehearsal and is unrelated to execution profile `isolated`.

PickleShell provides execution/capability mechanisms. Core may later select
`model + agent + execution profile + boundary` according to task policy. This
contract does not turn PickleShell into Core.
