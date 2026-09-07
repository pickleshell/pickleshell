const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const contract = require('./src/execution-profile');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-profile-'));
const rejects = (code, fn) => assert.throws(fn, error => error.code === code);
const resolve = (cfg = {}, chat = {}, request = {}) => contract.resolve(cfg, chat, request);
async function main() {
  assert.deepEqual(resolve(), { runtime: 'opencode', execution_profile: 'agent', boundary: 'host' });
  for (const name of contract.PROFILES) {
    const cfg = { execution_profiles: { [name]: { allowed_boundaries: ['vm'] } }, execution_surface: { execution_profile: name, boundary: 'vm' } };
    assert.equal(resolve(cfg, { allowed_execution_profiles: [name], allowed_boundaries: ['vm'] }, { execution_profile: name, boundary: 'vm' }).execution_profile, name);
  }
  rejects('invalid_execution_profile', () => resolve({}, {}, { execution_profile: 'root' }));
  rejects('invalid_execution_profile', () => resolve({ default_execution_profile: null }));
  rejects('invalid_boundary', () => resolve({}, {}, { boundary: 'invented' }));
  rejects('invalid_boundary', () => resolve({}, {}, { boundary: null }));
  rejects('execution_profile_not_allowed', () => resolve({}, {}, { execution_profile: 'privileged' }));
  rejects('execution_policy_invalid', () => resolve({ execution_profiles: [] }));
  const full = { execution_profiles: { 'full-control': { allowed_boundaries: ['host', 'vm'] } }, execution_surface: { execution_profile: 'full-control', boundary: 'host' } };
  const fullChat = { allowed_execution_profiles: ['full-control'], allowed_boundaries: ['host', 'vm'] };
  rejects('boundary_not_allowed', () => resolve(full, fullChat, { execution_profile: 'full-control' }));
  assert.equal(resolve({ ...full, allow_full_control_host: true }, fullChat, { execution_profile: 'full-control' }).boundary, 'host');
  rejects('insufficient_authority', () => resolve(full, fullChat, { execution_profile: 'full-control', boundary: 'vm' }));
  rejects('execution_profile_not_allowed', () => resolve(full, {}, { execution_profile: 'full-control', boundary: 'vm' }));
  rejects('boundary_not_allowed', () => resolve({ execution_profiles: { agent: { allowed_boundaries: ['host'] } } }, { allowed_boundaries: ['vm'] }, { boundary: 'vm' }));
  const oldSurface = process.env.PICKLESHELL_EXECUTION_SURFACE;
  process.env.PICKLESHELL_EXECUTION_SURFACE = 'opencode-agent-host';
  rejects('insufficient_authority', () => contract.resolve({}, {}, {}, 'codex'));
  if (oldSurface === undefined) delete process.env.PICKLESHELL_EXECUTION_SURFACE; else process.env.PICKLESHELL_EXECUTION_SURFACE = oldSurface;

  process.env.CONFIG_PATH = path.join(temp, 'config.json');
  process.env.SETTINGS_PATH = path.join(temp, 'settings.json');
  const cfg = { chats: { example: { workspace: temp } } };
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(cfg));
  const settings = require('./src/settings');
  assert(!JSON.stringify(settings.describe('example')).includes('execution_profile'));
  await assert.rejects(settings.update('example', 'set', { execution_profile: 'full-control' }), error => error.code === 'invalid_setting_name');

  const agent = require('./src/agent');
  const context = resolve();
  const registry = require('./src/runtime/registry');
  const adapter = registry.getRuntime('opencode');
  let received;
  registry.registerRuntime('opencode', { ...adapter, command: '/bin/true', buildArgs(...args) { received = args[4]; return []; } });
  const executed = await agent.runAgentRequest({ runtime: 'opencode', chatId: 'example', workspace: temp, message: 'test', timeoutSec: 2, executionContext: context }).promise;
  assert.equal(executed.ok, true);
  assert.deepEqual(received, context);
  assert.equal(executed.metadata.execution_profile, 'agent');
  assert.equal(executed.metadata.boundary, 'host');
  registry.registerRuntime('opencode', adapter);

  // Exercise HTTP dispatch's actual resolution, forwarding, completion and resume path.
  const originalRun = agent.runAgentRequest;
  const handler = require('./src/chat');
  const concurrency = require('./src/concurrency');
  let calls = 0;
  agent.runAgentRequest = options => {
    calls++;
    assert.deepEqual(options.executionContext, context);
    return { cancel: () => false, promise: Promise.resolve({ ok: true, runtime: 'opencode', session_id: 'ses_contract', state: 'completed', reply: 'ok', events: [], metadata: {} }) };
  };
  async function request(body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ body: { chat_id: 'example', message: 'test', ...body } }, res);
    await new Promise(resolve => setImmediate(resolve));
    return res;
  }
  const result = await request({});
  assert.equal(result.statusCode, 200);
  const session = require('./src/execution-session');
  const binding = session.tuple('example', temp, context);
  session.check('ses_contract', binding);
  assert.equal((await request({ session_id: 'ses_contract' })).statusCode, 200);
  const activeConfig = require('./src/config').loadConfig();
  activeConfig.execution_profiles = { agent: { allowed_boundaries: ['host', 'vm'] } };
  activeConfig.execution_surface = { execution_profile: 'agent', boundary: 'vm' };
  activeConfig.chats.example.allowed_boundaries = ['host', 'vm'];
  activeConfig.execution_surface.operator_note = '/operator-private-policy';
  const described = JSON.stringify(settings.describe('example'));
  assert(!described.includes('execution_surface'));
  assert(!described.includes('allowed_boundaries'));
  assert(!described.includes('/operator-private-policy'));
  const mismatch = await request({ session_id: 'ses_contract', boundary: 'vm' });
  assert.equal(mismatch.body.error, 'session_authority_mismatch');
  const unknown = await request({ session_id: 'ses_unknown', boundary: 'vm' });
  assert.equal(unknown.body.error, 'session_authority_unknown');
  assert.equal(calls, 2);
  // Fresh process reads persisted bindings; no process-local cache or TTL dependence.
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'src/execution-session'))}).check('ses_contract', ${JSON.stringify(binding)})`], { env: process.env });
  agent.runAgentRequest = originalRun;
  if (concurrency.stopCleanup) concurrency.stopCleanup();

  for (const file of ['terminal/systemd/pickleshell-terminal.service', 'deploy/systemd/pickleshell-terminal.service.in']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /^RestrictAddressFamilies=AF_UNIX$/m);
    assert.match(text, /^NoNewPrivileges=true$/m);
  }
  const unit = fs.readFileSync(path.join(root, 'deploy/systemd/pickleshell-opencode-agent.service.in'), 'utf8');
  for (const line of ['RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'NoNewPrivileges=true', 'CapabilityBoundingSet=', 'User=@GATEWAY_USER@', 'UnsetEnvironment=PICKLESHELL_MEMORY_BACKEND_TOKEN']) assert(unit.includes(line));
  // Use the installer's real render function, without sourcing its activation code.
  const release = fs.readFileSync(path.join(root, 'deploy/release.sh'), 'utf8');
  const render = release.slice(release.indexOf('render_unit() {'), release.indexOf('\ninstall_units() {'));
  fs.writeFileSync(path.join(temp, 'render.sh'), `${render}\nrender_unit gateway "$1"\n`);
  const env = { ...process.env, PROFILE: 'test', ROOT: '/test/app', ACTIVE_ROOT: '/test/app/active' };
  const tokens = new Set([...unit.matchAll(/@([A-Z_]+)@/g)].map(match => match[1]));
  for (const token of tokens) env[token] = `/test/${token.toLowerCase()}`;
  const rendered = execFileSync('bash', [path.join(temp, 'render.sh'), path.join(root, 'deploy/systemd/pickleshell-opencode-agent.service.in')], { env, encoding: 'utf8' });
  assert(!rendered.includes('@'));
  assert(rendered.includes('NoNewPrivileges=true'));
  console.log('Execution profile contract tests passed');
}
main().then(() => { fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); }).catch(error => { console.error(error); fs.rmSync(temp, { recursive: true, force: true }); process.exit(1); });
