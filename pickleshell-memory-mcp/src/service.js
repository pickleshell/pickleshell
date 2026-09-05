import { authorize, OPERATIONS } from "./policy.js";

export class MemoryService {
  constructor(config, backend, auditor) { Object.assign(this, { config, backend, auditor }); }

  async call(tool, args = {}) {
    const started = Date.now();
    let scope = null;
    try {
      const decision = authorize(this.config, tool, args);
      scope = decision.scope;
      const result = await this.backend.call(decision.operation, scope, args);
      this.audit(tool, scope, "allowed", "ok", started);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      this.audit(tool, scope, error.code?.includes("denied") ? "denied" : "allowed", "error", started, error.code || "internal_error");
      return { isError: true, content: [{ type: "text", text: JSON.stringify({
        error: error.code || "internal_error", status: error.status || 500,
        retryable: error.retryable === true,
      }) }] };
    }
  }

  async capabilities() {
    const started = Date.now();
    try {
      const health = await this.backend.discover();
      this.audit("memory_capabilities", null, "allowed", "ok", started);
      return { content: [{ type: "text", text: JSON.stringify({
        transport: "stdio", authentication: "operator-launched-process+optional-backend-bearer",
        backend_protocol: "mem0-http-v1", role: this.config.role,
        scope: this.config.role === "agent" ? this.config.scope : "explicit-per-call",
        semantics: "transparent", operations: Object.keys(OPERATIONS), backend: health,
      }) }] };
    } catch (error) {
      this.audit("memory_capabilities", null, "allowed", "error", started, error.code || "internal_error");
      return { isError: true, content: [{ type: "text", text: JSON.stringify({
        error: error.code || "internal_error", status: error.status || 500, retryable: error.retryable === true,
      }) }] };
    }
  }

  audit(tool, scope, decision, outcome, started, error) {
    this.auditor.record({ actor: this.config.actor, role: this.config.role, scope, tool, decision, outcome,
      duration_ms: Date.now() - started, ...(error ? { error } : {}) });
  }
}
