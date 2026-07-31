// Shared process supervision for runtime adapters.
//
// Spawns an argv-based child process, streams stdout line by line through
// onLine(), enforces a timeout, and supports cooperative cancellation.
//
// The child is spawned detached so it leads its own process group; signals
// are sent to the whole group so grandchildren (e.g. `opencode` spawned by
// the bash wrapper) cannot be orphaned when the wrapper dies.
//
// Cancellation sends SIGTERM to the process group, then escalates to SIGKILL
// after TERM_GRACE_MS if the group has not exited. Timeout sends SIGKILL
// immediately. In both cases the promise resolves only after the child has
// actually closed, so `proc.killed` semantics never hide a still-alive child.
//
// The returned promise always resolves with an outcome object (never
// rejects):
//   {
//     code,        // exit code, or null if killed by a signal / spawn error
//     signal,      // terminating signal, or null on clean exit / spawn error
//     stdout,      // full raw stdout captured so far
//     stderr,      // full raw stderr
//     cancelled,   // true when cancel() was called before the child exited
//     timedOut,    // true when the timeout fired (group is SIGKILLed)
//     spawnError,  // spawn error (e.g. ENOENT) if the child could not start
//     onLineError, // error thrown by onLine(); the group is SIGKILLed and no
//                  // further lines are delivered once this is set
//   }
//
// onLine(line) receives every non-empty trimmed stdout line, including a
// trailing partial line flushed when the child exits. A throw from onLine is
// isolated: it never propagates out of the supervisor. Instead the process
// group is SIGKILLed, further output is ignored, and the error is reported
// via onLineError in the outcome.

const { spawn } = require('child_process');

const TERM_GRACE_MS = 2000;

function killProcessGroup(proc, signal) {
  if (!proc || !proc.pid) return false;
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    try {
      proc.kill(signal);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function supervise({ command, args, cwd, env, timeoutMs, onLine }) {
  let proc = null;
  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let timer = null;
  let killTimer = null;
  let stdout = '';
  let stderr = '';
  let buffer = '';
  let spawnError = null;
  let exitSignal = null;
  let onLineError = null;

  const callOnLine = (line) => {
    if (onLineError) return;
    try {
      onLine(line);
    } catch (err) {
      onLineError = err;
      killProcessGroup(proc, 'SIGKILL');
    }
  };

  const promise = new Promise((resolve) => {
    proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env,
      detached: true,
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) callOnLine(trimmed);
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      clearTimeout(killTimer);
      killProcessGroup(proc, 'SIGKILL');
      // The promise resolves on 'close' once the group has actually exited.
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      exitSignal = signal || null;
      if (buffer.trim()) callOnLine(buffer.trim());
      resolve({ code, signal: exitSignal, stdout, stderr, cancelled, timedOut, spawnError, onLineError });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      spawnError = err;
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, stdout, stderr, cancelled, timedOut, spawnError, onLineError });
    });
  });

  const cancel = () => {
    if (settled || cancelled) return false;
    cancelled = true;
    if (timer) clearTimeout(timer);
    killProcessGroup(proc, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (settled) return;
      killProcessGroup(proc, 'SIGKILL');
    }, TERM_GRACE_MS);
    return true;
  };

  return { promise, cancel };
}

module.exports = {
  TERM_GRACE_MS,
  killProcessGroup,
  supervise,
};
