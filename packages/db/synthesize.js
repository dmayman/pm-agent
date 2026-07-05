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

// Build the Haiku prompt + event count for a thread (the sync gather step). Returns null
// when there's nothing to summarize.
function buildThreadPrompt(db, repo, threadId) {
  const thread = S.getThread(db, threadId);
  if (!thread) return null;
  const events = S.listEvents(db, repo.id, { threadId, limit: 100 }).slice().reverse(); // chronological
  if (!events.length) return null;

  const issueNum = primaryIssue(events);
  const issue = issueNum ? ghIssue(repo.root, issueNum) : null;
  const log = events.map((e) => `- ${e.type}: ${e.summary}`).join("\n");
  const context = issue
    ? `The issue this work addresses:\nTitle: ${issue.title}\n${issue.body}\n\n`
    : thread.genesis
      ? `Context: ${thread.genesis}\n\n`
      : "";

  const prompt =
    `Write a summary of one line of development work for a developer skimming a timeline weeks later. ` +
    `In 1-2 sentences of plain, human language, say WHAT this work accomplished and WHY it mattered — ` +
    `the intent and the outcome, not the mechanics. Do not list the commits, name files, or use hashes; ` +
    `synthesize the whole arc into its point. Write it so someone non-technical could follow.\n\n` +
    context +
    `Work log (newest last):\n${log}\n\n` +
    `Return ONLY the summary sentence(s), no preamble, no quotes.`;
  return { prompt, eventCount: events.length };
}

function storeSummary(db, threadId, out, eventCount) {
  if (!out) return false;
  const summary = out.trim().replace(/^["']+|["']+$/g, "");
  if (!summary) return false;
  S.setThreadSummary(db, threadId, summary, eventCount);
  return true;
}

// Synthesize one thread synchronously (used by the observer worker for the 1 touched thread).
export function synthesizeThread(db, repo, threadId) {
  const built = buildThreadPrompt(db, repo, threadId);
  if (!built) return false;
  return storeSummary(db, threadId, runHaiku(built.prompt, repo.root), built.eventCount);
}

// Synthesize threads that need it, running the Haiku calls concurrently. staleOnly skips
// threads whose summary already reflects their current event count.
export async function synthesizeAll(db, repo, { staleOnly = true, onProgress = null, concurrency = 6 } = {}) {
  const targets = [];
  for (const t of S.listThreads(db, repo.id)) {
    if (staleOnly && t.summary && t.summary_event_count === t.event_count) continue;
    const built = buildThreadPrompt(db, repo, t.id);
    if (built) targets.push({ thread: t, ...built });
  }
  let n = 0;
  await pool(targets, concurrency, async (t) => {
    const out = await runHaikuAsync(t.prompt, repo.root);
    if (storeSummary(db, t.thread.id, out, t.eventCount)) {
      n++;
      if (onProgress) onProgress(t.thread, n);
    }
  });
  return n;
}
