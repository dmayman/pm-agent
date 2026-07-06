// The ledger store — a single global SQLite DB shared by every session/worktree on the
// machine, keyed by repo. See docs/ledger.md for the why. Dependency-free: uses the
// built-in node:sqlite (Node >= 22.5), so `npx pm-agent` needs no native build.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// node:sqlite emits an ExperimentalWarning on import; swallow just that one so CLI
// output stays clean. Done before the (dynamic) import so it's in place when it fires.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === "string" ? warning : warning?.message || "";
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return _emitWarning(warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");

const now = () => new Date().toISOString();

// The canonical event vocabulary. `deferred` is load-bearing (loose ends query on it), so
// every write normalizes to this set — Haiku and hand-logging both drift otherwise.
export const EVENT_TYPES = [
  "decided",
  "built",
  "tested",
  "reviewed",
  "followup",
  "deferred",
  "merged",
  "blocked",
  "note",
];
const TYPE_ALIASES = {
  decision: "decided",
  decide: "decided",
  implementation: "built",
  implemented: "built",
  build: "built",
  building: "built",
  coded: "built",
  wrote: "built",
  test: "tested",
  tests: "tested",
  testing: "tested",
  review: "reviewed",
  reviewing: "reviewed",
  "follow-up": "followup",
  follow_up: "followup",
  defer: "deferred",
  deferral: "deferred",
  todo: "deferred",
  merge: "merged",
  merging: "merged",
  block: "blocked",
  blocker: "blocked",
  fixed: "built",
  fix: "built",
};
export function normalizeType(t) {
  if (!t) return "note";
  const k = String(t).toLowerCase().trim();
  if (EVENT_TYPES.includes(k)) return k;
  return TYPE_ALIASES[k] || "note";
}

// ---------------------------------------------------------------------------
// Location + schema
// ---------------------------------------------------------------------------

export function pmHome() {
  const home = process.env.PM_AGENT_HOME || path.join(os.homedir(), ".pm-agent");
  mkdirSync(home, { recursive: true });
  return home;
}

export function dbPath() {
  return path.join(pmHome(), "pm.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id         INTEGER PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,   -- owner/repo, or local:<hash> when there's no remote
  root       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY,
  repo_id    INTEGER NOT NULL REFERENCES repos(id),
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- active | in_review | blocked | done
  genesis    TEXT,                              -- distilled founding decisions
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_repo ON threads(repo_id, status);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  thread_id   INTEGER REFERENCES threads(id),
  ts          TEXT NOT NULL,        -- when it happened (may be backdated for derived)
  type        TEXT NOT NULL,        -- decided|built|tested|reviewed|followup|deferred|merged|blocked|note
  summary     TEXT NOT NULL,
  refs        TEXT,                 -- json: {issue, commit, branch, pr}
  source      TEXT NOT NULL,        -- observer | explicit | derived
  dedupe_key  TEXT,                 -- set for derived events so ingest is idempotent
  resolved_at TEXT,                 -- for type=deferred: when the loose end was closed
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_repo_ts ON events(repo_id, ts);
CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(repo_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS issue_titles (
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  number  INTEGER NOT NULL,
  title   TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);

CREATE TABLE IF NOT EXISTS config (
  scope TEXT NOT NULL,   -- 'global' or a repo slug
  key   TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (scope, key)
);

-- One row per Haiku call the tool makes, so the operator can see what it costs.
CREATE TABLE IF NOT EXISTS usage (
  id                    INTEGER PRIMARY KEY,
  repo_id               INTEGER REFERENCES repos(id),
  ts                    TEXT NOT NULL,   -- UTC ISO; grouped by local day for display
  kind                  TEXT,            -- observer | synthesis | cluster
  input_tokens          INTEGER DEFAULT 0,
  output_tokens         INTEGER DEFAULT 0,
  cache_read_tokens     INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cost_usd              REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_repo_ts ON usage(repo_id, ts);
`;

// Add a column if an older DB doesn't have it yet (CREATE TABLE IF NOT EXISTS won't alter).
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

let _db;
export function openDb() {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Migrations for DBs created before these columns existed.
  ensureColumn(db, "threads", "summary", "TEXT"); // Haiku-synthesized plain-language what/why
  ensureColumn(db, "threads", "summary_event_count", "INTEGER"); // staleness marker
  // issue_titles started life as just number→title; it's now the issues table with
  // lifecycle + thread membership. Grow it in place.
  ensureColumn(db, "issue_titles", "state", "TEXT"); // OPEN | CLOSED (from gh)
  ensureColumn(db, "issue_titles", "opened_at", "TEXT");
  ensureColumn(db, "issue_titles", "closed_at", "TEXT");
  ensureColumn(db, "issue_titles", "branch", "TEXT"); // an open branch for this issue, if any
  ensureColumn(db, "issue_titles", "status", "TEXT"); // todo | in_progress | done
  ensureColumn(db, "issue_titles", "thread_id", "INTEGER"); // initiative this issue belongs to
  _db = db;
  return db;
}

// ---------------------------------------------------------------------------
// Repo identity — unifies all worktrees of a repo onto one row
// ---------------------------------------------------------------------------

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function remoteSlug(url) {
  if (!url) return "";
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo.git  |  ssh://...
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : "";
}

export function resolveRepo(cwd = process.cwd()) {
  // --git-common-dir is shared across all worktrees of a repo, so it (and the remote
  // derived from it) is the stable identity that ties parallel worktrees together.
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (!commonDir) return null; // not a git repo
  const root = git(["rev-parse", "--show-toplevel"], cwd) || cwd;
  let slug =
    remoteSlug(git(["remote", "get-url", "origin"], cwd)) ||
    remoteSlug(git(["remote", "get-url", "upstream"], cwd));
  if (!slug) slug = "local:" + createHash("sha1").update(commonDir).digest("hex").slice(0, 12);
  return { slug, root, commonDir };
}

// Get (creating if needed) the repos row for a working directory. Returns null when the
// cwd isn't inside a git repo.
export function getRepo(db, cwd = process.cwd()) {
  const info = resolveRepo(cwd);
  if (!info) return null;
  db.prepare("INSERT OR IGNORE INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(
    info.slug,
    info.root,
    now()
  );
  const row = db.prepare("SELECT * FROM repos WHERE slug = ?").get(info.slug);
  if (info.root && row.root !== info.root) {
    db.prepare("UPDATE repos SET root = ? WHERE id = ?").run(info.root, row.id);
    row.root = info.root;
  }
  return { ...row, slug: info.slug };
}

// Look up a repo by its slug (owner/name or local:<hash>). Returns null if unknown — used
// by the operator UI to switch which project's ledger it's viewing.
export function getRepoBySlug(db, slug) {
  return db.prepare("SELECT * FROM repos WHERE slug = ?").get(slug) || null;
}

// Every repo the ledger knows about, most-recently-active first, with light activity counts
// so the operator UI can offer a project switcher. Repos with no events yet still appear
// (freshly initialized), but sort to the bottom.
export function listRepos(db) {
  return db
    .prepare(
      `SELECT r.id, r.slug, r.root, r.created_at,
         (SELECT COUNT(*) FROM threads t WHERE t.repo_id = r.id) AS threads,
         (SELECT COUNT(*) FROM events  e WHERE e.repo_id = r.id) AS events,
         (SELECT MAX(e.ts) FROM events e WHERE e.repo_id = r.id) AS last_event_ts
       FROM repos r
       ORDER BY (last_event_ts IS NULL), last_event_ts DESC, r.created_at DESC`
    )
    .all();
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export function createThread(db, repoId, { title, genesis = null, status = "active" }) {
  const t = now();
  const r = db
    .prepare(
      "INSERT INTO threads (repo_id, title, status, genesis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(repoId, title, status, genesis, t, t);
  return Number(r.lastInsertRowid);
}

export function getThread(db, id) {
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(id) || null;
}

export function findThreadByTitle(db, repoId, title) {
  return (
    db
      .prepare("SELECT * FROM threads WHERE repo_id = ? AND title = ? ORDER BY id DESC LIMIT 1")
      .get(repoId, title) || null
  );
}

// Resolve a thread by id or title, creating it if missing (so callers can just name it).
export function resolveThread(db, repoId, ref, { genesis = null } = {}) {
  if (ref == null || ref === "") return null;
  if (/^\d+$/.test(String(ref))) {
    const t = getThread(db, Number(ref));
    if (t && t.repo_id === repoId) return t.id;
  }
  const existing = findThreadByTitle(db, repoId, String(ref));
  if (existing) return existing.id;
  return createThread(db, repoId, { title: String(ref), genesis });
}

export function updateThread(db, id, fields) {
  const cols = [];
  const vals = [];
  for (const k of ["title", "status", "genesis"]) {
    if (k in fields && fields[k] != null) {
      cols.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!cols.length) return;
  cols.push("updated_at = ?");
  vals.push(now(), id);
  db.prepare(`UPDATE threads SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
}

function touchThread(db, id) {
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now(), id);
}

// Store the synthesized summary and the event count it was generated from (for staleness).
export function setThreadSummary(db, id, summary, eventCount) {
  db.prepare("UPDATE threads SET summary = ?, summary_event_count = ? WHERE id = ?").run(
    summary,
    eventCount,
    id
  );
}

export function listThreads(db, repoId, { status = null } = {}) {
  const where = status ? "AND status = ?" : "";
  const args = status ? [repoId, status] : [repoId];
  return db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM events e WHERE e.thread_id = t.id) AS event_count,
              (SELECT COUNT(*) FROM issue_titles i WHERE i.thread_id = t.id) AS issue_count,
              (SELECT MAX(ts) FROM events e WHERE e.thread_id = t.id) AS last_event_ts
         FROM threads t
        WHERE repo_id = ? ${where}
        ORDER BY COALESCE(last_event_ts, updated_at) DESC`
    )
    .all(...args);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function logEvent(
  db,
  repoId,
  { threadId = null, type, summary, refs = null, source = "explicit", ts = null, dedupeKey = null }
) {
  const t = now();
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO events
         (repo_id, thread_id, ts, type, summary, refs, source, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      repoId,
      threadId,
      ts || t,
      type,
      summary,
      refs ? (typeof refs === "string" ? refs : JSON.stringify(refs)) : null,
      source,
      dedupeKey,
      t
    );
  if (threadId && r.changes) touchThread(db, threadId);
  return Number(r.lastInsertRowid);
}

export function listEvents(db, repoId, { since = null, threadId = null, limit = 500 } = {}) {
  const clauses = ["e.repo_id = ?"];
  const args = [repoId];
  if (since) {
    clauses.push("e.ts >= ?");
    args.push(since);
  }
  if (threadId) {
    clauses.push("e.thread_id = ?");
    args.push(threadId);
  }
  args.push(limit);
  return db
    .prepare(
      `SELECT e.*, t.title AS thread_title, t.status AS thread_status
         FROM events e LEFT JOIN threads t ON t.id = e.thread_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.ts DESC LIMIT ?`
    )
    .all(...args);
}

// Loose ends = unresolved deferred events.
export function listLooseEnds(db, repoId) {
  return db
    .prepare(
      `SELECT e.*, t.title AS thread_title
         FROM events e LEFT JOIN threads t ON t.id = e.thread_id
        WHERE e.repo_id = ? AND e.type = 'deferred' AND e.resolved_at IS NULL
        ORDER BY e.ts DESC`
    )
    .all(repoId);
}

export function resolveLooseEnd(db, id) {
  db.prepare("UPDATE events SET resolved_at = ? WHERE id = ?").run(now(), id);
}

// ---------------------------------------------------------------------------
// Issue glossary (#53 -> human title) and config
// ---------------------------------------------------------------------------

export function setIssueTitle(db, repoId, number, title) {
  db.prepare(
    `INSERT INTO issue_titles (repo_id, number, title) VALUES (?, ?, ?)
     ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title`
  ).run(repoId, Number(number), title);
}

export function issueGlossary(db, repoId, limit = 50) {
  return db
    .prepare("SELECT number, title FROM issue_titles WHERE repo_id = ? ORDER BY number DESC LIMIT ?")
    .all(repoId, limit);
}

// --- Issue lifecycle -------------------------------------------------------

// Upsert an issue's identity + state (title/state/dates from gh). Leaves branch/status/
// thread_id untouched so derived fields survive re-syncs.
export function upsertIssue(db, repoId, { number, title, state = null, opened_at = null, closed_at = null }) {
  db.prepare(
    `INSERT INTO issue_titles (repo_id, number, title, state, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, number) DO UPDATE SET
       title = excluded.title,
       state = COALESCE(excluded.state, issue_titles.state),
       opened_at = COALESCE(excluded.opened_at, issue_titles.opened_at),
       closed_at = COALESCE(excluded.closed_at, issue_titles.closed_at)`
  ).run(repoId, Number(number), title, state, opened_at, closed_at);
}

export function setIssueFields(db, repoId, number, fields) {
  const cols = [];
  const vals = [];
  for (const k of ["branch", "status", "thread_id"]) {
    if (k in fields) {
      cols.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!cols.length) return;
  vals.push(repoId, Number(number));
  db.prepare(`UPDATE issue_titles SET ${cols.join(", ")} WHERE repo_id = ? AND number = ?`).run(...vals);
}

export function listIssues(db, repoId) {
  return db
    .prepare("SELECT * FROM issue_titles WHERE repo_id = ? ORDER BY number DESC")
    .all(repoId);
}

export function issuesForThread(db, threadId) {
  return db
    .prepare("SELECT * FROM issue_titles WHERE thread_id = ? ORDER BY number DESC")
    .all(threadId);
}

export function getConfig(db, scope, key, fallback = null) {
  const row = db.prepare("SELECT value FROM config WHERE scope = ? AND key = ?").get(scope, key);
  return row ? row.value : fallback;
}

export function setConfig(db, scope, key, value) {
  db.prepare(
    `INSERT INTO config (scope, key, value) VALUES (?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`
  ).run(scope, key, value);
}

// Effective config: repo scope overrides global.
export function effectiveConfig(db, slug, key, fallback = null) {
  const repoVal = getConfig(db, slug, key, null);
  if (repoVal != null) return repoVal;
  return getConfig(db, "global", key, fallback);
}

// ---------------------------------------------------------------------------
// Usage (token accounting for the tool's own Haiku calls)
// ---------------------------------------------------------------------------

// Record one Haiku call's token/cost usage. `usage` is the raw block from `claude -p
// --output-format json` (input_tokens, output_tokens, cache_* variants). Best-effort.
export function logUsage(db, repoId, { kind = null, usage = null, cost = 0 } = {}) {
  const u = usage || {};
  db.prepare(
    `INSERT INTO usage
       (repo_id, ts, kind, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repoId ?? null,
    now(),
    kind,
    Number(u.input_tokens) || 0,
    Number(u.output_tokens) || 0,
    Number(u.cache_read_input_tokens) || 0,
    Number(u.cache_creation_input_tokens) || 0,
    Number(cost) || 0
  );
}

// Token/cost spend grouped by local calendar day (newest first), for the last `days` days.
export function usageByDay(db, repoId, { days = 30 } = {}) {
  return db
    .prepare(
      `SELECT date(ts, 'localtime') AS day,
              SUM(input_tokens)          AS input,
              SUM(output_tokens)         AS output,
              SUM(cache_read_tokens)     AS cache_read,
              SUM(cache_creation_tokens) AS cache_creation,
              SUM(cost_usd)              AS cost,
              COUNT(*)                   AS calls
         FROM usage
        WHERE repo_id = ? AND date(ts, 'localtime') >= date('now', 'localtime', ?)
        GROUP BY day
        ORDER BY day DESC`
    )
    .all(repoId, `-${Math.max(0, days - 1)} days`);
}

// Grand totals over the whole recorded history for this repo.
export function usageTotals(db, repoId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0)          AS input,
              COALESCE(SUM(output_tokens), 0)         AS output,
              COALESCE(SUM(cache_read_tokens), 0)     AS cache_read,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation,
              COALESCE(SUM(cost_usd), 0)              AS cost,
              COUNT(*)                                AS calls,
              MIN(date(ts, 'localtime'))              AS since
         FROM usage WHERE repo_id = ?`
    )
    .get(repoId);
}
