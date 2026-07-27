import { GatewayError, GatewayClient } from "./src/gateway-client.js";
import { loadConfig } from "./src/config.js";
import { sendChatSchema } from "./src/tools/send-chat.js";
import { sessionStatusSchema } from "./src/tools/session-status.js";
import { sessionOutputSchema } from "./src/tools/session-output.js";

let failed = 0;
let passed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

// ============================================================
// GatewayError
// ============================================================
console.log("\n=== GatewayError ===");

{
  const err = new GatewayError(401, { error: "unauthorized" });
  assert(err.status === 401, "status is 401");
  assert(err.payload.error === "unauthorized", "payload.error is unauthorized");
  assert(err.message.includes("401"), "message includes status code");
  assert(err.name === "GatewayError", "name is GatewayError");
  assert(err instanceof Error, "instanceof Error");
}

{
  const err = new GatewayError(502, { error: "agent_error", current_task: "running" });
  assert(err.payload.current_task === "running", "payload.current_task preserved");
}

{
  const err = new GatewayError(409, {});
  assert(err.message.includes("request_failed"), "fallback error string in message");
}

// ============================================================
// loadConfig
// ============================================================
console.log("\n=== loadConfig ===");

{
  const origUrl = process.env.PICKLESHELL_GATEWAY_URL;
  const origKey = process.env.PICKLESHELL_API_KEY;
  const origAltUrl = process.env.LOCALAGENT_GATEWAY_URL;
  const origAltKey = process.env.LOCALAGENT_API_KEY;
  const origTimeout = process.env.PICKLESHELL_TIMEOUT_MS;

  // Test: missing URL throws
  delete process.env.PICKLESHELL_GATEWAY_URL;
  delete process.env.LOCALAGENT_GATEWAY_URL;
  process.env.PICKLESHELL_API_KEY = "test-key";
  try {
    loadConfig();
    assert(false, "throws when URL missing");
  } catch (e: any) {
    assert(e.message.includes("Missing required env vars"), "error mentions missing env vars");
  }

  // Test: missing API key throws
  process.env.PICKLESHELL_GATEWAY_URL = "http://localhost:18092";
  delete process.env.PICKLESHELL_API_KEY;
  delete process.env.LOCALAGENT_API_KEY;
  try {
    loadConfig();
    assert(false, "throws when API key missing");
  } catch (e: any) {
    assert(e.message.includes("Missing required env vars"), "error mentions missing env vars");
  }

  // Test: valid config
  process.env.PICKLESHELL_GATEWAY_URL = "http://localhost:18092";
  process.env.PICKLESHELL_API_KEY = "my-key";
  const cfg = loadConfig();
  assert(cfg.url === "http://localhost:18092", "url is set");
  assert(cfg.api_key === "my-key", "api_key is set");
  assert(cfg.timeout_ms === 420000, "default timeout is 420000");

  // Test: trailing slash stripped
  process.env.PICKLESHELL_GATEWAY_URL = "http://localhost:18092/";
  const cfg2 = loadConfig();
  assert(cfg2.url === "http://localhost:18092", "trailing slash stripped");

  // Test: custom timeout
  process.env.PICKLESHELL_TIMEOUT_MS = "60000";
  const cfg3 = loadConfig();
  assert(cfg3.timeout_ms === 60000, "custom timeout applied");

  // Test: fallback env vars
  delete process.env.PICKLESHELL_GATEWAY_URL;
  delete process.env.PICKLESHELL_API_KEY;
  process.env.LOCALAGENT_GATEWAY_URL = "http://fallback:18092";
  process.env.LOCALAGENT_API_KEY = "fallback-key";
  const cfg4 = loadConfig();
  assert(cfg4.url === "http://fallback:18092", "falls back to LOCALAGENT_GATEWAY_URL");
  assert(cfg4.api_key === "fallback-key", "falls back to LOCALAGENT_API_KEY");

  // Restore
  process.env.PICKLESHELL_GATEWAY_URL = origUrl;
  process.env.PICKLESHELL_API_KEY = origKey;
  process.env.LOCALAGENT_GATEWAY_URL = origAltUrl;
  process.env.LOCALAGENT_API_KEY = origAltKey;
  if (origTimeout !== undefined) process.env.PICKLESHELL_TIMEOUT_MS = origTimeout;
  else delete process.env.PICKLESHELL_TIMEOUT_MS;
}

// ============================================================
// sendChatSchema — session_id validation
// ============================================================
console.log("\n=== sendChatSchema ===");

{
  // Valid session_id
  const result = sendChatSchema.session_id.safeParse("my-session-123");
  assert(result.success, "valid session_id accepted");
}

{
  // Valid: short
  const result = sendChatSchema.session_id.safeParse("a");
  assert(result.success, "single char session_id accepted");
}

{
  // Valid: max length (128)
  const result = sendChatSchema.session_id.safeParse("a".repeat(128));
  assert(result.success, "128-char session_id accepted");
}

{
  // Invalid: too long (129)
  const result = sendChatSchema.session_id.safeParse("a".repeat(129));
  assert(!result.success, "129-char session_id rejected");
}

{
  // Invalid: contains space
  const result = sendChatSchema.session_id.safeParse("my session");
  assert(!result.success, "session_id with space rejected");
}

{
  // Invalid: contains dot
  const result = sendChatSchema.session_id.safeParse("my.session");
  assert(!result.success, "session_id with dot rejected");
}

{
  // Invalid: contains slash
  const result = sendChatSchema.session_id.safeParse("my/session");
  assert(!result.success, "session_id with slash rejected");
}

{
  // Optional: undefined is fine
  const result = sendChatSchema.session_id.safeParse(undefined);
  assert(result.success, "undefined session_id accepted (optional)");
}

{
  // Full schema: minimal valid request
  const result = sendChatSchema.chat_id.safeParse("my-chat");
  assert(result.success, "valid chat_id accepted");
}

{
  // Full schema: message must be string
  const result = sendChatSchema.message.safeParse("");
  // z.string() accepts empty string (non-empty check is in gateway)
  assert(result.success, "empty message accepted by schema (gateway enforces non-empty)");
}

// ============================================================
// session-status schema
// ============================================================
console.log("\n=== sessionStatusSchema ===");
assert(sessionStatusSchema.chat_id.safeParse("pickleshell-main").success, "status chat_id accepted");
assert(sessionStatusSchema.session_id.safeParse("ses_abc").success, "status session_id accepted");
assert(!sessionStatusSchema.session_id.safeParse("bad session").success, "status invalid session_id rejected");
assert(sessionOutputSchema.session_id.safeParse("ses_abc").success, "output session_id accepted");
assert(sessionOutputSchema.session_id.safeParse(undefined).success, "output session_id optional (request_id alternative)");
assert(sessionOutputSchema.request_id.safeParse("req_abc123").success, "output request_id accepted");
assert(!sessionOutputSchema.request_id.safeParse("bad-format").success, "output invalid request_id rejected");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
