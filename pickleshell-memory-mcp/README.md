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
| `PICKLESHELL_MEMORY_BACKEND_URL` | `http://127.0.0.1:8765` | Credential-free Mem0 HTTP base URL |
| `PICKLESHELL_MEMORY_BACKEND_TOKEN` | unset | Bearer credential sent only to the backend |
| `PICKLESHELL_MEMORY_TIMEOUT_MS` | `10000` | Request timeout, 1–120000 ms |

Install and start independently:

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
and backend health metadata without credentials.

Tool failures return `isError: true` with only `error`, HTTP-like `status`, and
`retryable`. Backend response bodies are not copied into errors or audit logs.
Audit records contain timestamp, actor, role, effective scope, tool, policy
decision, outcome, duration, and bounded error code—never memory text, query,
result content, or credentials.
