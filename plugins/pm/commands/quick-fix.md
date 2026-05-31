---
description: Run the whole pipeline for a small fix in one session — file the ticket, branch off main in an isolated worktree, build it, then validate and close out back to main. Safe to fire while other work is in flight. Stays a coding session.
argument-hint: "<the small fix to knock out now>"
---

You want to knock out a small, self-contained fix and have it fully tracked — without
derailing whatever else is in flight. This command runs the entire pipeline in one session:
file the ticket, branch off `main` in an isolated worktree, build the fix, then hand you a
way to validate it and close out cleanly back to `main`. You are — and remain — the coding
agent. Do NOT adopt the PM role.

It is the full pipeline (capture → build → done) collapsed into a single chat. The key
property: it works **off `main` in its own worktree**, so it does NOT touch the branch or
working tree of any session that is mid-flight. Fire it precisely *because* you are mid-branch
on something else and want this fix handled cleanly on the side — it stays isolated, and at
the end you are back on `main` with the work tracked and ticketed.

Where it fits in the family: `/pm:capture` files a one-liner for later; `/pm:build` builds a
ticket the PM already groomed and queued; `/pm:branch` retroactively tickets work already in
your tree. `/pm:quick-fix` is the do-it-now-and-close-it-out path for a small fix.

**1. File the ticket via the PM, capture-mode, foreground.** Spawn the PM as a subagent (Agent
   tool, `subagent_type: "pm"`) in the **foreground** — you need the issue ID before you can
   branch. Tell it: capture mode, stay lean (read `.claude/pm-memory.md`, single targeted
   duplicate search, no board sweep), pick the right team/project with sensible priority and
   labels. Give it the fix (below) and the real files/area you expect to touch. Have it report
   the issue ID, placement, and any suspected duplicate. If it surfaces a strong duplicate,
   relay it and pause before building; otherwise keep moving — don't groom, this is a quick fix.

**2. Branch off `main`, in its own worktree.** Always branch from the base (`origin/main`),
   NOT from whatever HEAD happens to be — the point is a clean, independent fix even though
   other work is in flight. One branch per ticket, named `fx-<n>-<slug>` from the returned
   issue ID (ignore Linear's `gitBranchName` with its creator-handle prefix). Create a
   dedicated worktree so this never disturbs an in-flight session's tree (path per the
   worktree convention in `.claude/pm-memory.md`):

   `git worktree add <worktree-path>/fx-<n>-<slug> -b fx-<n>-<slug> origin/main`

   Make that directory your working dir for everything below and tell the user which path the
   fix lives in. (Only if the repo-root tree is genuinely free — clean and on `main` — may you
   skip the worktree and `git checkout -b` there instead.)

**3. Claim it:** set the issue to **In Progress** — a mechanical status flip, not grooming.

**4. Build the fix.** Implement it to the one-liner's intent, in the worktree. It is meant to
   be small — if it turns out NOT to be (spans unrelated areas, needs a real design call, or
   touches files an in-flight ticket owns), STOP and run `/pm:plan` rather than letting a
   quick-fix sprawl into something that should have been scoped.

**5. Hand it back for validation.** Give the user a concrete way to check the fix — for UI
   work, follow the REVIEW HANDOFF protocol (start a dev server, hand over a live link); for
   other work, say how to run or exercise it — and report what changed. Then wait for the user
   to validate. At a commit boundary before validation, `/pm:checkpoint <issue-id>` works as
   usual.

**6. Close out and get back to `main`.** Once the user validates, run `/pm:done <issue-id>` —
   the PM merges the branch into `main`, deletes it, removes the worktree, and sets the issue
   Done. That is the "get out and back onto `main`, fully tracked" step. Do NOT self-merge or
   close issues yourself.

Quick fix: $ARGUMENTS
