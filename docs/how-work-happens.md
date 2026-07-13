# How work happens

This is the operating manual pm-agent teaches Claude in every repo it's installed
into. The goal: **the user carries none of the git/branch overhead.** They ask for
things; Claude knows how to carry the work across every active session as if it were
one mind — using this hygiene, plus (next) the context in the ledger.

This is v1: **branch hygiene**. It's the foundation. The ledger layers on top of it
later — the ledger tells Claude *what* is in flight and *why*; this tells Claude *how*
to move it without sessions tripping over each other.

---

## The one invariant

**`main` is always branchable** — clean, and not broken.

Everything below serves this. If at any moment you can cut a fresh branch off `main`
and start clean, the system is healthy. The whole cost of holding work *on* `main` is
that it blocks this — so `main` is only ever held briefly, for changes known to be
small.

---

## The four rules

**1. `main` is always branchable.** Clean working tree, nothing broken. This is the
state every branch returns `main` to.

**2. Depth never exceeds 1.** Branch off `main`, never off another branch. When work
on a branch reveals sub-work, that sub-work becomes a *sibling* off `main` — not a
child. At depth ≤ 1, any branch can merge to `main` *and* cross-pollinate into a
sibling (by merging `main` in) with a single flat merge. Nesting is the disease that
creates the "four interdependent branches with no end in sight" trap; depth ≤ 1 is the
cure.

**3. Merge on step-forward, not on solved.** A branch is ready to merge when it moves
`main` forward without breaking it — **even if the larger problem isn't solved.**
"Solved" is not the bar; "advances `main`, keeps it branchable" is. The unsolved
problem doesn't live in the branch — it lives in the goal, which survives across many
small merges. Prefer many small merges over one big one. It's fine to merge something
imperfect as long as it's a real step and `main` stays clean; you can go further, or
walk it back, in the next branch.

**4. Direct-to-`main` is allowed — deliberately, and briefly.** When a change is known
to be small, you may commit it straight to `main` *as an explicit choice*. The
tradeoff: while uncommitted work sits on `main`, `main` can't be cleanly branched. So
this is only for things that resolve fast. **The failsafe:** the moment it starts
getting deeper than "small," stop, branch from `main`, and move the work there.

---

## How a piece of work flows

Work begins in a Claude session on the primary worktree, as a prompt — often a
conversation, sometimes pure planning with no code yet. From there it takes one of two
shapes. Claude picks; when confidence is low, it asks.

### Quick path — small and known-small

- The change is small, low-risk, and easily reversible.
- Claude makes it, verifies it (tests / runs the affected flow), the user validates.
- Claude commits to `main`.
- If it grows past "small" — a discovery, a deficiency, scope creep — invoke the
  failsafe: branch from `main` and continue there (it just became the tracked path).

If you're mid-work on a *branch* and a small, unrelated fix occurs to you, don't let it
land on that branch. Branch it off `main` separately (a fresh worktree is cleanest),
fix it, validate, merge to `main`, get back out.

### Tracked path — anything real

- Claude defines the GitHub issue(s) in enough detail that a fresh agent could build
  them end-to-end.
- Claude creates a branch off `main` and gives it a worktree (see below). **No coding
  on `main`.** Every branch is guaranteed its own worktree space so concurrent sessions
  never collide.
- Issues are **not** 1:1 with branches. One branch can carry several issues,
  sequentially, when they share a goal and genuinely depend on each other. Use
  discretion; ask when unsure.
- Claude drives the build (directly, or by firing off agents). The user validates at
  each stopping point.
- Claude commits to the branch at smart moments, but waits for the user's validation
  before merging (overridable — the user can ask for auto-commit).
- When validation surfaces new side-work, **don't nest it.** Note it, and once the
  current branch is at a step-forward state, merge it to `main` and spin the side-work
  up as siblings off `main`.
- Merge to `main` as soon as the branch is a step-forward and `main` stays branchable.
  Then delete the branch (squash-merge; archive/delete once merged).

---

## Worked example — the pattern that keeps you out of the trap

You're improving coach responses (a hard, open-ended problem). You branch, make a
change, run a test — and the response reveals **3 gaps.** Mid-branch, you also notice
that more control in the operator UI would make this easier.

**The trap** (what not to do): create 3 sub-branches off your branch for the 3 gaps,
plus a 4th off `main` for the operator UI, all interdependent, none mergeable, no end
in sight.

**The move** (depth ≤ 1):

1. Your first change didn't *solve* coach responses — but it's a real step forward.
   **Merge it to `main`.** Now you're clean.
2. File the 3 gaps as issues. Pick them off as fresh branches **off `main`** —
   concurrently where independent, sequentially where one truly needs the last.
3. The operator-UI improvement is its own branch **off `main`**, in parallel.
4. Any of these can now merge to `main` independently. If a sibling needs another's
   change, it merges `main` in — one flat layer, no rebase hell.

The problem "coach responses aren't good enough yet" isn't lost when the branch
merges — it's held by the **goal**, which spans all of these merges. (That through-line
is where the ledger picks up.)

---

## Worktrees

- Every tracked branch gets its own worktree — this is what makes concurrent sessions
  safe.
- Worktrees are **reusable**: a worktree is a slot, not a branch. When a branch merges
  and is deleted, its worktree is freed and can host the next branch.
- Location + naming: generic numbered **siblings** of the main checkout — `../<repo>-1`,
  `../<repo>-2` (the next free number) — **never** named after the branch. This matches
  the dashboard's port-slot model (main = 0, extra trees 1, 2, …), and the dashboard's
  `+ worktree` button already creates them this way.
- Aim for **few** worktrees/branches open at once. Fewer open branches = less to keep
  in sync = fewer ways to collide.

---

## Pull requests are optional

A PR is a branch plus a server-side ceremony. For a solo dev who reviews the branch
live and merges locally, that ceremony is mostly redundant — a plain `git merge` lands
the work. So **merging locally is the default.**

Reach for a PR only when it earns its keep:

- you want CI to gate the merge, or
- you want a durable diff / discussion record, or `Fixes #N` to auto-close issues, or
- `main` is protected and a PR is the only way to land.

Otherwise, skip it.

---

## Guardrails (hold these even when it gets complicated)

- **`main` stays branchable.** Never leave it broken or half-changed for long.
- **Depth ≤ 1.** Never branch off a branch. Siblings, not children.
- **Merge on step-forward.** Small, frequent, clean merges beat big ones.
- **Don't stack dependent work before merging.** Get a step onto `main`, then build the
  next step off the updated `main`. It's fine for `main` to be imperfect — it just has
  to move forward and stay clean.
- **Small unrelated fixes don't ride on unrelated branches.** Sibling them off `main`.
- **Clean up.** Squash-merge; delete branches once merged; free their worktrees.
- The work of multiple concurrent agent sessions interfering is unacceptable. These
  rules exist to guarantee it can't happen.

---

## The contract (injected into every session)

pm-agent's SessionStart hook injects a short condensation of this doc into every
consuming Claude Code session (via `pm-agent context`). The text between the markers
below is that condensation, verbatim — **this doc is the single source of truth.**
`scripts/sync-session-contract.mjs` extracts it into the generated module
`packages/db/session-contract.js` (which `pm-agent context` imports). Edit it here,
then run `npm run sync:contract`; `npm test` fails while the two drift.

<!-- session-contract:start -->
Branch hygiene (own it silently, across all sessions of this repo): `main` is always
branchable — clean, not broken. Depth never exceeds 1: branch off `main`, never off
another branch; when work reveals sub-work, sibling it off `main` — don't nest. Merge
on step-forward, not on solved: a branch merges once it advances `main` without
breaking it, even if the larger problem isn't solved; prefer many small merges.
Direct-to-`main` is allowed deliberately and briefly for known-small changes — the
moment it grows past small, branch from `main` and move the work there.

Every tracked branch gets its own worktree — that's what keeps concurrent sessions
from colliding. Worktrees are reusable numbered siblings of the main checkout —
`../<repo>-1`, `../<repo>-2` (the next free number), never named after the branch.
When a branch is done: squash-merge, delete it, free its worktree.
<!-- session-contract:end -->
