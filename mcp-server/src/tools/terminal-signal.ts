import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { callTerminal } from "./terminal-common.js";

export const terminalSignalSchema = {
  chat_id: z.string().min(1).max(128).describe("Workspace chat ID"),
  terminal_id: z.string().max(80).regex(/^term_[A-Za-z0-9_-]+$/).describe("Terminal identifier"),
  signal: z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGCONT"]).describe("Signal sent to the terminal process group"),
};

export function registerTerminalSignal(mcp: any, client: GatewayClient) {
  mcp.tool("terminal-signal", "Send an allowed signal to the terminal process group.", terminalSignalSchema, (args: Record<string, unknown>) => callTerminal(client, "signal", args));
}
