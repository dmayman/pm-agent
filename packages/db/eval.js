// Eval harness (#28) — grade the live goal-first capture (#26) against a real session.
//
// The observer records two judgment-free streams as work happens: the RAW per-turn ledger
// (session_log — the untruncated digest) and the librarian's TRAJECTORY (initiative_snapshots —
// the initiative's goal/summary/event-set at each turn). This command assembles those plus the
// FINAL initiative state into one bundle and hands it to a stronger-than-Haiku judge, which
// scores how well capture did against #26's How-to-verify rubric and the emergent-pattern
// questions, writing a markdown report under ~/.pm-agent/evals/. Manual + at session end.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as S from "./store.js";
import { runJudge } from "./haiku.js";

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function fmtEvents(events) {
  // chronological (listEvents returns newest-first)
  return events
    .slice()
    .reverse()
    .map((e) => `  - [${e.type}] ${e.summary}${e.refs ? ` ${typeof e.refs === "string" ? e.refs : JSON.stringify(e.refs)}` : ""}`)
    .join("\n");
}

// Assemble the human-readable bundle the judge grades.
function buildBundle(db, repo, session, rawLog, snaps) {
  const parts = [];

  parts.push(`## RAW LEDGER — ${rawLog.length} turn(s), session ${session}\n`);
  parts.push(
    `This is the judgment-free ground truth: the untruncated per-turn digest of the session.\n`
  );
  for (const r of rawLog) {
    parts.push(`### turn ${r.turn}  (${r.created_at})\n${r.digest}\n`);
  }

  // Group snapshots by initiative so the judge can read each initiative's trajectory in order.
  const byThread = new Map();
  for (const s of snaps) {
    if (!byThread.has(s.thread_id)) byThread.set(s.thread_id, []);
    byThread.get(s.thread_id).push(s);
  }

  parts.push(`\n## TRAJECTORY SNAPSHOTS — how the librarian's initiatives evolved\n`);
  if (!byThread.size) parts.push(`(no snapshots captured this session)\n`);
  for (const [threadId, rows] of byThread) {
    const t = S.getThread(db, threadId);
    parts.push(`\n### initiative #${threadId} — "${t ? t.title : "?"}"`);
    for (const s of rows) {
      parts.push(
        `- turn ${s.turn}: goal=${JSON.stringify(s.goal)} [source:${s.goal_source || "—"}] · ` +
          `focus=${JSON.stringify(s.focus ?? null)} · why=${JSON.stringify(s.why ?? null)} · ` +
          `events=${s.event_count} · summary=${JSON.stringify(s.summary)}`
      );
    }
  }

  parts.push(`\n## FINAL INITIATIVE STATE\n`);
  for (const threadId of byThread.keys()) {
    const t = S.getThread(db, threadId);
    if (!t) continue;
    const events = S.listEvents(db, repo.id, { threadId, limit: 200 });
    const issues = S.issuesForThread(db, threadId);
    parts.push(`\n### initiative #${threadId} — "${t.title}"`);
    parts.push(`- status: ${t.status}`);
    parts.push(`- goal: ${JSON.stringify(t.goal)}  (source: ${t.goal_source || "—"})`);
    parts.push(`- focus: ${JSON.stringify(t.focus ?? null)}`);
    parts.push(`- goal_framing: ${JSON.stringify(t.goal_framing)}`);
    parts.push(`- why: ${JSON.stringify(t.why)}  (source: ${t.why_source || "—"})`);
    parts.push(`- genesis: ${JSON.stringify(t.genesis)}`);
    parts.push(`- summary: ${JSON.stringify(t.summary)}`);
    if (issues.length)
      parts.push(`- issues: ${issues.map((i) => `#${i.number} [${i.status || "?"}] ${i.title}`).join("; ")}`);
    parts.push(`- events (${events.length}):\n${fmtEvents(events)}`);
  }

  return parts.join("\n");
}

function buildJudgePrompt(bundle) {
  return `You are grading a live "goal-first capture" system for a developer's work ledger. The system's job is to watch a coding session and, as work happens, capture the DURABLE GOAL of each initiative and hold it steady over time — not reconstruct goals after the fact. The system splits two fields per initiative: GOAL (the durable outcome framed when the arc began) and FOCUS (what the work is concentrating on right now — expected to swing turn to turn, absorbing the tactical shifts so they never overwrite the goal).

Below is a bundle from ONE real coding session: the RAW per-turn transcript digests (ground truth), the TRAJECTORY of how the system's initiative snapshots evolved turn by turn (each snapshot carries goal AND focus), and the FINAL initiative state.

Grade each of these four points on a 0-3 scale (0=absent, 1=poor, 2=decent, 3=excellent), each with a one-line evidence citation to a specific turn or snapshot:

1. GOAL SEEDED AT BIRTH — Was a durable goal (and/or genesis) captured early, ideally before any GitHub issue or branch existed, from the moment the goal was framed (often the opening user message)?
2. GOAL HELD, FOCUS ABSORBED THE SWINGS — Across turns/snapshots, did the durable goal HOLD STEADY, changing only on a genuine reframe of what the arc is FOR (a sharpening counts; a rewrite to the tactic of the moment does not)? Did the tactical shifts — sub-questions, verification passes, implementation phases — land in the FOCUS field instead of overwriting the goal? Penalize a goal that chases the tactic; penalize equally a focus field frozen while the raw ledger shows attention moving.
3. CORRECT ATTRIBUTION — Did the session's events attribute to the RIGHT initiative (matched by its goal), or was a genuinely new goal correctly flagged — rather than collapsing into a title-matched surface thread or spawning a near-duplicate initiative?
4. DONE & LOOSE-END HYGIENE — When the raw ledger shows an initiative's durable goal was genuinely achieved (merged, verified, user moved on), did its status reach done? Were explicitly-deferred loose ends captured as deferred events rather than lost? Penalize initiatives left active forever after their work clearly finished, and done-flips the evidence doesn't support.

Then answer, in prose citing specific turns/snapshots:
A. How well did the system ITERATE the initiative and its events over time? Where did it lag, over-fragment, or miss a shift?
B. What are the emergent patterns of how loose ideas turn into clarity and get EXECUTED across this session — the loose ends that appeared, and the fabric of how work actually gets done? This is the exploratory part; surface anything interesting the raw ledger reveals that the captured ledger missed.

Output a MARKDOWN report, no preamble, in this order:
- A scores table (point | score | evidence).
- "### Iteration over time" (answer A).
- "### The fabric of the work" (answer B).
- "### Suggestions" — 3 concrete, specific improvements to the capture system.
Quote the digests/snapshots where it helps. Be specific and honest; a low score with good evidence is more useful than a generous one.

=== BUNDLE ===
${bundle}`;
}

export function runEval(argv = [], flags = {}) {
  const db = S.openDb();

  const repo =
    typeof flags.repo === "string" && flags.repo
      ? S.getRepoBySlug(db, flags.repo)
      : S.getRepo(db);
  if (!repo) {
    process.stderr.write("pm-agent eval: no repo (run inside a git repo, or pass --repo <slug>)\n");
    process.exit(1);
  }

  let session = typeof flags.session === "string" && flags.session ? flags.session : null;
  if (!session) {
    const sessions = S.listSessions(db, repo.id, { limit: 1 });
    if (!sessions.length) {
      process.stderr.write(
        "pm-agent eval: no recorded sessions for this repo yet (the observer records them as work happens)\n"
      );
      process.exit(1);
    }
    session = sessions[0].session_id;
  }

  const rawLog = S.getSessionLog(db, session);
  if (!rawLog.length) {
    process.stderr.write(`pm-agent eval: no raw ledger for session ${session}\n`);
    process.exit(1);
  }
  const snaps = S.getSnapshotsForSession(db, session);

  const bundle = buildBundle(db, repo, session, rawLog, snaps);
  const model = typeof flags.model === "string" && flags.model ? flags.model : undefined;

  process.stderr.write(
    `pm-agent eval: grading session ${session} (${rawLog.length} turns, ${snaps.length} snapshots)…\n`
  );
  const report = runJudge(buildJudgePrompt(bundle), repo.root, {
    model,
    meter: { db, repoId: repo.id, kind: "eval" },
  });
  if (!report) {
    process.stderr.write("pm-agent eval: the judge returned nothing (model/auth error?)\n");
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath =
    typeof flags.out === "string" && flags.out
      ? flags.out
      : path.join(S.pmHome(), "evals", `${sanitize(repo.slug)}-${sanitize(session)}-${ts}.md`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const header = `# Capture eval — ${repo.slug}\n\n- session: \`${session}\`\n- turns: ${rawLog.length}\n- snapshots: ${snaps.length}\n- graded: ${new Date().toISOString()}\n\n---\n\n`;
  writeFileSync(outPath, header + report + "\n");
  process.stdout.write(outPath + "\n");
}
