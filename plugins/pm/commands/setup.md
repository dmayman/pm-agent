---
description: Set up pm-agent in this repo — enable the ledger, scaffold the GitHub-issues grooming workflow, and point to the dashboard. One idempotent command.
argument-hint: "[--explicit] [--no-issues]"
---

The user wants to set up pm-agent in the current repo.

Run `pm-agent setup` in a shell from the repo root, and show the user its output. It runs
three idempotent steps (safe to re-run):

1. **Ledger** — enables the observational timeline (`.claude/pm-ledger.md` marker) and
   backfills it from the repo's git history.
2. **Issue grooming** — enables GitHub Issues, creates the `idea` → `ready` →
   `status:in-progress` workflow labels, and adds a 💡 Idea issue template. Skipped cleanly
   if `gh` isn't authenticated (the ledger still gets set up).
3. **Dashboard** — points to `pm-agent serve`.

Pass the user's arguments through: `$ARGUMENTS`. In particular:
- `--explicit` sets manual capture instead of the default observer mode.
- `--no-issues` sets up the ledger only (skips grooming).
- Do **not** pass `--serve`, and do **not** run `pm-agent serve` yourself — it's a
  long-running server that would block this session. Instead, tell the user they can run
  `pm-agent serve` to open the dashboard at http://localhost:4477.

**Optional — a memorable dashboard URL (macOS).** `pm-agent serve` runs at
`http://localhost:4477`, and remembering that port is a recurring annoyance. There's a
one-time, **machine-wide** fix: `sudo pm-agent observer-url`. Make sure the user understands
what this means before offering it:
- It's run **once per machine, ever** — NOT once per repo. It's not part of this repo's
  setup; it just changes how *this computer* resolves a name.
- It needs `sudo` because it edits `/etc/hosts` and adds a loopback `:80 → :4477` redirect
  (the server itself keeps running as the normal user). `sudo pm-agent observer-url --uninstall`
  reverts everything.
- After it's done, the payoff is: whenever `pm-agent serve` is running, the user just types
  **`observer/`** in their browser — the trailing slash matters (it tells the browser it's an
  address, not a search) — and lands on the dashboard. No port to remember, forever.

Only offer it if it isn't already set up — check with `grep -w observer /etc/hosts` (a match
means it's wired). If it's already wired, just remind them they can type `observer/` in the
browser. Don't run the `sudo` command yourself; give it to the user to run (e.g. via `!`).

There's also a companion, **unprivileged** step: `pm-agent observer-autostart` installs a
login LaunchAgent so the dashboard server is always running (no need to run `pm-agent serve`
by hand). It must NOT be run with `sudo` (it runs the server as the user so the ledger stays
user-owned). Offer it alongside `observer-url` for a fully hands-off `observer/` — but keep
the two straight: `observer-url` needs sudo, `observer-autostart` must not.

When it finishes:
- Tell the user to **restart Claude Code** so the session hooks pick up the ledger.
- `area:*` domain labels are intentionally left out (they're repo-specific). If the user
  wants them, offer to read the repo's structure, propose a small taxonomy, and create them
  with `gh label create` — the labels are a human/Claude grooming convention, so this is a
  natural thing for you to help with.

If the shell reports `pm-agent: command not found`, the CLI isn't installed — tell the user
to run `npm install -g @dmayman/pm-agent`, then retry.

This is a one-shot setup action — don't change this session's role or pick up other work off
the back of it.
