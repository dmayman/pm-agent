// Shared low-level helpers for the ledger packages — one home for the small utilities
// that used to be copy-pasted between work.js and ingest.js (and the pid check the
// server needs). No sqlite, no state: safe to import from anywhere.

import { execFileSync } from "node:child_process";

// Run a binary and return its stdout, or null on any failure. Deliberately
// swallows errors: callers treat null as "tool unavailable" and degrade gracefully.
export function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Run `gh` and parse its JSON output; null when gh is missing/unauthenticated or
// the output isn't JSON.
export function ghJson(args, cwd) {
  const out = sh("gh", args, cwd);
  if (out == null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// The first issue number encoded in a branch name (feat/41-x, issue-32-y → 41, 32).
// Deliberately naive (first run of digits) — kept as-is for now.
export function branchIssue(branch) {
  const m = /(\d+)/.exec(branch || "");
  return m ? Number(m[1]) : null;
}

// Is a pid still alive? (signal 0 = existence check; EPERM means alive but not ours.)
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
