# PickleShell

PickleShell connects ChatGPT to a locally operated OpenCode agent without
publishing the agent Gateway on the Internet.

> Status: pre-release (`0.1.0`). Use only with trusted users and a dedicated
> service account. Read [SECURITY.md](SECURITY.md) before deployment.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel (outbound HTTPS)
  -> tunnel-client
  -> PickleShell MCP server (stdio)
  -> PickleShell Gateway (loopback HTTP)
  -> OpenCode
  -> configured workspace
```

The repository contains:

- `gateway/`: authenticated HTTP process that runs OpenCode;
- `mcp-server/`: MCP `send-chat` adapter and file decoder;
- `docs/`: deployment, API, and ChatGPT setup documentation.

## Capabilities

- continue an OpenCode session with `session_id`;
- choose from an operator-controlled model allowlist;
- transfer up to 20 small files per request;
- place files in an explicit workspace-relative destination;
- reject traversal, absolute paths, symlink destinations, and unintended
  overwrite;
- reject concurrent work on the same explicit session without queueing;
- run independent sessions concurrently.

## Development

Requires Linux and Node.js 20 or newer.

```bash
npm --prefix gateway ci
npm --prefix mcp-server ci
npm test
npm run build
npm run audit
```

## Documentation

- [Deployment](docs/deployment.md)
- [API reference](docs/api.md)
- [ChatGPT setup](docs/chatgpt.md)
- [Security policy and threat model](SECURITY.md)

## License

ISC
