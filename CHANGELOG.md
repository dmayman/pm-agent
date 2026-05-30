# Changelog

All notable changes to this project are documented here. Versions follow
[semver](https://semver.org/); prerelease builds use `-beta.N` suffixes.

## [Unreleased]

## [0.1.0] — 2026-05-29

### Added
- Initial repo: `pm` Claude Code plugin (PM agent, `/pm:*` commands, SessionStart
  contract hook) migrated verbatim from local development into `plugins/pm/`.
- Repo doubles as a Claude Code marketplace (`pm-agent`) and an npm package
  (`npx pm-agent`).
- Monorepo scaffolding (`apps/server`, `apps/web`, `packages/db`, `packages/cli`)
  reserved for the future local-database + self-hosted Linear replacement.
