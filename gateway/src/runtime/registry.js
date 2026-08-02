// In-process registry of runtime adapters.
//
// Adapters register themselves here; the gateway resolves an adapter by
// runtime name. An adapter may expose isAvailable() when its executable is
// optional on a given host.
//
// This registry is the single source of truth for runtime availability:
// config.js consults isRuntimeAvailable()/availableRuntimes() instead of
// maintaining its own copy of the list.

const adapters = new Map();

function registerRuntime(name, adapter) {
  if (typeof name !== 'string' || !name) {
    throw new Error(`Invalid runtime name: ${name}`);
  }
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`Invalid adapter for runtime: ${name}`);
  }
  adapters.set(name, adapter);
  return adapter;
}

function getRuntime(name) {
  return adapters.get(name) || null;
}

function isRuntimeRegistered(name) {
  return adapters.has(name);
}

function isRuntimeAvailable(name) {
  const adapter = adapters.get(name);
  if (!adapter) return false;
  if (typeof adapter.isAvailable !== 'function') return true;
  try {
    return adapter.isAvailable() === true;
  } catch (_) {
    return false;
  }
}

function availableRuntimes() {
  return Array.from(adapters.keys()).filter(isRuntimeAvailable);
}

module.exports = {
  registerRuntime,
  getRuntime,
  isRuntimeRegistered,
  isRuntimeAvailable,
  availableRuntimes,
};
