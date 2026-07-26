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

## 8. Test the connection

Test:

```text
Use PickleShell.
chat_id: pickleshell-main
message: Reply with exactly: pong. Do not use tools or modify files.
```

For continued work, pass the `session_id` returned by the previous call. Use a
different session for unrelated work.
