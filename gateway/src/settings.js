const fs = require('fs');
const path = require('path');
let config = require('./config');
const agent = require('./agent');
const { parseAgentTimeoutSec } = require('./timeout');

const SCHEMA = 'pickleshell.gateway.settings';
const VERSION = 2;
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 86400;
const NAMES = ['runtime', 'model', 'agent_timeout_sec', 'codex_transport'];

function refreshConfig() { config = require('./config'); }

class SettingsError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function storePath() {
  if (process.env.SETTINGS_PATH) return path.resolve(process.env.SETTINGS_PATH);
  const configPath = path.resolve(process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json'));
  return path.join(path.dirname(configPath), 'settings.json');
}

function unavailable(message, cause) {
  const error = new SettingsError('settings_unavailable', message, 503);
  if (cause) error.cause = cause;
  return error;
}

function normalizeValue(name, value) {
  if (name === 'runtime') return config.normalizeRuntime(value);
  if (name === 'codex_transport') return config.normalizeCodexTransport(value);
  if (name === 'model') return value === null ? null : (typeof value === 'string' && value.length > 0 ? value : undefined);
  if (name === 'agent_timeout_sec') return Number.isInteger(value) && value >= MIN_TIMEOUT && value <= MAX_TIMEOUT ? value : undefined;
  return undefined;
}

function validSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid settings scope');
  for (const [name, value] of Object.entries(settings)) {
    if (!NAMES.includes(name) || normalizeValue(name, value) === undefined) throw new Error(`invalid setting: ${name}`);
  }
}

function readStore() {
  let raw;
  try { raw = fs.readFileSync(storePath(), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyDocument();
    throw unavailable('Settings store is unavailable', error);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || value.schema !== SCHEMA || value.version !== VERSION ||
        !Number.isSafeInteger(value.file_revision) || value.file_revision < 0 ||
        !value.global || typeof value.global !== 'object' || Array.isArray(value.global) ||
        !Number.isSafeInteger(value.global.revision) || value.global.revision < 0 ||
        !value.global.settings || typeof value.global.settings !== 'object' || Array.isArray(value.global.settings) ||
        !value.chats || typeof value.chats !== 'object' || Array.isArray(value.chats)) {
      throw new Error('obsolete or invalid settings document');
    }
    validSettings(value.global.settings);
    for (const [chatId, scope] of Object.entries(value.chats)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatId) || !scope || typeof scope !== 'object' || Array.isArray(scope) ||
          !Number.isSafeInteger(scope.revision) || scope.revision < 0 || !scope.settings ||
          typeof scope.settings !== 'object' || Array.isArray(scope.settings)) throw new Error('invalid chat settings scope');
      validSettings(scope.settings);
    }
    return value;
  } catch (error) { throw unavailable('Settings store is malformed or obsolete', error); }
}

function emptyDocument() { return { schema: SCHEMA, version: VERSION, file_revision: 0, global: { revision: 0, settings: {} }, chats: {} }; }

function writeStore(value) {
  const file = storePath();
  const directory = path.dirname(file);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(temp); } catch (_) {}
    throw unavailable('Settings store could not be persisted', error);
  }
}

let updateQueue = Promise.resolve();
function serialized(fn) { const result = updateQueue.then(fn, fn); updateQueue = result.catch(() => {}); return result; }

function chatOrThrow(chatId) {
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) throw new SettingsError('invalid_request', 'chat_id is invalid', 400);
  const chat = config.getChatConfig(chatId);
  if (!chat) throw new SettingsError('unknown_chat_id', 'Unknown chat_id', 404);
  return chat;
}

function staticValue(chatId, name) {
  const chat = config.getChatConfig(chatId) || {};
  if (name === 'runtime') return chat.runtime !== undefined ? chat.runtime : (chat.agent !== undefined ? chat.agent : config.loadConfig().default_runtime);
  if (name === 'model') return chat.model !== undefined ? chat.model : config.loadConfig().default_model;
  if (name === 'agent_timeout_sec') {
    if (process.env.AGENT_TIMEOUT_SEC === undefined || process.env.AGENT_TIMEOUT_SEC === '') return undefined;
    const value = parseAgentTimeoutSec(process.env.AGENT_TIMEOUT_SEC);
    return Number.isInteger(value) && value >= MIN_TIMEOUT && value <= MAX_TIMEOUT ? value : 3600;
  }
  if (name === 'codex_transport') {
    const chatCodex = chat.codex && typeof chat.codex === 'object' && !Array.isArray(chat.codex) ? chat.codex : {};
    const globalCodex = config.getGlobalCodexConfig();
    return chatCodex.transport !== undefined ? chatCodex.transport : globalCodex && globalCodex.transport;
  }
  return undefined;
}

function staticGlobalValue(name) {
  const globalConfig = config.loadConfig();
  if (name === 'runtime') return globalConfig.default_runtime;
  if (name === 'model') return globalConfig.default_model;
  if (name === 'agent_timeout_sec') return process.env.AGENT_TIMEOUT_SEC === undefined ? undefined : staticValue('', name);
  if (name === 'codex_transport') {
    const codex = globalConfig.codex;
    return codex && typeof codex === 'object' && !Array.isArray(codex) ? codex.transport : undefined;
  }
  return undefined;
}

function defaultValue(name) {
  if (name === 'runtime') return config.getDefaultRuntime();
  if (name === 'codex_transport') return 'exec';
  if (name === 'agent_timeout_sec') return 3600;
  return null;
}

function defaultModelForRuntime(runtime) {
  return config.normalizeRuntime(runtime) === 'opencode' ? config.getDefaultModel() : null;
}

function rawEffective(chatId, document, overrides = {}) {
  const chatScope = document.chats[chatId]?.settings || {};
  const values = {};
  const sources = {};
  const chat = config.getChatConfig(chatId) || {};
  for (const name of NAMES) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) { values[name] = overrides[name]; sources[name] = 'request_override'; }
    else if (Object.prototype.hasOwnProperty.call(chatScope, name)) { values[name] = chatScope[name]; sources[name] = 'chat_setting'; }
    else if (Object.prototype.hasOwnProperty.call(document.global.settings, name)) { values[name] = document.global.settings[name]; sources[name] = 'global_setting'; }
    else {
      const value = staticValue(chatId, name);
      values[name] = value === undefined ? defaultValue(name) : value;
      sources[name] = value === undefined ? 'default' : 'static_config';
    }
  }
  // A model inherited from a lower-precedence scope belongs to that scope's
  // runtime. When a request changes the runtime without also choosing a model,
  // use the new adapter's default instead of forwarding the old adapter's
  // model (for Codex, null means the Codex CLI default).
  if (Object.prototype.hasOwnProperty.call(overrides, 'runtime') &&
      !Object.prototype.hasOwnProperty.call(overrides, 'model')) {
    const inheritedRuntime = Object.prototype.hasOwnProperty.call(chatScope, 'runtime')
      ? chatScope.runtime
      : (Object.prototype.hasOwnProperty.call(document.global.settings, 'runtime')
        ? document.global.settings.runtime
        : staticValue(chatId, 'runtime'));
    if (config.normalizeRuntime(values.runtime) !== config.normalizeRuntime(inheritedRuntime || defaultValue('runtime'))) {
      values.model = defaultModelForRuntime(values.runtime);
      sources.model = 'default';
    }
  }
  if (values.runtime === 'codex' && !Object.prototype.hasOwnProperty.call(overrides, 'model') &&
      !Object.prototype.hasOwnProperty.call(chatScope, 'model') && !Object.prototype.hasOwnProperty.call(document.global.settings, 'model') &&
      !Object.prototype.hasOwnProperty.call(chat, 'model')) { values.model = null; sources.model = 'default'; }
  return { values, sources };
}

function globalRaw(document) {
  const values = {};
  for (const name of NAMES) values[name] = Object.prototype.hasOwnProperty.call(document.global.settings, name) ? document.global.settings[name] : (staticGlobalValue(name) === undefined ? defaultValue(name) : staticGlobalValue(name));
  if (values.runtime === 'codex' && !Object.prototype.hasOwnProperty.call(document.global.settings, 'model')) values.model = null;
  return values;
}

function validateTuple(tuple) {
  const runtime = config.normalizeRuntime(tuple.runtime);
  if (!runtime) throw new SettingsError('runtime_invalid', 'Runtime is invalid', 400);
  if (!config.isRuntimeAllowed(runtime)) throw new SettingsError('runtime_not_allowed', `Runtime "${runtime}" is not allowed`, 403);
  if (!config.isRuntimeAvailable(runtime)) throw new SettingsError('runtime_unavailable', `Runtime "${runtime}" is unavailable`, 503);
  const timeout = normalizeValue('agent_timeout_sec', tuple.agent_timeout_sec);
  if (timeout === undefined) throw new SettingsError('invalid_request', 'agent_timeout_sec must be an integer from 1 to 86400', 400);
  const model = normalizeValue('model', tuple.model);
  if (model === undefined) throw new SettingsError('invalid_request', 'model must be a string or null', 400);
  if (model !== null && !config.isModelAllowed(model)) throw new SettingsError('forbidden_model', 'Model is not allowed', 403);
  const modelError = agent.validateRuntimeModel(runtime, model);
  if (modelError) throw new SettingsError('runtime_model_invalid', modelError.message, 400);
  const transport = normalizeValue('codex_transport', tuple.codex_transport);
  if (!transport) throw new SettingsError('codex_transport_invalid', 'Codex transport must be exec or mcp', 400);
  if (runtime === 'codex' && !agent.isRuntimeTransportAvailable(runtime, transport)) throw new SettingsError('runtime_unavailable', `Codex transport "${transport}" is unavailable`, 503);
  return { runtime, model, agent_timeout_sec: timeout, codex_transport: transport };
}

function resolve(chatId, overrides = {}, document = readStore()) {
  refreshConfig(); chatOrThrow(chatId);
  const raw = rawEffective(chatId, document, overrides);
  return { values: validateTuple(raw.values), sources: raw.sources, persisted: document.chats[chatId]?.settings || {}, global: document.global.settings, revision: document.file_revision, global_revision: document.global.revision, chat_revision: document.chats[chatId]?.revision || 0 };
}

function definitions(effective) {
  return {
    runtime: { value: effective.runtime, label: 'Agent', description: 'OpenCode or Codex', allowed: config.KNOWN_RUNTIMES || ['opencode', 'codex'] },
    model: { value: effective.model, label: 'Model', description: 'Operator-allowlisted model used by the selected runtime', allowed: config.getAllowedModels(), nullable: true },
    agent_timeout_sec: { value: effective.agent_timeout_sec, label: 'Agent timeout', description: 'Timeout in seconds; allowed range 1..86400 seconds', minimum: MIN_TIMEOUT, maximum: MAX_TIMEOUT },
    codex_transport: { value: effective.codex_transport, label: 'Agent mode', description: 'Codex exec or Codex MCP', allowed: ['exec', 'mcp'] },
  };
}

function describe(chatId) {
  refreshConfig(); const document = readStore();
  if (chatId !== undefined) {
    const resolved = resolve(chatId, {}, document);
    return { ok: true, scope: 'chat', chat_id: chatId, revision: resolved.chat_revision, file_revision: document.file_revision, global_revision: document.global.revision, persisted: resolved.persisted, global_persisted: document.global.settings, effective: resolved.values, sources: resolved.sources, definitions: definitions(resolved.values), settings: definitions(resolved.values) };
  }
  const effective = {}; const sources = {}; const baseline = {};
  for (const name of NAMES) {
    if (Object.prototype.hasOwnProperty.call(document.global.settings, name)) { effective[name] = document.global.settings[name]; sources[name] = 'global_setting'; continue; }
    const value = staticGlobalValue(name);
    effective[name] = value === undefined ? defaultValue(name) : value;
    sources[name] = value === undefined ? 'default' : 'static_config';
  }
  const chats = Object.keys(config.loadConfig().chats || {});
  for (const name of NAMES) {
    const values = chats.map(chat => rawEffective(chat, document).values[name]);
    if (values.some(value => JSON.stringify(value) !== JSON.stringify(effective[name]))) baseline[name] = { global_static: effective[name], chat_static_values: values };
  }
  return { ok: true, scope: 'global', revision: document.global.revision, file_revision: document.file_revision, persisted: document.global.settings, effective, sources, baseline: Object.keys(baseline).length ? baseline : undefined, definitions: definitions(effective), settings: definitions(effective) };
}

function update(chatId, action, payload, expectedRevision) {
  return serialized(() => {
    refreshConfig(); const document = readStore();
    const scope = chatId === undefined ? document.global : (chatOrThrow(chatId), document.chats[chatId] || { revision: 0, settings: {} });
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== scope.revision)) throw new SettingsError('revision_conflict', 'Settings revision does not match', 409);
    const next = { ...scope.settings };
    if (action === 'set') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SettingsError('invalid_request', 'settings must be an object');
      for (const [name, value] of Object.entries(payload)) {
        if (!NAMES.includes(name)) throw new SettingsError('invalid_setting_name', `Unknown setting: ${name}`);
        const normalized = normalizeValue(name, value);
        if (normalized === undefined) throw new SettingsError('invalid_request', `Invalid value for ${name}`);
        next[name] = normalized;
      }
    } else if (action === 'reset') {
      if (!Array.isArray(payload) || payload.some(name => !NAMES.includes(name))) throw new SettingsError('invalid_setting_name', 'names must contain known setting names');
      for (const name of payload) delete next[name];
    } else throw new SettingsError('invalid_request', 'action must be set or reset');
    const candidate = JSON.parse(JSON.stringify(document));
    candidate.file_revision += 1;
    if (chatId === undefined) { candidate.global = { revision: document.global.revision + 1, settings: next }; }
    else candidate.chats[chatId] = { revision: scope.revision + 1, settings: next };
    const checkDocument = candidate;
    if (chatId === undefined) {
      validateTuple(globalRaw(checkDocument));
      for (const configuredChatId of Object.keys(config.loadConfig().chats || {})) {
        validateTuple(rawEffective(configuredChatId, checkDocument).values);
      }
    } else {
      validateTuple(rawEffective(chatId, checkDocument).values);
    }
    writeStore(candidate);
    return describe(chatId);
  });
}

module.exports = { SCHEMA, VERSION, NAMES, SettingsError, storePath, readStore, resolve, describe, update, validateTuple, normalizeValue };
