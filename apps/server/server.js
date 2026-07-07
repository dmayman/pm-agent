// The operator-UI server. Dependency-free node:http: a small JSON API over the ledger
// store plus static serving of apps/web. Run via `pm-agent serve` from inside a repo; it
// resolves that repo and shows only its timeline. Read-only — the UI is for looking, not
// managing (Claude owns the ledger; see docs/ledger.md).

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as S from "../../packages/db/store.js";
import { threadWorkStatus } from "../../packages/db/work.js";
import {
  worktreeReport,
  effectiveDevCommand,
  createWorktree,
  checkoutBranch,
} from "../../packages/db/worktrees.js";
import { startDevServer, stopDevServer, serverStatus } from "../../packages/db/devservers.js";

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
    const report = worktreeReport(repo, {
      skipPid: process.pid,
      skipPort: serverPort,
      devCommand: override,
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

// The write API: git worktree/branch mutations and dev-server lifecycle. Kept separate from
// the read `api()` because these have side effects, take a parsed JSON body, and are gated by
// the same-origin guard below. Every branch returns a plain object ({ ok, ... } / { error }).
async function writeApi(db, repo, url, body, serverPort) {
  const p = url.pathname;
  const b = body || {};

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
