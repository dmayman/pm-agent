---
description: Author or update this repo's .pm/services.json so its runnable services show up in the dashboard's worktrees panel with per-service Start/Stop + Start All.
argument-hint: ""
---

The user wants this repo's long-lived services declared so the pm-agent dashboard can start
and stop them per-service. The dashboard reads `.pm/services.json` at the repo root (checked
in, per-branch) — you own writing that file; the dashboard never edits it.

**Inspect the repo** to identify the runnable, long-lived services and their ports. Look at:
- `package.json` `scripts` (dev/start/serve; `--filter`/workspace-scoped scripts), and
  `pnpm-workspace.yaml` / npm/yarn workspaces for multiple apps.
- `wrangler.toml`/`wrangler.jsonc` (Workers `dev` ports), `vite.config.*` (`server.port`),
  `next.config.*`, `docker-compose.yml`, `Procfile`, `Makefile`, and the README's
  "getting started" / "running locally" section.
- Health endpoints (a `/health` or `/healthz` route) so an API opens to a 200, not a root 404.

**Write `.pm/services.json`** at the repo root with this schema:

```json
{
  "services": [
    { "name": "API", "command": "pnpm --filter @acme/app dev", "cwd": ".", "port": 8787, "health": "/health" },
    { "name": "Operator UI", "command": "pnpm dev:operator", "cwd": ".", "port": 5173, "url": "http://localhost:5173" }
  ]
}
```

Fields:
- `name` (required) — unique display label (e.g. "API", "Operator UI").
- `command` (required) — the exact shell command that starts the service and stays up.
- `cwd` (optional) — directory to run in, relative to the repo root. Default `"."`.
- `port` (optional) — the port it listens on. Used for liveness detection (a green dot when a
  listener appears) and the open-link. Prefer including it — port-less services can only be
  tracked as "running" while this dashboard's own process supervises them.
- `health` (optional) — a path like `/health`; the open-link becomes `localhost:{port}{health}`.
- `url` (optional) — overrides the open-link entirely (default `http://localhost:{port}`).

Guidance:
- Only declare services meant to run in the foreground and stay up (an API, a UI, a worker) —
  not one-off build/test/lint commands.
- Use the real invocation, verbatim, including any workspace filter. Don't wrap it in `&`.
- One service per port. If two commands share a port, they're the same service — pick one.

When done, confirm to the user what you wrote and that these services will now appear in the
dashboard's worktrees panel (Work view) with a status dot and per-service Start (▶) / Stop (■)
plus Start all / Stop all. The file is per-branch and checked in, so each worktree carries its
own manifest.

This is a one-shot authoring action — don't change this session's role or pick up other work
off the back of it.
