// The operator-UI server. Dependency-free node:http: a small JSON API over the ledger
// store plus static serving of apps/web. Run via `pm-agent serve` from inside a repo; it
// resolves that repo and shows only its timeline. Read-only — the UI is for looking, not
// managing (Claude owns the ledger; see docs/ledger.md).

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as S from "../../packages/db/store.js";

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

function api(db, repo, url) {
  const q = url.searchParams;
  const p = url.pathname;

  if (p === "/api/meta") {
    return {
      repo: repo.slug,
      root: repo.root,
      capture: S.effectiveConfig(db, repo.slug, "capture", "observer"),
      threads: S.listThreads(db, repo.id).length,
      loose: S.listLooseEnds(db, repo.id).length,
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
      threads: S.listThreads(db, repo.id).filter((t) => t.status !== "done"),
      loose: S.listLooseEnds(db, repo.id).map(decodeRefs),
    };
  }
  if (p === "/api/loose") return S.listLooseEnds(db, repo.id).map(decodeRefs);
  if (p === "/api/threads") return S.listThreads(db, repo.id);
  const m = p.match(/^\/api\/thread\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const thread = S.getThread(db, id);
    if (!thread || thread.repo_id !== repo.id) return { __status: 404, error: "no such thread" };
    return { thread, events: S.listEvents(db, repo.id, { threadId: id, limit: 1000 }).map(decodeRefs) };
  }
  return { __status: 404, error: "unknown endpoint" };
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
  const repo = S.getRepo(db, cwd);
  if (!repo) {
    process.stderr.write("pm-agent serve: not inside a git repository.\n");
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const result = api(db, repo, url);
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
    process.stdout.write(
      `\n  pm-agent operator UI  ·  ${repo.slug}\n  → http://localhost:${port}\n\n  Ctrl-C to stop.\n`
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
