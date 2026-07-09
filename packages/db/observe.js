// Observer capture — the automatic, hands-off mode. A Stop hook invokes `pm-agent
// observe` with the Claude Code Stop payload on stdin. We read ONLY the transcript slice
// added since a per-session cursor (keeps tokens tiny), then spawn a DETACHED Haiku
// worker to distill it into ledger events, so the user's turn ends with zero added
// latency. No-ops unless capture=observer — that's how the toggle works at the hook level.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as S from "./store.js";
import { runHaiku } from "./haiku.js";

const MIN_DIGEST_CHARS = 200; // below this there's nothing worth distilling
const MAX_DIGEST_CHARS = 8000; // keep Haiku's input cheap; take the tail if larger

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
function digestLines(lines, { raw = false } = {}) {
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
  if (!raw && text.length > MAX_DIGEST_CHARS) text = text.slice(-MAX_DIGEST_CHARS);
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

1) GOAL — Identify the durable goal this session is pursuing. Treat the FIRST user message of the excerpt as a goal-candidate: the moment a goal is framed is often the opening prompt, and it must not slip by as ordinary chatter. Decide whether this work advances one of the existing initiatives (below) or is a NEW goal.

2) EVENTS — Extract ONLY the meaningful, timeline-worthy events — decisions made, build/test/review milestones reached, followups taken on, and loose ends explicitly deferred. Skip routine chatter, tool mechanics, and anything trivial. Most excerpts yield 0-3 events; an empty array is correct and expected when nothing notable happened.

Respond with ONLY a JSON object (no prose, no code fence) of this shape:
{
  "goal": {
    "text": "the durable goal in one line — what the work aims to achieve (not the tactic of the moment)",
    "initiative": "the EXACT title of a matching initiative above, or a short new title if none fits",
    "isNew": true or false,
    "framing": "a short quote or paraphrase of the moment the goal was framed (usually the opening user message)",
    "shift": "if the goal sharpened versus the matched initiative's goal, say how — else null"
  },
  "events": [
    {
      "type": "one of decided|built|tested|reviewed|followup|deferred|merged|blocked|note",
      "summary": "one crisp past-tense line a busy developer would want on their timeline",
      "thread": "the initiative title this belongs to (reuse goal.initiative when it fits)",
      "refs": { "issue": 0, "pr": 0, "branch": "", "commit": "" }
    }
  ]
}

Rules: "goal" may be null only if the excerpt truly frames no goal (rare). Use "deferred" ONLY for things explicitly punted to later — those become tracked loose ends. Omit empty "refs".${known}

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

// Parse the distiller's response into { goal, events }. The model is asked for an object, but
// we degrade gracefully: a bare array (old shape / model drift) is treated as events with no
// goal, and a malformed object still yields whatever events we can recover. Never throws.
// Exported for tests.
export function extractSessionAnalysis(text) {
  if (!text) return { goal: null, events: [] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      // Only accept it as the wrapper if it actually carries goal/events — otherwise this was
      // a bare array whose inner objects we accidentally grabbed; fall through to array parsing.
      if (obj && typeof obj === "object" && !Array.isArray(obj) && ("goal" in obj || "events" in obj)) {
        const events = Array.isArray(obj.events) ? obj.events : [];
        const goal = obj.goal && typeof obj.goal === "object" ? obj.goal : null;
        return { goal, events };
      }
    } catch {
      // fall through to the array fallback
    }
  }
  return { goal: null, events: extractJsonArray(text) };
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

// The detached worker: call Haiku, write the events it distilled, clean up.
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
  const output = runHaiku(job.prompt, job.root, {
    meter: repo ? { db, repoId: repo.id, kind: "observer" } : null,
  });
  if (!output) {
    cleanup(jobFile);
    return;
  }
  const { goal, events } = extractSessionAnalysis(output);
  if (repo) {
    const touched = new Set();

    // Goal-first capture (#26): seed/refine the initiative's durable goal from what this
    // session is pursuing, before (or alongside) any events. resolveThread creates the
    // initiative by title when it's new; setThreadGoal's trust guard refines an observer goal
    // but never clobbers an agent-seeded one.
    if (goal && goal.text && goal.initiative) {
      const gid = S.resolveThread(db, repo.id, String(goal.initiative));
      if (gid) {
        S.setThreadGoal(db, gid, { goal: goal.text, framing: goal.framing, source: "observer" });
        if (goal.framing) S.setThreadGenesis(db, gid, String(goal.framing));
        touched.add(gid);
      }
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
        // it as a SOFT link so the initiative shows the issue (and the recluster can re-home).
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
    for (const id of await maybeRefreshLifecycle(db, repo)) touched.add(id);

    // Re-synthesize every thread we touched (new event) or whose issue status just flipped,
    // then snapshot it — the trajectory row the eval harness grades (goal seeded → refined →
    // sharpened across turns). Snapshot AFTER synthesis so it captures the fresh summary.
    if (touched.size) {
      const { synthesizeThread } = await import("./synthesize.js");
      for (const id of touched) {
        synthesizeThread(db, repo, id);
        try {
          S.snapshotInitiative(db, repo.id, id, { sessionId: job.sessionId, turn: job.turn });
        } catch {}
      }
    }
  }
  cleanup(jobFile);
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
