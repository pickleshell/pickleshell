import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GatewayError, type GatewayClient } from "../gateway-client.js";
import type { GatewaySettings, MutableSettingName } from "../types.js";

export const mutableSettingNames = ["runtime", "model", "agent_timeout_sec", "codex_transport"] as const;
export const SETTINGS_TOOL_DESCRIPTION =
  "Describe, get, set, or reset settings. Omit chat_id for instance-global settings; provide chat_id for that configured chat's overrides. " +
  "Precedence is explicit request > chat override > global setting > static config > default. " +
  "Mutable names are runtime, model, agent_timeout_sec, and codex_transport; operator policy remains immutable.";

export const settingsValuesSchema = z.object({
  runtime: z.enum(["opencode", "codex"]).optional(),
  model: z.string().min(1).nullable().optional(),
  agent_timeout_sec: z.number().int().min(1).max(86400).optional(),
  codex_transport: z.enum(["exec", "mcp"]).optional(),
}).strict();

export const settingsSchema = z.object({
  action: z.enum(["describe", "get", "set", "reset"]),
  chat_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "chat_id must contain only letters, numbers, _, or -").optional(),
  settings: settingsValuesSchema.optional(),
  names: z.array(z.enum(mutableSettingNames)).optional(),
  expected_revision: z.number().int().nonnegative().optional(),
}).strict();

function result(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function gatewayError(error: unknown): CallToolResult {
  if (error instanceof GatewayError) {
    return result({ ok: false, status: error.status, ...error.payload }, true);
  }
  return result({ ok: false, status: 503, error: "settings_unavailable", details: "Settings service is unavailable" }, true);
}

export function registerSettings(mcp: any, client: GatewayClient) {
  mcp.tool(
    "settings",
    SETTINGS_TOOL_DESCRIPTION,
    settingsSchema,
    async (rawArgs: unknown): Promise<CallToolResult> => {
      const parsed = settingsSchema.safeParse(rawArgs);
      if (!parsed.success) return result({ ok: false, error: "invalid_request", details: parsed.error.flatten() }, true);
      const args = parsed.data;
      try {
        if (args.action === "describe" || args.action === "get") {
          return result(await client.getSettings(args.chat_id));
        }
        if (args.action === "set") {
          if (!args.settings) return result({ ok: false, error: "invalid_request", details: "settings is required for set" }, true);
          return result(await client.updateSettings(args.chat_id, "set", args.settings as GatewaySettings, undefined, args.expected_revision));
        }
        const names = (args.names && args.names.length > 0 ? args.names : [...mutableSettingNames]) as MutableSettingName[];
        return result(await client.updateSettings(args.chat_id, "reset", undefined, names, args.expected_revision));
      } catch (error) {
        return gatewayError(error);
      }
    },
  );
}
