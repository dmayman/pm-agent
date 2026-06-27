---
description: Start a coding session on a ready issue — pull it from GitHub, set up its branch, claim it (status:in-progress), and load the handoff protocol. Stays a coding session.
argument-hint: "<issue-number | project/area, or empty to take the top of the ready queue>"
---

You're starting a unit of work. You are — and remain — the coding agent for this session.
Do NOT adopt the PM role and do NOT spawn the PM subagent. This command just bootstraps you
from an issue the PM already queued, so you can start building with minimal ceremony.

**Pick the issue:**
- If the arguments name an issue number, that's the one.
- If they name a milestone or area (e.g. "ios"), take the top issue in that group's ready
  queue — labeled `status:ready`, highest priority / earliest in the PM's sequence.
- If empty, take the top `status:ready` issue overall (`gh issue list --label status:ready`).
  If that's genuinely ambiguous across multiple areas, ask me which.

**Read the issue fully from GitHub** (`gh issue view <n> --comments`) — Goal, Problem,
Context, Scope, Constraints & gotchas, Branch/worktree, Acceptance, and the Done &
handoff-back protocol. This is your spec; pull it into your context now so you don't
round-trip back to GitHub mid-build.

**Before writing any code:**
1. **Collision check (cheap).** The PM sequenced the queue so working top-down is safe, but
   glance at what's already `status:in-progress` (`gh issue list --label status:in-progress`).
   Two *distinct* hazards — don't conflate them:
   - **Branch contention** — another live session is mid-work in the repo-root working tree.
     This is NOT a blocker: step 2 puts you in a dedicated worktree so you don't fight over
     the root tree's HEAD.
   - **File overlap** — another in-flight issue edits the same files this issue will touch.
     A worktree does **not** make this safe (you'd just merge-conflict at the end). If you
     see genuine file overlap, STOP and flag it — tell me to confirm with the PM
     (`/pm:start` in a separate, concurrent session — not this one) before proceeding.
     Overlapping issues serialize even in separate worktrees.
2. **Set up the branch — in the root tree if it's free, otherwise in a dedicated worktree.**
   **One branch per issue**, named `issue-<n>-<slug>`. (GitHub will suggest a `<n>-<slug>`
   branch from the issue; the `issue-` prefix just keeps these greppable — match whatever
   `pm-memory.md` records if it sets a different convention.) Decide where it lives:
   - If a worktree for this branch already exists (`git worktree list`), work from there.
   - Else if the repo-root tree is **free** — HEAD on `main` and `git status --porcelain`
     empty — create/check out the branch there from the base the issue names (default
     `origin/main`), as usual.
   - Else the root tree is **occupied** by another live session (HEAD on another branch, or
     dirty): do NOT check out over it — that's the collision you reported. Create a worktree
     and run the rest of this session from it:
     `git worktree add ../<repo>-worktrees/issue-<n>-<slug> -b issue-<n>-<slug> origin/main`
     Make that directory your working dir for everything below, and tell me which path you're
     in so I know where this session lives.

   Never work on `main` or commit feature work off this branch.
3. **Claim the issue:** add the `status:in-progress` label and remove `status:ready`
   (`gh issue edit <n> --add-label status:in-progress --remove-label status:ready`) so the
   concurrency map reflects that it's taken. This is a mechanical claim, not grooming —
   leave scope and grooming to the PM; just flip the label.

If the issue isn't actually *groomed* — missing scope/acceptance, can't be built from the
issue alone — don't paper over it: say so and suggest I run `/pm:start` in a separate,
concurrent session (not this one) to groom it first.
Status alone is not that gap: a groomed issue merely sitting at `status:backlog` is fine to
take — invoking `/pm:build` on it *is* the signal to pull it into the queue, so just promote
it (`--add-label status:in-progress --remove-label status:backlog`) and claim it (step 3),
don't flag it back to me as a process gap.

**Then build** to the issue's scope and acceptance, respecting its constraints & gotchas.
The issue is your whole unit of work: don't pick up adjacent untracked work you happen to
notice while building, even if it looks quick. If something needs doing, `/pm:capture` it so
it enters the queue — don't quietly fold it into this session. If you find yourself departing
from the issue in a way that affects other work or needs a call, run `/pm:start` in a
separate, concurrent session (not this one) to talk it through rather than expanding scope. At a natural commit boundary, run
`/pm:checkpoint <issue-number>`. When the work is complete or I've approved the acceptance, run
`/pm:done <issue-number>`.

Arguments: $ARGUMENTS
