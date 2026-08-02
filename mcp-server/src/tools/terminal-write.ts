import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { callTerminal } from "./terminal-common.js";

export const terminalWriteSchema = {
  chat_id: z.string().min(1).max(128).describe("Workspace chat ID"),
  terminal_id: z.string().max(80).regex(/^term_[A-Za-z0-9_-]+$/).describe("Terminal identifier"),
  data: z.string().min(1).max(87384).refine((value) => { try { const b = Buffer.from(value, "base64"); return b.length >= 1 && b.length <= 65536 && b.toString("base64") === value; } catch { return false; } }, "data must be canonical Base64 for 1-65536 bytes").describe("Exact Base64-encoded bytes to write; no newline is added"),
  idempotency_key: z.string().min(1).max(128).optional().describe("Rejected for this non-idempotent operation"),
};

export function registerTerminalWrite(mcp: any, client: GatewayClient) {
  mcp.tool("terminal-write", "Write exact bytes to a persistent PTY terminal.", terminalWriteSchema, (args: Record<string, unknown>) => callTerminal(client, "write", args));
}
