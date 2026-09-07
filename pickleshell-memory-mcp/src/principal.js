#!/usr/bin/env node
// Operator wires these two paths in the runtime MCP configuration. No identity
// string or backend credential is accepted. OS file access selects the principal.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./index.js";
import { loadConfig } from "./config.js";

try {
  if (process.argv.length !== 4 || process.env.PICKLESHELL_MEMORY_BACKEND_TOKEN) {
    throw new Error("Expected principal credential path and audit path, without backend token");
  }
  const config = loadConfig({
    PICKLESHELL_MEMORY_ROLE: "agent",
    PICKLESHELL_MEMORY_ACTOR: "principal-client",
    PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE: process.argv[2],
    PICKLESHELL_MEMORY_AUDIT_LOG: process.argv[3],
    PICKLESHELL_MEMORY_BACKEND_URL: "http://127.0.0.1:8767",
  });
  await createServer(config).connect(new StdioServerTransport());
} catch {
  console.error("Principal MCP startup failed: check credential, audit path and environment");
  process.exitCode = 1;
}
