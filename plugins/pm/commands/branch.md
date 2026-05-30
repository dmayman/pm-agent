---
description: Formalize in-flight work that has no ticket yet — file the ticket, move your uncommitted changes onto a proper ticket branch, and claim it, without losing work and without committing. Stays a coding session.
argument-hint: "[one-line description of the work, or empty to infer from the diff]"
---

You started coding before there was a ticket or branch, and now this in-flight work needs
to be put on rails — retroactively. This command files the ticket, moves your uncommitted
work onto a proper ticket branch, and claims it, WITHOUT losing changes and WITHOUT making
you commit. You are — and remain — the coding agent. Do NOT adopt the PM role.

This is the missing middle of the family: `/pm:capture` files a ticket but never touches
your tree; `/pm:build` sets up a branch but assumes a ready ticket already exists. Use
`/pm:branch` when the work already exists in your tree, there's no ticket yet, and you're
mid-flow.

**1. Confirm there's actually stray work to formalize.** Run `git status --porcelain` and
   `git branch --show-current`.
   - If the tree is clean AND HEAD is on a base branch (`main`): nothing to formalize. The
     user wants `/pm:build` (ready ticket) or `/pm:capture` (just file an idea). Say so and
     stop.
   - If you're already on a `fx-<n>-*` branch: this work is likely already ticketed. Confirm
     with the user before creating a second ticket; default to no-op.

**2. Characterize the stray work — two distinct shapes, handle differently:**
   - **Uncommitted changes only** (the common case): a `git checkout -b` carries them over
     untouched. Easy.
   - **Commits already landed on a shared/base branch** (e.g. you committed to `main`): you
     must rebranch AND rewind the base. Create the branch at current HEAD, then move the base
     pointer back to its remote (`git branch -f main origin/main`, only if `main` hasn't been
     pushed ahead of origin). Confirm with the user before rewinding anything.

   NEVER `stash drop`, `reset --hard`, `clean`, or otherwise discard. Preserving the work is
   the whole point.

**3. Sanity-check scope before filing.** Glance at `git diff --stat`. If the changes span
   clearly unrelated units of work, STOP — one ticket per unit. Flag it and ask the user how
   to split, rather than cramming everything under one ticket.

**4. Derive a one-line description of the work.** Use the user's arguments if given;
   otherwise infer it from the diff (changed files, the session so far) and state your
   inference in one line as you go — don't block on confirmation for a small, obvious change.

**5. File the ticket via the PM, capture-mode.** Spawn the PM as a subagent using the Agent
   tool with `subagent_type: "pm"`, in the **foreground** (you need the issue ID to proceed —
   this is not the usual fire-and-forget capture). Tell it: operate in capture mode and stay
   lean (read `.claude/pm-memory.md`, do a single targeted duplicate search, no full board
   sweep), pick the right team/project with sensible priority/labels. Give it the inferred
   description, the REAL file paths the work touches, and any suspected-duplicate tickets you
   already know about. Have it report back the issue ID, placement, assumptions, and any
   suspected duplicate. Relay that to the user.

**6. Move the work onto `fx-<n>-<slug>`.** One branch per ticket, named from the returned
   issue ID (ignore Linear's `gitBranchName` with its creator-handle prefix). Decide its home:
   - Root tree holds the changes and is otherwise the natural home → `git checkout -b
     fx-<n>-<slug>` from current HEAD (carries the dirty tree over).
   - Root tree is occupied by another live session → instead create a worktree off the base
     and replay the changes there; tell the user which path the session now lives in.

   Verify with `git status` afterward that every change came across.

**7. Claim it:** set the issue to **In Progress** — a mechanical status flip, not grooming.

**8. Report and stop.** Give the ticket URL, the branch name, and confirm what moved. Do NOT
   commit — leave that to the user or a later `/pm:checkpoint <issue-id>`. Do NOT pick up new
   scope. You remain the coding agent; just keep going from here.

Arguments: $ARGUMENTS
