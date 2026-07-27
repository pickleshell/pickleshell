import { registerSendChat } from "./src/tools/send-chat.js";

let handler: ((args: { chat_id: string; message: string }) => Promise<any>) | undefined;
const mcp = {
  tool: (_name: string, _description: string, _schema: unknown, toolHandler: typeof handler) => {
    handler = toolHandler;
  },
};

const client = {
  chat: async () => ({
    ok: true,
    chat_id: "pickleshell-main",
    session_id: "ses_test123",
    reply: "PONG_TEST",
    trace: ["✓ reply: PONG_TEST"],
  }),
};

registerSendChat(mcp, client as never);
if (!handler) throw new Error("send-chat handler was not registered");

const result = await handler({ chat_id: "pickleshell-main", message: "ping" });
const payload = JSON.parse(result.content[0].text);
if (payload.session_id !== "ses_test123" || payload.state !== "completed" ||
    payload.output !== "PONG_TEST" || payload.trace.length !== 1) {
  throw new Error(`Unexpected send-chat payload: ${result.content[0].text}`);
}

console.log("MCP send-chat response metadata test: passed");
