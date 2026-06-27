# Changelog

All notable changes to this project are documented here. Versions follow
[semver](https://semver.org/); prerelease builds use `-beta.N` suffixes.

## [Unreleased]

### Changed
- **Switched the system of record from Linear to GitHub Issues.** The PM now drives issues
  through the `gh` CLI instead of the Linear MCP — no MCP server or OAuth setup; just
  `gh auth login`. The work queue moved from Linear workflow states to `status:*` labels
  (`status:backlog` → `status:ready` → `status:in-progress` → closed), priority to
  `priority:*` labels, Linear projects to GitHub milestones, and closeout from a local
  branch merge to a pull request that `Closes #<n>`. Issue branches are now
  `issue-<n>-<slug>`. The per-repo gate maps the repo to a GitHub `owner/repo` rather than a
  Linear team.

## [0.1.0] — 2026-05-29

### Added
- Initial repo: `pm` Claude Code plugin (PM agent, `/pm:*` commands, SessionStart
  contract hook) migrated verbatim from local development into `plugins/pm/`.
- Repo doubles as a Claude Code marketplace (`pm-agent`) and an npm package
  (`npx pm-agent`).
- Monorepo scaffolding (`apps/server`, `apps/web`, `packages/db`, `packages/cli`)
  reserved for the future local-database + self-hosted Linear replacement.
