---
description: Drop an idea/issue to the PM (as a subagent) to file in GitHub with the right placement and priority — without changing this session's role
argument-hint: "<the idea or problem that just came up>"
---

An idea or issue surfaced mid-session and should be captured by the PM. Do NOT take on the
PM role yourself — you remain the coding agent and keep doing what you were doing.

Keep this fast — capture is fire-and-forget. Spawn the subagent in the background
(`run_in_background: true`) so the user keeps coding and is notified when it's filed,
unless the user clearly wants to see the result before moving on.

Spawn the PM as a subagent using the Agent tool with `subagent_type: "pm"`. In its prompt,
give it the raw idea plus what this session already knows, so it can place it well without
re-deriving:
- The idea/problem in the user's words (below), and the real problem underneath it if you
  can see it.
- Why it came up now, and whether it blocks current work or is just adjacent.
- Relevant files/modules/devices you'd point a future coding session at (real paths).

Tell the subagent to operate in capture mode and stay lean: read the cached GitHub repo
mapping from `.claude/pm-memory.md` instead of sweeping the board, do a single targeted
duplicate search (`gh issue list --search`, not a full board read), then create or update
the issue in the right repo/milestone with a sensible priority and labels, sequenced
against what's in flight. It runs non-interactively and can't ask follow-ups mid-run, so it
should file with sensible defaults and then report back: the issue number, where it placed
it and why, any assumptions it made (especially priority), and anything the user should
confirm or any suspected duplicate. Relay that back to me verbatim-enough to act on; don't
groom or expand it yourself.

Idea: $ARGUMENTS
