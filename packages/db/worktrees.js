// Live worktree + branch + dev-server enumeration for the operator UI. Unlike the ledger
// (persisted SQLite), this is computed on demand by shelling to `git` and `lsof`: it answers
// "which branches have active work, which worktree has each checked out, and where's each
// one's dev server?" — the "finding the server is always such a painpoint" problem. The read
// paths are best-effort (every probe degrades to empty rather than throwing); the write paths
// (worktree add / branch switch) return {ok, error} with git's stderr surfaced.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

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

// The branch a new worktree diverges from — origin/HEAD when the remote advertises one, else
// a local main/master. Returned as a rev-parseable ref ("origin/main" or "main").
function defaultBranch(root) {
  const remote = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (remote) return remote;
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", "refs/heads/" + b], root)) return b;
  }
  return "";
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
function attachServers(worktrees, { skipPid, skipPort } = {}) {
  const sockets = listeningSockets();
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
export function worktreeReport(repo, { skipPid, skipPort, devCommand } = {}) {
  const root = repo && repo.root;
  if (!root) return { worktrees: [], branches: [], serverScanned: false };

  const base = defaultBranch(root);
  const baseName = base.replace(/^origin\//, "");

  const raw = parseWorktrees(root).filter((w) => !w.bare);
  const branchToWorktree = new Map(); // branch name -> worktree path
  for (const w of raw) if (w.branch) branchToWorktree.set(w.branch, w.path);

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
      head: ci.short,
      subject: ci.subject,
      committedAt: ci.committedAt,
      ahead: base ? aheadBehind(root, rev, base) : null,
      devCommand: effectiveDevCommand(w.path, devCommand),
      servers: [],
    };
  });

  const serverScanned = attachServers(worktrees, { skipPid, skipPort });

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

  return { defaultBranch: baseName || null, worktrees, branches, serverScanned };
}

// ---- write ops -------------------------------------------------------------
// A filesystem-safe leaf for a worktree dir made from a branch name (feature/x -> feature-x).
function slugForBranch(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
}

// Where a new worktree for `branch` lands: sibling of the main checkout, ../<repo>-<branch>.
export function worktreePathFor(root, branch) {
  const parent = path.dirname(root);
  const repoName = path.basename(root);
  return path.join(parent, repoName + "-" + slugForBranch(branch));
}

// `git worktree add <path> <branch>` — checks the existing branch out into a fresh worktree.
export function createWorktree(repo, branch) {
  const root = repo && repo.root;
  if (!root) return { ok: false, error: "no repo root" };
  if (!branch) return { ok: false, error: "no branch given" };
  const dest = worktreePathFor(root, branch);
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
