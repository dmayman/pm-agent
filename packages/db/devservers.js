// In-process registry of dev servers the operator UI has started. The observer is otherwise
// read-only; this is the one place it spawns processes. Each entry is keyed by the worktree
// path PLUS the service name (a worktree can run several named services — an API and a UI, say),
// tracks the child's process *group* (so we can stop the whole tree), and keeps a small ring
// buffer of recent output for the panel. Liveness of the actual port is still discovered via
// lsof (see worktrees.js) — this registry only knows what *we* launched, so a server started in
// a terminal still shows as live, it just can't be stopped from here unless we also find its
// listening pid.

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

// The observer often runs as a launchd agent, which spawns it with a stripped-down PATH that does
// NOT include the node/npm bin dir (e.g. an nvm/volta install). A dev command spawned from here
// then dies with `sh: npm: command not found` (exit 127) — the real reason "Run does nothing".
// Guarantee the child can find at least the same node/npm that's running the observer by prepending
// its bin dir; version-manager shims (npx, corepack→yarn/pnpm) live there too.
const NODE_BIN_DIR = path.dirname(process.execPath);
function childEnv() {
  const basePath = process.env.PATH || "";
  const parts = basePath.split(path.delimiter);
  const PATH = parts.includes(NODE_BIN_DIR) ? basePath : NODE_BIN_DIR + path.delimiter + basePath;
  return { ...process.env, PATH };
}

const registry = new Map(); // "<worktreePath> <serviceName>" -> entry
const DEFAULT_SERVICE = "dev"; // the fallback single-command name (no-manifest path)
const LOG_LINES = 60;
// How long start waits to catch a fast-failing command (missing script, wrong dir, port in use,
// non-zero exit) before reporting success. Long enough to catch spawn errors and immediate exits;
// short enough that a healthy `npm run dev` (which stays up) returns promptly.
const START_GRACE_MS = 1500;

// The registry key: "<worktreePath> <serviceName>". We never parse it back apart — each entry
// also stores its worktreePath + name, so per-worktree iteration (trackedServiceNames) matches on
// those fields rather than string-splitting the key, so a path containing a space can't confuse it.
function keyFor(worktreePath, serviceName) {
  return worktreePath + " " + (serviceName || DEFAULT_SERVICE);
}

function pushLog(entry, buf) {
  const text = buf.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    entry.log.push(line);
    if (entry.log.length > LOG_LINES) entry.log.shift();
  }
}

// A compact status for one named service in a worktree: are we running it, still booting, output.
export function serviceStatus(worktreePath, serviceName) {
  const e = registry.get(keyFor(worktreePath, serviceName));
  if (!e) return null;
  return {
    tracked: true,
    name: e.name,
    pid: e.pid,
    command: e.command,
    exited: e.exited,
    exitCode: e.exitCode,
    startedAt: e.startedAt,
    log: e.log.slice(-8),
  };
}

// Names of every service this process is currently supervising (not exited) for a worktree.
export function trackedServiceNames(worktreePath) {
  const names = [];
  for (const e of registry.values()) {
    if (e.worktreePath === worktreePath && !e.exited) names.push(e.name);
  }
  return names;
}

// Start a named service in a worktree. `service = {name, command, cwd, port}` — cwd is resolved
// relative to the worktree root (default "."). Reuses the shared spawn options and the grace
// window that surfaces a fast-failing command's real error + log tail instead of a false success.
export async function startService(worktreePath, service) {
  const name = (service && service.name) || DEFAULT_SERVICE;
  const command = service && service.command;
  if (!command || !String(command).trim()) return { ok: false, error: "no command configured" };

  const key = keyFor(worktreePath, name);
  const existing = registry.get(key);
  if (existing && !existing.exited) return { ok: true, already: true, pid: existing.pid };

  const cwd = path.join(worktreePath, (service && service.cwd) || ".");

  let proc;
  try {
    // Run through the user's LOGIN shell (`-lc`) so services inherit the same PATH/env a terminal
    // has — Homebrew (/opt/homebrew/bin), nvm, docker/colima, direnv, etc. The observer usually
    // runs as a launchd agent with a bare PATH (/usr/bin:/bin:…), so a plain `sh -c` can't find
    // non-node tools: a `docker`/`colima`-based service would die with `command not found`. The
    // login shell sources the user's profile and resolves them exactly as a terminal would.
    // childEnv() still prepends the observer's own node bin dir as a belt-and-suspenders.
    // detached:true puts the child in its own process group so a later kill(-pid) takes the
    // whole tree (npm -> node -> …), not just the shim.
    const loginShell = process.env.SHELL || "/bin/zsh";
    proc = spawn(loginShell, ["-lc", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(),
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }

  const entry = {
    proc,
    pid: proc.pid,
    name,
    worktreePath,
    command,
    startedAt: new Date().toISOString(),
    log: [],
    exited: false,
    exitCode: null,
    spawnError: null,
  };
  proc.stdout.on("data", (d) => pushLog(entry, d));
  proc.stderr.on("data", (d) => pushLog(entry, d));
  // Resolve `settled` the moment the child exits or fails to spawn, so start can distinguish a
  // command that came up from one that died on the launch pad instead of optimistically claiming
  // success (the "Run does nothing" bug — the failure only ever landed in this ring buffer).
  let settle;
  const settled = new Promise((res) => { settle = res; });
  proc.on("exit", (code, signal) => {
    entry.exited = true;
    entry.exitCode = code != null ? code : signal;
    settle();
  });
  proc.on("error", (err) => {
    entry.exited = true;
    entry.spawnError = (err && err.message) || "spawn failed";
    pushLog(entry, "spawn error: " + entry.spawnError);
    settle();
  });
  registry.set(key, entry);

  // Wait out the grace window: if the command fails fast we surface the real reason + log tail;
  // if it's still alive it's presumed to be booting (lsof-based liveness in worktrees.js takes
  // over from here and flips the panel starting → live once it binds a port).
  await Promise.race([settled, new Promise((r) => setTimeout(r, START_GRACE_MS))]);

  if (entry.exited) {
    const why = entry.spawnError
      ? entry.spawnError
      : `command exited (code ${entry.exitCode}) before it came up`;
    return { ok: false, error: why, log: entry.log.slice(-8), exitCode: entry.exitCode };
  }
  return { ok: true, pid: proc.pid, log: entry.log.slice(-8) };
}

// Best-effort kill of the whole process group a listener belongs to (npm -> node -> …), given any
// pid in it. We spawn our own servers detached (pid == group leader), but a listener detected via
// lsof — e.g. one a previous, since-restarted serve process launched — may be a child, so resolve
// its pgid via `ps` and signal the group. Falls back to signalling the bare pid.
function killGroup(pid) {
  let pgid = null;
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) pgid = n;
  } catch {}
  let ok = false;
  if (pgid) {
    try { process.kill(-pgid, "SIGTERM"); ok = true; } catch {}
  }
  if (!ok) {
    // No pgid (or the group kill was rejected): try the pid as a group leader, then as a lone pid.
    try { process.kill(-pid, "SIGTERM"); ok = true; } catch {}
    if (!ok) { try { process.kill(pid, "SIGTERM"); ok = true; } catch {} }
  }
  return ok;
}

// Stop one named service. Kills the process group we launched for it, and also SIGTERMs any extra
// listening pids the caller detected on that service's port (covers servers started outside the
// dashboard). Returns whether anything was signalled.
export function stopService(worktreePath, serviceName, detectedPids = []) {
  let killed = false;
  const key = keyFor(worktreePath, serviceName);
  const entry = registry.get(key);
  if (entry && !entry.exited && killGroup(entry.pid)) killed = true;
  registry.delete(key);
  // Group-kill any listener we detected on that port too — covers servers started outside the
  // dashboard, and ones a previous serve process launched (its in-memory registry didn't survive
  // the restart). A single-pid SIGTERM used to leave the npm parent alive holding the port.
  for (const pid of detectedPids) {
    if (pid && killGroup(pid)) killed = true;
  }
  return { ok: killed };
}

// ---- backward-compatible single-command wrappers ---------------------------
// The no-manifest fallback path (and any existing callers) talk to one anonymous "dev" service.

export function isTracked(worktreePath) {
  const e = registry.get(keyFor(worktreePath, DEFAULT_SERVICE));
  return !!(e && !e.exited);
}

export function serverStatus(worktreePath) {
  return serviceStatus(worktreePath, DEFAULT_SERVICE);
}

export async function startDevServer(worktreePath, command) {
  if (!command || !command.trim()) return { ok: false, error: "no dev command configured" };
  return startService(worktreePath, { name: DEFAULT_SERVICE, command, cwd: "." });
}

export function stopDevServer(worktreePath, detectedPids = []) {
  return stopService(worktreePath, DEFAULT_SERVICE, detectedPids);
}
