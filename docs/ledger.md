# The ledger — pm-agent's observational layer

> Status: in development on the `ledger` branch.

pm-agent v0.3 was **prescriptive**: a gate that stopped you from writing code until
you'd ticketed. That's what made it rigid — small followups felt illegal, every redirect
demanded a new issue. The ledger is the opposite design: **an observational layer Claude
reports into**, that never blocks work and that Claude owns silently.

## Principles

1. **Observe, don't gate.** Nothing here is ever in the critical path of writing code.
   Your arch-chat → issue → branch → build → followup → merge flow is untouched.
2. **The unit is the _thread_, not the issue.** A thread is the whole arc of one line of
   work (often 1–2 days, sometimes several issues): its founding decisions (genesis), a
   chronological event log, current state, and loose ends. Issues/PRs/commits are
   _artifacts a thread references_ — not the container. A followup is just another event
   on the same thread; no new issue required.
3. **Claude owns it silently.** The user never manages threads and is never told the
   ledger is being maintained. Claude creates, names, and reorganizes threads on its own.
   The only way the user experiences it is by opening a view — which should feel like
   refreshing clarity, not a surface to tend.
4. **Cheap.** Most of the timeline is _derived_ for free from git + gh. The only thing
   Claude actively contributes is what git doesn't know: decisions, the "why", loose
   ends, and thread boundaries. Summarization/rendering is done by Haiku.

## Where it lives — global, keyed by repo

The store is **global on the machine**, not inside any worktree: `~/.pm-agent/pm.db`
(SQLite, WAL mode for concurrent writers). This is the crux — session A building #53 in
worktree-1 and session B building #56 in worktree-2 must land on one shared timeline.
All worktrees of a repo share the same `.git` common-dir and remote, so they resolve to
the same `repo_id`. Different repos stay isolated; a cross-repo "everything I'm touching"
view is free later.

Repo identity: `owner/repo` from the remote when present, else `sha1(git-common-dir)`.

## Data model

- **repos** — `id, slug, root, created_at`
- **threads** — `id, repo_id, title, status(active|in_review|blocked|done), genesis, created_at, updated_at`
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

- **CLI**: `pm-agent timeline | inflight | loose | thread <id> | log … | observe | serve`
- **Operator UI** (`apps/web` over `apps/server`, same DB): the timeline view first —
  clean, elegant, no bloat.
