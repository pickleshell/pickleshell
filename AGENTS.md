# AGENTS.md

## Scope

PickleShell is a Linux-only monorepo:

- `gateway/` is CommonJS and owns HTTP authentication, concurrency, workspace
  resolution, safe destination writes, and OpenCode execution.
- `mcp-server/` is TypeScript/ESM and owns the public MCP schema, Base64 file
  validation, temporary decoding, and Gateway HTTP client.

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
- Keep requests without `session_id` independent.
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
