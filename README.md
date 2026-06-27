# pm-agent

**An AI project manager for Claude Code — it keeps your coding sessions organized and stops
them from tripping over each other.**

The more you build with Claude Code, the more sessions you run — and the easier it is to
lose the plot: what's in flight, what was decided, what's next. Worse, parallel sessions
start colliding: two of them editing the same files, work landing on `main`, branches and
commits piling up in a mess you have to untangle later.

pm-agent adds a **project manager (PM)** to Claude Code: an agent whose only job is to
decide *what* to work on and keep concurrent work in order. It turns your ideas into
issues, grooms and sequences them, and routes each coding session so they don't step on
each other. You pick up work with zero prep and run several sessions at once without them
clobbering one another.

## How it works

- **It owns the version-control choreography, so you don't trip over it.** Every unit of
  work gets its own issue branch (`issue-<n>-<slug>`). When sessions run in parallel, each
  gets its own git **worktree** — and its own dev-preview server on its own port — so two
  sessions never fight over the working tree or collide on a port. Commits are
  issue-linked and scoped to what the session actually staged (never a blind `git add
  -A`), and at closeout the PM opens a pull request that `Closes #<n>`, merges it, deletes
  the branch, and prunes the worktree. You stay heads-down on code; it keeps the tree clean.
- **Issues are the source of truth.** Every idea, decision, status, and closeout lives on
  a GitHub issue — not in a session's memory — so a handoff is just *"work on #123"* and a
  `status:*` label is the work queue (`status:backlog` → `status:ready` →
  `status:in-progress` → closed). The PM drives **GitHub Issues** through the **`gh` CLI**;
  the plugin keeps no state of its own.

## Requirements

- **Claude Code**
- **The GitHub CLI (`gh`)**, installed and authenticated (`gh auth login`) — the PM's
  issue backend and system of record. A GitHub repo to file issues against (by default the
  one your working directory points at).

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

## Connect GitHub

Install the [GitHub CLI](https://cli.github.com/) and authenticate it once:

```bash
gh auth login
```

That's the whole setup — no MCP server, no OAuth dance inside Claude. The PM runs `gh
issue …` / `gh pr …` directly. The first time you run `/pm:start` in a repo, the PM
confirms `gh` is authenticated, picks the GitHub repo to file against (defaulting to the
one your checkout points at), and creates the `status:*` / `priority:*` labels it uses as
the work queue.

## Usage

### Set the context: `/pm:start`

`/pm:start` is how you talk directly to your PM. It puts the PM **on duty in
this session** — your Claude session stops being a coder and *will not write code*. It
becomes a standing project manager you keep coming back to: a thinking partner that decides
what to work on and why, turns rough ideas into real issues, sequences them, and keeps the
board honest. Start a different concurrent session for your coding work.

Run the command and the PM grounds itself, then opens with where things stand and a suggestion
or two of what to pick up next. Use it to figure out what's next, line up a milestone, or
talk through a decision that spans more than one issue.

The commands below are used during coding sessions. Each is a quick action for a specific kind of task, 
and either help the Claude coder get context from the PM or invoke a PM sub-agent for a quick task.

### Get work done

Pick the command that matches the task in front of you:

- **`/pm:build [issue]`** — Start coding a ready issue. Pulls the top of the queue (or one
  you name), sets up its branch, and claims it (`status:in-progress`). Run it before writing
  any feature work.
- **`/pm:branch`** — You started coding *without* an issue. Files one, moves your in-flight
  changes onto a proper branch, and claims it — without losing work or committing.
- **`/pm:capture <idea>`** — A bug or out-of-scope idea surfaced mid-task. File it for later
  without derailing what you're doing (don't silently fix it).
- **`/pm:checkpoint [issue]`** — At a commit boundary, have the PM commit your staged work
  with an issue-linked message and log progress. Not a closeout.
- **`/pm:done [issue]`** — The work is finished or approved. Hand it back to the PM to
  reconcile the issue, open the PR, merge, and close out. Don't self-merge — the PM owns
  closeout.
- **`/pm:quick-fix <fix>`** — Knock out a small fix start-to-finish, right now. Files an
  issue, branches off `main` in its own worktree, builds it, and closes out — isolated, so
  it won't disturb whatever else you have in flight.
- **`/pm:update`** — Update the plugin to the latest release.

### Tend the board on GitHub

It's worth opening GitHub now and then to review the issues you've created there. Set
priorities, add labels, group work into milestones — by hand or by asking your PM to do it.
The more you express what you're actually trying to get done, the better the PM can groom,
sequence, and route it, and the cleaner the whole workflow runs.

## The PM learns how you work

The PM keeps a tiny, per-repo config file at `.claude/pm-memory.md` — the durable facts
about how you want work run here. When you run **`/pm:start` for the first time, it sets it up for you.**
One repo per checkout is the recommended default, but if you have a different configuration
(say, issues filed against a separate planning repo), just tell it.

The PM will remember anything evergreen about how you work: pin a milestone, set
branch conventions, record standing rules about how this repo works. It'll stick to facts that stay true regardless of any issue's state
(it's config, not a log); everything issue-specific lives in GitHub.

## License

MIT
