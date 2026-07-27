import { registerSendChat } from "./src/tools/send-chat.js";

let handler: ((args: { chat_id: string; message: string; session_id?: string }) => Promise<any>) | undefined;
const mcp = {
  tool: (_name: string, _description: string, _schema: unknown, toolHandler: typeof handler) => {
    handler = toolHandler;
  },
};

// --- Test 1: Sync fallback (legacy, no state field) ---
const syncClient = {
  chat: async () => ({
    ok: true,
    chat_id: "pickleshell-main",
    session_id: "ses_test123",
    reply: "PONG_TEST",
    trace: ["✓ reply: PONG_TEST"],
  }),
};

registerSendChat(mcp, syncClient as never);
if (!handler) throw new Error("send-chat handler was not registered");

const syncResult = await handler({ chat_id: "pickleshell-main", message: "ping" });
const syncPayload = JSON.parse(syncResult.content[0].text);
if (syncPayload.session_id !== "ses_test123" || syncPayload.state !== "completed" ||
    syncPayload.output !== "PONG_TEST" || syncPayload.trace.length !== 1) {
  throw new Error(`Unexpected sync payload: ${syncResult.content[0].text}`);
}

console.log("MCP send-chat sync fallback test: passed");

// --- Test 2: Async busy response ---
let asyncHandler: typeof handler;
const asyncMcp = {
  tool: (_name: string, _description: string, _schema: unknown, toolHandler: typeof handler) => {
    asyncHandler = toolHandler;
  },
};

const asyncClient = {
  chat: async () => ({
    ok: true,
    chat_id: "pickleshell-main",
    request_id: "req_abc123",
    session_id: "ses_async456",
    state: "busy",
  }),
};

registerSendChat(asyncMcp, asyncClient as never);
if (!asyncHandler) throw new Error("async handler was not registered");

const asyncResult = await asyncHandler({
  chat_id: "pickleshell-main",
  message: "build something",
  session_id: "ses_async456",
});
const asyncPayload = JSON.parse(asyncResult.content[0].text);
if (asyncPayload.state !== "busy" || asyncPayload.request_id !== "req_abc123" ||
    asyncPayload.session_id !== "ses_async456" ||
    !asyncPayload.notification || !asyncPayload.notification.includes("req_abc123")) {
  throw new Error(`Unexpected async payload: ${asyncResult.content[0].text}`);
}

console.log("MCP send-chat async busy test: passed");

// --- Test 3: 409 busy response ---
let busyHandler: typeof handler;
const busyMcp = {
  tool: (_name: string, _description: string, _schema: unknown, toolHandler: typeof handler) => {
    busyHandler = toolHandler;
  },
};

const { GatewayError } = await import("./src/gateway-client.js");

const busyClient = {
  chat: async () => { throw new GatewayError(409, { error: "session_busy", current_task: "building", elapsed_s: 42 }); },
};

registerSendChat(busyMcp, busyClient as never);
if (!busyHandler) throw new Error("busy handler was not registered");

const busyResult = await busyHandler({
  chat_id: "pickleshell-main",
  message: "another command",
  session_id: "ses_busy789",
});
const busyPayload = JSON.parse(busyResult.content[0].text);
if (busyPayload.state !== "busy" || busyPayload.error !== "session_busy" ||
    busyPayload.current_task !== "building" || busyPayload.elapsed_s !== 42) {
  throw new Error(`Unexpected busy payload: ${busyResult.content[0].text}`);
}

console.log("MCP send-chat 409 busy test: passed");
