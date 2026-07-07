// In-process registry of dev servers the operator UI has started. The observer is otherwise
// read-only; this is the one place it spawns processes. Each entry is keyed by the worktree
// path it was launched in, tracks the child's process *group* (so we can stop the whole tree),
// and keeps a small ring buffer of recent output for the panel. Liveness of the actual port is
// still discovered via lsof (see worktrees.js) — this registry only knows what *we* launched,
// so a server started in a terminal still shows as live, it just can't be stopped from here
// unless we also find its listening pid.

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

const registry = new Map(); // worktreePath -> entry
const LOG_LINES = 60;
// How long start waits to catch a fast-failing command (missing script, wrong dir, port in use,
// non-zero exit) before reporting success. Long enough to catch spawn errors and immediate exits;
// short enough that a healthy `npm run dev` (which stays up) returns promptly.
const START_GRACE_MS = 1500;

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

export async function startDevServer(worktreePath, command) {
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
      env: childEnv(),
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
  registry.set(worktreePath, entry);

  // Wait out the grace window: if the command fails fast we surface the real reason + log tail;
  // if it's still alive it's presumed to be booting (lsof-based liveness in worktrees.js takes
  // over from here and flips the panel starting → live once it binds a port).
  await Promise.race([settled, new Promise((r) => setTimeout(r, START_GRACE_MS))]);

  if (entry.exited) {
    const why = entry.spawnError
      ? entry.spawnError
      : `dev command exited (code ${entry.exitCode}) before it came up`;
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

// Stop a worktree's dev server. Kills the process group we launched, and also SIGTERMs any
// extra listening pids the caller detected in that worktree (covers servers started outside
// the dashboard). Returns whether anything was signalled.
export function stopDevServer(worktreePath, detectedPids = []) {
  let killed = false;
  const entry = registry.get(worktreePath);
  if (entry && !entry.exited && killGroup(entry.pid)) killed = true;
  registry.delete(worktreePath);
  // Group-kill any listener we detected in that worktree too — covers servers started outside the
  // dashboard, and ones a previous serve process launched (its in-memory registry didn't survive
  // the restart). A single-pid SIGTERM used to leave the npm parent alive holding the port.
  for (const pid of detectedPids) {
    if (pid && killGroup(pid)) killed = true;
  }
  return { ok: killed };
}
