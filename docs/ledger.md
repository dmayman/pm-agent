# The ledger — pm-agent's observational layer

> Status: shipped — this is the live model since v1.0.0.

pm-agent v0.3 was **prescriptive**: a gate that stopped you from writing code until
you'd ticketed. That's what made it rigid — small followups felt illegal, every redirect
demanded a new issue. The ledger is the opposite design: **an observational layer Claude
reports into**, that never blocks work and that Claude owns silently.

## Principles

1. **Observe, don't gate.** Nothing here is ever in the critical path of writing code.
   Your arch-chat → issue → branch → build → followup → merge flow is untouched.
2. **The unit is the _initiative_, not the issue.** An initiative is the whole arc of one
   line of work, defined by its durable **goal** (often 1–2 days, sometimes several
   issues): its founding decisions (genesis), a chronological event log, current state,
   and loose ends. Issues/PRs/commits are _artifacts an initiative references_ — not the
   container. A followup is just another event on the same initiative; no new issue
   required. Goals are captured live: the moment one is framed in conversation, Claude
   seeds the initiative, and the observer refines it as work unfolds.
3. **Claude owns it silently.** The user never manages initiatives and is never told the
   ledger is being maintained. Claude creates, names, and reorganizes initiatives on its
   own. The only way the user experiences it is by opening a view — which should feel like
   refreshing clarity, not a surface to tend.
4. **Cheap.** Most of the timeline is _derived_ for free from git + gh. The only thing
   Claude actively contributes is what git doesn't know: goals, decisions, the "why",
   loose ends, and initiative boundaries. Summarization/rendering is done by Haiku.

## Where it lives — global, keyed by repo

The store is **global on the machine**, not inside any worktree: `~/.pm-agent/pm.db`
(SQLite, WAL mode for concurrent writers). This is the crux — session A building #53 in
worktree-1 and session B building #56 in worktree-2 must land on one shared timeline.
All worktrees of a repo share the same `.git` common-dir and remote, so they resolve to
the same `repo_id`. Different repos stay isolated; a cross-repo "everything I'm touching"
view is free later.

Repo identity: `owner/repo` from the remote when present, else `sha1(git-common-dir)`.

## Data model

(Initiatives are stored in the `threads` table — the table name predates the
initiative vocabulary and isn't worth a schema migration.)

- **repos** — `id, slug, root, created_at`
- **threads** — one row per initiative: `id, repo_id, title, status(active|in_review|blocked|done), genesis, goal, goal_source, focus, why, created_at, updated_at`
  - `goal` is the durable outcome framed at the arc's birth and held steady; `focus` is
    what the work is concentrating on right now and swings freely turn to turn — the
    split keeps the tactic of the moment from overwriting the goal
- **events** — `id, repo_id, thread_id?, ts, type, summary, refs(json), source(observer|explicit|derived), resolved_at?`
  - types: `decided, built, tested, reviewed, followup, deferred, merged, blocked, note`
  - loose ends = `type='deferred' AND resolved_at IS NULL` — a query, not a separate table
- **issue_titles** — `repo_id, number, title` — powers the `#53 → "the token-refresh work"` glossary
- **config** — `scope('global'|slug), key, value` — holds `capture=observer|explicit`, etc.

## Capture — two modes, one toggle

- **observer** (default while testing): a `Stop` hook runs `pm-agent observe`, which
  distills the just-finished turn via `claude -p --model claude-haiku-4-5` into events.
  Zero effort; may be chatty.
- **explicit**: Claude calls `pm-agent log …` only when it judges something worth
  recording. Quieter; relies on Claude's judgment.

Toggle: `pm-agent config capture observer|explicit` (per-repo). Flip freely to compare.

## Surfaces

- **CLI**: `pm-agent timeline | inflight | loose | initiative … | log … | observe | serve`
- **Operator UI** (`apps/web` over `apps/server`, same DB): the timeline view first —
  clean, elegant, no bloat.
