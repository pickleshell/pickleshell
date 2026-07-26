const fs = require('fs');
const path = require('path');

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
  getAllowedModels,
  getDefaultModel,
  isModelAllowed,
  resolveModel
};
