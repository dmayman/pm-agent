// One place to call Haiku headlessly. Reuses the user's Claude auth via `claude -p` (no API
// key needed) and always marks the sub-session so its own Stop hook won't re-trigger the
// observer. Returns the model's text, or null on any failure.

import { execFileSync, spawn } from "node:child_process";

const HAIKU = "claude-haiku-4-5";

export function runHaiku(prompt, cwd, { timeout = 60000 } = {}) {
  try {
    return execFileSync("claude", ["-p", prompt, "--model", HAIKU], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PM_AGENT_OBSERVING: "1" },
    });
  } catch {
    return null;
  }
}

// Async variant so callers can run several Haiku calls concurrently. Resolves to text or null.
export function runHaikuAsync(prompt, cwd, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const child = spawn("claude", ["-p", prompt, "--model", HAIKU], {
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
      finish(code === 0 ? out : null);
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
