# Live goal-capture eval — test protocol & findings log

A repeatable way to exercise **live goal-first capture (#26)** on a real coding session and grade
it with the **eval harness (#28)** — without touching your real ledger. You do the real work in a
hooked repo (e.g. `habitus`); the branch's observer captures goals/events into an isolated
**preview DB**; a judge scores it against #26's rubric at the end.

## How it works (the moving parts)

- **Preview env** — `pm-agent preview <branch>` serves the branch's committed code on
  `localhost:4478` against a scratch DB (`~/.pm-agent/preview-home/pm.db`) seeded from prod. Your
  real observer (`observer/`, :4477) and ledger are untouched.
- **Capture link** — `pm-agent preview --link` (or the **Link** button in the Work panel)
  npm-links the global `pm-agent` to the **preview worktree** (so your hooks run the branch's code)
  and points capture at the preview DB. `--unlink` / **Unlink** reverts both (restores the
  published CLI + real ledger). While linked, every hooked repo's capture flows into the preview.
- **Eval streams** — as you work, the observer tees an untruncated per-turn digest into
  `session_log` and snapshots each initiative's goal/summary/events into `initiative_snapshots`.
  These are the judgment-free ground truth + trajectory the judge reads.
- **Eval** — `pm-agent eval` bundles raw ledger + trajectory + final state and has a strong judge
  (Opus) score it, writing a markdown report under `~/.pm-agent/preview-home/evals/`.

## Setup (per run)

1. **Main checkout on the branch** (the preview serves its committed tip; commit before you expect
   changes to show): `git -C ~/Documents/GitHub/pm-agent switch live-goal-capture-and-eval`.
2. **Launch the preview, seeded from prod** so the target repo's current initiatives are present:
   `node ~/Documents/GitHub/pm-agent/bin/pm-agent.js preview live-goal-capture-and-eval --reseed`
   (the published global CLI predates `preview`, so call the checkout's bin). Opens
   `http://localhost:4478`.
3. **Link capture onto the branch.** In `observer/` → **Work** tab, on the `live-goal-capture-and-eval`
   row (or Primary), click **Link**. Both dots go green: *hooks → branch code*, *capture → preview
   DB*. (CLI equivalent: `pm-agent preview --link`.)

## Run the test

4. **Do the real work.** Open the target repo in Claude Code and build the feature normally — no env
   vars needed; capture is globally linked. **Frame the goal in your first message** ("I want to
   make X do Y") before any issue/branch exists — that's what #26 should capture at birth.
5. **Watch it live** on `http://localhost:4478`: switch to the target project (top-left project
   picker), open **Work**. Each turn, the initiative's **goal** should seed then sharpen, and its
   summary re-synthesize (goal → tried → done → left).
6. **Confirm the eval is recording** (optional, silent by design):
   ```
   sqlite3 ~/.pm-agent/preview-home/pm.db \
     "SELECT session_id, count(*) turns FROM session_log GROUP BY session_id ORDER BY max(created_at) DESC LIMIT 5;
      SELECT count(*) snapshots FROM initiative_snapshots;"
   ```

## Wrap up & grade

7. **Run the eval** when the session feels done (capture is still linked, so it targets the preview
   DB automatically): `cd ~/Documents/GitHub/habitus && pm-agent eval`. Prints the report path
   (`~/.pm-agent/preview-home/evals/…md`). Use `--session <id>` to grade a specific session, or
   `--model claude-sonnet-5` for a cheaper judge.
8. **Save the report** you want to keep: `cp <report> ~/Documents/GitHub/pm-agent/docs/eval-runs/`
   (preview-home is scratch and may be reseeded/wiped). Record a row in the log below.
9. **Revert** — click **Unlink** in the panel (restores the published CLI + real ledger), then
   `node bin/pm-agent.js preview --stop` if you're done previewing.

## Notes & known limits

- **One session per eval.** `pm-agent eval` grades a single session's raw log + that session's
  snapshots. To demonstrate goal *refinement across sessions* (#26 verify #2), compare the
  `initiative_snapshots` rows for the initiative across sessions by hand for now
  (`SELECT turn, goal, event_count FROM initiative_snapshots WHERE thread_id=<id> ORDER BY created_at`).
  A cross-session / per-initiative eval target is a candidate follow-up.
- While linked, **all** hooked repos capture into the preview DB — that's intended for the test
  window. Unlink when done.
- The judge costs a real (Opus) model call per `eval` run; it's manual and never hooked.

## Findings log

| Date | Target feature | Session(s) | Seeded@birth | Refined | Attribution | Emergent notes | Report |
|------|----------------|-----------|--------------|---------|-------------|----------------|--------|
| _e.g. 2026-07-09_ | _Habitus: G-jumps-to-today_ | _1_ | _3/3_ | _n/a (1 turn)_ | _3/3_ | _dropped the "why" from the framing_ | _docs/eval-runs/…md_ |
| | | | | | | | |
