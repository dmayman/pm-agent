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
npm install -g @dmayman/pm-agent   # get the CLI (command is `pm-agent`)
pm-agent install                   # register the marketplace + install the pm plugin
# restart Claude Code to load it
```

Or without the CLI, the plain Claude Code path:

```bash
claude plugin marketplace add dmayman/pm-agent
claude plugin install pm@pm-agent
```

Update later with `pm-agent update` (or `npx @dmayman/pm-agent update`).

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

In dev you never use the install pathway — you point the `pm-agent` channel at
your working tree, so Claude reads your live edits. From the repo root:

```bash
npm run dev          # point the channel at this working tree (then restart Claude Code)
# edit agent / commands / hooks …
npm run reload       # validate + clean-reinstall from the working tree (then restart)
npm run validate     # check both manifests (--strict) without changing anything
```

`dev` and `reload` are the same `pm-agent` CLI you ship — no separate tooling to
keep in sync. Switch back to the published plugin anytime with `pm-agent install`.

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
