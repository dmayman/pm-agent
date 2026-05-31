# pm-agent

**An AI project manager for Claude Code — it keeps your coding sessions organized and stops
them from tripping over each other.**

The more you build with Claude Code, the more sessions you run — and the easier it is to
lose the plot: what's in flight, what was decided, what's next. Worse, parallel sessions
start colliding: two of them editing the same files, work landing on `main`, branches and
commits piling up in a mess you have to untangle later.

pm-agent adds a **project manager (PM)** to Claude Code: an agent whose only job is to
decide *what* to work on and keep concurrent work in order. It turns your ideas into
tickets, grooms and sequences them, and routes each coding session so they don't step on
each other. You pick up work with zero prep and run several sessions at once without them
clobbering one another.

## How it works

- **It owns the version-control choreography, so you don't trip over it.** Every unit of
  work gets its own ticket branch (`fx-<n>-<slug>`). When sessions run in parallel, each
  gets its own git **worktree** — and its own dev-preview server on its own port — so two
  sessions never fight over the working tree or collide on a port. Commits are
  ticket-linked and scoped to what the session actually staged (never a blind `git add
  -A`), and at closeout the PM merges, deletes the branch, and prunes the worktree. You
  stay heads-down on code; it keeps the tree clean.
- **Tickets are the source of truth.** Every idea, decision, status, and closeout lives on
  a ticket — not in a session's memory — so a handoff is just *"work on FX-123"* and ticket
  **status** is the work queue (Backlog → Ready → In Progress → Done). The PM uses a ticket
  management system to stay organized and orchestrate; **Linear** is the app of choice for
  now (connected over MCP), with others possible down the line. The plugin keeps no state
  of its own.

## Requirements

- **Claude Code**
- **Linear** with the **Linear MCP** connected (setup below) — the PM's ticket backend and
  system of record for now.

## Install

```bash
npm install -g @dmayman/pm-agent
pm-agent install
# restart Claude Code to load it
```

**Updating.** A session tells you when a newer release is out; run `/pm:update` (inside
Claude Code) or `pm-agent update` (in a shell) to fetch it from npm and reinstall, then
restart Claude Code.

## Connect Linear

1. **Create a Linear account** if you don't have one — [linear.app](https://linear.app) —
   and set up the team/project you'll track this work in.

2. **Add the Linear MCP** to Claude Code:

   ```bash
   claude mcp add --transport http linear https://mcp.linear.app/mcp
   ```

   (If that transport gives you trouble, the SSE endpoint is
   `https://mcp.linear.app/sse`.)

3. **Authenticate** — open a Claude Code session and run `/mcp`, then complete the Linear
   OAuth login in your browser. No API key needed. See
   [Linear's MCP docs](https://linear.app/docs/mcp).

4. **Pick a team for the repo — `/pm:start` sets this up for you.** The first time you run
   `/pm:start` in a repo, the PM checks whether a Linear team is configured and, if not,
   shows your teams and asks which to use (or offers to create one), then writes it to
   `.claude/pm-memory.md`. One team per repo is the recommended default. It won't start
   planning until a team is set.

   That file is a tiny, evergreen config — the team is the only thing it needs. You can edit
   it to override defaults or add standing rules; keep it to facts that stay true regardless
   of any ticket's state (everything ticket-specific lives in Linear):

   ```markdown
   # PM memory

   - Linear team: <Your Team>          # required — what /pm:start fills in
   - Linear project: <Your Project>    # optional — pin a project, or let the PM choose
   - Branch naming: fx-<n>-<slug>, one branch per ticket
   ```

## Usage

### Set the context: `/pm:start`

`/pm:start` is the one command that's different from the rest. It puts the PM **on duty in
this session** — your Claude session stops being a coder and *will not write code*. It
becomes a standing project manager you keep coming back to: a thinking partner that decides
what to work on and why, turns rough ideas into real tickets, sequences them, and keeps the
board honest.

You don't need to know what you want to "plan" to run it. Fire it bare at the start of a
work session and the PM grounds itself, then opens with where things stand and a suggestion
or two of what to pick up next. Use it to figure out what's next, line up a milestone, or
talk through a decision that spans more than one ticket.

The commands below are the opposite: each is a quick action for a specific kind of task.
They don't change what your session is — you stay the coder — they just hand a slice of
work to the PM (or set you up to start one).

### Get work done

Pick the command that matches the task in front of you:

- **`/pm:build [ticket]`** — Start coding a ready ticket. Pulls the top of the queue (or one
  you name), sets up its branch, and claims it **In Progress**. Run it before writing any
  feature work.
- **`/pm:quick-fix <fix>`** — Knock out a small fix start-to-finish, right now. Files a
  ticket, branches off `main` in its own worktree, builds it, and closes out — isolated, so
  it won't disturb whatever else you have in flight.
- **`/pm:branch`** — You started coding *without* a ticket. Files one, moves your in-flight
  changes onto a proper branch, and claims it — without losing work or committing.
- **`/pm:capture <idea>`** — A bug or out-of-scope idea surfaced mid-task. File it for later
  without derailing what you're doing (don't silently fix it).
- **`/pm:checkpoint [ticket]`** — At a commit boundary, have the PM commit your staged work
  with a ticket-linked message and log progress. Not a closeout.
- **`/pm:done [ticket]`** — The work is finished or approved. Hand it back to the PM to
  reconcile the ticket, merge, and close out. Don't self-merge — the PM owns closeout.
- **`/pm:update`** — Update the plugin to the latest release.

## License

MIT
