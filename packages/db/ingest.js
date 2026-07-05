// Derived ingest — pulls the facts git + gh already know into the ledger for free, so the
// timeline is grounded without anyone reporting them. Deliberately lean: it syncs the
// #-glossary (issue number -> human title) and clear PR-merge milestones. Per-commit
// build narration is left to the observer, which is more digestible than raw WIP commits.

import { execFileSync } from "node:child_process";
import * as S from "./store.js";

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

// Sync the issue glossary from GitHub. Returns count, or null if gh is unavailable.
export function syncGlossary(db, repo, { limit = 200 } = {}) {
  const issues = ghJson(
    ["issue", "list", "--state", "all", "--limit", String(limit), "--json", "number,title"],
    repo.root
  );
  if (!issues) return null;
  let n = 0;
  for (const i of issues) {
    S.setIssueTitle(db, repo.id, i.number, i.title);
    n++;
  }
  return n;
}

// The first issue number encoded in a branch name (feat/41-x, issue-32-y → 41, 32).
function branchIssue(branch) {
  const m = /(\d+)/.exec(branch || "");
  return m ? Number(m[1]) : null;
}

// Record merged PRs as `merged` milestone events, threaded under their issue. `skipPRs`
// holds PR numbers already represented by a squash commit on main, so we don't double-count.
export function syncMergedPRs(db, repo, { limit = 100, skipPRs = new Set() } = {}) {
  const prs = ghJson(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      String(limit),
      "--json",
      "number,title,mergedAt,headRefName",
    ],
    repo.root
  );
  if (!prs) return null;
  let n = 0;
  for (const pr of prs) {
    if (skipPRs.has(pr.number)) continue;
    const refs = { pr: pr.number, branch: pr.headRefName };
    const issue = branchIssue(pr.headRefName);
    let threadId = null;
    if (issue) {
      refs.issue = issue;
      const t = db
        .prepare("SELECT title FROM issue_titles WHERE repo_id = ? AND number = ?")
        .get(repo.id, issue);
      threadId = S.resolveThread(db, repo.id, t ? t.title : `#${issue}`);
    }
    const id = S.logEvent(db, repo.id, {
      threadId,
      type: "merged",
      summary: pr.title,
      refs,
      source: "derived",
      ts: pr.mergedAt || null,
      dedupeKey: `pr:${pr.number}`,
    });
    if (id) n++;
  }
  return n;
}

// Map a conventional-commit type prefix to a ledger event type.
const CC_TYPE = {
  feat: "built",
  fix: "built",
  perf: "built",
  refactor: "built",
  build: "built",
  revert: "built",
  test: "tested",
  docs: "note",
  chore: "note",
  style: "note",
  ci: "note",
};

// Parse a commit subject into {type, summary, issue, pr}. Convention (GitHub squash):
//   feat(#41): execution layer + coach-API slimming (#43) (#47)
//   └ type  └ issue (in scope)                            └ PR (final trailing ref)
// So the issue is the scope number (or, lacking a scope, the first inline #N after dropping
// the final trailing (#N) PR artifact); the PR is that final trailing ref.
export function parseCommitSubject(subject) {
  const prMatch = subject.match(/\(#(\d+)\)\s*$/);
  const pr = prMatch ? Number(prMatch[1]) : null;
  const cc = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/);
  let type = "built";
  let scope = null;
  let rest = subject;
  if (cc) {
    type = CC_TYPE[cc[1].toLowerCase()] || "built";
    scope = cc[2];
    rest = cc[4];
  }
  let issue = null;
  const scopeNum = scope && scope.match(/#?(\d+)/);
  if (scopeNum) issue = Number(scopeNum[1]);
  else {
    // No scope issue — take the first inline #N after removing the trailing PR ref.
    const im = subject.replace(/\s*\(#\d+\)\s*$/, "").match(/#(\d+)/);
    if (im) issue = Number(im[1]);
  }
  // Clean the summary: human scope (e.g. "coach") as a lead-in, and drop trailing PR refs.
  let summary = scope && !/^#?\d+$/.test(scope) ? `${scope}: ${rest}` : rest;
  summary = summary.replace(/(\s*\(#\d+\))+\s*$/, "").trim();
  return { type, summary: summary || subject, issue, pr };
}

// Backfill the timeline from git history. Conventional-commit subjects become typed events
// threaded under the issue they reference. Idempotent via commit:<sha>. Deterministic and
// free — no Haiku, no network.
export function backfillCommits(db, repo, { limit = 500, all = false } = {}) {
  const sep = "\x1f";
  const range = all ? ["--all"] : [];
  const out = sh(
    "git",
    ["log", ...range, "--no-merges", `--pretty=format:%H${sep}%aI${sep}%s`, "-n", String(limit)],
    repo.root
  );
  if (out == null) return { count: 0, prNumbers: new Set() };
  let count = 0;
  const prNumbers = new Set(); // PRs represented by a squash commit — dedupe against gh PRs
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [sha, iso, subject = ""] = line.split(sep);
    const { type, summary, issue, pr } = parseCommitSubject(subject);
    if (pr) prNumbers.add(pr);
    // Thread under the issue's human title when we know it; else leave unthreaded.
    let threadId = null;
    if (issue) {
      const t = db
        .prepare("SELECT title FROM issue_titles WHERE repo_id = ? AND number = ?")
        .get(repo.id, issue);
      threadId = S.resolveThread(db, repo.id, t ? t.title : `#${issue}`);
    }
    const refs = { commit: sha };
    if (issue) refs.issue = issue;
    if (pr) refs.pr = pr;
    const id = S.logEvent(db, repo.id, {
      threadId,
      type,
      summary,
      refs,
      source: "derived",
      ts: iso,
      dedupeKey: `commit:${sha}`,
    });
    if (id) count++;
  }
  return { count, prNumbers };
}

export function ingest(db, repo, opts = {}) {
  // Glossary first (so commits/PRs thread under real issue titles), then commits (the
  // backbone), then PRs — skipping any PR already represented by a squash commit.
  const glossary = syncGlossary(db, repo, opts);
  const cb = opts.commits === false ? { count: 0, prNumbers: new Set() } : backfillCommits(db, repo, opts);
  const merged = syncMergedPRs(db, repo, { ...opts, skipPRs: cb.prNumbers });
  return {
    glossary,
    commits: cb.count,
    merged,
    ghAvailable: glossary !== null || merged !== null,
  };
}
