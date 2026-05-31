---
description: Start a coding session from a one-line idea — file the ticket, set up its branch/worktree, claim it (In Progress), then build it right away. Stays a coding session.
argument-hint: "<the one-line fix to do right now>"
---

You have a small, clear unit of work — one line — and you want to do it *now*, not route it
through the PM queue and pick it up later. This command files the ticket, sets up its branch
(or worktree), claims it In Progress, and then you build it straight away — no waiting. You
are — and remain — the coding agent. Do NOT adopt the PM role.

Where it fits in the family: `/pm:capture` files a one-liner and leaves it for later;
`/pm:build` builds a ticket the PM already groomed and queued; `/pm:branch` retroactively
tickets work already in your tree. `/pm:quick-fix` is the do-it-now path: idea → ticket →
branch → build, in one shot.

**1. Confirm this is a fresh start.** Run `git status --porcelain` and `git branch --show-current`.
   - Clean tree on `main` (or the base branch): good, proceed.
   - You already have uncommitted work, or you're on an `fx-<n>-*` branch: this isn't a fresh
     quick-fix. If stray work needs a ticket, that's `/pm:branch`; if you're mid-ticket, just
     keep going. Say which and stop.

**2. File the ticket via the PM, capture-mode, foreground.** Spawn the PM as a subagent (Agent
   tool, `subagent_type: "pm"`) in the **foreground** — you need the issue ID before you can
   branch. Tell it: capture mode, stay lean (read `.claude/pm-memory.md`, single targeted
   duplicate search, no board sweep), pick the right team/project with sensible priority and
   labels. Give it the one-liner (below) and the real files/area you expect to touch. Have it
   report back the issue ID, placement, and any suspected duplicate. If it surfaces a strong
   duplicate, relay it and pause before building; otherwise keep moving — don't groom, this is
   a quick fix.

**3. Set up the branch — root tree if free, else a worktree.** One branch per ticket, named
   `fx-<n>-<slug>` from the returned issue ID (ignore Linear's `gitBranchName` with its
   creator-handle prefix).
   - Root tree free (HEAD on the base, `git status --porcelain` empty) → `git checkout -b
     fx-<n>-<slug>` from the base the ticket names (default `origin/main`).
   - Root tree occupied by another live session → create a worktree off the base and run the
     rest of this session from it; tell the user which path you're now in.

   Never build on `main` or commit feature work off this branch.

**4. Claim it:** set the issue to **In Progress** — a mechanical status flip, not grooming.

**5. Build it now.** Implement the fix to the one-liner's intent. It's deliberately small — if
   partway in it turns out NOT to be small (spans unrelated areas, needs a real design call, or
   touches files another in-flight ticket owns), STOP and run `/pm:plan` rather than quietly
   growing the quick-fix into something that should have been scoped.

**6. Hand back when done.** When the work is complete or the user approves it, run
   `/pm:done <issue-id>` so the PM reconciles and closes — do NOT self-merge or close issues
   yourself. At a commit boundary before then, `/pm:checkpoint <issue-id>` works as usual.

Quick fix: $ARGUMENTS
