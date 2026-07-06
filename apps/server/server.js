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

function api(db, repo, url, cwdRepo) {
  const q = url.searchParams;
  const p = url.pathname;

  // The project switcher: every repo in the ledger, plus which one is "here" (the cwd repo).
  if (p === "/api/projects") {
    return {
      current: cwdRepo.slug,
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const scoped = scopeRepo(db, repo, url);
        const result = api(db, scoped, url, repo);
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
