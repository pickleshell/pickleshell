# Security Policy

## Supported versions

PickleShell is pre-release software. Security fixes are applied to the latest
`0.1.x` release only.

Report vulnerabilities through the repository's private GitHub Security
Advisory form. Do not open a public issue containing exploit details, tokens,
private keys, prompts, or logs.

## Trust model

PickleShell is a trusted, single-operator system. An authorized client can ask
OpenCode to execute commands with the permissions of the Gateway service user.
The configured workspace is an instruction boundary for the agent, not an
operating-system sandbox.

PickleShell is not designed for:

- untrusted or anonymous users;
- multi-tenant isolation;
- exposing the HTTP Gateway directly to the public Internet;
- containing a compromised OpenCode process or service account.

Use a dedicated, unprivileged service user. That user must not have access to
unrelated repositories, production credentials, SSH agent sockets, or sudo.
Keep the Gateway API key and tunnel control-plane key outside the repository.

## File delivery

Destination paths are relative to the configured workspace. On Linux, the
Gateway walks destination directories through directory file descriptors with
`O_DIRECTORY | O_NOFOLLOW`, writes to a private temporary file, and publishes
the result atomically. Existing symbolic links are rejected.

This implementation depends on Linux `/proc/self/fd` semantics and is not
portable to macOS or Windows.

## Availability

Requests with the same explicit session ID are single-flight. Requests with
different or omitted session IDs may run concurrently. The supplied systemd
unit uses process and memory limits to reduce host-level resource exhaustion;
operators must tune those limits for their hardware.
