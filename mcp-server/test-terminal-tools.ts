import assert from "node:assert/strict";
import { z } from "zod";
import { terminalSpawnSchema } from "./src/tools/terminal-spawn.js";
import { terminalWriteSchema } from "./src/tools/terminal-write.js";
import { terminalOutputSchema } from "./src/tools/terminal-output.js";
import { terminalResizeSchema } from "./src/tools/terminal-resize.js";
import { terminalSignalSchema } from "./src/tools/terminal-signal.js";
import { terminalCloseSchema } from "./src/tools/terminal-close.js";
import { GatewayError } from "./src/gateway-client.js";
import { callTerminal } from "./src/tools/terminal-common.js";

assert.equal(z.object(terminalSpawnSchema).safeParse({ chat_id: "chat" }).success, true);
assert.equal(z.object(terminalWriteSchema).safeParse({ chat_id: "chat", terminal_id: "term_x", data: "aGk=" }).success, true);
assert.equal(z.object(terminalWriteSchema).safeParse({ chat_id: "chat", terminal_id: "term_x", data: "AA==" }).success, true);
assert.equal(z.object(terminalWriteSchema).safeParse({ chat_id: "chat", terminal_id: "term_x", data: "/w==" }).success, false);
assert.equal(z.object(terminalWriteSchema).safeParse({ chat_id: "chat", terminal_id: "term_x", data: "not-base64" }).success, false);
assert.equal(z.object(terminalOutputSchema).safeParse({ chat_id: "chat", terminal_id: "term_x" }).success, true);
assert.equal(z.object(terminalResizeSchema).safeParse({ chat_id: "chat", terminal_id: "term_x", cols: 80, rows: 24 }).success, true);
assert.equal(z.object(terminalSignalSchema).safeParse({ chat_id: "chat", terminal_id: "term_x", signal: "SIGKILL" }).success, false);
assert.equal(z.object(terminalCloseSchema).safeParse({ chat_id: "chat", terminal_id: "term_x" }).success, true);

const errorClient = { terminal: async () => { throw new GatewayError(409, { error: "idempotency_unsupported" }); } };
const errorResult = await callTerminal(errorClient as any, "write", {});
assert.equal(errorResult.isError, true);
assert.equal(JSON.parse(String(errorResult.content[0].text)).error, "idempotency_unsupported");
assert.equal(JSON.parse(String(errorResult.content[0].text)).details, "Idempotency is not supported for terminal-write");

const unknownClient = { terminal: async () => { throw new GatewayError(504, { error: "terminal_write_outcome_unknown" }); } };
const unknownResult = await callTerminal(unknownClient as any, "write", {});
assert.equal(JSON.parse(String(unknownResult.content[0].text)).error, "terminal_write_outcome_unknown");
console.log("Terminal tool schema tests passed");
