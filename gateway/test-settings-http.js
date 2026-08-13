const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleshell-global-settings-http-'));
const configPath = path.join(root, 'config.json');
const settingsPath = path.join(root, 'settings.json');
const fakeWrapper = path.join(root, 'fake-wrapper.sh');
const port = 19000 + Math.floor(Math.random() * 500);
const token = 'global-settings-http-test-token';
fs.writeFileSync(fakeWrapper, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"text","part":{"text":"smoke"}}\'\n', { mode: 0o700 });
fs.writeFileSync(configPath, JSON.stringify({
  chats: { alpha: { workspace: root }, beta: { workspace: root, model: 'opencode/static' } },
  allowed_runtimes: ['opencode'], allowed_models: ['opencode/global', 'opencode/static'],
}));
const server = childProcess.spawn(process.execPath, ['src/server.js'], { cwd: __dirname, env: {
  ...process.env, CONFIG_PATH: configPath, SETTINGS_PATH: settingsPath, PICKLESHELL_API_KEY: token,
  HOST: '127.0.0.1', PORT: String(port), OPENCODE_WRAPPER_SCRIPT: fakeWrapper,
}, stdio: ['ignore', 'ignore', 'ignore'] });
const url = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${token}` };
async function request(route, init = {}) { const response = await fetch(`${url}${route}`, { ...init, headers: { ...auth, ...(init.headers || {}) } }); return { status: response.status, body: await response.json() }; }
async function waitForServer() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`, { headers: auth })).ok) return; } catch (_) {} await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Gateway did not start'); }
function json(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

(async () => {
  await waitForServer();
  assert.equal((await fetch(`${url}/settings`)).status, 401, 'global settings requires auth');
  let response = await request('/settings');
  assert.equal(response.status, 200); assert.equal(response.body.revision, 0); assert.ok(!('chat_id' in response.body));
  response = await request('/settings', json({ action: 'set', settings: { model: 'opencode/global', agent_timeout_sec: 7 }, expected_revision: 0 }));
  assert.equal(response.status, 200); assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  response = await request('/settings/alpha');
  assert.equal(response.status, 200); assert.equal(response.body.effective.model, 'opencode/global');
  response = await request('/settings/beta', json({ action: 'set', settings: { model: 'opencode/static' }, expected_revision: 0 }));
  assert.equal(response.status, 200); assert.equal(response.body.effective.model, 'opencode/static');
  response = await request('/settings/alpha');
  assert.equal(response.body.effective.model, 'opencode/global');
  response = await request('/settings', json({ action: 'set', settings: { agent_timeout_sec: 8 }, expected_revision: 0 }));
  assert.equal(response.status, 409); assert.equal(response.body.error, 'revision_conflict');
  response = await request('/settings', json({ action: 'set', settings: { unknown: true } }));
  assert.equal(response.status, 400); assert.equal(response.body.error, 'invalid_setting_name');
  response = await request('/settings', json({ action: 'get', unknown: true }));
  assert.equal(response.status, 400); assert.equal(response.body.error, 'invalid_request');
  response = await request('/settings/beta', json({ action: 'reset', names: ['model'], expected_revision: 1 }));
  assert.equal(response.status, 200); assert.equal(response.body.revision, 2); assert.equal(response.body.effective.model, 'opencode/global');
  response = await request('/settings', json({ action: 'reset', names: ['model'], expected_revision: 1 }));
  assert.equal(response.status, 200); assert.equal(response.body.effective.model, null);
  fs.writeFileSync(settingsPath, '{not-json'); response = await request('/settings');
  assert.equal(response.status, 503); assert.equal(response.body.error, 'settings_unavailable');
  fs.writeFileSync(settingsPath, JSON.stringify({ schema: 'pickleshell.gateway.settings', version: 2, file_revision: 4, global: { revision: 2, settings: {} }, chats: {} }));
  response = await request('/settings', json({ action: 'set', settings: { model: 'opencode/global' }, expected_revision: 2 }));
  assert.equal(response.status, 200);
  response = await request('/chat', json({ chat_id: 'alpha', message: 'smoke' }));
  assert.equal(response.status, 200); assert.equal(response.body.state, 'busy');
  response = await request('/chat', json({ chat_id: 'beta', message: 'smoke', model: 'opencode/static' }));
  assert.equal(response.status, 200); assert.equal(response.body.state, 'busy');
  console.log('Gateway scoped settings HTTP smoke: 29 assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.kill('SIGTERM'));
