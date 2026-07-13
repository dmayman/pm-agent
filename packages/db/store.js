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

-- Branch/PR → initiative association (#39). Goal-first threads are often born in conversation
-- with no GitHub issue number, so the issue_titles.thread_id bridge never attributes their open
-- branches / merged PRs to them and the lifecycle bar reads empty. This table records the
-- branch/pr refs the observer already captures on events, keyed by thread, with a merged flag
-- derived (deterministically, no network) from the merged-type events derived ingest writes.
CREATE TABLE IF NOT EXISTS thread_refs (
  repo_id    INTEGER NOT NULL REFERENCES repos(id),
  thread_id  INTEGER NOT NULL REFERENCES threads(id),
  kind       TEXT NOT NULL,               -- 'branch' | 'pr'
  value      TEXT NOT NULL,               -- branch name | pr number (as text)
  merged     INTEGER NOT NULL DEFAULT 0,  -- 1 once the ledger shows this branch/pr landed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, thread_id, kind, value)
);
CREATE INDEX IF NOT EXISTS thread_refs_thread ON thread_refs(thread_id);

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

-- Eval harness: the raw, judgment-free per-turn ledger. One row per observer turn, holding
-- the UNTRUNCATED digest the observer built (the clamped version still feeds Haiku). This is
-- ground truth for grading how well live capture did — written synchronously in the hook so
-- it survives even when the Haiku worker fails. Append-only.
CREATE TABLE IF NOT EXISTS session_log (
  id           INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id),
  session_id   TEXT NOT NULL,
  turn         INTEGER NOT NULL,     -- transcript line count after this slice (monotonic per session)
  cursor_start INTEGER,              -- prior cursor = slice start
  digest       TEXT NOT NULL,        -- untruncated USER/CLAUDE/ACTION digest for this turn
  char_count   INTEGER,
  distilled_at  TEXT,                -- set by the worker when the distiller succeeded for this turn
  distill_error TEXT,                -- set when the distiller FAILED (after retries) — dropped-turn audit
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS session_log_turn ON session_log(session_id, turn);
CREATE INDEX IF NOT EXISTS session_log_repo ON session_log(repo_id, session_id);

-- Eval harness: the librarian's trajectory. One snapshot of an initiative's state each time
-- the observer synthesizes it, so the judge can see the goal seeded -> refined -> sharpened
-- across turns rather than only its final state.
CREATE TABLE IF NOT EXISTS initiative_snapshots (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  session_id  TEXT,
  turn        INTEGER,               -- the turn/cursor that triggered this snapshot
  goal        TEXT,
  goal_source TEXT,
  focus       TEXT,
  why         TEXT,
  genesis     TEXT,
  summary     TEXT,
  event_count INTEGER,
  event_ids   TEXT,                  -- json array of event ids in the initiative at snapshot time
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_thread ON initiative_snapshots(thread_id, created_at);
CREATE INDEX IF NOT EXISTS snapshots_session ON initiative_snapshots(session_id);
`;

// Add a column if an older DB doesn't have it yet (CREATE TABLE IF NOT EXISTS won't alter).
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// Apply the schema and in-place column migrations to a freshly opened (writable) handle.
// Shared by openDb (the machine-global singleton) and openDbAt (arbitrary paths, e.g. replay).
function applySchema(db) {
  db.exec(SCHEMA);
  // Migrations for DBs created before these columns existed.
  ensureColumn(db, "threads", "summary", "TEXT"); // Haiku-synthesized plain-language what/why
  ensureColumn(db, "threads", "summary_event_count", "INTEGER"); // staleness marker
  // Goal-first capture (#26): an initiative is defined by its durable goal, not its title. The
  // goal is seeded at birth and refined as work reveals more; an agent-seeded goal is high-trust
  // and must never be clobbered by the observer's inference (guarded in setThreadGoal).
  ensureColumn(db, "threads", "goal", "TEXT"); // the durable goal — what this initiative aims to achieve
  ensureColumn(db, "threads", "goal_source", "TEXT"); // 'agent' (high-trust) | 'observer' (inferred)
  ensureColumn(db, "threads", "goal_framing", "TEXT"); // the quoted moment the goal was framed
  ensureColumn(db, "threads", "why", "TEXT"); // the motivation/impact — seeded at birth
  ensureColumn(db, "threads", "why_source", "TEXT"); // 'agent' (high-trust) | 'observer' (inferred)
  // Momentary focus — what the work is concentrating on RIGHT NOW. Deliberately volatile
  // (rewritten every capture) so it absorbs the tactical swings that used to clobber `goal`.
  ensureColumn(db, "threads", "focus", "TEXT");
  // Distill outcome audit on the raw ledger (older DBs predate these columns).
  ensureColumn(db, "session_log", "distilled_at", "TEXT");
  ensureColumn(db, "session_log", "distill_error", "TEXT");
  // Snapshots grew a focus column alongside goal/why so the eval can grade the goal/focus split.
  ensureColumn(db, "initiative_snapshots", "focus", "TEXT");
  // issue_titles started life as just number→title; it's now the issues table with
  // lifecycle + thread membership. Grow it in place.
  ensureColumn(db, "issue_titles", "state", "TEXT"); // OPEN | CLOSED (from gh)
  ensureColumn(db, "issue_titles", "opened_at", "TEXT");
  ensureColumn(db, "issue_titles", "closed_at", "TEXT");
  ensureColumn(db, "issue_titles", "branch", "TEXT"); // an open branch for this issue, if any
  ensureColumn(db, "issue_titles", "status", "TEXT"); // todo | in_progress | done
  ensureColumn(db, "issue_titles", "thread_id", "INTEGER"); // initiative this issue belongs to
  ensureColumn(db, "issue_titles", "pinned", "INTEGER DEFAULT 0"); // 1 = membership set by hand; automatic links never move it
}

let _db;
export function openDb() {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  applySchema(db);
  _db = db;
  return db;
}

// Open a DB at an EXPLICIT path (not the machine-global singleton) — used by the replay tool to
// read a source ledger and write a separate target one. A writable handle gets the full schema +
// migrations applied so a brand-new target file is usable immediately; a readonly handle is left
// untouched (it can't run WAL/DDL and is assumed already-provisioned). Never cached in _db.
export function openDbAt(file, { readonly = false } = {}) {
  const db = new DatabaseSync(file, readonly ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 5000");
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    applySchema(db);
  }
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

// Title normalization for matching (NOT storage): fold case, collapse whitespace, strip
// trailing punctuation — so "Auth Hardening" and "auth hardening." resolve to one initiative
// instead of forking. The stored title keeps its original casing.
export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…:;,]+$/, "");
}

// Case/whitespace/punctuation-insensitive title lookup (see normalizeTitle). Threads per repo
// are few, so a JS-side scan is fine — SQL lower() can't collapse whitespace anyway.
export function findThreadByNormalizedTitle(db, repoId, title) {
  const want = normalizeTitle(title);
  if (!want) return null;
  const rows = db
    .prepare("SELECT * FROM threads WHERE repo_id = ? ORDER BY id DESC")
    .all(repoId);
  return rows.find((t) => normalizeTitle(t.title) === want) || null;
}

// Resolve a thread by id or title, creating it if missing (so callers can just name it).
// Matching is exact first, then normalized (case/whitespace/punctuation-insensitive) — only
// a genuinely new title creates a thread, and creation preserves the exact given title.
export function resolveThread(db, repoId, ref, { genesis = null } = {}) {
  if (ref == null || ref === "") return null;
  if (/^\d+$/.test(String(ref))) {
    const t = getThread(db, Number(ref));
    if (t && t.repo_id === repoId) return t.id;
  }
  const existing =
    findThreadByTitle(db, repoId, String(ref)) || findThreadByNormalizedTitle(db, repoId, String(ref));
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

// The trust level of a thread's current goal ('agent' beats 'observer'). Callers writing an
// observer-inferred goal must not overwrite an agent-seeded one.
export function goalSource(db, id) {
  const row = db.prepare("SELECT goal_source FROM threads WHERE id = ?").get(id);
  return row ? row.goal_source : null;
}

// Seed or refine a thread's durable goal (#26). Trust guard: an agent-seeded goal
// (source='agent') is authoritative and is written unconditionally; the observer
// (source='observer') writes only when there's no agent goal already, so its inference can
// sharpen an observer goal but never clobber a high-trust one. `framing` is the quoted moment
// the goal was framed; it's stored once (first writer wins) as audit/eval fodder.
//
// The second half of the guard lives at the prompt level: the distiller is shown each
// initiative's CURRENT goal and told to return goal=null when it's unchanged (the common
// case), so an observer write only reaches here on a genuine reframe/sharpening — tactical
// swings land in `focus` (setThreadFocus) instead of overwriting the goal.
export function setThreadGoal(db, id, { goal = undefined, framing = undefined, source = "observer" } = {}) {
  if (goal === undefined || goal == null || String(goal).trim() === "") return false;
  if (source !== "agent" && goalSource(db, id) === "agent") return false; // don't clobber the agent's goal
  const cols = ["goal = ?", "goal_source = ?"];
  const vals = [String(goal).trim(), source];
  if (framing !== undefined && framing != null && String(framing).trim()) {
    // First framing wins — keep the original birth moment even as the goal is refined.
    const cur = db.prepare("SELECT goal_framing FROM threads WHERE id = ?").get(id);
    if (!cur || !cur.goal_framing) {
      cols.push("goal_framing = ?");
      vals.push(String(framing).trim());
    }
  }
  cols.push("updated_at = ?");
  vals.push(now(), id);
  db.prepare(`UPDATE threads SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

// Set a thread's momentary focus — what the work is concentrating on RIGHT NOW. No trust
// guard and no first-writer-wins: focus is MEANT to swing every capture; it's the pressure
// valve that keeps tactical shifts out of the durable goal.
export function setThreadFocus(db, id, focus) {
  if (focus == null || String(focus).trim() === "") return false;
  db.prepare("UPDATE threads SET focus = ?, updated_at = ? WHERE id = ?").run(
    String(focus).trim(),
    now(),
    id
  );
  return true;
}

// Conservative done-flip for the distiller's `completed` signal: only an ACTIVE thread moves
// to done, so an agent/user who reopened (or marked blocked/in_review) is never overridden.
// Returns true if the flip happened.
export function completeThreadIfActive(db, id) {
  const r = db
    .prepare("UPDATE threads SET status = 'done', updated_at = ? WHERE id = ? AND status = 'active'")
    .run(now(), id);
  return r.changes > 0;
}

// The trust level of a thread's current 'why' ('agent' beats 'observer').
export function whySource(db, id) {
  const row = db.prepare("SELECT why_source FROM threads WHERE id = ?").get(id);
  return row ? row.why_source : null;
}

// Seed or refine a thread's 'why' (motivation/impact). Agent writes are authoritative; the
// observer FILLS an empty why but never rewrites one — the why is the durable motivation, and
// letting the observer churn it every turn is the same failure mode the goal/focus split fixes.
export function setThreadWhy(db, id, { why = undefined, source = "observer" } = {}) {
  if (why === undefined || why == null || String(why).trim() === "") return false;
  if (source !== "agent") {
    const cur = db.prepare("SELECT why, why_source FROM threads WHERE id = ?").get(id);
    if (cur && cur.why_source === "agent") return false; // never clobber the agent's why
    if (cur && cur.why) return false; // observer fills only when empty
  }
  db.prepare("UPDATE threads SET why = ?, why_source = ?, updated_at = ? WHERE id = ?").run(
    String(why).trim(),
    source,
    now(),
    id
  );
  return true;
}

// Seed a thread's genesis (founding decisions) once — first writer wins, so the birth context
// isn't overwritten by later turns. Returns true if it was set.
export function setThreadGenesis(db, id, genesis) {
  if (!genesis || String(genesis).trim() === "") return false;
  const cur = db.prepare("SELECT genesis FROM threads WHERE id = ?").get(id);
  if (cur && cur.genesis) return false;
  db.prepare("UPDATE threads SET genesis = ?, updated_at = ? WHERE id = ?").run(
    String(genesis).trim(),
    now(),
    id
  );
  return true;
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

// Loose ends = unresolved deferred events. A deferred item whose initiative has already been
// marked done is dropped (#39): the work stream landed, so the punt no longer dangles — it was
// the single largest source of Loose-ends noise in real ledgers (~40% of entries sat on done
// threads). Reopening the thread (status != done) surfaces its loose ends again, so this is a
// reversible visual filter, not a mutation. Unthreaded deferrals (thread_id NULL) always show.
export function listLooseEnds(db, repoId) {
  return db
    .prepare(
      `SELECT e.*, t.title AS thread_title
         FROM events e LEFT JOIN threads t ON t.id = e.thread_id
        WHERE e.repo_id = ? AND e.type = 'deferred' AND e.resolved_at IS NULL
          AND (t.id IS NULL OR t.status != 'done')
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

// --- Manual initiative membership (pins) -----------------------------------
// A pin is a hand-made "this issue belongs to this initiative" that the auto-clusterer
// must respect. Ensures the issue row exists first, so you can pin an issue the ledger
// hasn't synced from GitHub yet (its title backfills on the next sync).
export function pinIssueToThread(db, repoId, number, threadId) {
  db.prepare("INSERT OR IGNORE INTO issue_titles (repo_id, number, title) VALUES (?, ?, ?)").run(
    repoId,
    Number(number),
    `#${number}`
  );
  db.prepare(
    "UPDATE issue_titles SET thread_id = ?, pinned = 1 WHERE repo_id = ? AND number = ?"
  ).run(threadId, repoId, Number(number));
}

// A SOFT (unpinned) initiative link — the observer's bridge from an event's refs.issue to
// the thread it created. Ensures the issue row exists first (title backfills on the next
// sync), then attaches it WITHOUT pinning, so a later soft link can still re-home it. Never
// overrides a manual pin (pinned = 1).
export function linkIssueToThread(db, repoId, number, threadId) {
  db.prepare("INSERT OR IGNORE INTO issue_titles (repo_id, number, title) VALUES (?, ?, ?)").run(
    repoId,
    Number(number),
    `#${number}`
  );
  db.prepare(
    "UPDATE issue_titles SET thread_id = ? WHERE repo_id = ? AND number = ? AND (pinned = 0 OR pinned IS NULL)"
  ).run(threadId, repoId, Number(number));
}

// Release a pin so automatic (soft) links are free to re-home the issue again. Leaves
// current membership in place until something does.
export function unpinIssue(db, repoId, number) {
  db.prepare("UPDATE issue_titles SET pinned = 0 WHERE repo_id = ? AND number = ?").run(
    repoId,
    Number(number)
  );
}

// --- Branch/PR → initiative refs (#39) -------------------------------------
// Goal-first threads frequently carry no GitHub issue number, so their open branches and merged
// PRs never attribute through the issue bridge. The observer already captures refs.branch /
// refs.pr on events; these helpers persist that association per-thread so lifecycle + the UI can
// show it. Association is soft and additive (idempotent upsert); the `merged` flag is derived
// deterministically from the ledger's merged-type events (see work.js refreshThreadRefs).

// Record a branch/PR association on a thread. Idempotent on (repo, thread, kind, value); never
// clobbers a merged=1 flag already set. `kind` must be 'branch' or 'pr'; blanks are ignored.
export function linkRefToThread(db, repoId, threadId, kind, value) {
  if (!threadId || (kind !== "branch" && kind !== "pr")) return;
  const v = String(value == null ? "" : value).trim();
  if (!v) return;
  const t = now();
  db.prepare(
    `INSERT INTO thread_refs (repo_id, thread_id, kind, value, merged, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(repo_id, thread_id, kind, value) DO NOTHING`
  ).run(repoId, threadId, kind, v, t, t);
}

// The branch/PR refs recorded for a thread, each with its derived merged flag.
export function refsForThread(db, threadId) {
  return db
    .prepare("SELECT kind, value, merged FROM thread_refs WHERE thread_id = ? ORDER BY kind, value")
    .all(threadId);
}

// All refs for a repo (used by the lifecycle refresh to (re)derive the merged flag in bulk).
export function listThreadRefs(db, repoId) {
  return db
    .prepare("SELECT thread_id, kind, value, merged FROM thread_refs WHERE repo_id = ?")
    .all(repoId);
}

// Set/clear the merged flag for one ref. Returns true when it actually changed.
export function setThreadRefMerged(db, repoId, threadId, kind, value, merged) {
  const r = db
    .prepare(
      "UPDATE thread_refs SET merged = ?, updated_at = ? WHERE repo_id = ? AND thread_id = ? AND kind = ? AND value = ? AND merged != ?"
    )
    .run(merged ? 1 : 0, now(), repoId, threadId, kind, String(value), merged ? 1 : 0);
  return r.changes > 0;
}

// Threads with their issues attached — the shape the `initiative list` command and the
// operator UI want. Newest-active first (inherits listThreads' ordering).
export function initiativesWithIssues(db, repoId) {
  const threads = listThreads(db, repoId);
  for (const t of threads) t.issues = issuesForThread(db, t.id);
  return threads;
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

// ---------------------------------------------------------------------------
// Eval harness — raw session ledger + initiative trajectory snapshots
// ---------------------------------------------------------------------------

// Append one turn's untruncated digest to the raw ledger. Idempotent on (session_id, turn) so
// a re-run of the same turn (or a retried hook) never double-writes.
export function appendSessionLog(db, repoId, { sessionId, turn, cursorStart = null, digest }) {
  if (!sessionId || !digest) return;
  db.prepare(
    `INSERT OR IGNORE INTO session_log
       (repo_id, session_id, turn, cursor_start, digest, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(repoId, sessionId, Number(turn) || 0, cursorStart, digest, digest.length, now());
}

// Record the distill outcome for one raw-ledger turn: success stamps distilled_at, failure
// stores the reason in distill_error (each clears the other, so a retried turn ends clean).
// Makes dropped turns queryable: SELECT count(*) FROM session_log WHERE distill_error IS NOT NULL.
export function markSessionLogDistilled(db, sessionId, turn, { error = null } = {}) {
  if (!sessionId) return;
  db.prepare(
    "UPDATE session_log SET distilled_at = ?, distill_error = ? WHERE session_id = ? AND turn = ?"
  ).run(
    error ? null : now(),
    error ? String(error).slice(0, 300) : null,
    sessionId,
    Number(turn) || 0
  );
}

// Snapshot an initiative's current state (goal/focus/why/genesis/summary + its event set) — the
// librarian's trajectory at this turn. Reads live from the thread; call after synthesis.
export function snapshotInitiative(db, repoId, threadId, { sessionId = null, turn = null } = {}) {
  const t = getThread(db, threadId);
  if (!t) return;
  const events = db
    .prepare("SELECT id FROM events WHERE thread_id = ? ORDER BY ts")
    .all(threadId)
    .map((r) => r.id);
  db.prepare(
    `INSERT INTO initiative_snapshots
       (repo_id, thread_id, session_id, turn, goal, goal_source, focus, why, genesis, summary,
        event_count, event_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repoId,
    threadId,
    sessionId,
    turn == null ? null : Number(turn),
    t.goal || null,
    t.goal_source || null,
    t.focus || null,
    t.why || null,
    t.genesis || null,
    t.summary || null,
    events.length,
    JSON.stringify(events),
    now()
  );
}

export function getSessionLog(db, sessionId) {
  return db
    .prepare("SELECT * FROM session_log WHERE session_id = ? ORDER BY turn")
    .all(sessionId);
}

export function getSnapshotsForSession(db, sessionId) {
  return db
    .prepare("SELECT * FROM initiative_snapshots WHERE session_id = ? ORDER BY created_at")
    .all(sessionId);
}

// Sessions the raw ledger knows about for a repo, most-recent first — for `pm-agent eval`'s
// default target selection.
export function listSessions(db, repoId, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT session_id,
              COUNT(*)      AS turns,
              MIN(created_at) AS first_ts,
              MAX(created_at) AS last_ts
         FROM session_log
        WHERE repo_id = ?
        GROUP BY session_id
        ORDER BY last_ts DESC
        LIMIT ?`
    )
    .all(repoId, limit);
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
