import assert from "node:assert/strict";
import { GatewayError } from "./src/gateway-client.js";
import { registerSettings, settingsSchema, SETTINGS_TOOL_DESCRIPTION } from "./src/tools/settings.js";
import { sendChatSchema, registerSendChat } from "./src/tools/send-chat.js";

let passed = 0;
function check(value: boolean, message: string) { assert.equal(value, true, message); passed++; }
function parse(result: any) { return JSON.parse(result.content[0].text); }

const calls: any[] = [];
const client: any = {
  async getSettings() { calls.push(["get"]); return { ok: true, revision: 4 }; },
  async updateSettings(...args: any[]) { calls.push(["update", ...args]); return { ok: true, revision: 5 }; },
};
let handler: any;
let registeredDescription = "";
registerSettings({ tool(_name: string, description: string, _schema: unknown, callback: any) { registeredDescription = description; handler = callback; } }, client);
check(registeredDescription === SETTINGS_TOOL_DESCRIPTION && registeredDescription.includes("Omit chat_id") && registeredDescription.includes("chat_id for that configured chat's overrides"), "settings description documents both scopes and precedence");
check(settingsSchema.safeParse({ action: "describe" }).success, "global describe omits chat_id");
check(settingsSchema.safeParse({ action: "get", chat_id: "chat" }).success, "chat_id is optional");
check(!settingsSchema.safeParse({ action: "get", unexpected: true }).success, "unknown top-level key rejected");
check(!settingsSchema.safeParse({ action: "set", settings: { runtime: "opencode", unexpected: true } }).success, "unknown setting key rejected");
check(!settingsSchema.safeParse({ action: "set", settings: { agent_timeout_sec: 0 } }).success, "timeout lower bound rejected");
check(settingsSchema.safeParse({ action: "set", settings: { codex_transport: "mcp" }, expected_revision: 3 }).success, "valid global set accepted");

check(parse(await handler({ action: "describe" })).ok, "describe calls Gateway GET");
await handler({ action: "get" });
await handler({ action: "set", settings: { runtime: "opencode" }, expected_revision: 4 });
check(calls[2][0] === "update" && calls[2][1] === undefined && calls[2][2] === "set" && calls[2][5] === 4, "set forwards global revision");
await handler({ action: "reset" });
check(Array.isArray(calls[3][4]) && calls[3][4].length === 4, "empty reset means all global names");

const errorClient: any = { async getSettings() { throw new GatewayError(409, { error: "revision_conflict", details: "conflict" }); } };
let errorHandler: any;
registerSettings({ tool(_n: string, _d: string, _s: unknown, callback: any) { errorHandler = callback; } }, errorClient);
const errorResult = await errorHandler({ action: "get", chat_id: "chat" });
check(errorResult.isError === true && parse(errorResult).status === 409 && parse(errorResult).error === "revision_conflict", "Gateway status and structured error preserved");

check(sendChatSchema.agent_timeout_sec.safeParse(86400).success, "send-chat timeout accepted");
check(sendChatSchema.codex_transport.safeParse("exec").success, "send-chat transport accepted");
check(!sendChatSchema.codex_transport.safeParse("other").success, "send-chat transport rejected");

let sendHandler: any;
const forwarded: any[] = [];
registerSendChat({ tool(_n: string, _d: string, _s: unknown, callback: any) { sendHandler = callback; } }, {
  async chat(request: any) { forwarded.push(request); return { ok: true, chat_id: request.chat_id, request_id: "req_test", session_id: null, state: "busy", next_action: "session-status", retry_after_ms: 1 }; },
} as any);
await sendHandler({ chat_id: "chat", message: "hello", agent_timeout_sec: 10, codex_transport: "mcp" });
check(forwarded[0].agent_timeout_sec === 10 && forwarded[0].codex_transport === "mcp", "send-chat forwards explicit settings");

const originalFetch = globalThis.fetch;
let fetched: string[] = [];
globalThis.fetch = (async (input: any) => { fetched.push(String(input)); return new Response(JSON.stringify({ ok: true, revision: 0, persisted: {}, effective: {} }), { status: 200 }); }) as typeof fetch;
const { GatewayClient } = await import("./src/gateway-client.js");
const gateway = new GatewayClient({ url: "http://gateway", api_key: "test", timeout_ms: 1000 });
await gateway.getSettings();
await gateway.getSettings("chat id");
globalThis.fetch = originalFetch;
check(fetched[0] === "http://gateway/settings" && fetched[1] === "http://gateway/settings/chat%20id", "global and chat URLs are correct and encoded");

console.log(`MCP scoped settings tool tests: ${passed} passed`);
