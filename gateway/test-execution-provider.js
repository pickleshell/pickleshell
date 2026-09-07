const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-provider-'));
process.env.CONFIG_PATH = path.join(temp, 'config.json');
process.env.SETTINGS_PATH = path.join(temp, 'settings.json');
process.env.OPENCODE_WRAPPER_SCRIPT = path.join(temp, 'wrapper.sh');
fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ chats: { example: { workspace: temp } } }));
fs.writeFileSync(process.env.OPENCODE_WRAPPER_SCRIPT, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"text","sessionID":"ses_provider","part":{"text":"host worked"}}\'\n');
const actualSpawn = childProcess.spawn, actualSpawnSync = childProcess.spawnSync;
let processes = 0;
childProcess.spawn = (...args) => { processes++; return actualSpawn(...args); };
childProcess.spawnSync = (...args) => { processes++; return actualSpawnSync(...args); };
const contract = require('./src/execution-profile');
const providers = require('./src/execution/providers');
const parseConfig = require('./src/execution/parse-config');
const config = require('./src/config');
const agent = require('./src/agent');
const concurrency = require('./src/concurrency');
const handler = require('./src/chat');
const session = require('./src/execution-session');
const supervisor = require('./src/runtime/supervisor');
let slots = 0, launches = 0;
const acquire = concurrency.acquire, supervise = supervisor.supervise;
concurrency.acquire = (...args) => { slots++; return acquire(...args); };
supervisor.supervise = (...args) => { launches++; return supervise(...args); };
const cfg = config.loadConfig();
function configure(profile = 'agent', boundary = 'host') {
  for (const key of Object.keys(cfg)) delete cfg[key];
  Object.assign(cfg, {
    chats: { example: { workspace: temp, allowed_execution_profiles: [profile], allowed_boundaries: [boundary] } },
    execution_profiles: { [profile]: { allowed_boundaries: [boundary] } },
    default_execution_profile: profile, default_boundary: boundary,
    execution_surface: { execution_profile: profile, boundary },
  });
}
const rejects = (code, fn) => assert.throws(fn, error => error.code === code);
async function request(body = {}, error) {
  const before = [processes, slots, launches];
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ body: { chat_id: 'example', message: 'test', ...body } }, res);
  if (error) {
    assert.equal(res.body.error, error);
    assert(res.statusCode >= 400);
    assert.deepEqual([processes, slots, launches], before, 'rejection must precede every process/probe, slot and supervisor');
    assert.equal(res.body.request_id, undefined);
  } else assert.equal(res.statusCode, 200);
  return res.body;
}
async function completed(id) {
  for (let i = 0; i < 200; i++) {
    const result = concurrency.getRequestOutput(id);
    if (result.ready) return result.output;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture did not complete');
}
async function main() {
  configure();
  const context = contract.resolve(cfg, cfg.chats.example);
  assert.equal(context.boundary_provider, 'host');
  assert.equal(providers.forContext(context).name, 'host');
  for (const boundary of ['vm', 'container']) {
    for (const profile of ['agent', 'full-control']) {
      configure(profile, boundary);
      await request({ runtime: 'opencode', execution_profile: profile, boundary }, 'boundary_provider_unavailable');
      cfg.boundary_providers = { [boundary]: { enabled: true } };
      await request({}, 'boundary_provider_unavailable');
      cfg.execution_surface.boundary_provider = 'host';
      delete cfg.boundary_providers;
      await request({}, 'execution_authority_unavailable');
      rejects('boundary_provider_unavailable', () => providers.forContext({ boundary, boundary_provider: boundary }));
      const before = [processes, slots, launches];
      const direct = await agent.runAgentRequest({ runtime: 'opencode', executionContext: { runtime: 'opencode', execution_profile: profile, boundary, boundary_provider: boundary } }).promise;
      assert.equal(direct.error.class, 'boundary_provider_unavailable');
      assert.deepEqual([processes, slots, launches], before);
      const mcp = await require('./src/runtime/adapters/codex-mcp').runRequest({
        runtime: 'codex', request_id: 'req_unavailable', message: 'test', workspace: temp, timeoutSec: 1,
        executionContext: { runtime: 'codex', execution_profile: profile, boundary, boundary_provider: boundary },
      }).promise;
      assert.equal(mcp.ok, false);
      assert.deepEqual([processes, slots, launches], before, 'custom MCP transport must not spawn an unavailable provider');
    }
  }
  configure('full-control');
  await request({}, 'boundary_not_allowed');
  configure(); cfg.execution_surface.boundary_provider = 'unknown';
  await request({}, 'boundary_provider_invalid');
  configure(); await request({ boundary_provider: 'vm' }, 'invalid_request');
  for (const bad of [null, [], { host: null }, { host: {} }, { host: { enabled: 'true' } }, { host: { enabled: true, command: '/bin/sh' } }]) {
    configure(); cfg.boundary_providers = bad;
    await request({}, 'execution_policy_invalid');
  }
  for (const policies of [{}, { host: { enabled: false } }]) {
    configure(); cfg.boundary_providers = policies;
    await request({}, 'boundary_provider_unavailable');
  }
  configure(); cfg.execution_surface.boundary_provider = null;
  await request({}, 'execution_policy_invalid');

  // P2: request overrides cannot hide invalid defaults or dangling references.
  configure(); cfg.default_execution_profile = 'root';
  await request({ execution_profile: 'agent' }, 'invalid_execution_profile');
  configure(); cfg.default_boundary = 'unknown';
  await request({ boundary: 'host' }, 'invalid_boundary');
  configure(); cfg.chats.example.allowed_execution_profiles.push('privileged');
  await request({}, 'execution_policy_invalid');
  configure(); cfg.default_boundary = 'vm';
  await request({ boundary: 'host' }, 'execution_policy_invalid');
  configure(); cfg.execution_profiles.privileged = { allowed_boundaries: ['host'] };
  cfg.default_execution_profile = 'privileged';
  await request({ execution_profile: 'agent' }, 'execution_policy_invalid');
  configure(); cfg.chats.example.boundary = 'vm';
  await request({ boundary: 'host' }, 'execution_policy_invalid');
  for (const text of [
    '{"execution_profiles":{"agent":{"allowed_boundaries":["host"]},"agent":{"allowed_boundaries":["vm"]}}}',
    '{"execution_profiles":{},"execution_profiles":{}}',
    '{"agent":{},"\\u0061gent":{}}',
    '{"chats":{"example":{"boundary":"host","boundary":"vm"}}}',
  ]) rejects('execution_policy_invalid', () => parseConfig(text));
  fs.writeFileSync(process.env.CONFIG_PATH, '{"chats":{},"chats":{}}');
  delete require.cache[require.resolve('./src/config')];
  rejects('execution_policy_invalid', () => require('./src/config').loadConfig());
  // Restore the cached fixture used by the handler and Settings.
  require.cache[require.resolve('./src/config')].exports = config;
  assert.deepEqual(parseConfig('{"x":[{"a":"b"},{"a":2}],"y":"comma, quote\\\" braces{}"}'), { x: [{ a: 'b' }, { a: 2 }], y: 'comma, quote" braces{}' });

  // P3: a registered Codex runtime would probe processes; surface rejects first.
  configure(); cfg.allowed_runtimes = ['opencode', 'codex'];
  process.env.PICKLESHELL_EXECUTION_SURFACE = 'opencode-agent-host';
  await request({ runtime: 'codex' }, 'insufficient_authority');
  delete process.env.PICKLESHELL_EXECUTION_SURFACE;
  configure('full-control', 'vm'); cfg.allowed_runtimes = ['opencode', 'codex'];
  await request({ runtime: 'codex' }, 'boundary_provider_unavailable');

  configure(); cfg.boundary_providers = { host: { enabled: true } };
  const result = await request();
  const output = await completed(result.request_id);
  assert.equal(output.execution_state, 'done');
  assert.equal(output.reply, 'host worked');
  assert.equal(launches, 1);
  assert.deepEqual(Object.fromEntries(['runtime', 'execution_profile', 'boundary', 'boundary_provider'].map(key => [key, output.metadata[key]])), context);
  session.check(output.session_id, session.tuple('example', temp, context));
  for (const change of [{ boundary_provider: 'another-host' }, { boundary: 'vm' }, { execution_profile: 'full-control' }, { runtime: 'codex' }]) {
    rejects('session_authority_mismatch', () => session.check(output.session_id, session.tuple('example', temp, { ...context, ...change })));
  }
  // A persisted different/old provider binding rejects at HTTP preflight too.
  session.check('ses_other_provider', session.tuple('example', temp, { ...context, boundary_provider: 'other' }), { bind: true });
  await request({ session_id: 'ses_other_provider' }, 'session_authority_mismatch');
  session.check('ses_old_binding', session.tuple('example', temp, { ...context, boundary_provider: undefined }), { bind: true });
  await request({ session_id: 'ses_old_binding' }, 'session_authority_mismatch');
  const resumed = await request({ session_id: output.session_id });
  assert.equal((await completed(resumed.request_id)).execution_state, 'done');
  for (const file of ['terminal/systemd/pickleshell-terminal.service', 'deploy/systemd/pickleshell-terminal.service.in']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(text, /^RestrictAddressFamilies=AF_UNIX$/m);
    assert.match(text, /^NoNewPrivileges=true$/m);
  }
  console.log('Execution provider tests passed: unavailable boundaries create zero processes, slots or host launches; host and session metadata verified');
}
main().then(() => { fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); }).catch(error => { console.error(error); fs.rmSync(temp, { recursive: true, force: true }); process.exit(1); });
