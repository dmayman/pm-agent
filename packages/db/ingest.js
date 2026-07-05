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

// Record merged PRs as `merged` milestone events (idempotent via dedupe_key).
export function syncMergedPRs(db, repo, { limit = 100 } = {}) {
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
    const refs = { pr: pr.number, branch: pr.headRefName };
    // Link to an issue if the branch encodes one (issue-<n>-slug) — powers the timeline tag.
    const m = /(?:issue[-_]?)(\d+)/i.exec(pr.headRefName || "");
    if (m) refs.issue = Number(m[1]);
    const id = S.logEvent(db, repo.id, {
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

export function ingest(db, repo, opts = {}) {
  const glossary = syncGlossary(db, repo, opts);
  const merged = syncMergedPRs(db, repo, opts);
  return { glossary, merged, ghAvailable: glossary !== null || merged !== null };
}
