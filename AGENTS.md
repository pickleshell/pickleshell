# AGENTS.md

## Scope

PickleShell is a Linux-only monorepo:

- `gateway/` is CommonJS and owns HTTP authentication, concurrency, workspace
  resolution, safe destination writes, and OpenCode execution.
- `mcp-server/` is TypeScript/ESM and owns the public MCP schema, Base64 file
  validation, temporary decoding, and Gateway HTTP client.

## Operational installation route

This repository is the v0.1.2 PickleShell Workstation release. It contains
these independently supervised components:

- Gateway and Agent runtimes: OpenCode (default) and native Codex;
- MCP server and the official outbound `tunnel-client`;
- Playwright Browser MCP runtime;
- persistent Terminal PTY service with systemd/cgroup-v2 lifecycle cleanup;
- immutable release staging, activation, readiness checks, and rollback.

Do not treat this file as a replacement for the deployment procedures. Read
the following sources in this order before installing a clean machine:

1. `README.md` for the product shape and requirements;
2. `docs/deployment.md` for users, directories, credentials, systemd, Browser,
   Terminal, tunnel, immutable releases, upgrades, and rollback;
3. `docs/models.md` for the model allowlist and runtime-specific model rules;
4. `docs/chatgpt.md` for Secure MCP Tunnel, plugin setup, refresh, and smoke
   tests;
5. `docs/terminal-pty-design.md` for the Terminal contract and cgroup policy;
6. `deploy/release.sh` and the current systemd templates for the exact
   installer arguments, service names, paths, and safety checks.

Required installation order on a fresh Linux host:

1. Confirm Linux, Node.js 20+, systemd/cgroup-v2, `setfacl`/`getfacl`, the
   official `tunnel-client`, and outbound HTTPS to `api.openai.com:443`.
2. Clone a clean checkout, fetch the intended full commit, and verify the
   worktree is clean; never deploy an uncommitted tree.
3. Create the dedicated Gateway, MCP/tunnel, and Terminal users/directories;
   keep service homes, caches, workspaces, sockets, and credentials separate.
4. Install Node dependencies and build Gateway, MCP, and Terminal with the
   deployed Node executable. Install OpenCode and Codex for their intended OS
   users, authenticate them without printing credentials, and install the
   Playwright Chromium revision matching the deployed package.
5. Create `/etc/pickleshell` configuration and operator-owned credentials with
   mode `0600`; configure the smallest workspace and model allowlists needed.
6. Activate the exact commit with `deploy/release.sh`, then install/reload only
   the rendered units and start Gateway, Terminal, and MCP/tunnel as selected.
7. Create and validate the tunnel profile, start `tunnel-client`, and verify
   local `healthz`/`readyz` before opening the ChatGPT plugin.
8. Run the release, Agent, Codex, Browser, Terminal, and MCP tunnel smoke tests
   below. If activation or readiness fails, use the recorded `active` and
   `state/previous-target` rollback instead of editing release trees manually.

The immutable deployment entry point is, from a clean checkout:

```bash
sudo deploy/release.sh \
  --source /path/to/clean/checkout \
  --root /opt/pickleshell \
  --commit <full-git-sha> \
  --gateway-user <gateway-user> \
  --mcp-user <mcp-user> \
  --terminal-user <terminal-user> \
  --include-terminal
```

The installer stages `releases/<full-sha>` and atomically updates `active`.
`--include-terminal` is required to change the shipped Terminal unit; omit it
for a separately managed Terminal profile. Use `--rollback` only when a
previous target exists. Use the `isolated` profile and dedicated
test prefixes for rehearsals; never pass production paths to an isolated test.

Runtime selection is explicit and has no fallback:

- `runtime: "opencode"` uses the supported default OpenCode adapter and its
  configured/default model;
- `runtime: "codex"` uses the native Codex adapter and Codex-compatible model
  IDs only;
- allowlists and model validation are independent per runtime;
- an unavailable, forbidden, or incompatible runtime/model is rejected with a
  structured error before a request/slot is created; it never falls back.

`chat_id` selects a configured workspace. `request_id` identifies one async
execution. `session_id` identifies the conversation context: OpenCode usually
returns `ses_...`, while Codex returns its thread/session identifier. New
requests without `session_id` create a new context and are tracked by
`request_id`; continuation must use the `session_id` returned by
`session-output`.

Deployment is successful only when all of these are true:

- the exact commit is active, services are `active`, `NRestarts` is stable, and
  Gateway `/health` plus tunnel `/healthz` and `/readyz` pass;
- an Agent `PONG` works through the deployed MCP path, OpenCode remains the
  default, and an explicit Codex request completes with a real session ID and
  resume works without fallback;
- Browser navigate/snapshot/screenshot succeeds with the deployed Chromium;
- Terminal spawn/write/output/resize/signal/close succeeds, including PTY
  reconnect, TTL cleanup, and delegated cgroup integration;
- the ChatGPT plugin exposes the current tools and the async
  `send-chat -> session-status -> session-output` flow passes, including file
  transfer and cancellation where configured;
- `npm test`, `npm run build`, `npm run audit`, `bash test/deployment-release.test.sh`,
  and `git diff --check` pass. Run the cgroup integration test when the host
  supports delegated cgroup-v2.

Clean-install lessons from the clean-install gate are part of the contract: a fresh host
must provide the three service identities, systemd/cgroup-v2 delegation,
`setfacl` and `getfacl`, a writable cache for the exact Playwright revision, and
credentials owned by the service user. Terminal keeps `ProtectHome=true` and
ordinary `NoNewPrivileges=true`; workspace access is granted by the release
installer's ACL/bind setup, not by giving the Terminal account sudo. A clean
install must not reuse another host's homes, tunnel profile, browser cache, or
credentials.

## Identifier terminology

| Identifier | Meaning |
|---|---|
| `chat_id` | Workspace/configuration identifier (maps to a directory on disk) |
| `session_id` | Real OpenCode conversation identifier (`ses_...`), used to continue context |
| `request_id` | Single command execution identifier (`req_...`), returned by send-chat |

Rules:
- `request_id` cannot be used instead of `session_id` (or vice versa);
- for a new command without `session_id`, use `request_id` to track progress;
- after completion, the real `session_id` is read from `session-output`.

## Required checks

Run before every commit:

```bash
npm --prefix gateway ci
npm --prefix gateway test
npm --prefix gateway audit --omit=dev
npm --prefix mcp-server ci
npm --prefix mcp-server run build
npm --prefix mcp-server test
npm --prefix mcp-server audit --omit=dev
git diff --check
```

## Operational deployment guidance

- Run repository operations as the deployment owner. Avoid recursive ACL changes;
  if permissions are wrong, fix ownership of the affected files explicitly.
- Before remote work, verify the SSH identity, host key policy, target user, and
  authorized sudo route. Use non-interactive sudo only where the deployment
  procedure requires it.
- Keep ordinary Terminal isolation separate from any privileged DevOps account.
  Do not weaken `NoNewPrivileges` or grant Terminal sudo merely to make host
  administration easier.
- Inspect the live systemd `ExecStart`, `User`, `Environment`, and installed
  Node/MCP package paths before changing a service. Do not infer paths from a
  previous host.
- Install Playwright browsers for the exact deployed package version. Expose the
  browser cache to the tunnel/MCP service with stable `HOME`, `XDG_CACHE_HOME`,
  `PLAYWRIGHT_BROWSERS_PATH`, and matching writable paths for runtime state.
- OpenCode auth and config resolution follows the Gateway service environment,
  especially `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `OPENCODE_CONFIG_DIR`.
- Run Codex CLI under its intended OS user. Its auth/config files must be owned
  by that user with mode `0600`; verify with `codex doctor` and a non-mutating
  exact `PONG` execution. CLI version and model compatibility are runtime
  requirements.
- Back up affected unit files, drop-ins, and operator configs before edits. Run
  `systemctl daemon-reload`, restart only affected services, then verify
  health/readiness, `NRestarts`, and end-to-end Agent, Browser, and Terminal
  behavior.
- Never print credential contents, private keys, token files, tunnel profiles,
  or environment files containing secrets.

## Security invariants

- Never build a shell command by concatenating request fields. Use argv-based
  process APIs; the PTY wrapper must shell-quote every argv element.
- Destination paths must remain workspace-relative and must not follow
  symbolic links. Keep the directory-FD and `O_NOFOLLOW` design.
- `overwrite` defaults to false.
- Never commit `.env`, `config.json`, tunnel profiles, API keys, control-plane
  keys, logs, temporary files, or production host details.
- The OpenCode worker is not an OS sandbox. Do not describe it as one.
- The public product path is the Secure MCP Tunnel. Keep the HTTP Gateway on
  loopback unless an operator explicitly designs a private network route.

## Change boundaries

- Update MCP schema, TypeScript types, Gateway request handling, tests, and API
  docs together when file-transfer fields change.
- Preserve immediate `409 session_busy` behavior for duplicate explicit
  sessions. Do not add a queue.
- Requests without `session_id` create a new opencode session each time; since each session is unique, these requests execute in parallel.
- Keep deployment examples generic; do not add real domains, IP addresses,
  chat IDs, usernames, or filesystem layouts from production.

## Security review triage

Security reviews report:

| Severity | Report | Fix during review |
|---|---|---|
| CRITICAL | Always | No |
| HIGH | Always | No |
| MEDIUM | Always | No |
| LOW | Only when essential | No |

An essential LOW finding directly affects security, data integrity,
availability, deployment correctness, API compatibility, or secret exposure.
Ignore cosmetic, stylistic, speculative, optional-refactoring, and unmeasured
performance findings.

Reviews produce findings only. Apply each confirmed finding in a separate
task, ordered by severity. Every fix requires a regression test before it can
be marked complete.
