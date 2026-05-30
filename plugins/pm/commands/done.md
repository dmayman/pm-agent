---
description: Hand this unit of work to the PM (as a subagent) for reconciliation and closeout — without changing this session's role
argument-hint: "<issue-id> [what changed vs the ticket, if anything]"
---

You are finishing a unit of work and handing it back to the PM for closeout. Do NOT take
on the PM role yourself — you remain the coding agent for this session, and you may keep
working afterward (e.g. one more change).

Spawn the PM as a subagent using the Agent tool with `subagent_type: "pm"`. In its prompt,
give it everything it needs to reconcile and close out without re-deriving it:
- The Linear issue ID (from the arguments below; if absent, your best inference).
- A concise summary of what was actually built.
- Any departures from the original ticket, and why.
- The branch/worktree this lives in, and the files changed.
- Whether the user has approved the acceptance criteria.

Remind the subagent to ground itself first — including reading `.claude/pm-memory.md` (if
present) for repo-specific PM conventions, since as a fresh subagent it has none of this
session's context.

Tell the subagent: the user validated the work, so reconcile the ticket to reality and
close it out — do not re-judge or invalidate accepted work. It should still check whether
the ticket's *original problem* was actually solved (vs. something adjacent) and propose a
spinoff ticket if not, asking the user first.

**Closeout includes merging — not just the Linear bookkeeping.** When the work is
validated, the subagent performs the full git closeout itself (this is the just-do-it set,
not something to hand back as commands):
1. **Merge the ticket's branch into `main`** and push `main` to origin.
2. **Delete the branch** — local and remote (`git branch -d` + `git push origin --delete`).
3. If the work lived in a worktree, **`git worktree remove <path>` then `git worktree
   prune`** (per the worktree convention in `pm-memory.md`).
4. Set the Linear issue to **Done**.

Guardrail: only merge work the user has actually validated. If approval is ambiguous or the
branch isn't clean to fast-forward/merge (conflicts, unexpected diff, work that wandered
without sign-off), STOP and confirm with the user before merging — don't force it.

Then relay its result back to me (what it merged + closed, anything it flagged as
cross-impact or a needed spinoff, what's unblocked next).

Arguments: $ARGUMENTS
