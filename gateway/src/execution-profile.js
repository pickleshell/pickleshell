// Operator declarations describe the actual enclosing execution surface.
// Selection never provisions a boundary or changes OS credentials.
const PROFILES = Object.freeze(['isolated', 'agent', 'privileged', 'full-control']);
const BOUNDARIES = Object.freeze(['host', 'container', 'vm']);
class ExecutionProfileError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new ExecutionProfileError(code, message, status); }
function profile(value) {
  if (!PROFILES.includes(value)) fail('invalid_execution_profile', 'Unknown execution profile');
  return value;
}
function boundary(value) {
  if (!BOUNDARIES.includes(value)) fail('invalid_boundary', 'Unknown execution boundary');
  return value;
}
function first(...values) { return values.find(value => value !== undefined); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function list(value, validate) {
  if (!Array.isArray(value) || value.length === 0) fail('execution_policy_invalid', 'Policy requires a nonempty allowlist');
  value.forEach(validate);
  return value;
}
function resolve(config, chat, request = {}, runtime = 'opencode') {
  if (request.boundary_provider !== undefined) fail('invalid_request', 'Boundary provider is operator-controlled');
  const policies = config.execution_profiles === undefined
    ? { agent: { allowed_boundaries: ['host'] } } : config.execution_profiles;
  if (!object(policies)) fail('execution_policy_invalid', 'Invalid execution policy');
  for (const [name, policy] of Object.entries(policies)) {
    profile(name);
    if (!object(policy)) fail('execution_policy_invalid', 'Invalid profile policy');
    list(policy.allowed_boundaries, boundary);
  }
  // Validate explicit policy independently of request precedence.
  for (const value of [config.default_execution_profile, chat.execution_profile]) {
    if (value !== undefined) {
      profile(value);
      if (!Object.hasOwn(policies, value)) fail('execution_policy_invalid', 'Default references a missing execution profile');
    }
  }
  for (const value of [config.default_boundary, chat.boundary]) if (value !== undefined) boundary(value);
  const selected = profile(request.execution_profile === undefined
    ? first(chat.execution_profile, config.default_execution_profile, 'agent') : request.execution_profile);
  const selectedBoundary = boundary(request.boundary === undefined
    ? first(chat.boundary, config.default_boundary, 'host') : request.boundary);
  const allowed = list(chat.allowed_execution_profiles === undefined ? ['agent'] : chat.allowed_execution_profiles, profile);
  if (allowed.some(name => !Object.hasOwn(policies, name))) {
    fail('execution_policy_invalid', 'Chat allowlist references a missing execution profile');
  }
  if (!Object.hasOwn(policies, selected) || !allowed.includes(selected)) {
    fail('execution_profile_not_allowed', 'Execution profile is not allowed for this chat', 403);
  }
  const boundaries = chat.allowed_boundaries === undefined ? ['host'] : list(chat.allowed_boundaries, boundary);
  if (!policies[selected].allowed_boundaries.includes(selectedBoundary) || !boundaries.includes(selectedBoundary) ||
      (selected === 'full-control' && selectedBoundary === 'host' && config.allow_full_control_host !== true)) {
    fail('boundary_not_allowed', 'Boundary is not allowed for this profile and chat', 403);
  }
  function validateDefault(profileValue, boundaryValue, allowedProfiles, allowedBoundaries) {
    if (!Object.hasOwn(policies, profileValue) || !allowedProfiles.includes(profileValue) ||
        !policies[profileValue].allowed_boundaries.includes(boundaryValue) || !allowedBoundaries.includes(boundaryValue)) {
      fail('execution_policy_invalid', 'Configured default is outside execution policy');
    }
  }
  if (config.default_execution_profile !== undefined || config.default_boundary !== undefined) {
    validateDefault(first(config.default_execution_profile, 'agent'), first(config.default_boundary, 'host'), Object.keys(policies), BOUNDARIES);
  }
  if (chat.execution_profile !== undefined || chat.boundary !== undefined ||
      config.default_execution_profile !== undefined || config.default_boundary !== undefined) {
    validateDefault(first(chat.execution_profile, config.default_execution_profile, 'agent'), first(chat.boundary, config.default_boundary, 'host'), allowed, boundaries);
  }
  const surface = config.execution_surface === undefined
    ? { execution_profile: 'agent', boundary: 'host' } : config.execution_surface;
  if (!object(surface)) fail('execution_policy_invalid', 'Invalid execution surface');
  profile(surface.execution_profile); boundary(surface.boundary);
  // A process cannot become less OR more privileged by changing a label.
  if (selected !== surface.execution_profile || selectedBoundary !== surface.boundary) {
    fail('insufficient_authority', 'Selected authority requires a separately provisioned execution surface; no fallback is available', 403);
  }
  if (process.env.PICKLESHELL_EXECUTION_SURFACE === 'opencode-agent-host' &&
      (selected !== 'agent' || selectedBoundary !== 'host' || runtime !== 'opencode')) {
    fail('insufficient_authority', 'This execution surface supports only OpenCode agent on host', 403);
  }
  return require('./execution/providers').resolve(config, { runtime, execution_profile: selected, boundary: selectedBoundary });
}
module.exports = { PROFILES, BOUNDARIES, ExecutionProfileError, resolve };
