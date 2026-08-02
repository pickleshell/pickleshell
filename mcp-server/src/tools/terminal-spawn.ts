import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { callTerminal } from "./terminal-common.js";

export const terminalSpawnSchema = {
  chat_id: z.string().min(1).max(128).describe("Workspace chat ID"),
  executable: z.string().optional().describe("Allowed executable; defaults to /bin/bash"),
  argv: z.array(z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 4096, "argument must be at most 4096 bytes")).max(32).optional().describe("Arguments excluding argv[0]"),
  cwd: z.string().optional().describe("Relative working directory under the allowed workspace"),
  env: z.record(z.string()).refine((value) => Object.keys(value).length <= 32, "at most 32 environment variables").optional().describe("Allowlisted environment variables"),
  cols: z.number().int().min(1).max(500).optional().default(80).describe("PTY columns"),
  rows: z.number().int().min(1).max(200).optional().default(24).describe("PTY rows"),
  idempotency_key: z.string().min(1).max(128).optional().describe("Retry key for spawn"),
};

export function registerTerminalSpawn(mcp: any, client: GatewayClient) {
  mcp.tool("terminal-spawn", "Start a persistent interactive PTY terminal.", terminalSpawnSchema, (args: Record<string, unknown>) => callTerminal(client, "spawn", args));
}
