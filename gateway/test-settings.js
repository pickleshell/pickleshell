const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-global-settings-'));
const configPath = path.join(dir, 'config.json');
const settingsPath = path.join(dir, 'settings.json');
process.env.CONFIG_PATH = configPath;
process.env.SETTINGS_PATH = settingsPath;
require('./src/agent');

function load(chats = { alpha: { workspace: dir }, beta: { workspace: dir, runtime: 'opencode', model: 'opencode/static' } }, extraConfig = {}) {
  fs.writeFileSync(configPath, JSON.stringify({ chats, allowed_models: ['opencode/global', 'opencode/static'], ...extraConfig }));
  delete require.cache[require.resolve('./src/config')];
  delete require.cache[require.resolve('./src/settings')];
  return require('./src/settings');
}
function check(value, message) { assert.ok(value, message); }

(async () => {
  let settings = load();
  let described = settings.describe();
  check(described.revision === 0 && !('chat_id' in described), 'empty global store has no chat_id');
  check(described.effective.runtime === 'opencode', 'global baseline reports common runtime');
  check(described.sources.model === 'default' && described.baseline.model, 'mixed static model baseline is explicit');
  check(Array.isArray(described.baseline.model.chat_static_values), 'mixed baseline values are reported');
  check(settings.normalizeValue('runtime', ' CODEX ') === 'codex', 'runtime canonicalizes case and whitespace');
  check(settings.normalizeValue('codex_transport', ' MCP ') === 'mcp', 'transport canonicalizes case and whitespace');
  check(settings.normalizeValue('model', 'opencode/static') === 'opencode/static', 'model preserves exact allowlisted identifier');
  const metadata = described.definitions;
  check(metadata.runtime.label === 'Agent' && metadata.runtime.description === 'OpenCode or Codex', 'global runtime metadata is exact');
  check(metadata.model.label === 'Model' && metadata.model.description === 'Operator-allowlisted model used by the selected runtime', 'global model metadata is exact');
  check(metadata.codex_transport.label === 'Agent mode' && metadata.codex_transport.description === 'Codex exec or Codex MCP', 'global transport metadata is exact');
  check(metadata.agent_timeout_sec.label === 'Agent timeout' && metadata.agent_timeout_sec.description === 'Timeout in seconds; allowed range 1..86400 seconds', 'global timeout metadata is exact');

  const saved = await settings.update(undefined, 'set', { runtime: ' OPENCODE ', model: 'opencode/global', agent_timeout_sec: 12, codex_transport: ' MCP ' }, 0);
  check(saved.revision === 1 && saved.persisted.model === 'opencode/global' && saved.persisted.runtime === 'opencode' && saved.persisted.codex_transport === 'mcp', 'global settings persist canonical values');
  check((fs.statSync(settingsPath).mode & 0o777) === 0o600, 'settings file is 0600');
  check((fs.statSync(dir).mode & 0o777) === 0o700, 'settings directory is 0700');
  check(settings.resolve('alpha').values.model === 'opencode/global' && settings.resolve('beta').values.model === 'opencode/global', 'one global setting applies to two chats');
  const chatMetadata = settings.describe('alpha').definitions;
  check(JSON.stringify(chatMetadata) === JSON.stringify(settings.describe().definitions), 'chat and global definitions share metadata');
  check(settings.resolve('alpha', { model: 'opencode/static' }).values.model === 'opencode/static', 'explicit request override wins once');
  check(settings.resolve('alpha').values.model === 'opencode/global', 'explicit override does not persist');
  settings = load(
    { 'pickleshell-main': { workspace: dir, runtime: 'opencode', model: 'opencode/static' } },
    { default_model: 'opencode/global', allowed_runtimes: ['opencode', 'codex'] }
  );
  const switched = settings.resolve('pickleshell-main', { runtime: 'codex' });
  check(switched.values.runtime === 'codex' && switched.values.model === null && switched.sources.model === 'default', 'runtime request does not inherit the previous runtime model');
  check(settings.resolve('pickleshell-main', { runtime: 'opencode' }).values.model === 'opencode/global', 'same runtime request keeps the inherited model');
  settings = load();
  await assert.rejects(settings.update(undefined, 'set', { agent_timeout_sec: 13 }, 0), e => e.code === 'revision_conflict');

  const reset = await settings.update(undefined, 'reset', ['model', 'agent_timeout_sec'], 1);
  check(reset.revision === 2 && !reset.persisted.model, 'reset removes global overrides');
  check(settings.resolve('alpha').values.model === null && settings.resolve('beta').values.model === 'opencode/static', 'reset restores each chat static behavior');
  const chatSaved = await settings.update('beta', 'set', { model: 'opencode/static' }, 0);
  check(chatSaved.revision === 1 && settings.resolve('beta').persisted.model === 'opencode/static', 'chat override has independent revision');
  await assert.rejects(settings.update('beta', 'set', { agent_timeout_sec: 20 }, 0), e => e.code === 'revision_conflict');
  const globalAgain = await settings.update(undefined, 'set', { model: 'opencode/global' }, 2);
  check(globalAgain.revision === 3 && settings.resolve('alpha').values.model === 'opencode/global' && settings.resolve('beta').values.model === 'opencode/static', 'global value skips chat override');
  await settings.update(undefined, 'reset', ['model'], 3);
  check(settings.resolve('alpha').values.model === null && settings.resolve('beta').values.model === 'opencode/static', 'global reset preserves chat override');

  for (const bad of [
    () => settings.update(undefined, 'set', { nope: 1 }),
    () => settings.update(undefined, 'set', { agent_timeout_sec: 0 }),
    () => settings.update(undefined, 'reset', ['nope']),
  ]) await assert.rejects(bad(), e => ['invalid_setting_name', 'invalid_request'].includes(e.code));

  fs.writeFileSync(settingsPath, JSON.stringify({ schema: settings.SCHEMA, version: 1, revision: 0, chats: {} }));
  assert.throws(() => settings.describe(), e => e.code === 'settings_unavailable');
  fs.writeFileSync(settingsPath, JSON.stringify({ schema: settings.SCHEMA, version: settings.VERSION, file_revision: 0, global: { revision: 0, settings: {} }, chats: {} }));
  settings = load();
  await Promise.all(Array.from({ length: 10 }, (_, i) => settings.update(undefined, 'set', { agent_timeout_sec: i + 1 })));
  check(settings.readStore().file_revision === 10, 'concurrent global updates serialize');
  fs.writeFileSync(settingsPath, JSON.stringify({ schema: settings.SCHEMA, version: settings.VERSION, file_revision: 0, global: { revision: 0, settings: {} }, chats: {} }));
  const cas = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => settings.update(undefined, 'set', { agent_timeout_sec: i + 1 }, 0)));
  check(cas.filter(result => result.status === 'fulfilled').length === 1 && settings.readStore().file_revision === 1, 'concurrent CAS has one winner');
  check(!JSON.stringify(settings.describe()).match(/workspace|credential|terminal|socket|root|executable|bind|tunnel|browser|systemd|security/), 'global response has no sensitive/static path fields');
  check(!fs.readdirSync(dir).some(name => name.endsWith('.tmp')), 'no temporary files remain');
  console.log('PASS: scoped settings tests (30 assertions)');
})().catch(error => { console.error(error); process.exitCode = 1; });
