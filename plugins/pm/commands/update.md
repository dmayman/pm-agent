---
description: Update pm-agent to the latest release from npm and reinstall the plugin. Run this when you're told a newer version is available.
argument-hint: ""
---

The user wants to update the pm-agent plugin to the latest release.

Run `pm-agent update` in a shell. It fetches the latest version from npm
(`npm install -g @dmayman/pm-agent@latest`) and cleanly reinstalls the plugin into
Claude Code. Show the user its output.

- When it finishes, tell the user to **restart Claude Code** — plugins load at startup, so
  the update isn't active until they do.
- If the shell reports `pm-agent: command not found`, they installed via the plain
  marketplace route rather than npm. Tell them to run `npm install -g @dmayman/pm-agent`
  first, then `pm-agent install`, then restart.

This is a one-shot maintenance action — don't change this session's role or pick up other
work off the back of it.
