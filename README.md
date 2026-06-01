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

**Per-repo, even though it's installed globally.** Installing PM doesn't put it on duty
everywhere. In a repo with no `.claude/pm-memory.md`, PM stays silent — it injects no
context and changes no behavior. Running `/pm:start` in a repo creates that file and opts
the repo in; from then on PM is active there. (The `/pm:*` commands are always available so
you can onboard any repo, but cost nothing until invoked.) To remove PM from a specific
repo entirely, run `claude plugin disable pm --scope project`.

## Connect Linear

Create a Linear account at [linear.app](https://linear.app) if you don't have one, then
connect the Linear MCP to Claude Code:

```bash
claude mcp add --transport http linear https://mcp.linear.app/mcp
```

Run `/mcp` in a Claude Code session and finish the OAuth login in your browser — no API key
needed. (If that transport gives you trouble, use the SSE endpoint
`https://mcp.linear.app/sse`.) See [Linear's MCP docs](https://linear.app/docs/mcp).


## Usage

### Set the context: `/pm:start`

`/pm:start` is how you talk directly to your PM. It puts the PM **on duty in
this session** — your Claude session stops being a coder and *will not write code*. It
becomes a standing project manager you keep coming back to: a thinking partner that decides
what to work on and why, turns rough ideas into real tickets, sequences them, and keeps the
board honest. Start a different concurrent session for your coding work.

Run the command and the PM grounds itself, then opens with where things stand and a suggestion
or two of what to pick up next. Use it to figure out what's next, line up a milestone, or
talk through a decision that spans more than one ticket.

The commands below are used during coding sessions. Each is a quick action for a specific kind of task, 
and either help the Claude coder get context from the PM or invoke a PM sub-agent for a quick task.

### Get work done

Pick the command that matches the task in front of you:

- **`/pm:build [ticket]`** — Start coding a ready ticket. Pulls the top of the queue (or one
  you name), sets up its branch, and claims it **In Progress**. Run it before writing any
  feature work.
- **`/pm:branch`** — You started coding *without* a ticket. Files one, moves your in-flight
  changes onto a proper branch, and claims it — without losing work or committing.
- **`/pm:capture <idea>`** — A bug or out-of-scope idea surfaced mid-task. File it for later
  without derailing what you're doing (don't silently fix it).
- **`/pm:checkpoint [ticket]`** — At a commit boundary, have the PM commit your staged work
  with a ticket-linked message and log progress. Not a closeout.
- **`/pm:done [ticket]`** — The work is finished or approved. Hand it back to the PM to
  reconcile the ticket, merge, and close out. Don't self-merge — the PM owns closeout.
- **`/pm:quick-fix <fix>`** — Knock out a small fix start-to-finish, right now. Files a
  ticket, branches off `main` in its own worktree, builds it, and closes out — isolated, so
  it won't disturb whatever else you have in flight.
- **`/pm:update`** — Update the plugin to the latest release.

### Tend the board in Linear

It's worth opening Linear now and then to review the tickets you've created there. Set
priorities, add labels, group work into projects — by hand or by asking your PM to do it.
The more you express what you're actually trying to get done, the better the PM can groom,
sequence, and route it, and the cleaner the whole workflow runs.

## The PM learns how you work

The PM keeps a tiny, per-repo config file at `.claude/pm-memory.md` — the durable facts
about how you want work run here. When you run **`/pm:start` for the first time, it sets it up for you.**
One team per repo is the recommended default, but if you have a different configuration, just tell it.

The PM will remember anything evergreen about how you work: pin a project, set
branch conventions, record standing rules about how this repo works. It'll stick to facts that stay true regardless of any ticket's state
(it's config, not a log); everything ticket-specific lives in Linear.

## License

MIT
