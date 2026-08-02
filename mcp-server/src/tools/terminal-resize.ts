import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { callTerminal } from "./terminal-common.js";

export const terminalResizeSchema = {
  chat_id: z.string().min(1).max(128).describe("Workspace chat ID"),
  terminal_id: z.string().max(80).regex(/^term_[A-Za-z0-9_-]+$/).describe("Terminal identifier"),
  cols: z.number().int().min(1).max(500).describe("PTY columns"),
  rows: z.number().int().min(1).max(200).describe("PTY rows"),
};

export function registerTerminalResize(mcp: any, client: GatewayClient) {
  mcp.tool("terminal-resize", "Change the PTY window size without writing input.", terminalResizeSchema, (args: Record<string, unknown>) => callTerminal(client, "resize", args));
}
