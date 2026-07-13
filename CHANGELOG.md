# Changelog

All notable changes to this project are documented here. Versions follow
[semver](https://semver.org/); prerelease builds use `-beta.N` suffixes.

## [1.0.0] — 2026-07-05

The pivot release. pm-agent began life as a **prescriptive, ticket-gated PM**: a gate
that stopped you writing code until the work was ticketed and labeled, driving issues
through a grooming pipeline. That model was too rigid to live with — every small
followup demanded ceremony — and it has been removed. pm-agent is now an
**observational, goal-first work ledger**:

### Changed
- **The unit of work is the initiative — a live-captured goal.** The moment a goal is
  framed in conversation, Claude seeds an initiative (`pm-agent initiative new … --goal …`)
  and the observer refines it as work unfolds. Issues, PRs, and commits are evidence
  that attaches to the goal — not the container the work must be poured into.
- **Nothing gates anything.** A `Stop`-hook observer (Haiku) distills each turn into
  timeline events; git and `gh` supply the derived facts (commits, merged PRs, issue
  lifecycle) for free. Explicit capture (`pm-agent log`) remains as an opt-in mode.
- **One dashboard.** `pm-agent serve` renders the timeline, active initiatives, loose
  ends, and per-worktree services; worktrees get port-slot offsets so several run at once.

### Removed
- The ticket-gate itself (the per-repo "map the repo before you may code" contract).
- The Linear integration and its GitHub-labels successor (`status:*`/`priority:*`
  grooming labels, the 💡 Idea issue template, and `pm-agent setup-issues`).
- The batch issue-clusterer that periodically rebuilt initiatives from issue titles —
  replaced by live goal capture plus incremental pin/link membership.

## [0.1.0] — 2026-05-29

### Added
- Initial repo: `pm` Claude Code plugin (PM agent, `/pm:*` commands, SessionStart
  contract hook) migrated verbatim from local development into `plugins/pm/`.
- Repo doubles as a Claude Code marketplace (`pm-agent`) and an npm package
  (`npx pm-agent`).
- Monorepo scaffolding (`apps/server`, `apps/web`, `packages/db`, `packages/cli`)
  reserved for the future local-database + self-hosted Linear replacement.
