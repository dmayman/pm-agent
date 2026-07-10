// The operator-UI server. Dependency-free node:http: a small JSON API over the ledger
// store plus static serving of apps/web. Run via `pm-agent serve` from inside a repo; it
// resolves that repo and shows only its timeline. Read-only — the UI is for looking, not
// managing (Claude owns the ledger; see docs/ledger.md).

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as S from "../../packages/db/store.js";
import { threadWorkStatus } from "../../packages/db/work.js";
import {
  worktreeReport,
  effectiveDevCommand,
  readServices,
  createWorktree,
  checkoutBranch,
  worktreeSlot,
  portStride,
  serviceLaunchEnv,
  effectivePort,
} from "../../packages/db/worktrees.js";
import {
  startDevServer,
  stopDevServer,
  serverStatus,
  startService,
  stopService,
  serviceStatus,
  trackedServiceNames,
} from "../../packages/db/devservers.js";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// The bare http://observer alias only reaches us when the loopback :80 redirect targets the
// port we actually bound (the default, 4477). Detect the /etc/hosts entry so the banner can
// surface the friendly URL — otherwise it'd be a lie.
function observerAlias(port) {
  if (port !== 4477) return null;
  try {
    const hosts = readFileSync("/etc/hosts", "utf8");
    return /^[^#\n]*\bobserver\b/m.test(hosts) ? "http://observer" : null;
  } catch {
    return null;
  }
}

// Preview awareness for the UI. Two sides of the same coin:
//   · THIS server is the preview (launched with PM_AGENT_PREVIEW=1) → tell the UI to show the
//     "not your real ledger" banner, and which branch it's serving.
//   · THIS server is the real one → look for a live preview via the rendezvous file the
//     `preview` command drops in the real home, so the dashboard can link to it.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function previewInfo() {
  if (process.env.PM_AGENT_PREVIEW === "1") {
    // The preview knows its own branch and a link back to the real observer (for the env toggle).
    return {
      self: true,
      branch: process.env.PM_AGENT_PREVIEW_BRANCH || null,
      parentUrl: process.env.PM_AGENT_PARENT_URL || null,
    };
  }
  const j = livePreview();
  return j ? { self: false, link: { url: j.url, branch: j.branch, port: j.port, lastSyncedAt: j.lastSyncedAt || null } } : null;
}

// The rendezvous the `preview` command drops in the real home, but only if its process is alive.
// Read by the real server both to link to a running preview and to hide its worktree from the panel.
function livePreview() {
  if (process.env.PM_AGENT_PREVIEW === "1") return null;
  try {
    const j = JSON.parse(readFileSync(path.join(S.pmHome(), "preview.json"), "utf8"));
    if (j && j.pid && pidAlive(j.pid)) return j;
  } catch {
    /* no preview running — the common case */
  }
  return null;
}

// A worktree's instance slot, computed with the SAME hidden-tree exclusion the /api/worktrees
// report uses (the live preview tree), so the offset a service launches with matches the port the
// panel shows for it.
function slotFor(repo, worktreePath) {
  const lp = livePreview();
  return worktreeSlot(repo, worktreePath, { excludePaths: lp && lp.tree ? [lp.tree] : undefined });
}

// Is the rendezvous'd preview's HTTP server actually answering yet? The rendezvous file appears
// as soon as `preview` spawns the child (pid alive), well before that child's server has bound
// its port — so the Primary/Preview panel's "launching…" spinner needs this, not just the pid
// check livePreview() already does for the env-switch banner.
function pingPreview(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/meta", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

// The Primary/Preview panel polls this (not previewInfo(), which only proves the pid is alive) to
// know when to upgrade its spinner to a live link.
async function previewState() {
  const lp = livePreview();
  if (!lp) return { running: false };
  const ready = await pingPreview(lp.port);
  return { running: true, ready, branch: lp.branch, url: lp.url, port: lp.port, lastSyncedAt: lp.lastSyncedAt || null };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  // Confine to WEB_DIR; default to index.html.
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error("dir");
    const buf = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    // SPA fallback: unknown non-API path → index.html
    try {
      const buf = await readFile(path.join(WEB_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] }).end(buf);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}

// Which repo a request is scoped to: the `?repo=<slug>` override when it names a known repo,
// otherwise the repo the server was launched inside (the default project).
function scopeRepo(db, cwdRepo, url) {
  const slug = url.searchParams.get("repo");
  if (slug) {
    const r = S.getRepoBySlug(db, slug);
    if (r) return r;
  }
  return cwdRepo;
}

function api(db, repo, url, cwdRepo, serverPort) {
  const q = url.searchParams;
  const p = url.pathname;

  // The project switcher: every repo in the ledger, as peers. There is no "home" project —
  // the observer is a system-level service, so the repos it serves are just the set that have
  // been enabled/initialized, ordered by recent activity (listRepos sorts by last event).
  if (p === "/api/projects") {
    return {
      selected: repo.slug,
      projects: S.listRepos(db).map((r) => ({
        slug: r.slug,
        root: r.root,
        threads: r.threads,
        events: r.events,
        lastActivity: r.last_event_ts,
      })),
    };
  }

  if (p === "/api/meta") {
    const u = S.usageTotals(db, repo.id) || {};
    return {
      repo: repo.slug,
      root: repo.root,
      capture: S.effectiveConfig(db, repo.slug, "capture", "observer"),
      threads: S.listThreads(db, repo.id).length,
      loose: S.listLooseEnds(db, repo.id).length,
      cost: u.cost || 0,
      tokens: (u.input || 0) + (u.output || 0) + (u.cache_read || 0) + (u.cache_creation || 0),
      preview: previewInfo(),
    };
  }
  if (p === "/api/timeline") {
    let since = q.get("since");
    if (q.get("days")) {
      const d = new Date();
      d.setDate(d.getDate() - Number(q.get("days")));
      since = d.toISOString();
    }
    const threadId = q.get("thread") ? S.resolveThread(db, repo.id, q.get("thread")) : null;
    return S.listEvents(db, repo.id, {
      since,
      threadId,
      limit: Number(q.get("limit")) || 500,
    }).map(decodeRefs);
  }
  if (p === "/api/inflight") {
    return {
      threads: S.listThreads(db, repo.id)
        .filter((t) => t.status !== "done")
        .map((t) => withWork(db, t)),
      loose: S.listLooseEnds(db, repo.id).map(decodeRefs),
    };
  }
  if (p === "/api/usage") {
    const days = Number(q.get("days")) || 30;
    return {
      days: S.usageByDay(db, repo.id, { days }),
      total: S.usageTotals(db, repo.id),
      window: days,
    };
  }
  // Live git state (not from the ledger): worktrees + their dev servers, every local branch
  // with its checkout/merge status. Computed on demand by shelling to git/lsof, then annotated
  // with which servers *this* process is supervising (so the panel can show "starting…").
  if (p === "/api/worktrees") {
    const override = S.effectiveConfig(db, repo.slug, "devCommand", null);
    const lp = livePreview();
    const report = worktreeReport(repo, {
      skipPid: process.pid,
      skipPort: serverPort,
      devCommand: override,
      excludePaths: lp && lp.tree ? [lp.tree] : undefined,
    });
    for (const wt of report.worktrees) {
      const tracked = serverStatus(wt.path);
      wt.serverState = wt.servers.length ? "live" : tracked && !tracked.exited ? "starting" : "stopped";
      wt.tracked = tracked;
    }
    report.devCommandOverride = override || null;
    return report;
  }
  if (p === "/api/loose") return S.listLooseEnds(db, repo.id).map(decodeRefs);
  if (p === "/api/threads") return S.listThreads(db, repo.id).map((t) => withWork(db, t));
  const m = p.match(/^\/api\/thread\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const thread = S.getThread(db, id);
    if (!thread || thread.repo_id !== repo.id) return { __status: 404, error: "no such thread" };
    return {
      thread: withWork(db, thread),
      issues: S.issuesForThread(db, id),
      events: S.listEvents(db, repo.id, { threadId: id, limit: 1000 }).map(decodeRefs),
    };
  }
  return { __status: 404, error: "unknown endpoint" };
}

// The listener pids on a service's declared port, under a given worktree — so stop can SIGTERM a
// server started outside the dashboard too (mirrors the single-server stop). A port-less service
// has nothing to port-detect: only the process group we ourselves launched can be stopped.
function listenerPidsFor(repo, worktree, port, serverPort) {
  if (port == null) return [];
  const report = worktreeReport(repo, { skipPid: process.pid, skipPort: serverPort });
  const wt = report.worktrees.find((w) => w.path === worktree);
  if (!wt) return [];
  return wt.servers.filter((s) => s.port === port).map((s) => s.pid).filter(Boolean);
}

// The write API: git worktree/branch mutations and dev-server lifecycle. Kept separate from
// the read `api()` because these have side effects, take a parsed JSON body, and are gated by
// the same-origin guard below. Every branch returns a plain object ({ ok, ... } / { error }).
async function writeApi(db, repo, url, body, serverPort) {
  const p = url.pathname;
  const b = body || {};

  // Re-point THIS preview at another branch. Only valid on a preview server. Relaunches `preview`
  // (idempotent: it stops this server, re-checks-out the hidden worktree, and rebinds the same
  // port), so the UI just waits a beat and reloads. The real home is threaded in via env so the
  // child writes the rendezvous where the real observer looks (not the scratch home).
  if (p === "/api/preview/switch") {
    if (process.env.PM_AGENT_PREVIEW !== "1") return { __status: 403, error: "not a preview server" };
    const target = String(b.branch || "").trim();
    if (!target) return { __status: 400, error: "branch required" };
    const cli = path.join(process.cwd(), "bin", "pm-agent.js");
    const child = spawn(process.execPath, [cli, "preview", target, "--port", String(serverPort)], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PM_AGENT_HOME: process.env.PM_AGENT_REAL_HOME || "",
        PM_AGENT_PREVIEW: "",
        PM_AGENT_PREVIEW_BRANCH: "",
      },
    });
    child.unref();
    return { ok: true, branch: target };
  }

  // Launch (or re-point) the preview from the PRIMARY dashboard — the gap /api/preview/switch
  // doesn't cover, since that one only works when called *on* an already-running preview. `preview`
  // is idempotent (it tears down any prior preview itself), so the same command covers both "spawn
  // a fresh one" and "re-point the running one": reuse its port if it's already up, else the
  // command's own default.
  if (p === "/api/preview/launch") {
    const target = String(b.branch || "").trim();
    if (!target) return { __status: 400, error: "branch required" };
    const cli = path.join(repo.root, "bin", "pm-agent.js");
    if (!existsSync(cli)) return { __status: 400, error: "not a pm-agent checkout" };
    const lp = livePreview();
    const args = [cli, "preview", target];
    if (lp && lp.port) args.push("--port", String(lp.port));
    const child = spawn(process.execPath, args, {
      cwd: repo.root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, branch: target };
  }

  // Resync the running preview's scratch DB from prod, on demand — the "Resync" button. Reseeding
  // means relaunching the preview with `--reseed` on ITS OWN branch and port (the preview server
  // holds the scratch SQLite open, so we stop + re-copy + respawn rather than overwrite underneath
  // it). Everything — branch, port, the file paths that get copied — is resolved server-side from
  // the rendezvous; the request body carries nothing, so a hostile POST can't redirect the copy.
  if (p === "/api/preview/reseed") {
    const lp = livePreview();
    if (!lp) return { __status: 409, error: "no preview is running" };
    const cli = path.join(repo.root, "bin", "pm-agent.js");
    if (!existsSync(cli)) return { __status: 400, error: "not a pm-agent checkout" };
    const child = spawn(process.execPath, [cli, "preview", lp.branch, "--reseed", "--port", String(lp.port)], {
      cwd: repo.root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, branch: lp.branch };
  }

  if (p === "/api/worktree/create") {
    return createWorktree(repo, b.branch);
  }
  if (p === "/api/worktree/checkout") {
    return checkoutBranch(repo, b.worktree, b.branch);
  }
  if (p === "/api/devcommand") {
    // Persist a per-repo override so the panel's edited command survives restarts, and so the
    // server (not the browser) is the source of truth for what `start` actually runs.
    const cmd = typeof b.command === "string" ? b.command.trim() : "";
    S.setConfig(db, repo.slug, "devCommand", cmd);
    return { ok: true, command: cmd || null };
  }
  if (p === "/api/server/start") {
    if (!b.worktree) return { __status: 400, error: "worktree required" };
    const override = S.effectiveConfig(db, repo.slug, "devCommand", null);
    const command = effectiveDevCommand(b.worktree, override);
    if (!command) return { __status: 400, error: "no dev command — set one first" };
    return await startDevServer(b.worktree, command);
  }
  if (p === "/api/server/stop") {
    if (!b.worktree) return { __status: 400, error: "worktree required" };
    // Also SIGTERM any listener we can see in that worktree, so servers started outside the
    // dashboard can be stopped too.
    const report = worktreeReport(repo, { skipPid: process.pid, skipPort: serverPort });
    const wt = report.worktrees.find((w) => w.path === b.worktree);
    const pids = wt ? wt.servers.map((s) => s.pid).filter(Boolean) : [];
    return stopDevServer(b.worktree, pids);
  }

  // Per-service lifecycle. The command is ALWAYS resolved by the server from the worktree's
  // checked-in .pm/services.json (never taken from the request body) — a hostile POST can name a
  // service but can't inject a command to run.
  if (p === "/api/service/start") {
    if (!b.worktree || !b.name) return { __status: 400, error: "worktree and name required" };
    const { services, error } = readServices(b.worktree);
    if (error) return { __status: 400, error };
    let service = services && services.find((s) => s.name === b.name);
    if (!service) {
      // No manifest entry: allow the fallback "dev" service via auto-detect / stored override.
      if (b.name === "dev") {
        const override = S.effectiveConfig(db, repo.slug, "devCommand", null);
        const command = effectiveDevCommand(b.worktree, override);
        if (!command) return { __status: 400, error: "no dev command — set one first" };
        service = { name: "dev", command, cwd: ".", port: null };
      } else {
        return { __status: 404, error: `no service "${b.name}" in .pm/services.json` };
      }
    }
    // Inject the per-worktree effective port so a non-primary worktree binds a distinct port.
    const slot = slotFor(repo, b.worktree);
    return await startService(b.worktree, { ...service, env: serviceLaunchEnv(service, slot, portStride(repo)) });
  }
  if (p === "/api/service/stop") {
    if (!b.worktree || !b.name) return { __status: 400, error: "worktree and name required" };
    const { services } = readServices(b.worktree);
    const svc = services && services.find((s) => s.name === b.name);
    // The listener lives on the effective (offset) port for this worktree, not the declared one.
    const eff = svc ? effectivePort(svc.port, slotFor(repo, b.worktree), portStride(repo)) : null;
    const pids = listenerPidsFor(repo, b.worktree, eff, serverPort);
    return stopService(b.worktree, b.name, pids);
  }
  if (p === "/api/services/start-all") {
    if (!b.worktree) return { __status: 400, error: "worktree required" };
    const { services, error } = readServices(b.worktree);
    if (error) return { __status: 400, error };
    if (!services || !services.length) return { __status: 400, error: "no services declared" };
    const slot = slotFor(repo, b.worktree);
    const stride = portStride(repo);
    // One scan up front tells us which effective ports are already listening.
    const report = worktreeReport(repo, { skipPid: process.pid, skipPort: serverPort });
    const wt = report.worktrees.find((w) => w.path === b.worktree);
    const livePorts = new Set((wt ? wt.servers : []).map((s) => s.port));
    const results = [];
    for (const s of services) {
      const eff = effectivePort(s.port, slot, stride);
      const trackedLive = (() => { const t = serviceStatus(b.worktree, s.name); return t && !t.exited; })();
      if ((eff != null && livePorts.has(eff)) || trackedLive) {
        results.push({ name: s.name, ok: true, already: true });
        continue;
      }
      const r = await startService(b.worktree, { ...s, env: serviceLaunchEnv(s, slot, stride) });
      results.push({ name: s.name, ...r });
    }
    return { ok: results.every((r) => r.ok !== false), results };
  }
  if (p === "/api/services/stop-all") {
    if (!b.worktree) return { __status: 400, error: "worktree required" };
    const { services } = readServices(b.worktree);
    const slot = slotFor(repo, b.worktree);
    const stride = portStride(repo);
    const report = worktreeReport(repo, { skipPid: process.pid, skipPort: serverPort });
    const wt = report.worktrees.find((w) => w.path === b.worktree);
    // Everything declared, plus anything we're still tracking that isn't declared anymore.
    const names = new Set((services || []).map((s) => s.name));
    for (const n of trackedServiceNames(b.worktree)) names.add(n);
    const results = [];
    for (const name of names) {
      const svc = (services || []).find((s) => s.name === name);
      const eff = svc ? effectivePort(svc.port, slot, stride) : null;
      const pids = eff != null && wt
        ? wt.servers.filter((s) => s.port === eff).map((s) => s.pid).filter(Boolean)
        : [];
      results.push({ name, ...stopService(b.worktree, name, pids) });
    }
    return { ok: true, results };
  }
  return { __status: 404, error: "unknown endpoint" };
}

// CSRF / DNS-rebinding guard for the write endpoints. The observer binds loopback and is
// single-user, but it can now spawn processes and mutate git — so reject any request whose
// Origin is cross-site or whose Host header isn't a loopback name we expect. A same-origin
// dashboard fetch has no Origin (or a matching one) and a localhost Host, so it passes.
function sameOrigin(req, port) {
  const host = String(req.headers.host || "");
  const hostOk = /^(localhost|127\.0\.0\.1|\[?::1\]?|observer)(:\d+)?$/.test(host);
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (!/^(localhost|127\.0\.0\.1|::1|observer)$/.test(o.hostname)) return false;
    } catch {
      return false;
    }
  }
  return hostOk;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return resolve(null);
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

// Attach the issue-lifecycle rollup (done/in-progress/todo counts + unfinished list) so the
// UI can lead with "what's finished vs still open" instead of raw commits.
function withWork(db, thread) {
  return { ...thread, work: threadWorkStatus(db, thread.id) };
}

function decodeRefs(e) {
  if (e && typeof e.refs === "string") {
    try {
      e.refs = JSON.parse(e.refs);
    } catch {}
  }
  return e;
}

// SQLite's data_version bumps whenever the database file is committed to by *another*
// connection — exactly our situation: the ledger is written by a separate observer process, so
// polling this on the server's own connection is a cheap, reliable "did the ledger change?"
// signal to fan out to connected SSE clients. (It deliberately does not tick for writes made on
// this same connection — our config writes — which don't need pushing anyway.)
function dataVersion(db) {
  try {
    return db.prepare("PRAGMA data_version").get().data_version;
  } catch {
    return 0;
  }
}

// Open a long-lived Server-Sent Events connection. Frames are pushed by the change-poll in
// serve() whenever data_version moves, so the dashboard learns of new ledger data in ~1s
// without polling. Named-event-less `data:` frames so the client's plain `onmessage` catches
// them; a `retry:` hint drives EventSource's own reconnect after a server restart.
function openStream(req, res, sseClients, version) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // stop any intermediary from buffering the stream (frames must flush immediately)
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(`data: ${JSON.stringify({ type: "hello", v: version })}\n\n`);
  sseClients.add(res);
  // A periodic comment keeps the socket alive through idle-timeout proxies without waking the UI.
  const ping = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {}
  }, 25000);
  if (ping.unref) ping.unref();
  const cleanup = () => {
    clearInterval(ping);
    sseClients.delete(res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

export function serve({ port = 4477, cwd = process.cwd() } = {}) {
  const db = S.openDb();
  // Default project: the repo we're launched inside. When there isn't one — e.g. the server
  // runs as a background LaunchAgent with no repo cwd — fall back to the most-recently-active
  // project so the dashboard still opens somewhere; the switcher reaches the rest.
  let repo = S.getRepo(db, cwd);
  if (!repo) {
    const known = S.listRepos(db);
    if (!known.length) {
      process.stderr.write(
        "pm-agent serve: not inside a git repository, and the ledger is empty.\n" +
          "Run `pm-agent setup` inside a repo first.\n"
      );
      process.exit(1);
    }
    repo = known[0];
  }

  // Live push: hold every /api/stream connection open and nudge them all whenever the ledger's
  // data_version changes. One shared 1s poll fans out to N clients, so the dashboard updates
  // within ~1s of the observer writing, with no per-client polling.
  const sseClients = new Set();
  let lastVersion = dataVersion(db);
  const watch = setInterval(() => {
    const v = dataVersion(db);
    if (v === lastVersion) return;
    lastVersion = v;
    const frame = `data: ${JSON.stringify({ type: "change", v })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {}
    }
  }, 1000);
  if (watch.unref) watch.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/stream" && req.method === "GET") {
          return openStream(req, res, sseClients, lastVersion);
        }
        // Not repo-scoped (the preview rendezvous is global to this machine, not per-project) and
        // async (the readiness probe is a real network call), so it's handled outside api()/writeApi().
        if (url.pathname === "/api/preview/state" && req.method === "GET") {
          return sendJson(res, 200, await previewState());
        }
        const scoped = scopeRepo(db, repo, url);
        if (req.method === "POST") {
          if (!sameOrigin(req, port)) return sendJson(res, 403, { error: "cross-origin request blocked" });
          const body = await readJsonBody(req);
          if (body === null) return sendJson(res, 400, { error: "invalid JSON body" });
          const result = await writeApi(db, scoped, url, body, port);
          const status = result && result.__status ? result.__status : 200;
          if (result) delete result.__status;
          return sendJson(res, status, result);
        }
        const result = api(db, scoped, url, repo, port);
        const status = result && result.__status ? result.__status : 200;
        if (result) delete result.__status;
        return sendJson(res, status, result);
      }
      await serveStatic(res, req.url);
    } catch (err) {
      sendJson(res, 500, { error: String(err && err.message) });
    }
  });

  server.listen(port, () => {
    // Record the real observer's URL so `pm-agent preview` can link the preview back here (the env
    // toggle). Only the real server does this — a preview must not overwrite the parent's pointer.
    if (process.env.PM_AGENT_PREVIEW !== "1") {
      try {
        writeFileSync(
          path.join(S.pmHome(), "observer.json"),
          JSON.stringify({ url: observerAlias(port) || `http://localhost:${port}`, port })
        );
      } catch {}
    }
    // If the http://observer redirect is wired up (scripts/observer-hostname-setup.sh),
    // it targets the default port — so lead with the pretty URL only when we bound it.
    const alias = observerAlias(port);
    const line = alias
      ? `  → ${alias}   ·   http://localhost:${port}`
      : `  → http://localhost:${port}`;
    process.stdout.write(
      `\n  pm-agent operator UI  ·  ${repo.slug}\n${line}\n\n  Ctrl-C to stop.\n`
    );
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`pm-agent serve: port ${port} is in use. Try --port <n>.\n`);
      process.exit(1);
    }
    throw err;
  });
  return server;
}
