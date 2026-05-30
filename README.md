# pm-agent

A work-orchestration / project-management tool. It ships a **Claude Code plugin
(`pm`)** today, and is structured to grow into a self-hosted alternative to
Linear: a local database and a web UI, all from one repo, installed with one
command.

This repo is three things at once:

- a **Claude Code marketplace** (`.claude-plugin/marketplace.json`),
- an **npm package** (`npx pm-agent`, via `bin/pm-agent.js`),
- a **monorepo** with room for the future server, web UI, and database.

## Install the Claude Code plugin

```bash
claude plugin marketplace add dmayman/pm-agent
claude plugin install pm@pm-agent
# restart Claude Code to load it
```

The `pm` plugin provides a PM agent plus slash commands — `/pm:start`,
`/pm:capture`, `/pm:checkpoint`, `/pm:plan`, `/pm:done` — that own Linear issue
tracking and git branching so coding sessions stay scoped to one ticket.

## Layout

```
pm-agent/
├── .claude-plugin/marketplace.json   # this repo is a Claude marketplace
├── package.json                      # this repo is also an npm package (npx pm-agent)
├── bin/pm-agent.js                   # npx entrypoint / bootstrapper
├── plugins/
│   └── pm/                           # the Claude Code plugin (agent, commands, hooks)
├── apps/
│   ├── server/                       # FUTURE: local API + DB access (the Linear backend)
│   └── web/                          # FUTURE: self-hosted web UI (the Linear replacement)
└── packages/
    ├── cli/                          # FUTURE: richer CLI surface
    └── db/                           # FUTURE: schema + migrations
```

## Development

Track your working copy instead of GitHub by adding this directory as a
marketplace, then reload after edits:

```bash
claude plugin marketplace add ~/Documents/GitHub/pm-agent
claude plugin install pm@pm-agent
# edit files → claude plugin marketplace update pm-agent → reinstall → restart
```

### Channels

- **local / nightly** — a *directory* marketplace pointing at this working tree.
  Edit, reload, restart. No commit or publish required.
- **beta** — a `beta` branch with a prerelease version (e.g. `0.2.0-beta.1`).
- **stable** — tagged releases on `main`. Cut one with:
  ```bash
  claude plugin tag --push        # creates pm--v<version> from plugins/pm/.claude-plugin/plugin.json
  ```

## Roadmap

1. ✅ Claude Code plugin (`pm`) — Linear-backed orchestration.
2. ⏳ Local database + server abstraction so the plugin talks to a pluggable
   backend (Linear *or* local).
3. ⏳ Self-hosted web UI to replace Linear.
4. ⏳ `npx pm-agent` one-command setup (install plugin, start server, open UI).

## License

MIT
