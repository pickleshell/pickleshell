# PickleShell Memory MCP

`@pickleshell/memory-mcp` is an optional stdio MCP transport for a separately
operated workstation memory sidecar. The first supported backend protocol is
the Mem0-compatible HTTP surface proven by `spikes/mem0-bos`; PickleShell does
not own the memory engine, extraction model, vector store, or persistence.

This package is independent of Gateway startup. If it is absent, stopped, or
misconfigured, Agent, Browser, Terminal, Gateway, and the standard PickleShell
MCP server continue to work unchanged.

## Policy modes

- `admin` is an explicitly global administrative view. Every memory call must
  include the literal Mem0 `user_id`; responses preserve Mem0 data and metadata.
- `agent` has one operator-configured `PICKLESHELL_MEMORY_SCOPE`. Its tool
  schemas do not contain `user_id`, and attempted scope overrides are denied
  before any backend request.

The MCP adds transport, local authentication through an operator-launched OS
process identity, optional backend bearer authentication, authorization, a
content-free JSONL audit trail, structured errors, and capability discovery.
It does not rename or reinterpret Mem0 fields. Assistant Notebook remains a
curated project index; Mem0 remains bounded associative recall.

## Configuration

Required environment variables:

| Variable | Meaning |
| --- | --- |
| `PICKLESHELL_MEMORY_ROLE` | `admin` or `agent` |
| `PICKLESHELL_MEMORY_ACTOR` | Audited local principal name |
| `PICKLESHELL_MEMORY_SCOPE` | Required only for `agent`; forbidden for `admin` |
| `PICKLESHELL_MEMORY_AUDIT_LOG` | Absolute operator-controlled JSONL path |

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PICKLESHELL_MEMORY_BACKEND_URL` | `http://127.0.0.1:8766` | Credential-free Mem0 HTTP base URL |
| `PICKLESHELL_MEMORY_BACKEND_TOKEN` | unset | Bearer credential sent only to the backend |
| `PICKLESHELL_MEMORY_TIMEOUT_MS` | `10000` | Request timeout, 1–120000 ms |

## Optional immutable deployment profile

Memory has a separate deployment entry point and does not modify or require
the core Gateway release:

```bash
sudo deploy/memory-release.sh \
  --source /path/to/clean/checkout \
  --root /opt/pickleshell-memory \
  --commit <full-git-sha> \
  --node-executable /path/to/node-20-or-newer \
  --python-executable /path/to/regular-python-3.11-or-newer
```

Before installation, create the dedicated `pickleshell-memory` user/group and
operator-owned `/etc/pickleshell-memory/backend.env` and `mcp.env` files. Both
files must be regular, non-symlink files owned by the invoking operator, group
`pickleshell-memory`, mode `0640`. Put backend process configuration in
`backend.env`; put the MCP variables below and any backend bearer token in
`mcp.env`. Secrets are never passed on a command line. The backend executable
is a credential-free, fixed path and receives its configuration through the
service environment. Every OS identity whose MCP client launches the installed
`pickleshell-memory-mcp` wrapper must be a member of the configured memory
service group. That dedicated group is the shared boundary for reading
`mcp.env` and writing the managed audit log; do not grant access to other
groups or users.

By default the installer stages the repository-owned
`pickleshell-memory-backend` package and its fully pinned Python dependency
set inside the immutable release, then transactionally installs the managed
launcher at `/usr/local/bin/pickleshell-memory-backend`. `backend.env` must set
`MEM0_DATA_DIR=/var/lib/pickleshell-memory/backend`; the installer creates that
separate service-owned directory. The backend defaults to authenticated
loopback port 8766 and rejects 8765, so it never reads, shares, or replaces BOS
spike state. See `pickleshell-memory-backend/README.md` for configuration names
and security requirements. `--backend-executable` is an explicit external
backend escape hatch; using it opts out of repository-managed backend staging.

The installer stages only this package and its memory deployment assets under
`releases/<sha>`, atomically switches `active`, installs a hardened backend
unit plus MCP/readiness wrappers, and runs readiness. Readiness performs a real
MCP stdio initialize, tool discovery, and `memory_capabilities` backend health
call. On failure the activation is rejected. To switch back to the recorded
previous release, repeat the path/identity options with `--rollback`.

Normal deployment and rollback serialize on the operator-owned per-root lock
`<root>.deploy.lock`. In production, the lock parent, deployment root,
`releases`, and deployment `state` directory must be root-owned and not
group/other writable. Together with final-release inode checks, this prevents
the service identity and other unprivileged users from replacing releases or
racing state cleanup. A hostile root process can bypass these controls and is
outside this deployment threat model.

The audit contract is `/var/log/pickleshell-memory/audit.jsonl`, owned by the
memory service identity and group-writable mode `0660`, in a `0750` directory.
The configured memory group gives wrapper-launching identities access without
broadening the directory or audit file to other users. The installed
logrotate policy rotates daily, retains 14 rotations for at most 30 days,
compresses old logs, and recreates the file with the same least-privilege
ownership. Review retention against local policy before activation.

For a no-sudo clean-host rehearsal, run `npm run test:memory-deployment`. It
uses a temporary isolated prefix, fake backend and service manager, and covers
two activations, rendered permissions/artifacts, real MCP stdio readiness, and
rollback without touching Gateway or host service paths.

Manual development start:

```bash
npm --prefix pickleshell-memory-mcp ci
PICKLESHELL_MEMORY_ROLE=agent \
PICKLESHELL_MEMORY_ACTOR=codex \
PICKLESHELL_MEMORY_SCOPE=codex-bos-v1 \
PICKLESHELL_MEMORY_AUDIT_LOG=/var/log/pickleshell/memory-codex.jsonl \
npm --prefix pickleshell-memory-mcp start
```

Register the command and environment through the MCP client's secret-aware
configuration. Never put backend tokens in Git or command arguments.

## Tools and errors

CRUD/search/history tools map transparently to Mem0. `memory_capabilities`
reports the effective role, scope behavior, supported operations, protocol,
and the same bounded public backend health object for agent and admin roles.
That object allowlists only string-valued `status`, `provider`, and `version`
fields of at most 64 characters, in that order. Unknown fields, nested values,
oversized values, credentials, tokens, and connection details are dropped.

Tool failures return `isError: true` with only `error`, HTTP-like `status`, and
`retryable`. Backend response bodies are not copied into errors or audit logs.
Audit records contain timestamp, actor, role, effective scope, tool, policy
decision, outcome, duration, and bounded error code—never memory text, query,
result content, or credentials.
