# pm-agent

**A work ledger for Claude Code — Claude quietly records what you're building, and you open
a calm timeline to see where everything stands.**

The more you build with Claude Code, the more you lose the plot: what's in flight, what got
finished when, what loose threads are still dangling. A single line of work sprawls across a
day or two — an architecture chat, an issue, a branch, a build, a review, a pile of
followups — and by the time you're deep in followups you've forgotten what the original
decision even was. GitHub issues hold the facts, but they're verbose and hard to parse, and
being forced to file a new ticket for every small thing is too rigid to live with.

pm-agent gives Claude a **ledger to report into**. As you work, Claude silently records the
decisions, milestones, and loose ends of each line of work into a timeline — and you open an
**operator UI** whenever you want a refreshing, at-a-glance read of what's going on. It never
gates your work, never makes you file anything, and never asks you to manage it. You just get
clarity when you want it.

> This is an evolution of pm-agent's earlier, ticket-gated PM. That model turned out too
> rigid — everything, however small, had to go through the issue pipeline. The ledger is the
> opposite: it **observes** instead of **prescribes**. See [`docs/ledger.md`](docs/ledger.md)
> for the design.

## How it works

- **The unit is an _initiative_, not a ticket.** An initiative is one whole arc of work,
  defined by its durable **goal** — captured live the moment you frame it in conversation,
  usually before any issue or branch exists. It holds the founding decisions (its
  *genesis*), a stream of events over hours or days, its current status, and its loose
  ends. Issues, PRs, and commits are artifacts an initiative *references* — a followup is
  just another event on the same initiative, no new ticket required. Claude names and
  organizes initiatives on its own.
- **Claude owns it silently.** You're never asked to log anything or tend a board. Claude
  records what matters as it works; you only ever *read* the result.
- **It spans all your worktrees.** The ledger is one store per repo, global on your machine
  (`~/.pm-agent/pm.db`) — so two sessions building two issues in two worktrees land on one
  shared timeline instead of each seeing half the picture.
- **It's cheap.** Most of the timeline is derived for free from `git` and `gh`; the rest —
  goals, decisions, loose ends, and where one initiative ends and the next begins — is
  distilled by a **Haiku** observer pass. Claude itself only steps in for what the observer
  can't see, or when you explicitly ask it to group issues or record a goal.
- **It calls issues by name.** A `#-glossary` means Claude says *"the token-refresh work
  (#53)"*, not a bare `#53` you don't recognize.

### Views

Run `pm-agent serve` and open the operator UI:

- **Timeline** — every event, reverse-chronological, grouped by day. Digestible at a glance.
- **In flight** — the active initiatives as cards (goal, recent events, status) plus every
  open loose end in one place.
- **Initiative** — click any initiative to see its goal and founding decisions pinned above
  its own timeline — the "what was the original plan?" view.

Prefer the terminal? `pm-agent timeline`, `pm-agent inflight`, and `pm-agent loose` render the
same data.

## Capture: automatic or deliberate

Two modes, one toggle — flip freely to find what fits:

- **`observer`** (default) — a Stop hook runs a cheap Haiku pass at the end of each turn that
  distills what happened into events. Zero effort; occasionally chatty.
- **`explicit`** — Claude logs only when it judges something worth recording. Quieter; relies
  on Claude's judgment.

```bash
pm-agent config capture explicit   # or: observer
```

## Requirements

- **Claude Code**
- **Node ≥ 22.5** (the ledger uses the built-in `node:sqlite` — no native build, no deps)
- **The GitHub CLI (`gh`)** — *optional*. When present and authenticated it powers the
  `#-glossary` and records merged-PR milestones. Everything else works without it.

## Install

```bash
npm install -g @dmayman/pm-agent
pm-agent install
# restart Claude Code to load the plugin
```

**Updating.** A session tells you when a newer release is out; run `/pm:update` (inside
Claude Code) or `pm-agent update` (in a shell), then restart Claude Code.

## Set it up in a repo

Installing the plugin doesn't switch it on everywhere — a repo stays silent until you opt it
in. One command does the whole setup:

```bash
cd your/repo
pm-agent setup             # add --serve to open the dashboard right after
# restart Claude Code so the session hooks pick it up
```

`setup` runs two steps, each idempotent so it's safe to re-run:

1. **Enables the ledger** — writes the `.claude/pm-ledger.md` marker and **backfills the
   timeline from your existing git history** (each commit becomes a typed event, threaded
   under the issue it references — conventional-commit messages like `feat(#41): …` thread
   cleanly), syncs the issue glossary, and records merged-PR milestones (the last two need
   `gh`). So an established project has a populated timeline immediately.
2. **Points you to the dashboard** — `pm-agent serve` at `http://localhost:4477`.

Add `--explicit` for manual capture instead of the observer. To opt back out,
`pm-agent disable` (your timeline data is kept); to remove the plugin from a repo entirely,
`claude plugin disable pm --scope project`.

The ledger only *observes* — it reads issue number, title, and open/closed state from
GitHub, never labels. How you groom your issues is entirely up to you.

## See where things stand

```bash
pm-agent serve             # open the operator UI at http://localhost:4477
pm-agent timeline          # or read it in the terminal (--days N, --thread REF)
pm-agent inflight
pm-agent loose
```

The UI is read-only — it's for looking, not managing. Claude keeps it current; you just open
it when you want the picture.

## License

MIT
