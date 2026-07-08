// Thread synthesis — the digestibility layer. Commits and merges are technical and hard to
// track; this reads a thread's issue + its events and writes a short, plain-language "what
// this was and why it mattered" summary with Haiku. The events stay as the evidence; the
// summary is the story you actually skim.

import { execFileSync } from "node:child_process";
import * as S from "./store.js";
import { runHaiku, runHaikuAsync, pool } from "./haiku.js";

function ghIssue(repoRoot, number) {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "view", String(number), "--json", "title,body"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
    );
    const j = JSON.parse(out);
    return { title: j.title || "", body: (j.body || "").slice(0, 900) };
  } catch {
    return null;
  }
}

function primaryIssue(events) {
  const counts = {};
  for (const e of events) {
    let r = e.refs;
    if (typeof r === "string") {
      try {
        r = JSON.parse(r);
      } catch {
        r = null;
      }
    }
    if (r && r.issue) counts[r.issue] = (counts[r.issue] || 0) + 1;
  }
  const nums = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return nums.length ? Number(nums[0]) : null;
}

const STATUS_LABEL = {
  done: "done",
  shipped: "merged but issue still open",
  in_progress: "in progress on a branch",
  todo: "not started",
};

// How each initiative lifecycle should frame its standing summary. The old prompt forced a
// bold "X is complete" headline off a work log that's ~90% build/merge events — so every
// initiative read as finished. State is now driven by the lifecycle, NOT by the event verbs.
const LIFECYCLE_FRAME = {
  planned:
    "This initiative is PLANNED — work has not started yet. Say what it sets out to do and " +
    "why it matters (its goal and motivation). Do NOT imply any work is done.",
  active:
    "This initiative is ACTIVE — in progress. Say what has been accomplished so far and what " +
    "is still open or coming next. Do NOT claim it is finished.",
  closed:
    "This initiative is CLOSED — wrapped up. Say what it set out to do and what came of it, in " +
    "the past tense.",
};

// The coarse freshness signal for a thread — what synthesizeAll compares against
// summary_event_count to skip threads whose summary is already current. Kind-aware: an area's
// state lives in its initiatives, so its signal rolls those up; an initiative's is its own
// events + issues (matching what buildInitiativePrompt counts).
function coarseSignal(db, repoId, t) {
  if (t.kind === "area") {
    const inits = S.listInitiatives(db, repoId, { parentId: t.id });
    return inits.length + inits.reduce((s, i) => s + (i.event_count || 0) + (i.issue_count || 0), 0);
  }
  return (t.event_count || 0) + (t.issue_count || 0);
}

// Build the Haiku prompt + a freshness signal for one INITIATIVE (the sync gather step). The
// summary is a standing snapshot — what happened AND what's still open — drawn from the issue
// roster (with lifecycle status) and the work log, but with the current state framed by the
// initiative's own lifecycle rather than inferred from the events. Returns null only when
// there's genuinely nothing to summarize (no issues and no events).
function buildInitiativePrompt(db, repo, thread) {
  const events = S.listEvents(db, repo.id, { threadId: thread.id, limit: 100 }).slice().reverse(); // chronological
  const issues = S.issuesForThread(db, thread.id);
  if (!events.length && !issues.length) return null;

  const issueNum = primaryIssue(events) || (issues[0] && issues[0].number) || null;
  const issue = issueNum ? ghIssue(repo.root, issueNum) : null;
  const context = issue
    ? `The issue at the heart of this work:\nTitle: ${issue.title}\n${issue.body}\n\n`
    : thread.genesis
      ? `Context: ${thread.genesis}\n\n`
      : "";

  // The 'why' (agent-seeded at birth, or librarian-inferred) is the motivation the summary
  // should lead with when present.
  const why = thread.why ? `Why this initiative exists (its motivation): ${thread.why}\n\n` : "";

  // The issue roster with lifecycle status is what lets the summary say what's still open /
  // next; the work log carries what actually happened.
  const roster = issues.length
    ? `Issues in this initiative (status shows what's finished vs still open):\n` +
      issues.map((i) => `- #${i.number} [${STATUS_LABEL[i.status] || i.status || "?"}] ${i.title}`).join("\n") +
      `\n\n`
    : "";
  const log = events.length
    ? `Work log (newest last):\n${events.map((e) => `- ${e.type}: ${e.summary}`).join("\n")}\n\n`
    : "";

  const lifecycle = thread.lifecycle || "active";
  const frame = LIFECYCLE_FRAME[lifecycle] || LIFECYCLE_FRAME.active;

  const prompt =
    `You are writing the standing summary for one initiative — a bounded arc of work — that a ` +
    `developer will skim weeks later to remember where things stand.\n\n` +
    `${frame}\n\n` +
    `Write it in this exact shape:\n` +
    `1. A first sentence that is the headline — what this initiative is and its current state, ` +
    `stated in line with the lifecycle above — wrapped in **double asterisks** so it renders bold.\n` +
    `2. Then 1-3 more sentences of plain language: what has been accomplished so far, and — if the ` +
    `lifecycle is planned or active and any issues above are not yet done — what's still open or ` +
    `next.\n\n` +
    `Rules: base the current state ONLY on the lifecycle stated above, never on how many build or ` +
    `merge events appear below. Plain, human language a non-technical person could follow. No file ` +
    `names, no commit hashes, don't enumerate commits — synthesize the arc into its point.\n\n` +
    `Initiative: ${thread.title}\n\n` +
    why +
    roster +
    context +
    log +
    `Return ONLY the summary, starting with the bold first sentence. No preamble, no surrounding quotes.`;
  // Signal = events + issues, so adding an issue or logging work re-triggers synthesis.
  return { prompt, signal: events.length + issues.length };
}

// Build the Haiku prompt + signal for one AREA — an evergreen domain that is never "done". Its
// summary is a rolling status: what the area is, and where things stand across its initiatives
// right now. The area's own `description` (what it is) is authored elsewhere and left
// untouched; this only writes the rolling status into `summary`. Returns null when the area has
// no initiatives and no description to summarize.
function buildAreaPrompt(db, repo, thread) {
  const inits = S.listInitiatives(db, repo.id, { parentId: thread.id });
  if (!inits.length && !thread.description) return null;

  const desc = thread.description ? `What this area is: ${thread.description}\n\n` : "";
  const roster = inits.length
    ? `Initiatives in this area (with lifecycle + last activity):\n` +
      inits
        .map((i) => {
          const last = i.last_event_ts ? new Date(i.last_event_ts).toISOString().slice(0, 10) : "no activity";
          const gist = i.summary ? ` — ${i.summary.replace(/\*\*/g, "").split(/(?<=\.)\s/)[0]}` : "";
          return `- ${i.title} [${i.lifecycle || "active"}] (${last})${gist}`;
        })
        .join("\n") +
      `\n\n`
    : "No initiatives yet.\n\n";

  const prompt =
    `You are writing the rolling status for an AREA — an evergreen domain of ongoing work that ` +
    `is NEVER "done" (unlike a bounded initiative). A developer skims this to remember where the ` +
    `whole area stands.\n\n` +
    `Write 2-4 sentences of plain language: (1) what this area is about, then (2) where things ` +
    `stand across its initiatives right now — what's active, what's planned, what recently ` +
    `closed. Draw the current state from the initiatives listed below and their lifecycle. Never ` +
    `describe the area itself as complete or finished.\n\n` +
    `Rules: plain, human language. No file names, no commit hashes.\n\n` +
    `Area: ${thread.title}\n\n` +
    desc +
    roster +
    `Return ONLY the rolling status. No preamble, no surrounding quotes.`;
  return { prompt, signal: coarseSignal(db, repo.id, thread) };
}

// Dispatch by kind: areas get a rolling status, initiatives (the default for un-reclassified
// threads) get a lifecycle-framed standing summary.
function buildThreadPrompt(db, repo, threadId) {
  const thread = S.getThread(db, threadId);
  if (!thread) return null;
  if (thread.kind === "area") return buildAreaPrompt(db, repo, thread);
  return buildInitiativePrompt(db, repo, thread);
}

// ---------------------------------------------------------------------------
// Update synthesis (the per-cluster status line the timeline shows)
// ---------------------------------------------------------------------------

// Synthesize one Update's summary: a 1-2 sentence WHY + what came out of it (NOT a play-by-play
// — the expanded event list carries the blow-by-blow). No-op on a sealed update (frozen) or one
// with no events, and skipped when the summary already reflects the current event count.
export function synthesizeUpdate(db, repo, updateId) {
  const update = S.getUpdate(db, updateId);
  if (!update || update.sealed) return false;
  const events = S.eventsForUpdate(db, updateId);
  if (!events.length) return false;
  const signal = events.length;
  if (update.summary && update.signal === signal) return false; // already current

  const thread = update.thread_id ? S.getThread(db, update.thread_id) : null;
  const heading = thread ? `${thread.kind === "area" ? "Area" : "Initiative"}: ${thread.title}` : "";
  const why = thread && thread.why ? `Its motivation: ${thread.why}\n` : "";
  const log = events.map((e) => `- ${e.type}: ${e.summary}`).join("\n");

  const prompt =
    `You are writing a single status update for a developer's timeline: a short caption over a ` +
    `burst of related work that happened together. Say WHY the work happened and WHAT came out ` +
    `of it — the point, not a play-by-play (the individual events are listed separately for ` +
    `anyone who wants the detail).\n\n` +
    `Write 1-2 crisp sentences of plain language. No file names, no commit hashes, no bullet ` +
    `list.\n\n` +
    (heading ? heading + "\n" : "") +
    why +
    `\nWhat happened in this burst (chronological):\n${log}\n\n` +
    `Return ONLY the caption. No preamble, no surrounding quotes.`;

  const out = runHaiku(prompt, repo.root, { meter: { db, repoId: repo.id, kind: "synthesis" } });
  if (!out) return false;
  const summary = out.trim().replace(/^["']+|["']+$/g, "");
  if (!summary) return false;
  S.setUpdateSummary(db, updateId, summary, signal);
  return true;
}

function storeSummary(db, threadId, out, signal) {
  if (!out) return false;
  const summary = out.trim().replace(/^["']+|["']+$/g, "");
  if (!summary) return false;
  S.setThreadSummary(db, threadId, summary, signal);
  return true;
}

// Synthesize one thread synchronously (used by the observer worker for the 1 touched thread).
export function synthesizeThread(db, repo, threadId) {
  const built = buildThreadPrompt(db, repo, threadId);
  if (!built) return false;
  const out = runHaiku(built.prompt, repo.root, { meter: { db, repoId: repo.id, kind: "synthesis" } });
  return storeSummary(db, threadId, out, built.signal);
}

// Synthesize threads that need it, running the Haiku calls concurrently. staleOnly skips
// threads whose summary already reflects their current event count.
export async function synthesizeAll(db, repo, { staleOnly = true, onProgress = null, concurrency = 6 } = {}) {
  const targets = [];
  for (const t of S.listThreads(db, repo.id)) {
    // Freshness signal is kind-aware (see coarseSignal); re-synthesize when it changes.
    const signal = coarseSignal(db, repo.id, t);
    if (staleOnly && t.summary && t.summary_event_count === signal) continue;
    const built = buildThreadPrompt(db, repo, t.id);
    if (built) targets.push({ thread: t, ...built });
  }
  let n = 0;
  await pool(targets, concurrency, async (t) => {
    const out = await runHaikuAsync(t.prompt, repo.root, { meter: { db, repoId: repo.id, kind: "synthesis" } });
    if (storeSummary(db, t.thread.id, out, t.signal)) {
      n++;
      if (onProgress) onProgress(t.thread, n);
    }
  });
  return n;
}
