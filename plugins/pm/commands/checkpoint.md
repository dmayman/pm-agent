---
description: Checkpoint a unit of work — PM commits the staged changes (ticket-linked message) and records progress on the ticket. Not closeout; doesn't change this session's role.
argument-hint: "<issue-id> [what this checkpoint covers]"
---

You've reached a checkpoint in a unit of work — a natural commit boundary. Hand it to the
PM to commit and record progress. Do NOT take on the PM role yourself — you remain the
coding agent and keep working afterward.

First, **stage the files that belong to this unit of work yourself** (`git add <paths>`):
you know which changes are part of it and which are scratch. Just stage — don't commit. If
nothing should be committed yet, say so and the PM will skip the commit.

Then spawn the PM as a subagent using the Agent tool with `subagent_type: "pm"`. In its
prompt, give it:
- The Linear issue ID (from the arguments below; infer from the session if absent).
- A concise summary of what this checkpoint accomplished and what's still left.
- Confirmation of what you staged (or that there's nothing to commit).

Tell the subagent to:
1. Review the **staged** diff (not the whole working tree), write a commit message that
   references the issue, and commit. It commits only what you staged — it must NOT
   `git add` anything more.
2. Record progress on the ticket: add a comment summarizing what's now done (referencing
   the commit), set status to In Progress if it isn't already, and note the remaining work
   so completeness is visible at a glance.
3. NOT close, merge, or treat this as done — this is a mid-work save point. If the work
   looks complete, it should say so and point to `/pm:done`, not act on it.

Relay back the commit SHA and the one-line progress summary, then keep coding.

Arguments: $ARGUMENTS
