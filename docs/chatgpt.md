# Connect ChatGPT

Prerequisites:

- an OpenAI account and workspace that support custom MCP apps;
- Developer mode enabled;
- a Secure MCP Tunnel created in the OpenAI Platform;
- `tunnel-client` running on the PickleShell host.

## Create the plugin

Create a ChatGPT plugin named `PickleShell`, select the configured tunnel, and
allow the `send-chat` action.

![Create the PickleShell plugin in ChatGPT](assets/plugin-create.png)

## Verify the connected plugin

The connected PickleShell entry should show the `send-chat` action and the
current schema.

![Connected PickleShell plugin and send-chat action](assets/plugin-connected.png)

## Refresh after schema changes

After changing the MCP schema:

1. open the app's action controls;
2. select **Refresh**;
3. review the action diff;
4. enable the updated action;
5. start a new conversation.

## Test the connection

Test:

```text
Use PickleShell.
chat_id: pickleshell-main
message: Reply with exactly: pong. Do not use tools or modify files.
```

For continued work, pass the `session_id` returned by the previous call. Use a
different session for unrelated work.
