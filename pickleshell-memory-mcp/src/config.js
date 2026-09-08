import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

const ROLES = new Set(["admin", "agent"]);

export function loadConfig(env = process.env) {
  const role = env.PICKLESHELL_MEMORY_ROLE;
  const actor = env.PICKLESHELL_MEMORY_ACTOR;
  const scope = env.PICKLESHELL_MEMORY_SCOPE;
  const auditLog = env.PICKLESHELL_MEMORY_AUDIT_LOG;
  const credentialFile = env.PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE;
  const brokerMode = Boolean(credentialFile);
  let backendUrl;
  try {
    backendUrl = new URL(env.PICKLESHELL_MEMORY_BACKEND_URL || (brokerMode ? "http://127.0.0.1:8767" : "http://127.0.0.1:8766"));
  } catch {
    throw new Error("PICKLESHELL_MEMORY_BACKEND_URL must be a valid HTTP(S) URL");
  }
  if (!ROLES.has(role)) throw new Error("PICKLESHELL_MEMORY_ROLE must be admin or agent");
  if (!actor || actor.length > 200) throw new Error("PICKLESHELL_MEMORY_ACTOR is required (maximum 200 characters)");
  if (role === "agent" && !brokerMode && (!scope || scope.length > 200)) {
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
  if (brokerMode && (role !== "agent" || scope || env.PICKLESHELL_MEMORY_BACKEND_TOKEN)) {
    throw new Error("Principal MCP requires agent role without scope or backend token");
  }
  if (brokerMode && (backendUrl.protocol !== "http:" || backendUrl.hostname !== "127.0.0.1" || (backendUrl.pathname !== "/" || backendUrl.port === "8766"))) {
    throw new Error("Principal MCP requires a loopback broker URL");
  }
  const principalToken = brokerMode ? readPrincipalCredential(credentialFile) : null;
  return Object.freeze({
    brokerMode, principalToken,
    exposeAdmin: brokerMode && env.PICKLESHELL_MEMORY_EXPOSE_ADMIN === "1",
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

function readPrincipalCredential(path) {
  let fd;
  try {
    if (!isAbsolute(path)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || ![0, process.getuid()].includes(stat.uid) || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.size > 129) throw new Error();
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error();
    return token;
  } catch {
    throw new Error("Principal credential file is invalid or inaccessible");
  } finally { if (fd !== undefined) closeSync(fd); }
}
