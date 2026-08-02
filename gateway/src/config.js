const fs = require('fs');
const path = require('path');
const { isRuntimeAvailable: isRegisteredRuntimeAvailable } = require('./runtime/registry');

let configData = null;

const loadConfig = () => {
  if (configData) return configData;

  const configPath = path.resolve(
    process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json')
  );

  try {
    const rawData = fs.readFileSync(configPath, 'utf8');
    configData = JSON.parse(rawData);
    return configData;
  } catch (error) {
    console.error('Failed to load config:', error.message);
    configData = { chats: {} };
    return configData;
  }
};

const getChatConfig = (chatId) => {
  const config = loadConfig();
  return config.chats[chatId] || null;
};

const getWorkspace = (chatId) => {
  const chatConfig = getChatConfig(chatId);
  return chatConfig ? chatConfig.workspace : null;
};

const getTerminalConfig = () => {
  const config = loadConfig();
  const terminal = config.terminal || {};
  return {
    ...terminal,
    socket_path: terminal.socket_path || terminal.socket || process.env.PICKLESHELL_TERMINAL_SOCKET,
    auth_token: terminal.auth_token || process.env.PICKLESHELL_TERMINAL_AUTH,
  };
};

const getTerminalPolicy = (chatId) => {
  const chatConfig = getChatConfig(chatId);
  if (!chatConfig) return null;
  const terminal = getTerminalConfig();
  const chatPolicy = chatConfig.terminal;
  if (chatPolicy === false || (chatPolicy && chatPolicy.enabled === false)) return null;
  if (terminal.enabled === false) return null;
  return {
    ownerScope: typeof terminal.owner_scope === 'string' && terminal.owner_scope
      ? terminal.owner_scope
      : 'local',
  };
};

// --- Runtime configuration (preparatory for Codex) ---

const DEFAULT_RUNTIME = 'opencode';

// Recognized runtime names (validity). Availability is NOT maintained here:
// it is derived from the adapters registered in runtime/registry.js, the
// single source of truth for what this gateway build can actually execute.
// Codex is recognized but not yet executable by this build; selecting it
// must be rejected, never silently downgraded to OpenCode.
const KNOWN_RUNTIMES = ['opencode', 'codex'];

const normalizeRuntime = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return KNOWN_RUNTIMES.includes(normalized) ? normalized : null;
};

const getConfiguredDefaultRuntime = () => {
  const config = loadConfig();
  return config.default_runtime === undefined ? DEFAULT_RUNTIME : config.default_runtime;
};

const getDefaultRuntime = () => {
  return normalizeRuntime(getConfiguredDefaultRuntime()) || DEFAULT_RUNTIME;
};

const getAllowedRuntimes = () => {
  const config = loadConfig();
  if (config.allowed_runtimes === undefined) return [DEFAULT_RUNTIME];
  if (!Array.isArray(config.allowed_runtimes)) return null;
  return config.allowed_runtimes
    .map(normalizeRuntime)
    .filter((runtime) => runtime !== null);
};

const isRuntimeAllowed = (runtime) => {
  const allowed = getAllowedRuntimes();
  if (allowed === null) return false;
  return runtime !== null && allowed.includes(runtime);
};

const isRuntimeAvailable = (runtime) => {
  return runtime !== null && isRegisteredRuntimeAvailable(runtime);
};

const getChatRuntime = (chatId) => {
  const chatConfig = getChatConfig(chatId);
  if (!chatConfig) return null;
  const value = chatConfig.runtime !== undefined ? chatConfig.runtime : chatConfig.agent;
  if (value === undefined) return null;
  return normalizeRuntime(value);
};

// Resolve the runtime the gateway would use to execute for a chat.
const resolveRuntime = (chatId, requestedRuntime) => {
  const chatConfig = getChatConfig(chatId);
  const perChat = chatConfig
    ? (chatConfig.runtime !== undefined ? chatConfig.runtime : chatConfig.agent)
    : undefined;
  const rawValue = requestedRuntime !== undefined
    ? requestedRuntime
    : (perChat !== undefined ? perChat : getConfiguredDefaultRuntime());
  const runtime = normalizeRuntime(rawValue);

  if (!runtime) {
    return { runtime: null, status: 'invalid' };
  }

  if (!isRuntimeAllowed(runtime)) {
    return { runtime, status: 'not_allowed' };
  }

  if (!isRuntimeAvailable(runtime)) {
    return { runtime, status: 'unavailable' };
  }

  return { runtime, status: 'ok' };
};

const getAllowedModels = () => {
  const config = loadConfig();
  return config.allowed_models || [];
};

const getDefaultModel = () => {
  const config = loadConfig();
  return config.default_model || null;
};

const isModelAllowed = (model) => {
  const allowed = getAllowedModels();
  if (allowed.length === 0) return false;
  return allowed.includes(model);
};

const resolveModel = (requestedModel) => {
  const defaultModel = getDefaultModel();

  if (!requestedModel) {
    return defaultModel; // null if no default configured
  }

  if (!isModelAllowed(requestedModel)) {
    return null; // Not allowed
  }

  return requestedModel;
};

module.exports = {
  loadConfig,
  getChatConfig,
  getWorkspace,
  getTerminalConfig,
  getTerminalPolicy,
  getAllowedModels,
  getDefaultModel,
  isModelAllowed,
  resolveModel,
  normalizeRuntime,
  getDefaultRuntime,
  getAllowedRuntimes,
  isRuntimeAllowed,
  isRuntimeAvailable,
  getChatRuntime,
  resolveRuntime
};
