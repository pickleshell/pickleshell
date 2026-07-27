import { GatewayError } from "./src/gateway-client.js";
import { registerSendChat } from "./src/tools/send-chat.js";

let handler: ((args: {
  chat_id: string;
  message: string;
  session_id?: string;
}) => Promise<{ content: Array<{ type: string; text: string }> }>) | undefined;

const mcp = {
  tool: (
    _name: string,
    _description: string,
    _schema: unknown,
    toolHandler: typeof handler
  ) => {
    handler = toolHandler;
  },
};

const client = {
  chat: async () => {
    throw new GatewayError(409, {
      error: "session_busy",
      current_task: "Build forecast widget",
      elapsed_s: 12,
    });
  },
};

registerSendChat(mcp, client as never);

if (!handler) {
  throw new Error("send-chat handler was not registered");
}

const result = await handler({
  chat_id: "pickleshell-main",
  message: "Run another task",
  session_id: "session-a",
});

const text = result.content[0]?.text;
const payload = JSON.parse(text || "{}");
if (payload.state !== "rejected" || payload.error !== "session_busy" ||
    payload.current_task !== "Build forecast widget" || payload.elapsed_s !== 12 ||
    payload.next_action !== "session-status" || payload.retry_after_ms !== 2000) {
  throw new Error(`Unexpected busy notification: ${text}`);
}

console.log("MCP busy notification test: passed");
