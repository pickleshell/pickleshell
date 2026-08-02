import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { callTerminal } from "./terminal-common.js";

export const terminalCloseSchema = {
  chat_id: z.string().min(1).max(128).describe("Workspace chat ID"),
  terminal_id: z.string().max(80).regex(/^term_[A-Za-z0-9_-]+$/).describe("Terminal identifier"),
  reason: z.string().min(1).max(64).optional().describe("Close reason"),
};

export function registerTerminalClose(mcp: any, client: GatewayClient) {
  mcp.tool("terminal-close", "Explicitly close a persistent PTY terminal and reap its process group.", terminalCloseSchema, (args: Record<string, unknown>) => callTerminal(client, "close", args));
}
