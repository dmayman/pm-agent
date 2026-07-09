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

// Build the Haiku prompt + a freshness signal for a thread (the sync gather step). The
// summary is a standing snapshot of the whole initiative — what happened AND what's next —
// so it draws on both the issue roster (with lifecycle status) and the work log. Returns
// null only when there's genuinely nothing to summarize (no issues and no events).
function buildThreadPrompt(db, repo, threadId) {
  const thread = S.getThread(db, threadId);
  if (!thread) return null;
  const events = S.listEvents(db, repo.id, { threadId, limit: 100 }).slice().reverse(); // chronological
  const issues = S.issuesForThread(db, threadId);
  if (!events.length && !issues.length) return null;

  const issueNum = primaryIssue(events) || (issues[0] && issues[0].number) || null;
  const issue = issueNum ? ghIssue(repo.root, issueNum) : null;
  const context = issue
    ? `The issue at the heart of this work:\nTitle: ${issue.title}\n${issue.body}\n\n`
    : thread.genesis
      ? `Context: ${thread.genesis}\n\n`
      : "";

  // The durable goal (#26) anchors the summary. It's held in its own column and refined under a
  // trust guard, so we hand it to the model verbatim and tell it to preserve — not re-derive —
  // it, keeping the goal steady while the progress narrative around it evolves.
  const goalBlock =
    (thread.goal ? `Durable goal (preserve this verbatim as the Goal line — do NOT reword it): ${thread.goal}\n` : "") +
    (thread.why ? `Why it matters: ${thread.why}\n` : "");

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

  const prompt =
    `You are writing the standing summary for one initiative — an arc of work defined by a ` +
    `durable GOAL — that a developer will skim weeks later to remember where things stand. ` +
    `Tell the WHOLE story as progress against that goal.\n\n` +
    `Write it in this exact shape:\n` +
    `1. A first sentence that is the headline — what this initiative is and its current state — ` +
    `wrapped in **double asterisks** so it renders bold.\n` +
    `2. Then 1-3 more sentences of plain language covering, in order: the GOAL (what this is ` +
    `trying to achieve), what's been TRIED or accomplished so far, and — if any issues above ` +
    `are not yet done — what's DONE versus what's LEFT. If there is open or not-started work, ` +
    `you MUST end by saying what's next.\n\n` +
    `Rules: plain, human language a non-technical person could follow. No file names, no commit ` +
    `hashes, don't enumerate commits — synthesize the arc into its point. Hold the goal steady: ` +
    `if a durable goal is given below, state it as the goal verbatim rather than re-deriving one ` +
    `from recent events.\n\n` +
    `Initiative: ${thread.title}\n\n` +
    goalBlock +
    (goalBlock ? "\n" : "") +
    roster +
    context +
    log +
    `Return ONLY the summary, starting with the bold first sentence. No preamble, no surrounding quotes.`;
  // Signal = events + issues, so adding an issue or logging work re-triggers synthesis.
  return { prompt, signal: events.length + issues.length };
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
    // Freshness signal = events + issues; re-synthesize when either changes.
    const signal = (t.event_count || 0) + (t.issue_count || 0);
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
