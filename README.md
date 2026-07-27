<h1 align="center">
  <img src="docs/assets/pickleshell-logo.png" height="48" alt="PickleShell cucumber logo" align="center">
  PickleShell
</h1>

<p align="center"><strong>Give ChatGPT a secure path to your local OpenCode agent</strong></p>

[![Release](https://img.shields.io/badge/release-v0.1.0-f5a623)](#project-status)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](#development)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)](#requirements)

**Website:** [pickleshell.github.io](https://pickleshell.github.io/)

PickleShell connects ChatGPT to a locally operated
[OpenCode](https://opencode.ai/) agent through an outbound-only OpenAI Secure
MCP Tunnel. Your Gateway stays off the public Internet.

ChatGPT delegates work through four MCP tools—`send-chat`, `session-status`,
`session-output`, and `cancel-request`—and receives structured results with
full traces. Continue local coding sessions, delegate to an operator-approved
model, and transfer files into a controlled workspace.

> [!WARNING]
> **PickleShell is pre-release software (`0.1.0`).** Use it only with trusted
> users and a dedicated service account. Read
> [SECURITY.md](SECURITY.md) before deployment.

## Quick Start

1. Follow the [Deployment guide](docs/deployment.md) to install the Gateway and
   tunnel-client on a Linux host.
2. Follow the [ChatGPT setup](docs/chatgpt.md) to create the Secure MCP Tunnel,
   configure the PickleShell plugin, and run the connection test.
3. Send a test message: `Reply exactly: pong. Do not use tools or modify files.`
4. Poll `session-status` until `state: "completed"`, then read the result with
   `session-output`.

## Why PickleShell?

ChatGPT can reason about a project, while OpenCode can operate inside a local
development environment. PickleShell provides the secure, explicit boundary
between them:

- no public Gateway endpoint;
- no inbound port forwarding;
- operator-controlled workspaces and model allowlists;
- authenticated requests and auditable local execution;
- file transfer with path, symlink, and overwrite protection;
- workspace isolation that prevents cross-chat state mixing.

## Architecture

```mermaid
flowchart TD
    A["ChatGPT"] --> B["OpenAI Secure MCP Tunnel"]
    B --> C["tunnel-client"]
    C --> D["PickleShell MCP server"]
    D --> E["PickleShell Gateway"]
    E --> F["OpenCode"]
    F --> G["Configured workspace"]

    classDef cloud fill:#e9f3ff,stroke:#1677c8,color:#102a43
    classDef bridge fill:#fff4d6,stroke:#d48806,color:#3d2b00
    classDef local fill:#e8f7ec,stroke:#2f855a,color:#173d2a
    class A,B cloud
    class C,D bridge
    class E,F,G local
```

The tunnel is initiated from the local machine over outbound HTTPS. The Gateway
remains reachable only inside the trusted local environment.

## Async Workflow

`send-chat` returns immediately with a `request_id` and `state: "busy"`. Poll
`session-status` to track progress, then read the result with `session-output`.
Cancel in-flight work with `cancel-request` at any time.

```
send-chat ──▸ { request_id, state: "busy", next_action: "session-status" }
                    │
                    ▼
              session-status ──▸ { state: "busy", progress: [...] }
                    │                retry_after_ms: 2000
                    ▼
              session-status ──▸ { state: "completed", next_action: "session-output" }
                    │
                    ▼
              session-output ──▸ { reply, trace, session_id, timestamps }
```

Each response includes `next_action` (which tool to call next) and
`retry_after_ms` (suggested polling interval). Pass the returned `session_id` in
subsequent `send-chat` calls to continue the same OpenCode conversation. Omit it
to start a fresh session that runs independently and in parallel.

**Idempotency:** when a client provides an explicit idempotency key, duplicate
`send-chat` requests are detected and the original result is returned instead of
re-executing the command.

**Completed results** are retained for 24 hours and can be read repeatedly
through `session-output`.

**Session locking:** concurrent `send-chat` requests to the same explicit
`session_id` receive a `409 session_busy` response. Independent sessions run in
parallel without interference.

## File Transfer

```mermaid
flowchart LR
    C["ChatGPT file attachment"] --> M["Base64 decode & validate"]
    M --> F["Path + symlink + size checks"]
    F --> W["Workspace-safe write"]
```

![PickleShell file-transfer example](docs/assets/example-file-transfer.png)

| Constraint | Limit |
| --- | --- |
| Files per request | 20 |
| Size per file | 2 MiB |
| Total payload | 10 MiB |
| Overwrite | Disabled by default; explicit opt-in per file |

Destination resolution: `files[].dest_dir` > `destination_dir` > `.inbox/<request-id>/`.

The Gateway writes through directory file descriptors with `O_NOFOLLOW`, rejects
symbolic links as destinations, and publishes results atomically.

## Capabilities

| Capability | Behaviour |
| --- | --- |
| Async execution | Non-blocking tasks with `request_id` tracking and structured polling |
| Session continuity | Continue an OpenCode conversation across multiple ChatGPT messages using `session_id` |
| Cancellation | Abort in-flight tasks with `cancel-request` |
| Model selection | Choose only from an operator-controlled model allowlist |
| File transfer | Transfer up to 20 files per request with size, path, symlink, and overwrite protection |
| Destination control | Place files in an explicit workspace-relative directory |
| Session locking | Reject concurrent work on the same explicit session |
| Parallel work | Run independent sessions concurrently without state mixing |
| Structured metadata | Timestamps (`created_at`, `started_at`, `completed_at`), `queue_ms`, `execution_ms`, and full execution traces in every completed result |

## Security Model

PickleShell is a controlled bridge to a local coding agent, not a
general-purpose public shell. Deployments should use a dedicated unprivileged
service account, strict workspace permissions, a narrow model allowlist, and
environment-backed credentials.

See [SECURITY.md](SECURITY.md) for the trust model, file-delivery invariants,
availability guarantees, and vulnerability reporting.

## Requirements

- Linux;
- Node.js 20 or newer;
- OpenCode installed and configured;
- OpenAI Secure MCP Tunnel access;
- a dedicated local service account is strongly recommended.

## Development

Install dependencies, run the complete test suite, build both components, and
audit dependencies:

```bash
npm --prefix gateway ci
npm --prefix mcp-server ci
npm test
npm run build
npm run audit
```

## Documentation

- [ChatGPT setup](docs/chatgpt.md) — connect the plugin and run the connection test
- [Deployment guide](docs/deployment.md) — install the Gateway, tunnel, and systemd units
- [API reference](docs/api.md) — MCP tool schemas, async protocol, and Gateway endpoints
- [Security policy](SECURITY.md) — trust model, threat boundaries, and vulnerability reporting
- [Roadmap](docs/roadmap.md) — v1 production checklist and deferred features

## Project Status

PickleShell `0.1.0` is the first production-ready release. It supports
asynchronous task execution with polling, structured result output, in-flight
cancellation, explicit session continuity, file transfer, and operator-controlled
model and workspace scoping.

This is pre-1.0 software. Interfaces may change before a stable `1.0` release.

## Authors

- Me
- Big Pickle
- Codex
- Grok
- ChatGPT

## License

PickleShell is available under the [MIT License](LICENSE).
