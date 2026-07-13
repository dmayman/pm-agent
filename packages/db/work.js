// Work model — the layer the user actually cares about: not individual commits, but the
// lifecycle of each unit of work (did a branch open, get committed to, and merge & close —
// or is it still open and unfinished?).
//
//   sync issue state (gh) + open branches (git) → per-issue status
//
// Grouping into initiatives is NOT done here: an initiative is a live-captured goal
// (seeded by Claude / the observer), and issues attach to it incrementally via the
// pin/link mechanics in store.js — never by a batch re-clustering pass.

import * as S from "./store.js";
import { sh, ghJson, branchIssue } from "./util.js";

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

// Backfill + refresh branch/PR → initiative refs (#39). Two deterministic, network-free passes:
//   1) BACKFILL — mirror branch/pr refs from every threaded event into thread_refs, so existing
//      ledgers (and the derived-ingest path, which the observer bridge doesn't cover) attribute
//      too, not just captures made after this shipped. Idempotent.
//   2) MERGED — a branch/pr is "landed" if the ledger holds ANY merged-type event carrying that
//      same branch or pr (derived ingest writes one per merged PR, with its headRefName branch).
//      Merged-ness is a global property of the branch/pr, so a merged event on a DIFFERENT thread
//      still counts. Reuses data already ingested — no extra gh call.
// Returns the set of thread ids whose merged flags changed (for re-synthesis).
export function refreshThreadRefs(db, repo) {
  // 1) Backfill associations from event refs.
  const rows = db
    .prepare(
      `SELECT thread_id,
              json_extract(refs, '$.branch') AS branch,
              json_extract(refs, '$.pr')     AS pr
         FROM events
        WHERE repo_id = ? AND thread_id IS NOT NULL
          AND (json_extract(refs, '$.branch') IS NOT NULL OR json_extract(refs, '$.pr') IS NOT NULL)`
    )
    .all(repo.id);
  for (const r of rows) {
    if (r.branch) S.linkRefToThread(db, repo.id, r.thread_id, "branch", r.branch);
    if (r.pr != null && r.pr !== "" && r.pr !== 0) S.linkRefToThread(db, repo.id, r.thread_id, "pr", r.pr);
  }
  // 2) Derive the merged flag from merged-type events.
  const mergedBranch = db.prepare(
    `SELECT 1 FROM events WHERE repo_id = ? AND type = 'merged' AND json_extract(refs, '$.branch') = ? LIMIT 1`
  );
  const mergedPr = db.prepare(
    `SELECT 1 FROM events WHERE repo_id = ? AND type = 'merged' AND json_extract(refs, '$.pr') = ? LIMIT 1`
  );
  const changed = new Set();
  for (const ref of S.listThreadRefs(db, repo.id)) {
    const landed =
      ref.kind === "pr"
        ? !!mergedPr.get(repo.id, Number(ref.value))
        : !!mergedBranch.get(repo.id, ref.value);
    if (landed && !ref.merged && S.setThreadRefMerged(db, repo.id, ref.thread_id, ref.kind, ref.value, 1)) {
      changed.add(ref.thread_id);
    }
  }
  return changed;
}

// Days a goal-first thread must be quiet (no new events) before a branch-merged signal is
// allowed to auto-complete it — the deterministic stand-in for "the distiller/synthesis went
// quiet and the user moved on". Deliberately long so live work is never closed out from under.
const ZERO_ISSUE_QUIET_DAYS = 14;

// Deterministic initiative done-detection, deliberately conservative. Two paths:
//   • ISSUE-BACKED — an ACTIVE thread with ≥1 linked issue flips when ALL its issues are closed
//     and none has an open (unmerged) branch (the clean finish).
//   • GOAL-FIRST (zero linked issues, #39) — lifecycle used to never touch these; now, if its
//     branch/PR refs show at least one MERGED ref and NO still-open (unmerged) ref, AND the
//     thread has gone quiet for ZERO_ISSUE_QUIET_DAYS, it flips too. The quiet gate is what keeps
//     this safe: a live goal-first thread (recent events) is never auto-closed — that stays the
//     distiller's `completed` call.
// Only 'active' threads flip, so a reopened/blocked/in_review thread is left alone. Returns the
// set of thread ids flipped (for re-synthesis).
export function autoCompleteThreads(db, repo, { quietDays = ZERO_ISSUE_QUIET_DAYS, now = Date.now() } = {}) {
  const flipped = new Set();
  for (const t of S.listThreads(db, repo.id, { status: "active" })) {
    const issues = S.issuesForThread(db, t.id);
    if (issues.length) {
      const allClosed = issues.every((i) => i.state === "CLOSED");
      const hasOpenBranch = issues.some((i) => i.branch);
      if (allClosed && !hasOpenBranch) {
        S.updateThread(db, t.id, { status: "done" });
        flipped.add(t.id);
      }
      continue;
    }
    // Zero-issue (goal-first) thread: lean on branch/PR refs, gated by the quiet window.
    const refs = S.refsForThread(db, t.id);
    if (!refs.length) continue;
    const anyMerged = refs.some((r) => r.merged);
    const anyOpen = refs.some((r) => !r.merged);
    if (!anyMerged || anyOpen) continue;
    const ageDays = t.last_event_ts
      ? (now - Date.parse(t.last_event_ts)) / 86400000
      : Infinity;
    if (ageDays < quietDays) continue;
    S.updateThread(db, t.id, { status: "done" });
    flipped.add(t.id);
  }
  return flipped;
}

// The deterministic git/GitHub refresh: re-pull issue state + open branches and recompute
// lifecycle (per-issue statuses, then initiative-level done-detection on top). No Haiku —
// cheap enough to run silently on a heartbeat. Returns { changedThreads, ghAvailable }.
export function refreshLifecycle(db, repo) {
  const issues = syncIssues(db, repo); // open/closed state (null if gh unavailable)
  syncOpenBranches(db, repo); // unfinished-branch marks (uses merged-PR exclusion)
  const changedThreads = computeStatuses(db, repo);
  // Attribute goal-first threads' branches/PRs and derive their merged flags (#39) BEFORE
  // done-detection, so a merged-branch signal can auto-complete a zero-issue thread.
  for (const id of refreshThreadRefs(db, repo)) changedThreads.add(id);
  for (const id of autoCompleteThreads(db, repo)) changedThreads.add(id);
  return { changedThreads, ghAvailable: issues !== null };
}

// Roll up a thread's issue lifecycle into a status summary for the UI.
export function threadWorkStatus(db, threadId) {
  const issues = S.issuesForThread(db, threadId);
  const by = (s) => issues.filter((i) => i.status === s);
  const inProgress = by("in_progress");
  const shipped = by("shipped");
  // Branch/PR refs (#39): the attribution for goal-first threads that carry no issue. Surfaced
  // so the UI lifecycle bar isn't empty for them; `openRefs`/`mergedRefs` are the fold-in counts
  // the bar uses ONLY when there are no issues (issue-backed threads keep their existing bar).
  const refs = S.refsForThread(db, threadId);
  const mergedRefs = refs.filter((r) => r.merged);
  const openRefs = refs.filter((r) => !r.merged);
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
    refs,
    mergedRefs: mergedRefs.length,
    openRefs: openRefs.length,
  };
}
