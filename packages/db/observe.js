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
// the summary lives in Claude's own words anyway.
function digestLines(lines) {
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
        out.push(`${role === "user" ? "USER" : "CLAUDE"}: ${block.text.trim().slice(0, 800)}`);
      } else if (block.type === "tool_use") {
        const target =
          block.input?.file_path || block.input?.command || block.input?.path || "";
        out.push(`ACTION: ${block.name}${target ? " " + String(target).slice(0, 120) : ""}`);
      }
    }
  }
  let text = out.join("\n");
  if (text.length > MAX_DIGEST_CHARS) text = text.slice(-MAX_DIGEST_CHARS);
  return text;
}

function buildPrompt(digest, threadTitles) {
  const known = threadTitles.length
    ? `\n\nExisting threads you should reuse when the work fits one (match by title, don't duplicate):\n- ${threadTitles.join("\n- ")}`
    : "";
  return `You maintain a developer's work ledger. Below is an excerpt from a Claude Code coding session. Extract ONLY the meaningful, timeline-worthy events — decisions made, build/test/review milestones reached, followups taken on, and loose ends explicitly deferred. Skip routine chatter, tool mechanics, and anything trivial. Most excerpts yield 0-3 events; returning an empty array is correct and expected when nothing notable happened.

For each event output an object:
  "type": one of decided|built|tested|reviewed|followup|deferred|merged|blocked|note
  "summary": one crisp past-tense line a busy developer would want on their timeline
  "thread": the title of the arc of work this belongs to (reuse an existing one when it fits, or a short new title)
  "refs": optional object with any of {"issue":<n>,"pr":<n>,"branch":"<s>","commit":"<sha>"}

Use "deferred" ONLY for things explicitly punted to later — those become tracked loose ends.${known}

Respond with ONLY a JSON array (no prose, no code fence). Excerpt:
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
  // Advance the cursor now, so a slow/failed worker never causes reprocessing next turn.
  S.setConfig(db, "global", cursorKey, String(allLines.length));
  if (!fresh.length) return;

  const digest = digestLines(fresh);
  if (digest.length < MIN_DIGEST_CHARS) return;

  const threadTitles = S.listThreads(db, repo.id)
    .filter((t) => t.status !== "done")
    .map((t) => t.title)
    .slice(0, 20);

  // Hand the heavy Haiku call to a detached worker and return immediately.
  const jobDir = path.join(S.pmHome(), "jobs");
  mkdirSync(jobDir, { recursive: true });
  const jobFile = path.join(jobDir, `${sessionId}-${allLines.length}.json`);
  writeFileSync(
    jobFile,
    JSON.stringify({ repoSlug: repo.slug, root: repo.root, prompt: buildPrompt(digest, threadTitles) })
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
  const events = extractJsonArray(output);
  if (repo) {
    const touched = new Set();
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

    // Re-synthesize every thread we touched (new event) or whose issue status just flipped.
    if (touched.size) {
      const { synthesizeThread } = await import("./synthesize.js");
      for (const id of touched) synthesizeThread(db, repo, id);
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
