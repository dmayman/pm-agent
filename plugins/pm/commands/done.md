---
description: Hand this unit of work to the PM (as a subagent) for reconciliation and closeout — without changing this session's role
argument-hint: "<issue-number> [what changed vs the issue, if anything]"
---

You are finishing a unit of work and handing it back to the PM for closeout. Do NOT take
on the PM role yourself — you remain the coding agent for this session, and you may keep
working afterward (e.g. one more change).

Spawn the PM as a subagent using the Agent tool with `subagent_type: "pm"`. In its prompt,
give it everything it needs to reconcile and close out without re-deriving it:
- The GitHub issue number (from the arguments below; if absent, your best inference).
- A concise summary of what was actually built.
- Any departures from the original issue, and why.
- The branch/worktree this lives in, and the files changed.
- Whether the user has approved the acceptance criteria.

Remind the subagent to ground itself first — including reading `.claude/pm-memory.md` (if
present) for repo-specific PM conventions, since as a fresh subagent it has none of this
session's context.

Tell the subagent: the user validated the work, so reconcile the issue to reality and
close it out — do not re-judge or invalidate accepted work. It should still check whether
the issue's *original problem* was actually solved (vs. something adjacent) and propose a
spinoff issue if not, asking the user first.

**Closeout goes through a pull request — not a local merge.** When the work is validated,
the subagent performs the full git + PR closeout itself (this is the just-do-it set, not
something to hand back as commands):
1. **Push the branch** to origin (`git push -u origin issue-<n>-<slug>`).
2. **Open a PR into `main`** (`gh pr create --base main --fill`) whose body contains
   `Closes #<n>` so merging auto-closes the issue. Reconcile the issue body first if the
   work departed from it, so the PR description matches reality.
3. **Merge the PR and delete the branch** — `gh pr merge --merge --delete-branch` (use the
   repo's merge style; `--delete-branch` removes the remote branch and the merged local one).
4. If the work lived in a worktree, **`git worktree remove <path>` then `git worktree
   prune`** (per the worktree convention in `pm-memory.md`).
5. Confirm the issue closed (the `Closes #<n>` link does this on merge into the default
   branch); if for any reason it didn't, close it with `gh issue close <n>` and strip the
   `status:in-progress` label.

Guardrail: only merge work the user has actually validated. If approval is ambiguous or the
branch won't cleanly merge (conflicts, unexpected diff, work that wandered without sign-off),
STOP and confirm with the user before merging — don't force it. If the repo gates merges on
review or CI, open the PR and report it back rather than force-merging past the gate.

Then relay its result back to me (the PR it merged + the issue it closed, anything it
flagged as cross-impact or a needed spinoff, what's unblocked next).

Arguments: $ARGUMENTS
