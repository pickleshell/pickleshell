import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GatewayError, type GatewayClient } from "../gateway-client.js";

export function terminalResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

export async function callTerminal(client: GatewayClient, operation: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return terminalResult(await client.terminal(operation, args));
  } catch (error) {
    if (error instanceof GatewayError) {
      const code = error.payload.error || "internal_error";
      const details: Record<string, string> = {
        invalid_request: "Terminal request is invalid",
        terminal_not_found: "Terminal was not found",
        terminal_unavailable: "Terminal service is unavailable",
        terminal_cgroup_unavailable: "Terminal cgroup lifecycle is unavailable",
        terminal_closed: "Terminal is closed",
        terminal_not_writable: "Terminal is not writable",
        idempotency_unsupported: "Idempotency is not supported for terminal-write",
        terminal_write_outcome_unknown: "Write outcome is unknown; do not retry automatically",
      };
      return terminalResult({ ok: false, error: code, details: details[code] || "Terminal request failed" }, true);
    }
    return terminalResult({ ok: false, error: "terminal_unavailable", details: "Terminal service is unavailable" }, true);
  }
}
