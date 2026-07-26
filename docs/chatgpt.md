# Connect ChatGPT

Prerequisites:

- an OpenAI account and workspace that support custom MCP apps;
- Developer mode enabled;
- a Secure MCP Tunnel created in the OpenAI Platform;
- `tunnel-client` running on the PickleShell host.

Create a ChatGPT app named `PickleShell`, select the configured tunnel, and
allow the `send-chat` action.

After changing the MCP schema:

1. open the app's action controls;
2. select **Refresh**;
3. review the action diff;
4. enable the updated action;
5. start a new conversation.

Test:

```text
Use PickleShell.
chat_id: pickleshell-main
message: Reply with exactly: pong. Do not use tools or modify files.
```

For continued work, pass the `session_id` returned by the previous call. Use a
different session for unrelated work.
