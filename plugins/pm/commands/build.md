---
description: Start a coding session on a ready ticket — pull it from Linear, set up its branch, claim it (In Progress), and load the handoff protocol. Stays a coding session.
argument-hint: "<issue-id | project/area, or empty to take the top of the ready queue>"
---

You're starting a unit of work. You are — and remain — the coding agent for this session.
Do NOT adopt the PM role and do NOT spawn the PM subagent. This command just bootstraps you
from a ticket the PM already queued, so you can start building with minimal ceremony.

**Pick the issue:**
- If the arguments name an issue ID, that's the one.
- If they name a project or area (e.g. "ios"), take the top issue in that project's ready
  queue — the team's ready state (Todo, or a dedicated "Up Next"/"Ready"), highest priority
  / earliest in the PM's sequence.
- If empty, take the top ready issue overall. If that's genuinely ambiguous across multiple
  projects, ask me which.

**Read the ticket fully from Linear** — Goal, Problem, Context, Scope, Constraints &
gotchas, Branch/worktree, Acceptance, and the Done & handoff-back protocol. This is your
spec; pull it into your context now so you don't round-trip back to Linear mid-build.

**Before writing any code:**
1. **Collision check (cheap).** The PM sequenced the queue so working top-down is safe, but
   glance at what's already In Progress. Two *distinct* hazards — don't conflate them:
   - **Branch contention** — another live session is mid-work in the repo-root working tree.
     This is NOT a blocker: step 2 puts you in a dedicated worktree so you don't fight over
     the root tree's HEAD.
   - **File overlap** — another in-flight issue edits the same files this ticket will touch.
     A worktree does **not** make this safe (you'd just merge-conflict at the end). If you
     see genuine file overlap, STOP and flag it — tell me to confirm with the PM
     (`/pm:start`) before proceeding. Overlapping tickets serialize even in separate worktrees.
2. **Set up the branch — in the root tree if it's free, otherwise in a dedicated worktree.**
   **One branch per ticket**, named `fx-<n>-<slug>` (no owner/handle prefix) — ignore Linear's
   auto-suggested `gitBranchName`, which prefixes the creator handle. Decide where it lives:
   - If a worktree for this branch already exists (`git worktree list`), work from there.
   - Else if the repo-root tree is **free** — HEAD on `main` and `git status --porcelain`
     empty — create/check out the branch there from the base the ticket names (default
     `origin/main`), as usual.
   - Else the root tree is **occupied** by another live session (HEAD on another branch, or
     dirty): do NOT check out over it — that's the collision you reported. Create a worktree
     and run the rest of this session from it:
     `git worktree add ../fauxnos-worktrees/fx-<n>-<slug> -b fx-<n>-<slug> origin/main`
     Make that directory your working dir for everything below, and tell me which path you're
     in so I know where this session lives.

   Never work on `main` or commit feature work off this branch.
3. **Claim the issue:** set its status to **In Progress** so the concurrency map reflects
   that it's taken. This is a mechanical claim, not grooming — leave scope and grooming to
   the PM; just flip the status.

If the ticket isn't actually ready (missing scope/acceptance, or it's still in Backlog),
don't paper over it — say so and suggest I run `/pm:start` to groom and queue it first.

**Then build** to the ticket's scope and acceptance, respecting its constraints & gotchas.
If you find yourself departing from the ticket in a way that affects other work or needs a
call, run `/pm:start` to talk it through rather than quietly expanding scope. At a natural
commit boundary, run `/pm:checkpoint <issue-id>`. When the work is complete or I've approved
the acceptance, run `/pm:done <issue-id>`.

Arguments: $ARGUMENTS
