// Live worktree + branch + dev-server enumeration for the operator UI. Unlike the ledger
// (persisted SQLite), this is computed on demand by shelling to `git` and `lsof`: it answers
// "which branches have active work, which worktree has each checked out, and where's each
// one's dev server?" — the "finding the server is always such a painpoint" problem. The read
// paths are best-effort (every probe degrades to empty rather than throwing); the write paths
// (worktree add / branch switch) return {ok, error} with git's stderr surfaced.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { serviceStatus } from "./devservers.js";

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}
const git = (args, cwd) => run("git", args, cwd);

// git run that keeps stderr, for write ops where the failure message is the point.
function gitWrite(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const stderr = (err && err.stderr && err.stderr.toString().trim()) || "";
    return { ok: false, error: stderr || String(err && err.message) };
  }
}

// `git worktree list --porcelain` — records separated by blank lines, one attribute per line.
function parseWorktrees(root) {
  const out = git(["worktree", "list", "--porcelain"], root);
  if (!out) return [];
  const wts = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) wts.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "bare") {
      cur.bare = true;
    }
  }
  if (cur) wts.push(cur);
  return wts;
}

// The branch everything else (merged-check, ahead/behind) diffs against. Prefer the LOCAL
// branch of the same name over the remote-tracking ref: origin/HEAD only tells us the *name*
// ("main"), and if origin/main hasn't been fetched since local main last moved, diffing against
// the stale remote ref makes freshly-merged branches look unmerged and inflates ahead/behind
// counts. Fall back to the remote ref itself when there's no local copy (e.g. a fresh clone).
function defaultBranch(root) {
  const remote = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  const remoteName = remote ? remote.replace(/^origin\//, "") : null;
  if (remoteName && git(["rev-parse", "--verify", "--quiet", "refs/heads/" + remoteName], root)) return remoteName;
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", "refs/heads/" + b], root)) return b;
  }
  return remote || "";
}

// commits `ref` is ahead of / behind `base`. `A...B --left-right --count` -> "behind ahead".
function aheadBehind(root, ref, base) {
  if (!ref || !base) return null;
  const out = git(["rev-list", "--left-right", "--count", base + "..." + ref], root);
  const m = out.match(/^(\d+)\s+(\d+)$/);
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

function commitInfo(root, rev) {
  const out = git(["log", "-1", "--format=%h%x00%s%x00%cI", rev], root);
  if (!out) return { short: null, subject: null, committedAt: null };
  const [short, subject, committedAt] = out.split("\0");
  return { short, subject, committedAt: committedAt || null };
}

// The dev command for a worktree: an explicit per-repo override wins, else the conventional
// package.json script (dev > start), else null. Discovery, not execution — the panel shows
// this and the server runs the *stored* value, so a hostile POST can't inject a command.
export function effectiveDevCommand(worktreePath, override) {
  if (override && override.trim()) return override.trim();
  try {
    const pkg = JSON.parse(readFileSync(path.join(worktreePath, "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    if (scripts.dev) return "npm run dev";
    if (scripts.start) return "npm start";
  } catch {}
  return null;
}

// The per-branch service manifest: `<worktree>/.pm/services.json`, checked in, Claude-authored.
// The dashboard READS this (it never edits it — the file is the source of truth). Returns
//   { services: [...], error: null }  when present and valid,
//   { services: null, error: "<msg>" } on malformed JSON / schema, and
//   { services: null, error: null }    when the file is simply absent.
// Each service carries `location: "local" | "remote"` (default "local"). A local service is
// normalized to {location, name, command, cwd, port|null, portEnv|null, health|null, url|null} —
// something the dashboard can launch and port-scan. A remote service (hosted infra: Fly/Neon/
// Vercel) has nothing to launch or bind, so it drops command/port/portEnv and instead carries
// {location, name, provider|null, dashboard|null, url|null, health|null, branch|null} — the
// dashboard only watches it (HTTP health-probe) and links to its console.
export function readServices(worktreePath) {
  let raw;
  try {
    raw = readFileSync(path.join(worktreePath, ".pm", "services.json"), "utf8");
  } catch {
    return { services: null, error: null }; // absent — not an error, just no manifest
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { services: null, error: "invalid .pm/services.json: " + (err && err.message) };
  }
  const list = parsed && Array.isArray(parsed.services) ? parsed.services : null;
  if (!list) return { services: null, error: ".pm/services.json: expected { \"services\": [ … ] }" };
  const services = [];
  const seen = new Set();
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  for (const s of list) {
    if (!s || typeof s.name !== "string" || !s.name.trim())
      return { services: null, error: ".pm/services.json: every service needs a non-empty name" };
    if (seen.has(s.name))
      return { services: null, error: `.pm/services.json: duplicate service name "${s.name}"` };
    seen.add(s.name);
    if (s.location != null && s.location !== "local" && s.location !== "remote")
      return { services: null, error: `.pm/services.json: service "${s.name}" location must be "local" or "remote"` };
    if (s.location === "remote") {
      // Nothing to launch or bind — command/port/portEnv are meaningless for hosted infra, so
      // reject them rather than silently ignore (a stray command here is almost always a mistake).
      if (str(s.command))
        return { services: null, error: `.pm/services.json: remote service "${s.name}" must not set a command (there is nothing to launch)` };
      if (s.port != null)
        return { services: null, error: `.pm/services.json: remote service "${s.name}" must not set a port (it isn't a local listener)` };
      services.push({
        location: "remote",
        name: s.name,
        provider: str(s.provider),   // free label for icon/grouping: "fly" | "neon" | "vercel" | …
        dashboard: str(s.dashboard), // provider console URL for this service
        url: str(s.url),             // the live/public URL of the service itself
        // Full URL, or a path appended to `url`, that the observer polls for up/down. Absent →
        // liveness is declared, not probed (shown neutrally, never falsely green/red).
        health: str(s.health),
        branch: str(s.branch),       // which branch/environment is deployed there ("main", "preview/x")
      });
      continue;
    }
    if (typeof s.command !== "string" || !s.command.trim())
      return { services: null, error: `.pm/services.json: service "${s.name}" needs a command` };
    services.push({
      location: "local",
      name: s.name,
      command: s.command,
      cwd: typeof s.cwd === "string" && s.cwd.trim() ? s.cwd : ".",
      port: Number.isFinite(s.port) ? Number(s.port) : null,
      // The env var pm-agent sets to the service's *effective* (offset) port at launch, so a
      // non-primary worktree binds a distinct port. The command/compose file must read it
      // (e.g. `vite --port $OPERATOR_PORT`, `${APP_DB_PORT:-5432}:5432`). Null = not parameterized.
      portEnv: typeof s.portEnv === "string" && s.portEnv.trim() ? s.portEnv.trim() : null,
      health: typeof s.health === "string" && s.health.trim() ? s.health : null,
      url: typeof s.url === "string" && s.url.trim() ? s.url : null,
    });
  }
  return { services, error: null };
}

// Join a base URL and a path part, tolerating trailing/leading slashes; a path that is itself a
// full http(s) URL wins outright.
function joinUrl(base, pathPart) {
  if (/^https?:\/\//i.test(pathPart)) return pathPart;
  if (!base) return null;
  return base.replace(/\/+$/, "") + "/" + String(pathPart).replace(/^\/+/, "");
}

// The URL the observer polls for a remote service's liveness, or null when it can't be probed —
// no health declared (a hosted Postgres: liveness is declared, not probed), or a bare health path
// with no `url` to resolve it against. A full http(s) health value is used as-is.
export function remoteHealthUrl(s) {
  if (!s || s.location !== "remote" || !s.health) return null;
  return joinUrl(s.url, s.health);
}

// The repo-level opt-in config: `.pm/config.json`, checked in, Claude/human-authored. Read the
// same defensive way readServices() reads .pm/services.json — tolerate a missing or invalid file
// (never throws), and never let a request body stand in for it: this is repo config, not
// something a POST should be able to spoof. Currently the only recognized key is
// `worktreePanel: "primary-preview"`, which swaps the dashboard's generic per-branch worktree
// picker for the restricted Primary/Preview layout (see worktreeReport below).
export function readPmConfig(root) {
  let raw;
  try {
    raw = readFileSync(path.join(root, ".pm", "config.json"), "utf8");
  } catch {
    return {}; // absent — not an error, just no config
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // malformed — degrade to defaults rather than throw
  }
}

// ---- per-worktree port offset ("instance slots") --------------------------
// Two worktrees of the same repo declare the SAME checked-in ports (.pm/services.json is identical
// across branches), so their services would collide and can't run at once. We give each worktree a
// stable "slot" — its index in `git worktree list` order (the main worktree is always slot 0) — and
// shift every declared port by `slot * stride`. Slot 0 uses ports exactly as declared (the primary
// keeps canonical ports); slot 1 gets +stride, slot 2 +2*stride, and so on. The offset is injected
// into the launched process via each service's `portEnv` (see serviceLaunchEnv), reflected in the
// panel, and used for liveness/stop — so the two trees run independently.
export const DEFAULT_PORT_STRIDE = 100;

// The ordered, visible worktrees (bare + hidden/preview trees dropped) — the single ordering that
// both worktreeReport and worktreeSlot index into, so a slot never drifts between them.
function visibleWorktrees(root, hidden) {
  const skip = hidden instanceof Set ? hidden : new Set(hidden || []);
  return parseWorktrees(root).filter((w) => !w.bare && !skip.has(w.path));
}

// The per-repo port stride, overridable via .pm/config.json { "portStride": <n> }; default 100.
export function portStride(repo) {
  const cfg = readPmConfig((repo && repo.root) || "");
  const n = Number(cfg.portStride);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PORT_STRIDE;
}

// A worktree's stable slot: its position in the visible worktree ordering (main = 0). `excludePaths`
// must match what worktreeReport was given (e.g. the hidden preview tree) so the numbering agrees.
export function worktreeSlot(repo, worktreePath, { excludePaths } = {}) {
  const root = repo && repo.root;
  if (!root) return 0;
  const idx = visibleWorktrees(root, excludePaths).findIndex((w) => w.path === worktreePath);
  return idx < 0 ? 0 : idx;
}

// The effective (offset) port for a declared base port at a given slot. Port-less stays null.
export function effectivePort(basePort, slot, stride) {
  if (basePort == null) return null;
  return basePort + (slot || 0) * (stride || DEFAULT_PORT_STRIDE);
}

// The env pm-agent injects when launching a service in a slot: always PM_SLOT/PM_PORT_OFFSET (so a
// multi-port command like docker-compose can offset several ports generically), plus the service's
// own portEnv bound to its effective port when both are present.
export function serviceLaunchEnv(service, slot, stride) {
  const offset = (slot || 0) * (stride || DEFAULT_PORT_STRIDE);
  const env = { PM_SLOT: String(slot || 0), PM_PORT_OFFSET: String(offset) };
  const eff = effectivePort(service && service.port, slot, stride);
  if (service && service.portEnv && eff != null) env[service.portEnv] = String(eff);
  return env;
}

// The reachable URL for a service at its effective port: rewrite the declared url's port when it
// carries the base port, else synthesize from the effective port + health path.
function effectiveUrl(declaredUrl, basePort, eff, health) {
  if (eff == null) return declaredUrl || null;
  if (declaredUrl && basePort != null && declaredUrl.includes(":" + basePort))
    return declaredUrl.replace(":" + basePort, ":" + eff);
  if (declaredUrl) return declaredUrl;
  return "http://localhost:" + eff + (health || "");
}

// Enrich one declared service with its live state, from (a) a global scan of listening ports and
// (b) this process's own registry for services we launched. Port-detected liveness wins; a
// service we spawned but that hasn't bound its port yet reads as "starting"; a port-less service
// falls back purely to the registry (tracked → live, since we can't probe it).
//
// A declared port is authoritative, so we check whether *anything* is listening on it anywhere
// (`listeningByPort`) rather than only a process whose cwd sits under the worktree. Docker/Colima
// publish a container's port via a proxy/ssh-forward process whose cwd is elsewhere, so the
// cwd-attribution used for auto-discovered servers would never mark a containerized DB live.
function enrichService(wt, s, listeningByPort, offset = 0) {
  const eff = s.port != null ? s.port + offset : null;
  const out = {
    name: s.name,
    command: s.command,
    cwd: s.cwd,
    port: eff, // the *effective* (offset) port — what actually runs and what the panel shows
    basePort: s.port, // the declared port, before the per-worktree offset
    portEnv: s.portEnv,
    health: s.health,
    url: s.url,
    state: "stopped",
    pid: null,
    liveUrl: null,
  };
  const listenPid = eff != null && listeningByPort ? listeningByPort.get(eff) : undefined;
  const tracked = serviceStatus(wt.path, s.name);
  if (listenPid !== undefined) {
    out.state = "live";
    out.pid = listenPid;
    out.liveUrl = effectiveUrl(s.url, s.port, eff, s.health);
  } else if (tracked && !tracked.exited) {
    // We launched it and it's still alive. With a port it's booting (not yet bound); without a
    // port there's nothing to bind so treat "still running" as live.
    out.pid = tracked.pid;
    if (eff != null) {
      out.state = "starting";
    } else {
      out.state = "live";
      out.liveUrl = s.url || null;
    }
  }
  return out;
}

// Every TCP socket in LISTEN state, one row per (pid, port), deduped across the IPv4/IPv6 pair.
function listeningSockets() {
  const out = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], undefined);
  if (!out) return null; // null => scan failed (lsof absent/denied); [] would mean "none found"
  const seen = new Set();
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line || line.startsWith("COMMAND")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const name = parts[parts.length - 2]; // e.g. *:5173, 127.0.0.1:3000, [::1]:3000
    const pm = name.match(/:(\d+)$/);
    if (!pm) continue;
    const pid = Number(parts[1]);
    const port = Number(pm[1]);
    const key = pid + ":" + port;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ command: parts[0], pid, port });
  }
  return rows;
}

function pidCwds(pids) {
  if (!pids.length) return {};
  const out = run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], undefined);
  const map = {};
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) cur = Number(line.slice(1));
    else if (line.startsWith("n") && cur != null) map[cur] = line.slice(1);
  }
  return map;
}

// Attach dev servers to the worktree whose path is the longest prefix of the listening
// process's cwd (so a server in a linked worktree isn't credited to the tree that contains
// it on disk). Returns whether the scan actually ran.
function attachServers(worktrees, sockets, { skipPid, skipPort } = {}) {
  if (sockets === null) return false;
  const relevant = sockets.filter((s) => s.pid !== skipPid && s.port !== skipPort);
  const cwds = pidCwds([...new Set(relevant.map((s) => s.pid))]);
  for (const s of relevant) {
    const cwd = cwds[s.pid];
    if (!cwd) continue;
    let best = null;
    for (const wt of worktrees) {
      if (cwd === wt.path || cwd.startsWith(wt.path + path.sep)) {
        if (!best || wt.path.length > best.path.length) best = wt;
      }
    }
    if (best) {
      best.servers.push({
        port: s.port,
        url: "http://localhost:" + s.port,
        command: s.command,
        pid: s.pid,
      });
    }
  }
  for (const wt of worktrees) wt.servers.sort((a, b) => a.port - b.port);
  return true;
}

// The full report the /api/worktrees endpoint serves.
//   opts.devCommand — per-repo override string (from ledger config), or null to auto-discover.
export function worktreeReport(repo, { skipPid, skipPort, devCommand, excludePaths } = {}) {
  const root = repo && repo.root;
  if (!root) return { worktrees: [], branches: [], serverScanned: false };

  const base = defaultBranch(root);
  const baseName = base.replace(/^origin\//, "");

  // Hidden worktrees (e.g. the preview environment's dedicated tree) are dropped entirely, so
  // they never surface in the panel and don't claim a branch's worktreePath.
  const hidden = new Set(excludePaths || []);
  const raw = visibleWorktrees(root, hidden);
  const branchToWorktree = new Map(); // branch name -> worktree path
  for (const w of raw) if (w.branch) branchToWorktree.set(w.branch, w.path);

  const config = readPmConfig(root);
  const stride = portStride(repo);

  const worktrees = raw.map((w, i) => {
    const rev = w.branch ? "refs/heads/" + w.branch : w.head || "HEAD";
    const ci = commitInfo(root, rev);
    return {
      path: w.path,
      name: path.basename(w.path),
      branch: w.branch,
      detached: w.detached,
      isMain: i === 0,
      isCurrent: w.path === root,
      // Stable instance slot (main = 0). Every declared port shifts by slot*stride so sibling
      // worktrees run on distinct ports; slot 0 keeps the canonical ports.
      slot: i,
      portOffset: i * stride,
      head: ci.short,
      subject: ci.subject,
      committedAt: ci.committedAt,
      ahead: base ? aheadBehind(root, rev, base) : null,
      devCommand: effectiveDevCommand(w.path, devCommand),
      servers: [],
    };
  });

  // One lsof scan feeds both the cwd-attributed auto-discovery (attachServers) and the global
  // port→pid map declared services use for liveness.
  const sockets = listeningSockets();
  const serverScanned = attachServers(worktrees, sockets, { skipPid, skipPort });
  // Unlike attachServers above, this does NOT skip the dashboard's own pid/port. skipPid/skipPort
  // exist so the dashboard's own listener isn't mistakenly auto-discovered as some worktree's
  // phantom dev server — but a declared service is an explicit assertion ("this port is what I
  // run"), and a repo can legitimately declare its own dashboard process as one (e.g. pm-agent
  // declaring "Observer" on its own serve port). Skipping here would make that service permanently
  // unable to report live, even while it's the process serving this very request.
  const listeningByPort = new Map();
  if (sockets) {
    for (const s of sockets) {
      if (!listeningByPort.has(s.port)) listeningByPort.set(s.port, s.pid);
    }
  }

  // Per-worktree declared services (from .pm/services.json), each enriched with live state.
  // Runs after the scan so port liveness is available. `devCommand` stays on each worktree for
  // the no-manifest fallback the panel still renders. Only *local* services live on the worktree
  // (they're the startable/port-scannable half); remote services are hoisted to the repo level
  // below, since hosted infra is shared across branches, not owned by a single worktree.
  const remoteServices = [];
  const remoteSeen = new Set();
  for (const wt of worktrees) {
    const svc = readServices(wt.path);
    wt.servicesError = svc.error || null;
    const local = (svc.services || []).filter((s) => s.location !== "remote");
    wt.servicesDeclared = local.length > 0;
    wt.services = local.map((s) => enrichService(wt, s, listeningByPort, wt.portOffset));
    // The repo-level Remote section is sourced from the primary (main) worktree's manifest — the
    // canonical checked-in declaration of the hosted stack. (A feature branch may declare its own
    // remotes; the primary is the stable source for the shared block.) `branch` labels which
    // branch is *deployed* there, independent of the branch you have checked out.
    if (wt.isMain) {
      for (const s of svc.services || []) {
        if (s.location !== "remote" || remoteSeen.has(s.name)) continue;
        remoteSeen.add(s.name);
        remoteServices.push({
          name: s.name,
          provider: s.provider,
          dashboard: s.dashboard,
          url: s.url,
          health: s.health,
          branch: s.branch,
          healthUrl: remoteHealthUrl(s), // null when unprobeable
          // "declared" = no health to probe (shown neutral forever); "unprobed" = has a health
          // URL but no result yet. The server overlays "up"/"down" once a probe lands.
          state: remoteHealthUrl(s) ? "unprobed" : "declared",
        });
      }
    }
  }

  // Which branches are merged into the default — those with no worktree are "closed".
  const mergedSet = new Set();
  if (base) {
    const merged = git(["branch", "--merged", base, "--format=%(refname:short)"], root);
    if (merged) for (const n of merged.split("\n")) if (n) mergedSet.add(n.trim());
  }

  const branches = [];
  const forEach = git(
    ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(committerdate:iso8601-strict)", "--sort=-committerdate", "refs/heads"],
    root
  );
  if (forEach) {
    for (const line of forEach.split("\n")) {
      const [name, head, committedAt] = line.split("\t");
      if (!name) continue;
      const ci = commitInfo(root, "refs/heads/" + name);
      branches.push({
        name,
        current: head === "*",
        isDefault: name === baseName,
        merged: mergedSet.has(name),
        worktreePath: branchToWorktree.get(name) || null,
        subject: ci.subject,
        committedAt: committedAt || ci.committedAt,
        ahead: base ? aheadBehind(root, "refs/heads/" + name, base) : null,
      });
    }
  }

  // Worktrees: current tree first, then main, then most-recent commit.
  worktrees.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return String(b.committedAt || "").localeCompare(String(a.committedAt || ""));
  });

  const worktreePanel = config.worktreePanel === "primary-preview" ? "primary-preview" : null;

  return { defaultBranch: baseName || null, worktrees, branches, remoteServices, serverScanned, worktreePanel, portStride: stride };
}

// ---- write ops -------------------------------------------------------------
// Where a new worktree lands: a generic numbered sibling of the main checkout — ../<repo>-1,
// ../<repo>-2, … — NOT a folder named after whatever branch first populates it. A worktree is a
// durable numbered workspace (matching the port "slot" model: main = 0, extra trees 1, 2, …) that
// branches move THROUGH (see checkoutBranch), so its folder name shouldn't be tied to one branch.
// Pick the smallest n≥1 whose dir is free both on disk and among registered worktrees, so removing
// one slot never renumbers the others.
export function worktreePathFor(root) {
  const parent = path.dirname(root);
  const repoName = path.basename(root);
  const taken = new Set(parseWorktrees(root).map((w) => w.path));
  for (let n = 1; ; n++) {
    const dest = path.join(parent, repoName + "-" + n);
    if (!taken.has(dest) && !existsSync(dest)) return dest;
  }
}

// `git worktree add <path> <branch>` — checks the existing branch out into a fresh numbered worktree.
export function createWorktree(repo, branch) {
  const root = repo && repo.root;
  if (!root) return { ok: false, error: "no repo root" };
  if (!branch) return { ok: false, error: "no branch given" };
  const dest = worktreePathFor(root);
  const r = gitWrite(["worktree", "add", dest, branch], root);
  return r.ok ? { ok: true, path: dest } : r;
}

// `git -C <worktree> switch <branch>` — move an existing worktree onto another branch. Git
// refuses if the branch is checked out elsewhere or the tree is dirty; that stderr is returned.
export function checkoutBranch(repo, worktreePath, branch) {
  if (!repo || !repo.root) return { ok: false, error: "no repo root" };
  if (!worktreePath || !branch) return { ok: false, error: "worktree and branch required" };
  // Confine the target to a worktree that actually belongs to this repo.
  const known = parseWorktrees(repo.root).some((w) => w.path === worktreePath);
  if (!known) return { ok: false, error: "unknown worktree for this repo" };
  return gitWrite(["-C", worktreePath, "switch", branch], repo.root);
}
