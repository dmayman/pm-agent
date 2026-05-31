---
name: pm-release
description: Cut a release of pm-agent — bump the version, tag, push to GitHub, and publish to npm. Use when asked to release, publish, ship a version, or cut a new pm-agent version. Picks the increment (patch/minor/major) with the user, then delegates to the repo's `pm-agent release` CLI, which versions + pushes + publishes only already-committed work. Dev-only: project-scoped to the pm-agent repo.
---

# Cut a pm-agent release (development)

This skill is **project-scoped** — it only exists when Claude Code is running inside the
pm-agent repo, so it can never fire during normal use of the published plugin.

A release is an outward-facing, hard-to-reverse action: it pushes to GitHub and publishes
to npm, where users pick it up via `/pm:update`. Treat it deliberately.

## What to do

1. **Make sure the work is committed.** The release only tags and publishes what's already
   committed — it refuses on a dirty tree. If there are uncommitted changes, stop and tell
   me to commit (or commit them first if that's clearly the intent), then continue.

2. **Pick the increment** (semver, pre-1.0):
   - `patch` — a fix or small tweak, no new surface.
   - `minor` — a new command/feature, or a breaking change (pre-1.0, breaking changes ride
     in minors by convention).
   - `major` — reserved for the 1.0 line / a deliberate stable break.

   If I named the increment, use it. If not, look at what changed since the last tag
   (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`) and **propose** an
   increment with a one-line rationale, then confirm with me before cutting it.

3. **Run the release** and show me its full output:

   ```bash
   bash .claude/skills/pm-release/release.sh <patch|minor|major>
   ```

   It runs `npm version <level>` (bumps `package.json`, syncs `plugin.json` to match,
   commits, and tags `vX.Y.Z`), then `git push --follow-tags`, then `npm publish`.

4. **If it aborts** — dirty tree, failed publish (e.g. not logged into npm: `npm whoami`),
   or a push rejection — report the error and stop. Don't hand-fix versions, retag, or
   force anything as part of this skill.

5. **On success**, tell me the released version and that it's live on both GitHub and npm,
   and that users get it via `pm-agent update` / `/pm:update`.

## Scope

This skill only releases what's already committed. Do not edit plugin files, bump versions
by hand, or amend commits as part of running it.
