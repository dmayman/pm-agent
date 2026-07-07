---
description: Author or update this repo's .pm/services.json so its runnable services show up in the dashboard's worktrees panel with per-service Start/Stop + Start All.
argument-hint: ""
---

The user wants this repo's long-lived services declared so the pm-agent dashboard can start
and stop them per-service. The dashboard reads `.pm/services.json` at the repo root (checked
in, per-branch) — you own writing that file; the dashboard never edits it.

**Inspect the repo** to identify everything needed to make the app *operable* — not just the
app servers, but the backing infrastructure they can't run without. Look at:
- `package.json` `scripts` (dev/start/serve; `--filter`/workspace-scoped scripts), and
  `pnpm-workspace.yaml` / npm/yarn workspaces for multiple apps.
- `wrangler.toml`/`wrangler.jsonc` (Workers `dev` ports), `vite.config.*` (`server.port`),
  `next.config.*`, `Procfile`, `Makefile`, and the README's / CLAUDE.md's "running locally".
- **Backing infrastructure** — `docker-compose.yml`, `.env` (`DATABASE_URL`, `REDIS_URL`, etc.):
  a local database, cache, or queue the app connects to. Declare these too — if the app 500s
  without a Postgres on :5432, that Postgres is one of the repo's services. Put dependencies
  *first* in the list (a DB before the API): Start all boots services in declaration order.
- Health endpoints (a `/health` or `/healthz` route) so an API opens to a 200, not a root 404.

**Write `.pm/services.json`** at the repo root with this schema:

```json
{
  "services": [
    { "name": "App DB", "command": "docker compose up", "cwd": ".", "port": 5432 },
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
- Declare services meant to run and stay up — app servers (API, UI, worker) AND the
  infrastructure they depend on (DB, cache, queue). Skip one-off build/test/lint/migrate/seed
  commands (they run once and exit).
- **Run in the foreground so the dashboard can supervise and Stop it.** Strip any
  detach/background flag: use `docker compose up`, not `docker compose up -d`; drop a trailing
  `&`. A detached command returns immediately, so the dashboard can't stop it (though a declared
  `port` still lights the dot green while the port is up). If the daemon it needs isn't always
  running (e.g. Colima / Docker Desktop), prefix a start: `colima start && docker compose up`.
- Use the real invocation, including any workspace filter (`pnpm --filter @acme/app dev`).
- **Non-HTTP services** (Postgres, Redis…) have no meaningful `health`/`url` — omit both and
  rely on `port` alone for the green-dot liveness check. `health`/`url` are only for HTTP
  services you'd open in a browser.
- One service per port. If two commands share a port, they're the same service — pick one.

When done, confirm to the user what you wrote and that these services will now appear in the
dashboard's worktrees panel (Work view) with a status dot and per-service Start (▶) / Stop (■)
plus Start all / Stop all. The file is per-branch and checked in, so each worktree carries its
own manifest.

This is a one-shot authoring action — don't change this session's role or pick up other work
off the back of it.
