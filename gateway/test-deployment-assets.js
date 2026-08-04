const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function assertIncludes(text, needle, label) {
  assert.ok(text.includes(needle), `${label}: missing ${needle}`);
}

function modelIdsFromDocs(markdown) {
  const match = markdown.match(/## Maintained Allowed Model IDs\n\n```text\n([\s\S]*?)\n```/);
  assert.ok(match, "docs/models.md contains maintained model ID block");
  return match[1].trim().split(/\n/).filter(Boolean);
}

const config = JSON.parse(read("gateway/config.example.json"));
const modelsDoc = read("docs/models.md");
assert.deepStrictEqual(
  modelIdsFromDocs(modelsDoc),
  config.allowed_models,
  "docs/models.md model IDs match gateway/config.example.json"
);

assertIncludes(read("README.md"), "[Model allowlist](docs/models.md)", "README documentation links");

const gatewayService = read("gateway/systemd/pickleshell-gateway.service");
for (const line of [
  "Environment=HOME=/var/lib/pickleshell/agent-home",
  "Environment=XDG_CONFIG_HOME=/var/lib/pickleshell/config",
  "Environment=XDG_DATA_HOME=/var/lib/pickleshell/data",
  "Environment=XDG_STATE_HOME=/var/lib/pickleshell/state",
  "Environment=XDG_CACHE_HOME=/var/cache/pickleshell/opencode",
  "Environment=CODEX_HOME=/var/lib/pickleshell/agent-home/.codex",
  "Environment=OPENCODE_CONFIG_DIR=/var/lib/pickleshell/config/opencode",
  "Environment=NPM_CONFIG_CACHE=/var/cache/pickleshell/npm",
  "NoNewPrivileges=true",
]) {
  assertIncludes(gatewayService, line, "gateway systemd template");
}

const tunnelService = read("mcp-server/systemd/pickleshell-tunnel.service");
for (const line of [
  "Environment=HOME=/var/lib/pickleshell/mcp-home",
  "Environment=XDG_CACHE_HOME=/var/cache/pickleshell/mcp",
  "Environment=PLAYWRIGHT_BROWSERS_PATH=/var/cache/pickleshell/ms-playwright",
  "ReadWritePaths=/var/lib/pickleshell/mcp-home",
  "ReadWritePaths=/var/cache/pickleshell/mcp",
  "NoNewPrivileges=true",
]) {
  assertIncludes(tunnelService, line, "tunnel systemd template");
}

assertIncludes(read("mcp-server/.env.example"), "PLAYWRIGHT_BROWSERS_PATH=/var/cache/pickleshell/ms-playwright", "MCP env example");

const terminalService = read("terminal/systemd/pickleshell-terminal.service");
assertIncludes(terminalService, "NoNewPrivileges=true", "ordinary Terminal service");
const terminalConfig = JSON.parse(read("terminal/config.example.json"));
assert.deepStrictEqual(
  {
    maxTerminals: terminalConfig.maxTerminals,
    ringBytes: terminalConfig.ringBytes,
    ttlMs: terminalConfig.ttlMs,
  },
  { maxTerminals: 8, ringBytes: 1048576, ttlMs: 1800000 },
  "Terminal example keeps conservative defaults"
);

const deployment = read("docs/deployment.md");
for (const text of [
  "maxTerminals: 32",
  "ringBytes: 16777216",
  "ttlMs:",
  "86400000",
  "Codex returns `401`",
  "OpenCode exits `127`",
  "Services are healthy locally but ChatGPT still shows stale tools",
]) {
  assertIncludes(deployment, text, "deployment guidance");
}

for (const file of ["AGENTS.md", "docs/deployment.md", "docs/models.md"]) {
  const text = read(file).toLowerCase();
  for (const forbidden of ["b" + "ee", "b" + "os", "pickleshell" + "-main", "019" + "fcc"]) {
    assert.ok(!text.includes(forbidden), `${file}: host-specific detail leaked: ${forbidden}`);
  }
}

console.log("Deployment asset tests passed");
