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
  const operation = OPERATIONS[tool];
  if (!operation) throw policyError("unknown_tool", `Unknown memory tool: ${tool}`);
  const suppliedScope = args.user_id;
  if (config.role === "agent" && suppliedScope !== undefined) {
    throw policyError("scope_override_denied", "Agent requests may not supply user_id");
  }
  if (config.role === "admin" && (typeof suppliedScope !== "string" || !suppliedScope)) {
    throw policyError("scope_required", "Admin requests must supply an explicit user_id");
  }
  return { operation, scope: config.role === "agent" ? config.scope : suppliedScope };
}

function policyError(code, message) {
  return Object.assign(new Error(message), { code, status: 403, retryable: false });
}
