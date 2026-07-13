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
  // it, keeping the goal steady while the progress narrative around it evolves. The momentary
  // focus rides along as context for what's happening NOW, explicitly fenced off from the goal.
  const goalBlock =
    (thread.goal ? `Durable goal (preserve this verbatim as the Goal line — do NOT reword it): ${thread.goal}\n` : "") +
    (thread.why ? `Why it matters: ${thread.why}\n` : "") +
    (thread.focus
      ? `Current focus (the tactic of the moment — use it for the "where things stand" part only; it is NOT the goal): ${thread.focus}\n`
      : "");

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
    `durable GOAL. A developer will skim it weeks later to remember what this initiative is and ` +
    `why it exists. Describe the initiative as a THING that stands on its own, not a stream of ` +
    `recent events.\n\n` +
    `Write it in this EXACT shape:\n` +
    `1. A first sentence — wrapped in **double asterisks** so it renders bold — that says what ` +
    `this initiative IS and why it matters (its point, the impact it has). Make it EVERGREEN: it ` +
    `must read the same whether the work just started or finished long ago. Put NO status in it — ` +
    `forbidden words include "underway", "in progress", "merged", "shipped", "done", "complete", ` +
    `"wins", "progress", "now", "landed". Anchor it on the durable goal and the "why" below when ` +
    `they are given; otherwise infer the point from the initiative's context.\n` +
    `2. Then 1 to 3 plain sentences: what has actually been accomplished so far, and — only if the ` +
    `work is unfinished — what is still open. Concrete but high level.\n\n` +
    `Hard rules:\n` +
    `- Plain, human language a non-technical person could follow. Short: a bold headline plus a ` +
    `few sentences, never paragraphs.\n` +
    `- Do NOT recount technical history, decisions, or a play-by-play. No file names, no function ` +
    `names, no commit hashes, no enumerating commits or issue numbers. Synthesize the arc into its ` +
    `point.\n` +
    `- The durable goal and "why" are the BACKBONE of the headline. The work log and issue roster ` +
    `are only EVIDENCE for what's been done and what's left — never the subject of the summary.\n` +
    `- Hold the goal steady: if a durable goal is given below, treat it as the fixed point the ` +
    `headline describes rather than re-deriving a goal from recent events.\n\n` +
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
