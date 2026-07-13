// Observer capture — the automatic, hands-off mode. A Stop hook invokes `pm-agent
// observe` with the Claude Code Stop payload on stdin. We read ONLY the transcript slice
// added since a per-session cursor (keeps tokens tiny), then spawn a DETACHED Haiku
// worker to distill it into ledger events, so the user's turn ends with zero added
// latency. No-ops unless capture=observer — that's how the toggle works at the hook level.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as S from "./store.js";
import { runHaikuOnce } from "./haiku.js";

const MIN_DIGEST_CHARS = 200; // below this there's nothing worth distilling
const MAX_DIGEST_CHARS = 8000; // keep Haiku's input cheap; head+tail if larger
// Head+tail clamp, not tail-only: the OPENING user message is where the goal is framed, and a
// tail slice on a long turn cut it out — exactly the text the distiller needs most. Keep the
// first ~2k (the framing) and the last ~6k (the outcome), and mark the elision.
const DIGEST_HEAD_CHARS = 2000;
const DIGEST_TAIL_CHARS = MAX_DIGEST_CHARS - DIGEST_HEAD_CHARS; // 6000

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Turn a transcript JSONL slice into a compact text digest: user prompts, Claude's text,
// and the names of actions it took. Tool-result payloads are dropped — they're huge and
// the summary lives in Claude's own words anyway. With { raw: true } the per-message and
// whole-digest clamps are lifted — that's the untruncated version the eval harness tees into
// the raw ledger; the clamped default is what feeds the (token-metered) Haiku prompt.
// Exported for tests.
export function digestLines(lines, { raw = false } = {}) {
  const out = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj.message || obj;
    const role = msg.role || obj.type;
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim()) out.push(`${role === "user" ? "USER" : "CLAUDE"}: ${content.trim()}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "text" && block.text && block.text.trim()) {
        const text = raw ? block.text.trim() : block.text.trim().slice(0, 800);
        out.push(`${role === "user" ? "USER" : "CLAUDE"}: ${text}`);
      } else if (block.type === "tool_use") {
        const target =
          block.input?.file_path || block.input?.command || block.input?.path || "";
        const t = raw ? String(target) : String(target).slice(0, 120);
        out.push(`ACTION: ${block.name}${target ? " " + t : ""}`);
      }
    }
  }
  let text = out.join("\n");
  if (!raw && text.length > MAX_DIGEST_CHARS) {
    text =
      text.slice(0, DIGEST_HEAD_CHARS) +
      "\n…[truncated]…\n" +
      text.slice(-DIGEST_TAIL_CHARS);
  }
  return text;
}

function buildPrompt(digest, initiatives) {
  // Show the model each initiative BY ITS GOAL, not just its title, so it attributes work by
  // what the initiative is trying to achieve rather than a surface label — and can tell when
  // this session is a genuinely new goal.
  const known = initiatives.length
    ? `\n\nExisting initiatives (match this session's work to one by its GOAL, not just its title; use the EXACT title below when it fits):\n` +
      initiatives.map((i) => `- "${i.title}" — goal: ${i.goal ? i.goal : "(no goal captured yet)"}`).join("\n")
    : "";
  return `You maintain a developer's work ledger. Below is an excerpt from a Claude Code coding session. Do two things:

1) GOALS — Identify the SET of durable goals this session advances or spawns. Treat the FIRST user message of the excerpt as a goal-candidate: the moment a goal is framed is often the opening prompt, and it must not slip by as ordinary chatter. For each goal decide whether it advances one of the existing initiatives (below) or is a NEW goal.

   GOAL vs FOCUS — the GOAL is the durable outcome framed when the arc began: what will be true when the work is finished. The FOCUS is what the work is concentrating on RIGHT NOW. When attention shifts to a sub-question, a verification pass, a simplification, a bug, or an implementation phase, that is a change of FOCUS — the goal has NOT changed. The goal changes ONLY when the user genuinely reframes what the arc is FOR. Example: goal "give the coach a per-muscle recovery readiness signal" stays the goal while the session's focus swings to "verify whether the tier 2 muscle taxonomy serves practical value" — the verification is focus, never the new goal.

   For an EXISTING initiative ("isNew": false): if its goal shown below is still the right durable goal, return "text": null — null means "goal unchanged", and it is the COMMON case. Return a non-null "text" for an existing initiative ONLY when the user genuinely reframed (or the goal was empty and this excerpt frames it).

   Emit a SEPARATE goal entry ONLY for a durable goal with its OWN done-signal — a ticket, a distinct workstream, or a shippable outcome that can independently be called finished. A step taken WITHIN a goal (e.g. "run the test suite", "enrich one issue") is an EVENT, not a goal. Apply this test to avoid over-fragmenting: if it has no independent done-signal, it is not its own goal.

   TITLES — every NEW goal ("isNew": true) MUST get its OWN distinct, specific short title. Do NOT file multiple new goals under a single existing umbrella/surface title — that silently collapses them back into one initiative. Reuse an EXACT existing title ONLY when "isNew": false, i.e. the goal genuinely advances that initiative. Example: in a retro that frames "reviewable set_plan diffs" AND "fix the deterministic duplicate-row projection", those are TWO separate new initiatives with two distinct titles (e.g. "Reviewable set_plan diffs" and "Deterministic duplicate-row cleanup") — NOT two goals both titled "Plan Model & Execution".

   A normal session that advances one initiative yields EXACTLY ONE entry. A planning / retro / triage session whose product is several distinct workstreams (e.g. "three action priorities + file two new issues + a discovery ticket") yields SEVERAL — one per workstream, each with its own distinct title. Returning a single-element array is the common case; an empty array is allowed only if the excerpt truly frames no goal (rare).

2) EVENTS — Extract ONLY the meaningful, timeline-worthy events — decisions made, build/test/review milestones reached, followups taken on, and loose ends explicitly deferred. Skip routine chatter, tool mechanics, and anything trivial. Most excerpts yield 0-3 events; an empty array is correct and expected when nothing notable happened.

Respond with ONLY a JSON object (no prose, no code fence) of this shape:
{
  "goals": [
    {
      "initiative": "the EXACT title of a matching initiative above, or a short new title if none fits",
      "isNew": true or false,
      "text": "for a NEW goal: the durable goal in one line — the outcome, not the tactic of the moment. For an existing initiative: null when its goal is unchanged (the common case), else the genuinely reframed goal",
      "focus": "one line: what the work is concentrating on right now (this may swing every turn)",
      "why": "why the durable goal matters, if evident from the excerpt — else null",
      "framing": "a short quote or paraphrase of the moment the goal was framed (usually the opening user message) — else null",
      "completed": false
    }
  ],
  "events": [
    {
      "type": "one of decided|built|tested|reviewed|followup|deferred|merged|blocked|note",
      "summary": "one crisp past-tense line a busy developer would want on their timeline",
      "thread": "the initiative title this belongs to (reuse a goals[].initiative when it fits)",
      "refs": { "issue": 0, "pr": 0, "branch": "", "commit": "" }
    }
  ]
}

Rules: "goals" may be an empty array only if the excerpt truly frames no goal (rare). Set "completed": true ONLY when this excerpt's evidence shows the durable goal is ACHIEVED — merged AND verified AND the user has moved on; when in doubt, false. Use "deferred" ONLY for things explicitly punted to later — those become tracked loose ends. Omit empty "refs".${known}

Excerpt:
---
${digest}`;
}

function extractJsonArray(text) {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Parse the distiller's response into { goals, events } — goals is ALWAYS an array. The model
// is asked for a `goals: []` object (#36), but we degrade gracefully and never throw:
//   - new shape { goals: [...], events: [...] }  → used as-is (goals filtered to {text} objects)
//   - legacy shape { goal: {...}, events: [...] } → the singular goal wrapped as a 1-element array
//   - bare array [...]                            → { goals: [], events: <array> } (events only)
//   - malformed                                   → whatever events we can slice out, no goals
// Exported for tests.
export function extractSessionAnalysis(text) {
  if (!text) return { goals: [], events: [] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      // Only accept it as the wrapper if it actually carries goal(s)/events — otherwise this was
      // a bare array whose inner objects we accidentally grabbed; fall through to array parsing.
      if (
        obj &&
        typeof obj === "object" &&
        !Array.isArray(obj) &&
        ("goals" in obj || "goal" in obj || "events" in obj)
      ) {
        const events = Array.isArray(obj.events) ? obj.events : [];
        let goals = [];
        if (Array.isArray(obj.goals)) {
          goals = obj.goals;
        } else if (obj.goal && typeof obj.goal === "object" && !Array.isArray(obj.goal)) {
          goals = [obj.goal]; // legacy singular-goal shape → one-element array
        }
        // Keep only real goal objects; drops nulls/strings/junk. A goal entry must carry an
        // initiative (the ledger can't file it otherwise) OR a text (legacy shapes that
        // predate the initiative field). `text: null` with an initiative is VALID — it means
        // "goal unchanged" and still carries focus/why/completed for that initiative.
        goals = goals.filter(
          (g) => g && typeof g === "object" && !Array.isArray(g) && (g.initiative || g.text)
        );
        return { goals, events };
      }
    } catch {
      // fall through to the array fallback
    }
  }
  return { goals: [], events: extractJsonArray(text) };
}

// Entry point invoked by the Stop hook (payload on stdin). Fast + non-blocking.
export function observe(cwd = process.cwd()) {
  // Loop guard: the worker's own `claude -p` is a fresh session in this repo, whose Stop
  // hook would re-enter here. We tag that subprocess so it no-ops instead of fork-bombing.
  if (process.env.PM_AGENT_OBSERVING) return;
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {}
  const transcriptPath = payload.transcript_path;
  const sessionId = payload.session_id || "unknown";
  if (!transcriptPath) return;

  const db = S.openDb();
  const repo = S.getRepo(db, cwd);
  if (!repo) return;
  if (S.effectiveConfig(db, repo.slug, "capture", "observer") !== "observer") return; // toggle

  let content;
  try {
    content = readFileSync(transcriptPath, "utf8");
  } catch {
    return;
  }
  const allLines = content.split("\n").filter(Boolean);
  const cursorKey = `cursor:${sessionId}`;
  const cursor = Number(S.getConfig(db, "global", cursorKey, "0")) || 0;
  const fresh = allLines.slice(cursor);
  const turn = allLines.length;
  // Advance the cursor now, so a slow/failed worker never causes reprocessing next turn.
  S.setConfig(db, "global", cursorKey, String(turn));
  if (!fresh.length) return;

  const digest = digestLines(fresh);
  if (digest.length < MIN_DIGEST_CHARS) return;

  // Eval harness: tee the UNTRUNCATED digest into the raw ledger here, in the synchronous hook
  // path — so ground truth is captured even if the Haiku worker below never runs or fails. No
  // model call; this is just the text we already built. Append-only, idempotent per (session,turn).
  try {
    S.appendSessionLog(db, repo.id, {
      sessionId,
      turn,
      cursorStart: cursor,
      digest: digestLines(fresh, { raw: true }),
    });
  } catch {}

  const initiatives = S.listThreads(db, repo.id)
    .filter((t) => t.status !== "done")
    .slice(0, 20)
    .map((t) => ({ title: t.title, goal: t.goal || null }));

  // Hand the heavy Haiku call to a detached worker and return immediately.
  const jobDir = path.join(S.pmHome(), "jobs");
  mkdirSync(jobDir, { recursive: true });
  const jobFile = path.join(jobDir, `${sessionId}-${turn}.json`);
  writeFileSync(
    jobFile,
    JSON.stringify({
      repoSlug: repo.slug,
      root: repo.root,
      sessionId,
      turn,
      prompt: buildPrompt(digest, initiatives),
    })
  );

  const self = fileURLToPath(new URL("../../bin/pm-agent.js", import.meta.url));
  const child = spawn(process.execPath, [self, "observe", "--worker", jobFile], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// The shared capture loop (#36). Given the distiller's { goals, events }, seed/refine every
// initiative, log every event, then synthesize + snapshot each touched thread. Both the live
// observer worker and the offline replay tool run this, so capture is identical on both paths.
// Order matters: seed ALL goals BEFORE logging events, so an event that names a just-spawned
// initiative resolves to it rather than creating a duplicate.
//   refreshLifecycle: live-only. Re-derives issue status from git/GitHub (throttled). Replay has
//   no live git, so it passes false.
export async function applyCapture(
  db,
  repo,
  { goals = [], events = [], sessionId = null, turn = null, refreshLifecycle = false } = {}
) {
  const touched = new Set();

  // Goal-first capture (#26/#36): seed/refine each initiative's durable goal from what this
  // session pursues, before any events. resolveThread creates the initiative by title when it's
  // new; setThreadGoal's trust guard refines an observer goal but never clobbers an agent one.
  // `text: null` means "goal unchanged" (the distiller sees each initiative's current goal and
  // is told to return null unless the user genuinely reframed) — the momentary tactic lands in
  // `focus`, which is written unconditionally because it's MEANT to swing turn to turn.
  // Guard against same-title collapse: if two goals in ONE batch resolve to the same thread id
  // (e.g. the model filed two new workstreams under one umbrella title), the second setThreadGoal
  // would silently overwrite the first and lose a workstream. Keep the first, warn, drop the rest
  // — the prompt is told to give each new goal a distinct title, so this only fires on model drift.
  const seededThisBatch = new Set();
  for (const g of goals) {
    if (!g || !g.initiative) continue;
    const gid = S.resolveThread(db, repo.id, String(g.initiative));
    if (!gid) continue;
    if (seededThisBatch.has(gid)) {
      process.stderr.write(
        `warning: two goals in one turn resolved to the same initiative "${g.initiative}" (#${gid}); ` +
          `keeping the first, dropping: ${g.text || "(goal unchanged)"}\n`
      );
      continue;
    }
    seededThisBatch.add(gid);
    if (g.text) S.setThreadGoal(db, gid, { goal: g.text, framing: g.framing, source: "observer" });
    if (g.focus) S.setThreadFocus(db, gid, g.focus);
    // `why` fills when empty and observer-sourced updates never clobber an agent-seeded why
    // (the trust guard inside setThreadWhy).
    if (g.why) S.setThreadWhy(db, gid, { why: g.why, source: "observer" });
    if (g.framing) S.setThreadGenesis(db, gid, String(g.framing));
    // Conservative done-flip: the distiller vouches the durable goal is achieved (merged +
    // verified + moved on). Only an ACTIVE thread flips — a reopened/blocked one is left alone.
    if (g.completed === true) S.completeThreadIfActive(db, gid);
    touched.add(gid);
  }

  for (const e of events) {
    if (!e || !e.type || !e.summary) continue;
    const threadId = e.thread ? S.resolveThread(db, repo.id, String(e.thread)) : null;
    S.logEvent(db, repo.id, {
      threadId,
      type: S.normalizeType(e.type),
      summary: String(e.summary),
      refs: e.refs && typeof e.refs === "object" ? e.refs : null,
      source: "observer",
    });
    if (threadId) {
      touched.add(threadId);
      // Bridge issue→initiative membership: the event names its thread AND a GitHub issue,
      // but membership lives in issue_titles.thread_id, which logEvent doesn't touch. Attach
      // it as a SOFT link so the initiative shows the issue (a later soft link can re-home).
      const issueNum = Number(e.refs?.issue);
      if (Number.isInteger(issueNum) && issueNum > 0) {
        S.linkIssueToThread(db, repo.id, issueNum, threadId);
      }
    }
  }

  // Bridge the git/GitHub side: a turn may have closed an issue, merged a PR, or pushed a
  // branch (e.g. `gh issue close 13`). The observer distills the narrative event, but issue
  // *status* only moves when we re-derive lifecycle. Do it here, throttled, so done/shipped
  // reclassify silently within a turn or two of the change — no manual `ingest` needed.
  if (refreshLifecycle) {
    for (const id of await maybeRefreshLifecycle(db, repo)) touched.add(id);
  }

  // Re-synthesize every thread we touched (new goal/event) or whose issue status just flipped,
  // then snapshot it — the trajectory row the eval harness grades (goal seeded → refined →
  // sharpened across turns). Snapshot AFTER synthesis so it captures the fresh summary.
  if (touched.size) {
    const { synthesizeThread } = await import("./synthesize.js");
    for (const id of touched) {
      synthesizeThread(db, repo, id);
      try {
        S.snapshotInitiative(db, repo.id, id, { sessionId, turn });
      } catch {}
    }
  }
  return touched;
}

// The detached worker: call Haiku (with retries — we're already off the user's turn, so we can
// afford them), write the events it distilled, and record the distill outcome on the raw
// ledger row so dropped turns are queryable instead of silent. Clean up either way.
export async function observeWorker(jobFile) {
  let job;
  try {
    job = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch {
    return;
  }
  // Open the DB first so the Haiku call can be metered against this repo.
  const db = S.openDb();
  const repo = db.prepare("SELECT * FROM repos WHERE slug = ?").get(job.repoSlug);
  const { text, error, attempts } = await callModelWithRetry(
    job.prompt,
    job.root,
    repo ? { db, repoId: repo.id, kind: "observer" } : null,
    { timeout: LIVE_TIMEOUT_MS, backoff: LIVE_BACKOFF_MS }
  );
  if (!text) {
    if (repo) {
      try {
        S.markSessionLogDistilled(db, job.sessionId, job.turn, {
          error: `${error || "no model output"} (${attempts} attempt(s))`,
        });
      } catch {}
    }
    cleanup(jobFile);
    return;
  }
  const { goals, events } = extractSessionAnalysis(text);
  if (repo) {
    await applyCapture(db, repo, {
      goals,
      events,
      sessionId: job.sessionId,
      turn: job.turn,
      refreshLifecycle: true,
    });
    try {
      S.markSessionLogDistilled(db, job.sessionId, job.turn);
    } catch {}
  }
  cleanup(jobFile);
}

// Offline replay (#36): re-run stored session_log digests through the CURRENT distiller into a
// fresh TARGET db, reproducing live capture deterministically from stored input. This is how the
// multi-goal change is regression-tested against real captured sessions without re-driving them.
//   --source <path>  DB to READ session_log rows from (opened readonly; never mutated)
//   --target <path>  DB to WRITE captured initiatives/events/snapshots into (created if absent)
//   --repo   <slug>  which repo's sessions to replay, e.g. dmayman/habitus
//   --since  <iso>   only replay rows with created_at >= this (optional)
// Rows are processed in created_at ASC order — the real chronological capture order across
// interleaved sessions — so each digest sees the initiatives that earlier digests spawned.
export function replay(flags = {}) {
  const sourcePath = flags.source;
  const targetPath = flags.target;
  const repoSlug = flags.repo;
  const since = flags.since || null;
  if (!sourcePath || typeof sourcePath !== "string")
    return void fail("observe --replay needs --source <db path>");
  if (!targetPath || typeof targetPath !== "string")
    return void fail("observe --replay needs --target <db path>");
  if (!repoSlug || typeof repoSlug !== "string")
    return void fail("observe --replay needs --repo <owner/name>");
  if (!existsSync(sourcePath)) return void fail(`source DB not found: ${sourcePath}`);

  const source = S.openDbAt(sourcePath, { readonly: true });
  const target = S.openDbAt(targetPath); // schema applied; created if new

  const srcRepo = source.prepare("SELECT * FROM repos WHERE slug = ?").get(repoSlug);
  if (!srcRepo) return void fail(`no repo '${repoSlug}' in source DB ${sourcePath}`);
  const repo = target.prepare("SELECT * FROM repos WHERE slug = ?").get(repoSlug);
  if (!repo) return void fail(`target DB has no repos row for '${repoSlug}' — seed one first`);

  // runHaiku only uses cwd to spawn `claude -p`; the target repo's checkout may not exist here,
  // so fall back to the current directory when its root is missing.
  const root = repo.root && existsSync(repo.root) ? repo.root : process.cwd();

  const rows = since
    ? source
        .prepare(
          "SELECT * FROM session_log WHERE repo_id = ? AND created_at >= ? ORDER BY created_at ASC, turn ASC"
        )
        .all(srcRepo.id, since)
    : source
        .prepare("SELECT * FROM session_log WHERE repo_id = ? ORDER BY created_at ASC, turn ASC")
        .all(srcRepo.id);

  process.stdout.write(
    `Replaying ${rows.length} session_log row(s) for ${repoSlug}\n  source: ${sourcePath}\n  target: ${targetPath}${since ? `\n  since:  ${since}` : ""}\n\n`
  );

  let totalGoals = 0;
  let totalEvents = 0;
  let processed = 0;
  let dropped = 0;

  // Sequential (not concurrent): each digest must see the initiatives earlier digests spawned,
  // exactly as live capture does turn-by-turn.
  const run = async () => {
    let first = true;
    for (const row of rows) {
      const digest = row.digest || "";
      const tag = `${String(row.session_id).slice(0, 8)} turn ${row.turn}`;
      if (digest.length < MIN_DIGEST_CHARS) {
        process.stdout.write(`  ${tag}: skipped (digest ${digest.length} chars)\n`);
        continue;
      }
      // Pace between turns so a burst of sequential calls doesn't get throttled — the exact
      // failure mode that silently dropped the late/big turns before.
      if (!first) await sleep(REPLAY_PACING_MS);
      first = false;

      // Rebuild the initiatives list from the TARGET exactly as observeWorker/observe does.
      const initiatives = S.listThreads(target, repo.id)
        .filter((t) => t.status !== "done")
        .slice(0, 20)
        .map((t) => ({ title: t.title, goal: t.goal || null }));

      // Retry with backoff + a generous timeout (digests run 20k+ chars) so transient
      // timeouts/throttling don't vanish as an opaque "no model output".
      const { text, error, attempts } = await callModelWithRetry(
        buildPrompt(digest, initiatives),
        root,
        { db: target, repoId: repo.id, kind: "observer" },
        { timeout: REPLAY_TIMEOUT_MS, backoff: REPLAY_BACKOFF_MS }
      );
      // Mirror the raw-ledger row into the TARGET and record the distill outcome there — the
      // same success/failure audit the live worker writes, so a replayed ledger is queryable
      // the same way (SELECT ... WHERE distill_error IS NOT NULL). Idempotent per (session,turn).
      try {
        S.appendSessionLog(target, repo.id, {
          sessionId: row.session_id,
          turn: row.turn,
          cursorStart: row.cursor_start,
          digest,
        });
        S.markSessionLogDistilled(target, row.session_id, row.turn, {
          error: text ? null : `${error} (${attempts} attempt(s))`,
        });
      } catch {}
      if (!text) {
        dropped++;
        process.stdout.write(`  ${tag}: DROPPED after ${attempts} attempt(s) — ${error}\n`);
        continue;
      }
      const { goals, events } = extractSessionAnalysis(text);
      await applyCapture(target, repo, {
        goals,
        events,
        sessionId: row.session_id,
        turn: row.turn,
        refreshLifecycle: false, // no live git during replay
      });
      totalGoals += goals.length;
      totalEvents += events.length;
      processed++;
      const retryNote = attempts > 1 ? ` (after ${attempts} attempts)` : "";
      process.stdout.write(`  ${tag}: ${goals.length} goal(s), ${events.length} event(s)${retryNote}\n`);
    }
    const initiatives = S.listThreads(target, repo.id).length;
    process.stdout.write(
      `\nDone. ${processed}/${rows.length} rows processed → ${totalGoals} goal(s), ${totalEvents} event(s) seeded across ${initiatives} initiative(s) in target.` +
        (dropped ? ` ${dropped} turn(s) DROPPED after retries.` : ` No turns dropped.`) +
        `\n`
    );
  };
  return run();
}

// Model-call tuning. The live worker is detached (the user's turn already ended), so it can
// afford a couple of quick retries; replay is offline batch work and retries harder with a
// longer per-call timeout (its digests run 20k+ chars vs the live 8k clamp).
const LIVE_TIMEOUT_MS = 60000;
const LIVE_BACKOFF_MS = [2000, 5000]; // 2 retries with short backoff
const REPLAY_TIMEOUT_MS = 150000;
const REPLAY_BACKOFF_MS = [2000, 6000, 15000]; // exponential-ish waits before retry 2, 3, 4
const REPLAY_PACING_MS = 1000; // small gap between turns to avoid throttling

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One model call, retried on failure with backoff. Returns { text, error, attempts }.
// Surfaces the last failure reason (timeout/stderr/exit) so a dropped turn is never opaque.
// Shared by the live worker (short backoff) and replay (longer timeout, more retries).
async function callModelWithRetry(prompt, cwd, meter, { timeout, backoff }) {
  const maxAttempts = backoff.length + 1;
  let last = { text: null, error: "not attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = runHaikuOnce(prompt, cwd, { timeout, meter });
    if (last.text) return { ...last, attempts: attempt };
    if (attempt < maxAttempts) await sleep(backoff[attempt - 1]);
  }
  return { ...last, attempts: maxAttempts };
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exitCode = 1;
}

const LIFECYCLE_THROTTLE_MS = 90 * 1000; // at most once every ~90s per repo

// Run the deterministic lifecycle refresh if enough time has passed since the last one.
// Returns the set of thread ids whose issue statuses changed (empty when skipped/unchanged).
async function maybeRefreshLifecycle(db, repo) {
  const key = `lifecycle-ts:${repo.slug}`;
  const last = Number(S.getConfig(db, "global", key, "0")) || 0;
  if (Date.now() - last < LIFECYCLE_THROTTLE_MS) return new Set();
  S.setConfig(db, "global", key, String(Date.now()));
  try {
    const { refreshLifecycle } = await import("./work.js");
    return refreshLifecycle(db, repo).changedThreads;
  } catch {
    return new Set();
  }
}

function cleanup(f) {
  try {
    unlinkSync(f);
  } catch {}
}
