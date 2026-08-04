# AGENTS.md

## Scope

PickleShell is a Linux-only monorepo:

- `gateway/` is CommonJS and owns HTTP authentication, concurrency, workspace
  resolution, safe destination writes, and OpenCode execution.
- `mcp-server/` is TypeScript/ESM and owns the public MCP schema, Base64 file
  validation, temporary decoding, and Gateway HTTP client.

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
