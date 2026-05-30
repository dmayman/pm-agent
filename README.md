# pm-agent

A Claude Code plugin that makes **Linear the source of truth for what you work on**.

It adds a PM agent and a set of `/pm:*` commands. The PM scopes your ideas into Linear
tickets, grooms and sequences them, and routes your coding sessions so they don't collide.
Coding sessions claim a ticket up front and stay scoped to it — so you can pick up work
with zero prep and run several sessions without them tripping over each other.

## Requirements

- **Claude Code**
- **A Linear account** with the **Linear MCP** connected (setup below). Linear is
  required — the plugin keeps no state of its own.

## Why Linear

The plugin doesn't store your work anywhere itself. **Linear is the system of record**:
every idea, ticket, decision, status, and closeout lives on a Linear issue or project, and
the PM agent reads and writes it through the Linear MCP.

That's what makes the whole thing work:

- A handoff to a coding session is just *"work on FX-123"* — the session reads the ticket
  from Linear and has everything it needs.
- Ticket **status** is the work queue (Backlog → Ready → In Progress → Done), so you start
  work without re-explaining it.
- Because the PM can see what every session owns, it can sequence overlapping work instead
  of letting two sessions edit the same files at once.

## Install

```bash
npm install -g @dmayman/pm-agent   # the installed command is `pm-agent`
pm-agent install                   # register the marketplace + install the pm plugin
# restart Claude Code to load it
```

Or the plain Claude Code path, without the CLI:

```bash
claude plugin marketplace add dmayman/pm-agent
claude plugin install pm@pm-agent
```

Update later with `pm-agent update`.

## Connect Linear

1. **Add the Linear MCP** to Claude Code:

   ```bash
   claude mcp add --transport http linear https://mcp.linear.app/mcp
   ```

   (If that transport gives you trouble, the SSE endpoint is
   `https://mcp.linear.app/sse`.)

2. **Authenticate** — open a Claude Code session and run `/mcp`, then complete the Linear
   OAuth login in your browser. No API key needed. See
   [Linear's MCP docs](https://linear.app/docs/mcp).

3. **Tell the PM which Linear team/project this repo maps to.** In the repo where you'll
   use the plugin, create `.claude/pm-memory.md` — a tiny, evergreen config file the PM
   reads at the start of every session:

   ```markdown
   # PM memory

   - Linear team: <Your Team>
   - Linear project: <Your Project>
   - Branch naming: fx-<n>-<slug>, one branch per ticket
   - Conventions: <priority/label conventions, standing rules>
   ```

   Keep it to facts that stay true regardless of any ticket's state — it's config, not a
   log. Everything ticket-specific lives in Linear.

## Usage

There are two distinct ways the PM shows up, and it's worth understanding the difference:

- **`/pm:plan` turns *this* session into the PM.** It loads the PM's brain into your
  current Claude session — that session stops being a coder and *will not write code*. All
  it does is plan the work with you through Linear tickets.
- **The other commands invoke the PM as a background agent.** `/pm:capture`,
  `/pm:checkpoint`, and `/pm:done` spawn the PM as a subagent to do one side task (file an
  idea, commit a checkpoint, close out) and return. Your session stays the coding session
  the whole time — they don't interrupt your workflow or change what you're doing.

### Plan with the PM: `/pm:plan`

Run this to **plan, not build**. Your session becomes the PM: a thinking partner and ticket
steward that decides *what* to work on and *why* — dump ideas, turn rough thoughts into
real tickets, sequence them, and promote the ready ones to the top of the queue. It works
entirely through Linear and never touches code.

Use it to start a work session, figure out what's next, line up a milestone, or talk
through a decision that affects more than one ticket.

### Build: `/pm:build`

Start a **coding session** on a ready ticket. In a fresh session, run `/pm:build` — it
pulls the top ready ticket (or one you name), creates its branch, and claims it **In
Progress**. Do this **before writing any feature work**, so every change is tied to a
ticket and a branch.

### Formalize in-flight work: `/pm:branch`

The missing middle between capture and build: you started coding *before* there was a
ticket, and now this in-flight work needs to be put on rails. `/pm:branch` files the
ticket, moves your uncommitted changes onto a proper `fx-<n>-<slug>` branch, and claims it
**In Progress** — without losing work and without committing. (`/pm:capture` files a ticket
but never touches your tree; `/pm:build` sets up a branch but assumes a ready ticket already
exists.) It also handles the messier case where you'd already committed to `main`, rewinding
the base safely. You stay the coding session and keep going.

### While you're coding

These spawn the PM as a subagent for a quick side task — you stay in your coding session:

- **`/pm:capture <idea>`** — a bug or out-of-scope idea surfaces mid-task. File it to
  Linear without derailing what you're doing. Don't silently fix it — capture it.
- **`/pm:checkpoint <issue>`** — at a commit boundary, have the PM commit the work you've
  staged with a ticket-linked message and log progress on the issue. Not a closeout.
- **`/pm:done <issue>`** — the work is complete or its acceptance is approved. Hand it back
  to the PM to reconcile the ticket and close it. Don't self-merge or close issues
  yourself — the PM owns closeout.

## License

MIT
