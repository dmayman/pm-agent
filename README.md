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
pm-agent install                   # points Claude at the installed files + installs the plugin
# restart Claude Code to load it
```

npm is the source of truth: `pm-agent install` points Claude Code's marketplace at the
package npm just put on disk, so you're always running a published release.

**Updating.** A session tells you when a newer release is out; run `/pm:update` (inside
Claude Code) or `pm-agent update` (in a shell) to fetch it from npm and reinstall, then
restart Claude Code.

**Without the CLI**, you can install straight from GitHub instead — but this tracks the
repo directly and won't get npm-based update notices:

```bash
claude plugin marketplace add dmayman/pm-agent
claude plugin install pm@pm-agent
```

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

- **`/pm:start` puts the PM on duty in *this* session.** It loads the PM's brain into your
  current Claude session — that session stops being a coder and *will not write code*. It
  becomes a standing PM you keep coming back to: a thinking partner that organizes the work
  with you through Linear tickets. Run it bare and it grounds itself, then opens with where
  things stand and what's worth picking up next.
- **The other commands invoke the PM as a subagent.** `/pm:capture`, `/pm:branch`,
  `/pm:checkpoint`, and `/pm:done` spawn the PM to do one side task (file an idea, put
  in-flight work on a ticket branch, commit a checkpoint, close out) and return. Your
  session stays the coding session the whole time — they don't change what you're doing.
  (`/pm:branch` runs the PM in the foreground because it needs the new issue ID before it
  can name the branch; the rest are fire-and-forget.)
- **`/pm:build` and `/pm:quick-fix` start a coding session.** `/pm:build` bootstraps you
  from a ticket the PM already queued (no subagent). `/pm:quick-fix` runs the whole pipeline
  for a small fix in one chat — files a ticket through the PM, branches off `main` in an
  isolated worktree, builds it, and closes out — so you can knock it out on the side without
  disturbing other in-flight work.

### Put the PM on duty: `/pm:start`

Run this to **plan, not build**. Your session becomes the PM: a thinking partner and ticket
steward that decides *what* to work on and *why* — dump ideas, turn rough thoughts into
real tickets, sequence them, and promote the ready ones to the top of the queue. It works
entirely through Linear and never touches code.

You don't need to know what you want to "plan" to run it. Fire it bare at the start of a
work session and the PM takes a moment to ground itself, then comes back with where things
stand and a suggestion or two of what to pick up next. From there it's your standing PM for
the session — figure out what's next, line up a milestone, or talk through a decision that
affects more than one ticket.

### Build: `/pm:build`

Start a **coding session** on a ready ticket. In a fresh session, run `/pm:build` — it
pulls the top ready ticket (or one you name), creates its branch, and claims it **In
Progress**. Do this **before writing any feature work**, so every change is tied to a
ticket and a branch.

### Do it now, on the side: `/pm:quick-fix`

For a small, self-contained fix you want done *right now* and fully tracked — without
derailing whatever you're already in the middle of. Run `/pm:quick-fix <the small fix>` and
it runs the whole pipeline in one session: files the ticket through the PM, branches off
`main` **in its own worktree**, claims it **In Progress**, builds the fix, hands you a way
to validate, and on `/pm:done` merges back to `main` and cleans up the worktree.

The point is the isolation: because it works off `main` in a separate worktree, you can fire
it while you're mid-branch on something else and it won't touch that work — you spin off the
fix cleanly and end up back on `main`, ticketed. It's the full capture → build → done
pipeline collapsed into one chat. (If the fix turns out *not* to be small, it bails to
`/pm:start` rather than quietly growing.)

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

## Development & releasing

For working on the plugin itself (the source lives in `plugins/pm/`). These steps are
project-scoped — the `/pm-reload` and `/pm-release` skills only load inside this repo.

- **Develop locally.** Point Claude at your working tree once with `pm-agent dev`, then
  after each edit run `/pm-reload` (or `pm-agent reload`) and restart Claude Code. Claude
  reads your live files, not a release.
- **Save work without releasing.** Just `git push`. Pushing to GitHub only saves source —
  it doesn't change anything for installed users, who only move when a new version is
  published to npm. So commit and push freely between releases.
- **Cut a release** when you're ready, with `/pm-release` (or `pm-agent release <level>`).
  It bumps the version (`patch` / `minor` / `major`), keeps `package.json` and the plugin's
  `plugin.json` in lockstep, tags `vX.Y.Z`, pushes, and publishes to npm. Users then get it
  via the update notice → `/pm:update`. Releases publish only already-committed work.

A beta tester who wants the bleeding edge can install straight from a branch without waiting
for a release: `npm install -g dmayman/pm-agent#main` (or `#<branch>`), then `pm-agent
install`.

## License

MIT
