# Connect ChatGPT

This guide walks through every UI step from enabling developer mode to testing
PickleShell in ChatGPT.

## Prerequisites

- an OpenAI account and workspace that support custom MCP apps;
- Developer mode enabled;
- a Secure MCP Tunnel created in the OpenAI Platform;
- `tunnel-client` running on the PickleShell host.

## 1. Enable Developer mode

1. Open **Settings → Security and login**.
2. Enable **Developer mode**.
3. Leave **Enforce CSP in developer mode** enabled for additional protection.

![Enable Developer mode in ChatGPT settings](assets/developer-mode.png)

## 2. Create a Secure MCP Tunnel

1. Go to **OpenAI Platform → project settings → Tunnels**.
2. Click **Create tunnel**.
3. Enter a descriptive name and description.
4. Select the organization and the permitted ChatGPT workspace.
5. Create the tunnel.

![Create a Secure MCP Tunnel](assets/tunnel-create.png)

> **Warning:** Treat the Tunnel ID, organization ID, and workspace ID as
> private configuration values. Do not publish them.

## 3. Create a restricted tunnel key

1. In the OpenAI Platform, create a **restricted project secret key**.
2. Leave unrelated permissions at **None**.
3. Grant only **Tunnels: Read** and **Tunnels: Use**.

![Grant only Read and Use permissions for Tunnels](assets/tunnel-key-permissions.png)

> **Warning:** Copy the secret immediately. Never commit, screenshot, log, or
> publish it. Store it in the protected configuration described by
> [deployment.md](deployment.md).

## 4. Start the local tunnel

See [Deployment](deployment.md) for installation commands. The `tunnel-client`
and the PickleShell services must both report healthy/ready before continuing.

## 5. Create the PickleShell plugin

Create a ChatGPT plugin named `PickleShell`, select the configured tunnel, and
allow the `send-chat` action.

![Create the PickleShell plugin in ChatGPT](assets/plugin-create.png)

## 6. Verify the connected plugin

The connected PickleShell entry should show the `send-chat` action and the
current schema.

![Connected PickleShell plugin and send-chat action](assets/plugin-connected.png)

## 7. Refresh after schema changes

After changing the MCP schema:

1. Open the plugin's action controls;
2. Select **Refresh**;
3. Review the action diff;
4. Enable the updated action;
5. Start a new conversation.

The connected plugin should expose `send-chat`, `session-status`, and
`session-output`. If Refresh completes but the old schema still exposes only
`send-chat`, do a full connector reset: remove the PickleShell plugin/connector,
create it again using the current PickleShell tunnel, and open a new
conversation. A new chat alone is not sufficient when ChatGPT has retained the
old connector registration.

## 8. Test the connection

Test:

```text
Use PickleShell.
chat_id: pickleshell-main
message: Reply with exactly: pong. Do not use tools or modify files.
```

For continued work, pass the `session_id` returned by the previous call. Use a
different session for unrelated work.

## 9. Plugin tool smoke test

Use this checklist in a fresh ChatGPT conversation after the initial `pong`
test. All messages below target `chat_id: pickleshell-main` and must not edit
files.

1. Call `session-status` without `session_id`. Expect `state: "new_session"`.
2. Call `send-chat` with the message: `Reply exactly: PONG_TEST. Do not use tools or modify files.`
   Save the returned `session_id` and confirm the reply is `PONG_TEST`.
3. Call `session-status` with that `session_id`. Expect `state: "completed"`.
4. Call `session-output` with that `session_id`. Confirm it returns the previous
   reply and, when available, a `trace`.
5. Call `send-chat` again with the same session: `Reply exactly: SECOND_TEST. Do not use tools or modify files.`
6. Call `session-output` after completion. Confirm the buffer now contains
   `SECOND_TEST`, not `PONG_TEST`.

To test the busy state, start a separate explicit session with:
`Wait 10 seconds, then reply exactly: BUSY_TEST_DONE. Do not use tools or modify files.`
While it runs, call `session-status` and `session-output` for that session.
Both must report `state: "busy"` and include elapsed time or progress. After
completion, repeat `session-output` and expect `BUSY_TEST_DONE`.

The expected tool sequence is:

```text
session-status -> send-chat -> session-status -> session-output
                -> send-chat -> session-output
```

Receiving `409 session_busy` during a race is expected; wait and repeat the
status check rather than sending a second command to the same session.
