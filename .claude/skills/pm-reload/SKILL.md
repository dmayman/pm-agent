---
name: pm-reload
description: Re-sync the locally-developed PM plugin during development after editing files in this repo (the pm plugin under plugins/pm — the pm agent, the plan/capture/checkpoint/done/start commands, or the SessionStart hook). Use when asked to reload the PM plugin, sync PM plugin changes, apply plugin edits, or "reload pm". Delegates to the repo's `pm-agent reload` CLI (validated clean reinstall) and reminds to restart. Dev-only: this skill is project-scoped to the pm-agent repo and only loads when Claude Code runs here.
---

# Reload the PM plugin (development)

This skill is **project-scoped** — it only exists when Claude Code is running inside the
pm-agent repo, so it can never fire during normal use of the published plugin.

The PM plugin source lives in `plugins/pm/`. After editing any of its files, run this to
re-sync the installed copy from your working tree.

## What to do

1. Run the reload script and show me its full output:

   ```bash
   bash .claude/skills/pm-reload/reload.sh
   ```

2. The script delegates to `pm-agent reload`, which **refuses unless the install is a
   directory (dev) source**, then validates the manifest (`--strict`), refreshes the
   marketplace, and does a clean `uninstall` → `install` of `pm@pm-agent` (clean reinstall
   avoids the version-pin no-op where `plugin update` skips unchanged versions).

3. If it aborts on validation failure or because the install isn't in dev mode, report the
   error and stop — do **not** hand-fix the manifest or force a reinstall as part of this skill.

4. On success, remind me that a **Claude Code restart is required** for changes to take
   effect (plugins load at startup; the current session won't pick them up until restart).

## Scope

This skill only reloads what's already on disk. Do not edit the plugin's files as part of
running it — that's separate work.
