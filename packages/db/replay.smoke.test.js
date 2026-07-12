// Structural smoke test for `observe --replay`. Proves the wiring runs end-to-end and WRITES
// initiatives into a target DB — WITHOUT the real model and WITHOUT touching ~/.pm-agent. The
// Haiku call is stubbed by putting a fake `claude` executable on PATH that echoes a canned
// distiller response. Everything lives under a fresh system-temp dir. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("observe --replay seeds multiple initiatives into a target DB (model stubbed)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-replay-smoke-"));
  // Never let anything fall back to the real ledger home.
  process.env.PM_AGENT_HOME = path.join(tmp, "home");

  // Fake `claude`: ignore args, print the --output-format json envelope whose `result` is a
  // multi-goal distiller response. Same output for every call → deterministic.
  const model = JSON.stringify({
    goals: [
      { text: "Ship the zone model", initiative: "Zone model", isNew: true, framing: "build the zone model" },
      { text: "Deterministic duplicate-plan cleanup", initiative: "Dup cleanup", isNew: true },
    ],
    events: [{ type: "decided", summary: "Framed two workstreams", thread: "Zone model" }],
  });
  const binDir = path.join(tmp, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = path.join(binDir, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
      JSON.stringify({ result: model, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
    )});\n`
  );
  chmodSync(fakeClaude, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

  const S = await import("./store.js");
  const { replay } = await import("./observe.js");

  const slug = "acme/widget";
  const sourcePath = path.join(tmp, "source.db");
  const targetPath = path.join(tmp, "target.db");

  // Source: a repos row + two fabricated session_log rows (digests must clear MIN_DIGEST_CHARS).
  const source = S.openDbAt(sourcePath);
  const now = new Date().toISOString();
  source.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(slug, tmp, now);
  const srcRepoId = source.prepare("SELECT id FROM repos WHERE slug = ?").get(slug).id;
  const bigDigest = "USER: " + "let's plan the roadmap for the coach. ".repeat(20);
  const ins = source.prepare(
    "INSERT INTO session_log (repo_id, session_id, turn, cursor_start, digest, char_count, created_at) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run(srcRepoId, "sess-aaaa", 10, 0, bigDigest, bigDigest.length, "2026-07-01T00:00:00.000Z");
  ins.run(srcRepoId, "sess-bbbb", 20, 10, bigDigest, bigDigest.length, "2026-07-02T00:00:00.000Z");

  // Target: only a seeded repos row (root points at a nonexistent path on purpose → replay
  // must fall back to process.cwd() for the spawn cwd without crashing).
  const target = S.openDbAt(targetPath);
  target
    .prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)")
    .run(slug, path.join(tmp, "does-not-exist"), now);

  await replay({ source: sourcePath, target: targetPath, repo: slug });

  // Verify the target now holds the spawned initiatives, their goals, an event, and snapshots.
  const verify = S.openDbAt(targetPath, { readonly: true });
  const repoId = verify.prepare("SELECT id FROM repos WHERE slug = ?").get(slug).id;
  const threads = verify.prepare("SELECT title, goal, goal_source FROM threads WHERE repo_id = ?").all(repoId);
  const titles = threads.map((t) => t.title).sort();
  assert.deepEqual(titles, ["Dup cleanup", "Zone model"]);
  for (const t of threads) {
    assert.ok(t.goal, `initiative ${t.title} has a goal`);
    assert.equal(t.goal_source, "observer");
  }
  const events = verify.prepare("SELECT COUNT(*) AS n FROM events WHERE repo_id = ?").get(repoId).n;
  assert.ok(events >= 1, "at least one event logged");
  const snaps = verify.prepare("SELECT COUNT(*) AS n FROM initiative_snapshots WHERE repo_id = ?").get(repoId).n;
  assert.ok(snaps >= 1, "at least one snapshot recorded");

  rmSync(tmp, { recursive: true, force: true });
});
