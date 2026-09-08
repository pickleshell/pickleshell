import { MANAGEMENT_TOOLS, managementOperation } from "./management.js";
export const OPERATIONS = Object.freeze({
  memory_add: { method: "POST", path: "/memories", body: ["text", "infer"] },
  memory_search: { method: "POST", path: "/search", body: ["query", "limit"] },
  memory_list: { method: "GET", path: "/memories", query: ["limit"] },
  memory_get: { method: "GET", path: "/memories/{memory_id}" },
  memory_update: { method: "PUT", path: "/memories/{memory_id}", body: ["text"] },
  memory_delete: { method: "DELETE", path: "/memories/{memory_id}" },
  memory_history: { method: "GET", path: "/memories/{memory_id}/history" },
});

export function authorize(config, tool, args) {
  if (Object.hasOwn(MANAGEMENT_TOOLS, tool)) {
    if (!config.brokerMode || (tool.startsWith("memory_admin_") && !config.exposeAdmin)) {
      throw policyError("admin_required", "Trusted broker administration is required");
    }
    const schema = MANAGEMENT_TOOLS[tool].schema;
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(schema, k))) {
      throw policyError("invalid_request", "Unexpected management argument");
    }
    return { operation: managementOperation(tool), scope: null };
  }
  const operation = OPERATIONS[tool];
  if (!operation) throw policyError("unknown_tool", `Unknown memory tool: ${tool}`);
  const suppliedScope = args.user_id;
  if (config.role === "agent" && ["user_id", "principal", "agent_id", "namespace", "scope", "actor"].some((key) => Object.hasOwn(args, key))) {
    throw policyError("scope_override_denied", "Agent requests may not supply user_id");
  }
  if (config.role === "admin" && (typeof suppliedScope !== "string" || !suppliedScope)) {
    throw policyError("scope_required", "Admin requests must supply an explicit user_id");
  }
  if (config.role === "agent" && args.target !== undefined && (!config.brokerMode || typeof args.target !== "string" || !/^(private|shared\/[a-z][a-z0-9_/-]{0,120})$/.test(args.target))) {
    throw policyError("target_access_denied", "Invalid memory target");
  }
  if (config.brokerMode) {
    const allowed = new Set(["target", ...(operation.body || []), ...(operation.query || []), ...(operation.path.includes("{memory_id}") ? ["memory_id"] : [])]);
    if (Object.keys(args).some(key => !allowed.has(key))) throw policyError("invalid_request", "Unexpected memory argument");
    return { operation, scope: args.target || "private" };
  }
  return { operation, scope: config.role === "agent" ? config.scope : suppliedScope };
}

function policyError(code, message) {
  return Object.assign(new Error(message), { code, status: 403, retryable: false, policyDenied: true });
}
