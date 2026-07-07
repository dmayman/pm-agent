// In-process registry of dev servers the operator UI has started. The observer is otherwise
// read-only; this is the one place it spawns processes. Each entry is keyed by the worktree
// path it was launched in, tracks the child's process *group* (so we can stop the whole tree),
// and keeps a small ring buffer of recent output for the panel. Liveness of the actual port is
// still discovered via lsof (see worktrees.js) — this registry only knows what *we* launched,
// so a server started in a terminal still shows as live, it just can't be stopped from here
// unless we also find its listening pid.

import { spawn } from "node:child_process";

const registry = new Map(); // worktreePath -> entry
const LOG_LINES = 60;

function pushLog(entry, buf) {
  const text = buf.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    entry.log.push(line);
    if (entry.log.length > LOG_LINES) entry.log.shift();
  }
}

export function isTracked(worktreePath) {
  const e = registry.get(worktreePath);
  return !!(e && !e.exited);
}

// A compact status for one worktree: are we running it, is it still booting, last output.
export function serverStatus(worktreePath) {
  const e = registry.get(worktreePath);
  if (!e) return null;
  return {
    tracked: true,
    pid: e.pid,
    command: e.command,
    exited: e.exited,
    exitCode: e.exitCode,
    startedAt: e.startedAt,
    log: e.log.slice(-8),
  };
}

export function startDevServer(worktreePath, command) {
  if (!command || !command.trim()) return { ok: false, error: "no dev command configured" };
  const existing = registry.get(worktreePath);
  if (existing && !existing.exited) return { ok: true, already: true, pid: existing.pid };

  let proc;
  try {
    // detached:true puts the child in its own process group so a later kill(-pid) takes the
    // whole tree (npm -> node -> …), not just the npm shim.
    proc = spawn(command, {
      cwd: worktreePath,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }

  const entry = {
    proc,
    pid: proc.pid,
    command,
    startedAt: new Date().toISOString(),
    log: [],
    exited: false,
    exitCode: null,
  };
  proc.stdout.on("data", (d) => pushLog(entry, d));
  proc.stderr.on("data", (d) => pushLog(entry, d));
  proc.on("exit", (code, signal) => {
    entry.exited = true;
    entry.exitCode = code != null ? code : signal;
  });
  proc.on("error", (err) => {
    entry.exited = true;
    pushLog(entry, "spawn error: " + (err && err.message));
  });
  registry.set(worktreePath, entry);
  return { ok: true, pid: proc.pid };
}

// Stop a worktree's dev server. Kills the process group we launched, and also SIGTERMs any
// extra listening pids the caller detected in that worktree (covers servers started outside
// the dashboard). Returns whether anything was signalled.
export function stopDevServer(worktreePath, detectedPids = []) {
  let killed = false;
  const entry = registry.get(worktreePath);
  if (entry && !entry.exited) {
    try {
      process.kill(-entry.pid, "SIGTERM");
      killed = true;
    } catch {
      try {
        process.kill(entry.pid, "SIGTERM");
        killed = true;
      } catch {}
    }
  }
  registry.delete(worktreePath);
  for (const pid of detectedPids) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed = true;
    } catch {}
  }
  return { ok: killed };
}
