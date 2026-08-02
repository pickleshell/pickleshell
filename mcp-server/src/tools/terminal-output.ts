import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { callTerminal } from "./terminal-common.js";

export const terminalOutputSchema = {
  chat_id: z.string().min(1).max(128).describe("Workspace chat ID"),
  terminal_id: z.string().max(80).regex(/^term_[A-Za-z0-9_-]+$/).describe("Terminal identifier"),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().default(0).describe("Exclusive byte cursor"),
  max_bytes: z.number().int().min(1).max(65536).optional().default(16384).describe("Maximum output bytes"),
  wait_ms: z.number().int().min(0).max(30000).optional().default(0).describe("Long-poll duration"),
};

export function registerTerminalOutput(mcp: any, client: GatewayClient) {
  mcp.tool("terminal-output", "Read retained incremental PTY output and terminal state.", terminalOutputSchema, (args: Record<string, unknown>) => callTerminal(client, "output", args));
}
