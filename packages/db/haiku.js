// One place to call Haiku headlessly. Reuses the user's Claude auth via `claude -p` (no API
// key needed) and always marks the sub-session so its own Stop hook won't re-trigger the
// observer. Returns the model's text, or null on any failure. Every call is metered: with
// `--output-format json` the CLI reports token usage + cost, which we record so the operator
// UI can show what the tool costs (pass a `meter: { db, repoId, kind }` to log it).

import { execFileSync, spawn } from "node:child_process";
import * as S from "./store.js";

const HAIKU = "claude-haiku-4-5";
const JUDGE = "claude-opus-4-8"; // eval judge — needs more capability than the observer's Haiku
const ARGS = (prompt, model = HAIKU) => ["-p", prompt, "--model", model, "--output-format", "json"];

// Pull the model's text + usage out of the `--output-format json` envelope. Falls back to
// treating the raw output as plain text if it isn't the expected JSON (older CLI, etc.).
function parseResult(raw) {
  if (!raw) return { text: null, usage: null, cost: 0 };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.result === "string") {
      return { text: j.result, usage: j.usage || null, cost: Number(j.total_cost_usd) || 0 };
    }
  } catch {}
  return { text: raw, usage: null, cost: 0 };
}

function meter(m, usage, cost) {
  if (!m || !m.db) return;
  try {
    S.logUsage(m.db, m.repoId, { kind: m.kind, usage, cost });
  } catch {}
}

export function runHaiku(prompt, cwd, { timeout = 60000, meter: m = null } = {}) {
  try {
    const raw = execFileSync("claude", ARGS(prompt), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PM_AGENT_OBSERVING: "1" },
    });
    const { text, usage, cost } = parseResult(raw);
    meter(m, usage, cost);
    return text;
  } catch {
    return null;
  }
}

// A single Haiku attempt that SURFACES why it failed — for offline batch use (the replay tool),
// where a silently dropped turn is a data-loss bug, not a shrug. Unlike runHaiku (which pipes a
// bare null and swallows stderr to keep the live Stop hook fast), this captures the subprocess's
// stderr and distinguishes a timeout from a nonzero exit, returning { text, error }. text is null
// on any failure and error holds a human-readable reason. Kept separate so live-hook behavior is
// unchanged; the replay loop layers retry/backoff/pacing on top of this.
export function runHaikuOnce(prompt, cwd, { timeout = 60000, meter: m = null } = {}) {
  try {
    const raw = execFileSync("claude", ARGS(prompt), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], // capture stderr so failures aren't opaque
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PM_AGENT_OBSERVING: "1" },
    });
    const { text, usage, cost } = parseResult(raw);
    if (!text) return { text: null, error: "claude returned an empty result" };
    meter(m, usage, cost);
    return { text, error: null };
  } catch (e) {
    let error;
    if (e.killed || e.signal === "SIGTERM") error = `timed out after ${timeout}ms`;
    else {
      const stderr = e.stderr && String(e.stderr).trim();
      error = stderr || e.message || `claude exited with code ${e.status ?? "?"}`;
    }
    return { text: null, error: String(error).slice(0, 300) };
  }
}

// The eval judge: same headless `claude -p` path as runHaiku, but on a stronger model (Opus by
// default) and a longer timeout, since it grades a whole session's ledger. Sets the same
// PM_AGENT_OBSERVING guard so the judge's own Stop hook never re-enters the observer. Returns
// the model's text (markdown report) or null. Metered as kind:'eval'.
export function runJudge(prompt, cwd, { model = JUDGE, timeout = 180000, meter: m = null } = {}) {
  try {
    const raw = execFileSync("claude", ARGS(prompt, model), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PM_AGENT_OBSERVING: "1" },
    });
    const { text, usage, cost } = parseResult(raw);
    meter(m, usage, cost);
    return text;
  } catch {
    return null;
  }
}

// Async variant so callers can run several Haiku calls concurrently. Resolves to text or null.
export function runHaikuAsync(prompt, cwd, { timeout = 60000, meter: m = null } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const child = spawn("claude", ARGS(prompt), {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PM_AGENT_OBSERVING: "1" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeout);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const { text, usage, cost } = parseResult(out);
      meter(m, usage, cost);
      finish(text);
    });
  });
}

// Run async thunks with a bounded concurrency pool.
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
