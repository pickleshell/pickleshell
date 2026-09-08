import { MANAGEMENT_TOOLS } from "./management.js";
import { authorize, OPERATIONS } from "./policy.js";

const MUTATIONS = new Set(["memory_add", "memory_update", "memory_delete", "memory_admin_delete"]);
const PUBLIC_HEALTH_FIELDS = ["status", "provider", "version"];
const MAX_PUBLIC_HEALTH_VALUE_LENGTH = 64;

export class MemoryService {
  constructor(config, backend, auditor) { Object.assign(this, { config, backend, auditor }); }

  async call(tool, args = {}) {
    const started = Date.now();
    let scope = null;
    let result;
    try {
      const decision = authorize(this.config, tool, args);
      scope = decision.scope;
      result = await this.backend.call(decision.operation, scope, args);
    } catch (error) {
      const mutation = MUTATIONS.has(tool);
      const uncertainMutation = mutation && error.mutationOutcomeUncertain === true;
      if (!this.tryAudit(tool, scope, error.policyDenied === true ? "denied" : "allowed", "error", started,
        error.code || "internal_error")) {
        return this.error("audit_failure", 500, false,
          uncertainMutation ? { mutation_outcome: "uncertain" } : {});
      }
      return this.error(error.code || "internal_error", error.status || 500,
        mutation ? false : error.retryable === true,
        uncertainMutation ? { mutation_outcome: "uncertain" } : {});
    }

    if (!this.tryAudit(tool, scope, "allowed", "ok", started)) {
      const mutation = MUTATIONS.has(tool);
      return this.error(mutation ? "audit_failure_after_mutation" : "audit_failure", 500, false,
        mutation ? { mutation_outcome: "uncertain" } : {});
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  async capabilities(args = {}) {
    if (Object.keys(args).length) {
      this.tryAudit("memory_capabilities", null, "denied", "error", Date.now(), "invalid_request");
      return this.error("invalid_request", 400, false);
    }
    const started = Date.now();
    let health;
    try {
      health = await this.backend.discover();
    } catch (error) {
      if (!this.tryAudit("memory_capabilities", null, "allowed", "error", started,
        error.code || "internal_error")) {
        return this.error("audit_failure", 500, false);
      }
      return this.error(error.code || "internal_error", error.status || 500, error.retryable === true);
    }
    if (!this.tryAudit("memory_capabilities", null, "allowed", "ok", started)) {
      return this.error("audit_failure", 500, false);
    }
    return { content: [{ type: "text", text: JSON.stringify({
      transport: "stdio", authentication: this.config.brokerMode ? "principal-credential-broker" : "operator-launched-process+optional-backend-bearer",
      backend_protocol: "mem0-http-v1", role: this.config.role,
      scope: this.config.brokerMode ? "operator-targets" : (this.config.role === "agent" ? this.config.scope : "explicit-per-call"),
      ...(this.config.brokerMode ? publicPrincipal(health) : {}),
      semantics: "transparent", policy_mutation_supported: false, operations: [...Object.keys(OPERATIONS), "memory_capabilities", ...(this.config.brokerMode ? ["memory_list_targets"] : []), ...(this.config.exposeAdmin && health?.broker?.role === "admin" ? Object.keys(MANAGEMENT_TOOLS).filter(t => t.startsWith("memory_admin_")) : [])], backend: publicBackendHealth(health),
    }) }] };
  }

  error(code, status, retryable, extra = {}) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({
      error: code, status, retryable, ...extra,
    }) }] };
  }

  tryAudit(...args) {
    try {
      this.audit(...args);
      return true;
    } catch {
      return false;
    }
  }

  audit(tool, scope, decision, outcome, started, error) {
    this.auditor.record({ actor: this.config.actor, role: this.config.role, scope, tool, decision, outcome,
      duration_ms: Date.now() - started, ...(error ? { error } : {}) });
  }
}

function publicBackendHealth(health) {
  const result = {};
  if (!health || typeof health !== "object" || Array.isArray(health)) return result;
  for (const field of PUBLIC_HEALTH_FIELDS) {
    const value = health[field];
    if (typeof value === "string" && value.length <= MAX_PUBLIC_HEALTH_VALUE_LENGTH) result[field] = value;
  }
  return result;
}

function publicPrincipal(health) {
  const broker = health?.broker;
  if (!broker || !/^[a-z][a-z0-9_-]{0,63}$/.test(broker.principal) || !Array.isArray(broker.targets)) return {};
  return { broker_health: "ok", default_target: "private", principal: broker.principal, role: broker.role === "admin" ? "admin" : "agent", targets: broker.targets.slice(0, 65).filter((g) => g &&
    typeof g.target === "string" && /^(private|shared\/[a-z][a-z0-9_/-]{0,120})$/.test(g.target) &&
    typeof g.read === "boolean" && typeof g.write === "boolean").map(({target, scope, read, write}) => ({target, ...(typeof scope === "string" && /^[A-Za-z0-9][A-Za-z0-9_:./-]{0,199}$/.test(scope) ? {scope} : {}), read, write})) };
}
