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
    { "name": "App DB", "command": "docker compose up", "cwd": ".", "port": 5432, "portEnv": "APP_DB_PORT" },
    { "name": "API", "command": "pnpm --filter @acme/app dev", "cwd": ".", "port": 8787, "health": "/health", "portEnv": "API_PORT" },
    { "name": "Operator UI", "command": "pnpm dev:operator", "cwd": ".", "port": 5173, "url": "http://localhost:5173", "portEnv": "OPERATOR_PORT" }
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
- `portEnv` (optional but **strongly recommended** — see "Make services relocatable" below) —
  the env var pm-agent sets to this service's *effective* port when it launches the service, so
  a second worktree of the same repo runs on a shifted port instead of colliding. Only useful if
  the `command` (or the config it reads) actually consumes that env var.

**Make services relocatable (so two worktrees run at once).** pm-agent's worktree panel makes
checking a branch out into a second worktree a single click, and its preview env runs another
copy of the repo — so *two checkouts of this repo commonly run at the same time*. But
`.pm/services.json` is checked in and identical across branches, so without help every worktree
declares the **same** ports and they collide: only one can bind `:5432`/`:8787`/`:5173`, and the
dashboard can't tell them apart. pm-agent solves this by giving each worktree a stable **slot**
(the primary checkout is slot 0; the next worktree slot 1, and so on) and shifting every declared
port by `slot × 100`. Your job is to make the repo's services *honor that shift* so the second
worktree comes up cleanly on `:5532`/`:8887`/`:5273`.

How pm-agent hands you the offset when it launches a service — three env vars, always set:
- `PM_SLOT` — the worktree's slot (0 for the primary; 1, 2, … for extra worktrees).
- `PM_PORT_OFFSET` — `slot × stride` (e.g. `100`). **Uniform across every service in that
  worktree**, so any service can reach a sibling at `sibling_base_port + PM_PORT_OFFSET`.
- `<portEnv>` — the service's own *effective* port (`port + PM_PORT_OFFSET`), but only if you
  declared a `portEnv` for it. This is the ergonomic handle: name it, then make the command bind it.

pm-agent runs every `command` through your **login shell** (`$SHELL`, e.g. `zsh -lc`), so you can
rely on shell features directly in the command string: arithmetic (`$(( 5432 + PM_PORT_OFFSET ))`),
default expansion (`${API_PORT:-8787}`), conditionals, and `&&` chaining all work — no need to guess
whether the string is shell-evaluated.

To wire a service, do BOTH:
1. **Declare `portEnv`** on the service (e.g. `"portEnv": "API_PORT"`).
2. **Make its command bind that env var**, falling back to the base port so a plain checkout with
   no offset still works. Adapt to how each tool takes a port:
   - **Vite / Next / most dev servers** — a `--port` flag: `vite --port ${OPERATOR_PORT:-5173}`.
   - **docker-compose** — interpolate the host port in the mapping:
     `ports: ["${APP_DB_PORT:-5432}:5432"]` (the *container* port stays fixed; only the host port
     shifts). The `command` stays `docker compose up`; pm-agent's injected env reaches compose.
     **Also drop any pinned `container_name`** (and named/host-path `volumes` that hard-code a
     name): two worktrees would collide on that identical name even with distinct ports. Compose
     auto-namespaces containers, networks, and anonymous volumes by the project directory, so
     removing `container_name` lets a second worktree's stack come up cleanly. If you truly need a
     stable name, suffix it — `container_name: acme-db-${APP_DB_PORT:-5432}`.
   - **Wrangler** — `wrangler dev --port ${API_PORT:-8787}`.
   - **A framework that only reads `PORT`** — set it inline: `PORT=${API_PORT:-3000} npm start`.
3. **Fix cross-service references with `PM_PORT_OFFSET`.** If the API connects to the DB, in a
   shifted worktree the DB is on `5432 + PM_PORT_OFFSET`, so the API's connection string must
   shift too — e.g. run it as
   `DATABASE_URL="postgres://localhost:$((5432 + ${PM_PORT_OFFSET:-0}))/app" pnpm --filter @acme/app dev`.
   Because `PM_PORT_OFFSET` is the same for every service in the worktree, this always points at
   the sibling that's actually running alongside it.

Prefer editing the repo's own config to read these env vars (a `vite.config` reading
`process.env.OPERATOR_PORT`, a compose file with `${APP_DB_PORT:-5432}`, an `.env` default) over
cramming everything into the `command` string — but either works. Leave the base ports as the
no-offset default everywhere, so slot 0 and any non-pm-agent run are unchanged. If a service
genuinely can't be relocated, still declare `portEnv` and note the limitation to the user;
single-worktree use is unaffected either way.

Guidance:
- **Assume a cold machine — nothing is already running.** The whole point is that the user
  needs to know *nothing* about how to boot this repo: they open the dashboard, hit Start all,
  and everything comes up. So write each command to be self-sufficient from a fresh slate —
  never assume a daemon, VM, database, or tunnel is already up because it happens to be up on
  your machine right now. If a service needs a container runtime, VM, or background daemon,
  the command must **start that first**: `colima start && docker compose up`, not bare
  `docker compose up`. Read the repo's docs for the *documented* startup, then fold every
  prerequisite step into the command so a single click reproduces it end to end.
- Declare services meant to run and stay up — app servers (API, UI, worker) AND the
  infrastructure they depend on (DB, cache, queue). Skip one-off build/test/lint/migrate/seed
  commands (they run once and exit). If the DB genuinely needs a one-time migrate/seed on a
  truly empty volume, chain it before the long-lived process (`… && pnpm db:migrate && docker
  compose up`) only when it's idempotent — otherwise leave setup to the repo's own tooling.
- **Run in the foreground so the dashboard can supervise and Stop it.** Strip any
  detach/background flag: use `docker compose up`, not `docker compose up -d`; drop a trailing
  `&`. A detached command returns immediately, so the dashboard can't stop it (though a declared
  `port` still lights the dot green while the port is up).
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
