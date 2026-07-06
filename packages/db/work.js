// Work model — the layer the user actually cares about: not individual commits, but the
// lifecycle of each unit of work (did a branch open, get committed to, and merge & close —
// or is it still open and unfinished?), and how related issues group into one root idea.
//
//   sync issue state (gh) + open branches (git) → per-issue status
//   cluster issues into initiatives (Haiku)      → thread = root idea
//   re-thread the commit/PR events by initiative → evidence under the story

import { execFileSync } from "node:child_process";
import * as S from "./store.js";
import { runHaiku } from "./haiku.js";

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
function ghJson(args, cwd) {
  const out = sh("gh", args, cwd);
  if (out == null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const branchIssue = (b) => {
  const m = /(\d+)/.exec(b || "");
  return m ? Number(m[1]) : null;
};

// Pull issue identity + state from gh. Returns count or null when gh is unavailable.
export function syncIssues(db, repo, { limit = 300 } = {}) {
  const issues = ghJson(
    ["issue", "list", "--state", "all", "--limit", String(limit), "--json", "number,title,state,createdAt,closedAt"],
    repo.root
  );
  if (!issues) return null;
  for (const i of issues) {
    S.upsertIssue(db, repo.id, {
      number: i.number,
      title: i.title,
      state: i.state, // OPEN | CLOSED
      opened_at: i.createdAt || null,
      closed_at: i.closedAt || null,
    });
  }
  return issues.length;
}

// Find branches with unmerged work (a branch opened for an issue that never merged into the
// default branch) and record them on their issue — this is what "unfinished" means.
export function syncOpenBranches(db, repo) {
  // Clear stale branch marks first, then re-mark from live unmerged branches.
  for (const iss of S.listIssues(db, repo.id)) {
    if (iss.branch) S.setIssueFields(db, repo.id, iss.number, { branch: null });
  }
  // GitHub knows a branch merged even when git ancestry doesn't: a squash-merge lands the
  // branch's work as one NEW commit on main, so the branch's own commits are never ancestors
  // and `git branch --no-merged` still lists it. Trust the merged-PR record to exclude those
  // stale-but-merged branches (otherwise they masquerade as loose threads). See feat/48.
  const mergedPrs = ghJson(
    ["pr", "list", "--state", "merged", "--limit", "200", "--json", "headRefName"],
    repo.root
  );
  const mergedBranches = new Set((mergedPrs || []).map((p) => p.headRefName));

  // Prefer origin's default branch as the merge base.
  const base =
    (sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], repo.root) || "")
      .trim()
      .replace(/^refs\/remotes\//, "") || "origin/main";
  const out = sh("git", ["branch", "-r", "--no-merged", base], repo.root);
  if (out == null) return 0;
  let n = 0;
  for (let line of out.split("\n")) {
    line = line.trim();
    if (!line || line.includes("->") || line.endsWith("/HEAD")) continue;
    const short = line.replace(/^origin\//, "");
    if (short === "main" || short === "master") continue;
    if (mergedBranches.has(short)) continue; // squash-merged: content is in main, not a loose end
    const issue = branchIssue(short);
    if (issue) {
      S.setIssueFields(db, repo.id, issue, { branch: short });
      n++;
    }
  }
  return n;
}

// Derive each issue's status from its lifecycle:
//   done        — issue closed (branch → commits → merged & closed, the clean finish)
//   in_progress — open, with an unmerged branch (started but unfinished — a loose thread)
//   shipped     — open, but its work already merged (a different loose end: never closed)
//   todo        — open, no work started
// Returns the set of thread ids whose issues changed status (so callers can re-synthesize
// exactly the affected thread summaries — the "what's next" line depends on these).
export function computeStatuses(db, repo) {
  const hasMerged = db.prepare(
    `SELECT COUNT(*) c FROM events
       WHERE repo_id = ? AND json_extract(refs, '$.issue') = ?
         AND (type = 'merged' OR json_extract(refs, '$.pr') IS NOT NULL)`
  );
  const changedThreads = new Set();
  for (const iss of S.listIssues(db, repo.id)) {
    let status;
    if (iss.state === "CLOSED") status = "done";
    else if (iss.branch) status = "in_progress";
    else if (hasMerged.get(repo.id, iss.number).c > 0) status = "shipped";
    else status = "todo";
    if (status !== iss.status) {
      if (iss.thread_id) changedThreads.add(iss.thread_id);
      S.setIssueFields(db, repo.id, iss.number, { status });
    }
  }
  return changedThreads;
}

// The deterministic git/GitHub refresh: re-pull issue state + open branches and recompute
// lifecycle. No Haiku, no clustering — cheap enough to run silently on a heartbeat. Returns
// { changedThreads, ghAvailable }. clusterIntoInitiatives is deliberately NOT called here:
// re-grouping is a heavier, less frequent operation left to `ingest`/`recluster`.
export function refreshLifecycle(db, repo) {
  const issues = syncIssues(db, repo); // open/closed state (null if gh unavailable)
  syncOpenBranches(db, repo); // unfinished-branch marks (uses merged-PR exclusion)
  const changedThreads = computeStatuses(db, repo);
  return { changedThreads, ghAvailable: issues !== null };
}

// Cluster issues into initiatives with Haiku, then rebuild threads so each thread is one
// initiative (root idea) and its issues' commit/PR events hang under it.
export async function clusterIntoInitiatives(db, repo) {
  const issues = S.listIssues(db, repo.id).filter((i) => i.title);
  if (!issues.length) return 0;

  const list = issues.map((i) => `#${i.number} ${i.title}`).join("\n");
  const prompt =
    `Below is a list of GitHub issues from one project. Group them into "initiatives" — a ` +
    `small number of higher-level root ideas or feature arcs that several issues share (e.g. ` +
    `"data ingest pipeline", "the plan model", "coach behavior"). Every issue goes in exactly ` +
    `one initiative. Aim for a handful of meaningful groups, not one giant bucket and not one ` +
    `per issue. Give each initiative a short, human name (not an issue title).\n\n` +
    `Issues:\n${list}\n\n` +
    `Return ONLY a JSON array: [{"initiative":"<name>","issues":[<numbers>]}]`;

  const out = runHaiku(prompt, repo.root, { timeout: 90000, meter: { db, repoId: repo.id, kind: "cluster" } });
  if (!out) return 0;
  let groups;
  try {
    const s = out.indexOf("[");
    const e = out.lastIndexOf("]");
    groups = JSON.parse(out.slice(s, e + 1));
  } catch {
    return 0;
  }
  if (!Array.isArray(groups) || !groups.length) return 0;

  // Rebuild: detach everything, create initiative threads, reattach issues + their events.
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE issue_titles SET thread_id = NULL WHERE repo_id = ?").run(repo.id);
    db.prepare("UPDATE events SET thread_id = NULL WHERE repo_id = ?").run(repo.id);
    for (const g of groups) {
      if (!g || !g.initiative || !Array.isArray(g.issues) || !g.issues.length) continue;
      const threadId = S.createThread(db, repo.id, { title: String(g.initiative) });
      for (const num of g.issues) {
        S.setIssueFields(db, repo.id, Number(num), { thread_id: threadId });
        db.prepare(
          "UPDATE events SET thread_id = ? WHERE repo_id = ? AND json_extract(refs, '$.issue') = ?"
        ).run(threadId, repo.id, Number(num));
      }
    }
    // Drop threads that ended up with no issues and no events (the old per-issue buckets).
    db.prepare(
      `DELETE FROM threads WHERE repo_id = ?
         AND id NOT IN (SELECT thread_id FROM issue_titles WHERE thread_id IS NOT NULL)
         AND id NOT IN (SELECT thread_id FROM events WHERE thread_id IS NOT NULL)`
    ).run(repo.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return groups.length;
}

// Roll up a thread's issue lifecycle into a status summary for the UI.
export function threadWorkStatus(db, threadId) {
  const issues = S.issuesForThread(db, threadId);
  const by = (s) => issues.filter((i) => i.status === s);
  const inProgress = by("in_progress");
  const shipped = by("shipped");
  return {
    total: issues.length,
    done: by("done").length,
    shipped: shipped.length,
    todo: by("todo").length,
    inProgress: inProgress.length,
    // The loose ends: started-but-unmerged branches, plus merged-but-never-closed issues.
    unfinished: [...inProgress, ...shipped].map((i) => ({
      number: i.number,
      title: i.title,
      status: i.status,
      branch: i.branch,
    })),
  };
}
