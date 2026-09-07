# PickleShell Memory MCP

`@pickleshell/memory-mcp` is an optional stdio MCP transport for a separately
operated workstation memory sidecar. The first supported backend protocol is
the Mem0-compatible HTTP surface proven by `spikes/mem0-bos`; PickleShell does
not own the memory engine, extraction model, vector store, or persistence.

This package is independent of Gateway startup. If it is absent, stopped, or
misconfigured, Agent, Browser, Terminal, Gateway, and the standard PickleShell
MCP server continue to work unchanged.

## PickleShell Memory component

PickleShell Memory is an additional PickleShell component; it is not a fourth
core service. It is currently implemented by three independently released
parts:

- `pickleshell-memory-mcp`: this stdio MCP transport; it adds transport,
  policy, audit, structured errors, and capability discovery;
- `pickleshell-memory-broker`: a loopback-only scoped credential broker used
  by the managed Codex wiring;
- `pickleshell-memory-backend`: the production Mem0 backend that owns the
  memory engine, extraction, vector store, and persistence.

PickleShell Memory is **shared external memory**. It is deliberately separate
from agent-local memory:

- **Agent-local context / native memory** is the runtime's own session
  context and any memory the runtime itself provides. Its sharing and lifetime
  follow that runtime; it does not imply access to PickleShell shared scopes.
- **Shared external memory** is the Mem0 backend: persistent, scope-bound,
  and addressable through the MCP tools by any correctly wired agent session
  in the same scope, including sessions that start later.

## Managed production path (single-principal baseline)

The managed production deployment exposes shared memory to Codex only through
this loopback-only chain:

```text
Codex
  -> installed PickleShell Memory MCP (role=agent, scope=codex-bos-v1)
  -> scoped broker on 127.0.0.1:8767
  -> production Mem0 backend on 127.0.0.1:8766
```

Backend credential projection is owned by the broker: the broker service
receives a systemd `LoadCredential` copy of the operator-only `0600`
`backend.env`, applies that credential, and fixes `user_id=codex-bos-v1` on
every request. The backend credential is not exposed to Codex or to the MCP
process, and the Codex MCP launcher never reads `backend.env` or `mcp.env`.

## Verified shared-memory handoff (2026-09-07)

A 2026-09-07 end-to-end experiment on the managed production path verified
that shared memory survives across independent agent sessions:

1. Agent A, a Codex session, stored architectural knowledge together with the
   marker `PICKLESHELL_SHARED_MEMORY_HANDOFF_20260907_A` in scope
   `codex-bos-v1`.
2. Agent B, a completely fresh independent Codex session, received no
   transcript and no memory ID, then semantically searched the shared memory.
3. Agent B found memory `6a293b43-afe6-4b1c-9641-663c8896a58c` and recovered
   the architecture and the marker.

Verdict: **AGENT A -> SHARED MEM0 -> AGENT B HANDOFF PASS**.

Why this matters: shared persistent knowledge can outlive an individual
session or agent and be recovered by another. That is a useful proven
engineering precursor for Core's future shared/organizational knowledge
layer.

What is proven is cross-session handoff between independent Codex agent
sessions through the managed production memory path. Cross-runtime handoff
(for example, Codex -> OpenCode) has not been proven and is not claimed here.

Sanitized evidence:
[`docs/evidence/2026-09-07-shared-memory-handoff.md`](../docs/evidence/2026-09-07-shared-memory-handoff.md)

## Multi-principal shared memory (not yet deployed)

The repository now supports one authenticated broker at 8767 for Codex,
OpenCode and future configured principals. Private memory defaults to `private`;
shared project memory uses an operator-approved target such as
`shared/project/pickleshell`, with independent read/write permissions. Keep
`codex-bos-v1` as Codex's physical private scope to preserve existing memories.

See [principal policy, trust boundary, installation, migration and tests](../docs/memory-principals.md).
Principal credentials are distinct from the backend bearer. Separate Unix
accounts protect each runtime's credential; the installed `src/principal.js`
launcher fixes the single broker endpoint. Admin/direct 8766 behavior remains
unchanged. No multi-principal production deployment or real OpenCode handoff
is claimed by this implementation.

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
| `PICKLESHELL_MEMORY_BACKEND_URL` | `http://127.0.0.1:8766` | Authenticated direct backend; explicitly set 8767 only for Codex |
| `PICKLESHELL_MEMORY_BACKEND_TOKEN` | unset | Bearer credential for direct backend/admin access; omit for the Codex broker |
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

For authenticated multi-principal installation, follow the linked policy guide
and pass `--broker-policy`; the legacy setup below documents compatibility.

Before installation, create distinct backend (`pickleshell-memory`) and broker
(`pickleshell-memory-broker`) users/groups, plus a separate
`pickleshell-memory-audit` group. Override them with `--service-user`,
`--service-group`, `--broker-user`, `--broker-group`, and `--audit-group`.
Production configuration must be operator/root owned. `backend.env` must be a
regular non-symlink file with mode `0600`: do not give Codex or MCP launchers
read permission or membership in a credential-bearing group. The backend gets
its environment from systemd; only the distinct broker service receives a
private `LoadCredential` copy, read through `%d/backend.env`. This requires
systemd with `LoadCredential` and the `%d` credential-directory specifier.

The installed shared/admin MCP wrapper continues to read `mcp.env` (mode
`0640`, operator-owned, backend/admin service group). Its default is the direct
backend at `127.0.0.1:8766`; retain its bearer token and existing admin/shared
scope configuration. This file may contain the admin bearer credential and
must never be readable by Codex. Audit access is separate: grant Codex only
membership in the audit group, not the backend/admin service group. Keep the
config directory traversable as needed without granting secret file access.

Codex wiring is explicit and separate from that shared wrapper. Configure its
MCP launcher to run the active release's `pickleshell-memory-mcp/src/index.js`
with Node and these environment variables (plus the managed audit path):

```text
PICKLESHELL_MEMORY_ROLE=agent
PICKLESHELL_MEMORY_ACTOR=codex
PICKLESHELL_MEMORY_SCOPE=codex-bos-v1
PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:8767
PICKLESHELL_MEMORY_AUDIT_LOG=/var/log/pickleshell-memory/audit.jsonl
```

Do not set a backend token or source `mcp.env` in the Codex launcher. The broker
injects authorization and fixes `user_id=codex-bos-v1`; it accepts only the
memory route/method allowlist and never follows redirects or selects an
arbitrary upstream. Both listeners remain loopback-only. Each broker connection
has a five-second absolute inbound deadline (including headers and body), one
request, and a bounded response write; at most 16 connections run concurrently.
Excess connections are closed and callers may retry safe reads.

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
Broker-introducing upgrades enable the broker for boot. Deployment records the
prior backend/broker enabled states; rollback restores them. A pre-broker
release (including `769ffde`) requires no broker templates: recovery removes
broker artifacts and stops/disables the broker while restoring the direct
backend/MCP wrappers. Keep operator-managed admin `mcp.env` compatible with the
previous release; rollback does not rewrite credentials or Codex configuration.
A rollback to a pre-broker release makes separately wired Codex broker access
unavailable until a broker release is activated again.

An isolated profile must explicitly specify a non-production broker service
name, broker user/group, and audit group as well as the other isolated options.
The broker user must differ from the backend user and the two service names
must differ. Rendered broker `After`/`Requires` refer to the configured backend
service. Fixtures simulate service identities; they do not install host units.

Normal deployment and rollback serialize on the operator-owned per-root lock
`<root>.deploy.lock`. In production, the lock parent, deployment root,
`releases`, and deployment `state` directory must be root-owned and not
group/other writable. Together with final-release inode checks, this prevents
the service identity and other unprivileged users from replacing releases or
racing state cleanup. A hostile root process can bypass these controls and is
outside this deployment threat model.

The audit contract is `/var/log/pickleshell-memory/audit.jsonl`, owned by the
memory service identity and separate audit group, mode `0660`, in a `0750` directory.
The configured audit group gives wrapper-launching identities access without
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
PICKLESHELL_MEMORY_BACKEND_URL=http://127.0.0.1:8767 \
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
