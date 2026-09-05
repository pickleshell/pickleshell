import { isAbsolute } from "node:path";

const ROLES = new Set(["admin", "agent"]);

export function loadConfig(env = process.env) {
  const role = env.PICKLESHELL_MEMORY_ROLE;
  const actor = env.PICKLESHELL_MEMORY_ACTOR;
  const scope = env.PICKLESHELL_MEMORY_SCOPE;
  const auditLog = env.PICKLESHELL_MEMORY_AUDIT_LOG;
  let backendUrl;
  try {
    backendUrl = new URL(env.PICKLESHELL_MEMORY_BACKEND_URL || "http://127.0.0.1:8765");
  } catch {
    throw new Error("PICKLESHELL_MEMORY_BACKEND_URL must be a valid HTTP(S) URL");
  }
  if (!ROLES.has(role)) throw new Error("PICKLESHELL_MEMORY_ROLE must be admin or agent");
  if (!actor || actor.length > 200) throw new Error("PICKLESHELL_MEMORY_ACTOR is required (maximum 200 characters)");
  if (role === "agent" && (!scope || scope.length > 200)) {
    throw new Error("PICKLESHELL_MEMORY_SCOPE is required for agent role (maximum 200 characters)");
  }
  if (role === "admin" && scope) throw new Error("PICKLESHELL_MEMORY_SCOPE must be unset for admin role");
  if (!auditLog || !isAbsolute(auditLog)) throw new Error("PICKLESHELL_MEMORY_AUDIT_LOG must be an absolute path");
  if (!new Set(["http:", "https:"]).has(backendUrl.protocol) || backendUrl.username || backendUrl.password) {
    throw new Error("PICKLESHELL_MEMORY_BACKEND_URL must be credential-free HTTP(S)");
  }
  if (backendUrl.search || backendUrl.hash) {
    throw new Error("PICKLESHELL_MEMORY_BACKEND_URL must not include a query or fragment");
  }
  return Object.freeze({
    role, actor, scope: role === "agent" ? scope : null,
    auditLog, backendUrl: backendUrl.href.replace(/\/$/, ""),
    backendToken: env.PICKLESHELL_MEMORY_BACKEND_TOKEN || null,
    timeoutMs: parsePositiveInt(env.PICKLESHELL_MEMORY_TIMEOUT_MS || "10000", "PICKLESHELL_MEMORY_TIMEOUT_MS"),
  });
}

function parsePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 120000) {
    throw new Error(`${name} must be an integer from 1 to 120000`);
  }
  return parsed;
}
