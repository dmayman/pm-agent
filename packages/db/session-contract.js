// GENERATED FILE — DO NOT EDIT.
// Source: the session-contract section of docs/how-work-happens.md.
// Regenerate with `npm run sync:contract` (scripts/sync-session-contract.mjs);
// packages/db/contract.sync.test.js fails `npm test` while this file drifts
// from the doc.

export const branchHygieneContract = [
  "Branch hygiene (own it silently, across all sessions of this repo): `main` is always branchable — clean, not broken. Depth never exceeds 1: branch off `main`, never off another branch; when work reveals sub-work, sibling it off `main` — don't nest. Merge on step-forward, not on solved: a branch merges once it advances `main` without breaking it, even if the larger problem isn't solved; prefer many small merges. Direct-to-`main` is allowed deliberately and briefly for known-small changes — the moment it grows past small, branch from `main` and move the work there.",
  "Every tracked branch gets its own worktree — that's what keeps concurrent sessions from colliding. Worktrees are reusable numbered siblings of the main checkout — `../<repo>-1`, `../<repo>-2` (the next free number), never named after the branch. When a branch is done: squash-merge, delete it, free its worktree.",
];
