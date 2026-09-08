# Changelog

All notable PickleShell releases are documented here.

## [0.2.0] - 2026-09-08

### Added

- First-class execution authority resolution through
  `runtime + execution_profile + boundary + boundary_provider`.
- Operator-controlled execution profiles: `isolated`, `agent`, `privileged`, and
  `full-control`, with session authority binding and no implicit upward privilege fallback.
- Enforced boundary-provider layer. The host provider is implemented; container and VM
  boundaries fail closed until a concrete provider is configured and available.
- Dedicated networked OpenCode `agent + host` systemd surface with an unprivileged identity,
  isolated runtime state, `NoNewPrivileges=true`, and AF_UNIX/AF_INET/AF_INET6 access.
  The ordinary Terminal remains a separate AF_UNIX-only isolated surface.
- Optional managed PickleShell Memory stack backed by Mem0, with a credential-projecting
  broker, immutable release activation, health checks, rollback, and recovery.
- Multi-principal Memory policy with isolated private scopes and operator-approved shared
  project scopes.
- Production-validated cross-runtime knowledge handoff from Codex to OpenCode through
  shared Memory while preserving separate OS identities, private scopes, and credentials.

### Security

- VM/container boundary labels can no longer execute on the host without a real provider.
  Missing or unavailable providers reject the request before process launch or slot
  acquisition.
- `full-control + host` is denied by default. Root authority inside a VM/container is only
  meaningful after a concrete provider has established that containment boundary.
- Memory policy files are installed with deterministic safe ownership and mode; the broker
  rejects unsafe policy ownership or permissions.
- Agent principals do not receive the Memory backend bearer credential; the broker owns
  backend credential projection.

### Changed

- Package versions for the core Gateway, MCP server, Terminal, and Memory MCP are aligned to
  `0.2.0`.
- Deployment and API documentation now describe execution profiles, boundary providers,
  OpenCode agent surfaces, and multi-principal Memory behavior.

### Validation

The v0.2.0 architecture was validated end to end on a controlled BOS deployment:

- OpenCode `agent + host` executed successfully through MCP → Gateway → runtime.
- VM/container requests failed closed without host fallback; full-control host requests were
  denied; session authority changes were rejected.
- Codex wrote project knowledge into shared Memory and a fresh OpenCode session discovered it
  semantically without receiving the Codex transcript or memory ID.
- Private memory remained isolated between principals and the shared handoff remained
  discoverable after a managed broker restart.

Production-specific usernames, credentials, memory identifiers, and host paths are
intentionally omitted from this public changelog.

## [0.1.4] - 2026-08-13

- Added persisted runtime/model/settings controls and optional supervised Codex MCP
  transport.

For older release details, see the [README release history](README.md#release-history).
