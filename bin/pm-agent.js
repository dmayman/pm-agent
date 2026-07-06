#!/usr/bin/env node
// pm-agent — CLI / bootstrapper.
//
// npm is the source of truth: `npm install -g @dmayman/pm-agent` puts the package
// (CLI + plugin files) on disk, and Claude's marketplace is pointed at *those files*
// rather than at GitHub. So `git push` only saves source; users change only when a new
// version is published to npm. This file wraps the `claude plugin …`, `npm`, and `git`
// commands so install / update / release / local-dev are one command each. As the tool
// grows this also becomes the launcher for the local server + web UI. Dependency-free so
// `npx pm-agent` works with zero install.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const REPO = "dmayman/pm-agent"; // GitHub source (docs + git-ref installs)
const NPM_PKG = "@dmayman/pm-agent"; // npm package name — the release artifact
const MARKETPLACE = "pm-agent"; // marketplace.json "name" — the single channel slot
const PLUGIN = "pm"; // plugin.json "name"
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, ".."); // the installed package files; what we serve to Claude

const help = `
pm-agent — work-orchestration tool with a Claude Code plugin

USAGE
  pm-agent <command>

END-USER COMMANDS
  install            Point Claude's marketplace at the installed package and
                       install the pm plugin
  update             Fetch the latest release from npm and reinstall the plugin
  uninstall          Remove the pm plugin and the marketplace

LOCAL-DEV COMMANDS
  dev [path]         Point the pm-agent channel at a working tree (default: cwd)
                       so Claude reads your live edits instead of the release
  reload [path]      Re-sync the working tree after edits (validate + clean
                       reinstall). Use this on every change while developing.
  validate [path]    Validate the marketplace + plugin manifests (--strict)
  release <level>    Cut a release: bump (patch|minor|major), tag, push, publish
                       to npm. Run from the repo (or pass its path).

LEDGER COMMANDS (the observational timeline — see docs/ledger.md)
  enable             Opt this repo into the ledger (--explicit for manual capture)
  disable            Opt this repo out (keeps the timeline data)
  timeline           Show the activity timeline (--days N, --thread REF, --json)
  inflight           Active threads, recent events, and loose ends
  loose              Open loose ends (loose resolve <id> to close one)
  log <summary...>   Record an event (--type, --thread, --issue, --commit …)
  thread             list | new <title> | set <id> (--status, --genesis …)
  issue-title <n> …  Set the #-glossary title for an issue
  config [key] [val] capture=observer|explicit, etc.
  serve              Serve the operator UI (--port)

MISC
  check-update       Print a one-line notice if a newer release is on npm
                       (throttled; used by the SessionStart hook)
  help, --help       Show this help
  --version          Show the CLI version

After any command that changes plugins, RESTART Claude Code to apply.
Docs: https://github.com/${REPO}
`;

function run(args, { tolerate = false } = {}) {
  const r = spawnSync("claude", args, { stdio: "inherit" });
  if (r.error?.code === "ENOENT") {
    fail("`claude` CLI not found on PATH. Install Claude Code first.");
  }
  if (r.status !== 0 && !tolerate) {
    fail(`\`claude ${args.join(" ")}\` exited ${r.status}.`);
  }
  return r.status === 0;
}

function fail(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

// Run a real binary (npm, git). Inherits stdio by default; pass capture:true to
// grab trimmed stdout instead.
function runLocal(bin, args, { cwd, tolerate = false, capture = false, timeout } = {}) {
  const r = spawnSync(bin, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    timeout,
  });
  if (r.error?.code === "ENOENT") {
    if (tolerate) return { ok: false, stdout: "" };
    fail(`\`${bin}\` not found on PATH.`);
  }
  if (r.status !== 0 && !tolerate) {
    fail(`\`${bin} ${args.join(" ")}\` exited ${r.status}.`);
  }
  return { ok: r.status === 0, stdout: (r.stdout || "").trim() };
}

// Compare two version strings by their x.y.z core; a prerelease (1.0.0-beta) sorts
// below the same core release. Returns 1 if a > b, -1 if a < b, 0 if equal.
function cmpVer(a, b) {
  const core = (v) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  const apr = a.includes("-");
  const bpr = b.includes("-");
  if (!apr && bpr) return 1;
  if (apr && !bpr) return -1;
  return 0;
}

// Reload only makes sense against a working tree. Refuse if the channel is
// bound to anything but a directory source (e.g. the published GitHub install),
// so reload can't silently reinstall the wrong thing. Keeps reload dev-only.
function assertDevInstall() {
  const r = spawnSync("claude", ["plugin", "marketplace", "list", "--json"], {
    encoding: "utf8",
  });
  if (r.error?.code === "ENOENT") fail("`claude` CLI not found on PATH.");
  let entry;
  try {
    entry = JSON.parse(r.stdout).find((m) => m.name === MARKETPLACE);
  } catch {
    return; // Can't determine source — don't block on a parse hiccup.
  }
  if (!entry) {
    fail(
      `${MARKETPLACE} isn't installed in dev mode. Run \`pm-agent dev <path>\` first.`
    );
  }
  if (entry.source !== "directory") {
    fail(
      `reload is dev-only: ${MARKETPLACE} is a "${entry.source}" source, not a working tree.\n` +
        `  Use \`pm-agent dev <path>\` to track a local checkout, or \`pm-agent update\` for the published plugin.`
    );
  }
}

function restartReminder() {
  process.stdout.write(
    "\n⚠️  RESTART Claude Code to apply — plugins load at startup.\n"
  );
}

// Resolve and sanity-check a working-tree path for dev/reload/validate.
function resolveTree(arg) {
  const tree = path.resolve(arg || process.cwd());
  const manifest = path.join(tree, ".claude-plugin", "marketplace.json");
  if (!existsSync(manifest)) {
    fail(
      `No marketplace manifest at ${manifest}.\n` +
        `  Run this from the pm-agent repo root, or pass the path: pm-agent dev <path>`
    );
  }
  return tree;
}

function cmdInstall() {
  // Bind the channel slot to the installed package files (idempotent: re-point if
  // already present). The package must already be on disk via `npm install -g`.
  run(["plugin", "marketplace", "remove", MARKETPLACE], { tolerate: true });
  run(["plugin", "marketplace", "add", PKG_ROOT]);
  run(["plugin", "install", `${PLUGIN}@${MARKETPLACE}`]);
  process.stdout.write(`✅ Installed ${PLUGIN}@${MARKETPLACE} from ${PKG_ROOT}.\n`);
  restartReminder();
}

function cmdUpdate() {
  process.stdout.write("▶ Fetching the latest release from npm…\n");
  runLocal("npm", ["install", "-g", `${NPM_PKG}@latest`]);
  // npm rewrote the package files in place (PKG_ROOT path is unchanged); refresh
  // Claude's cached copy with a clean reinstall so the new files take effect.
  run(["plugin", "marketplace", "remove", MARKETPLACE], { tolerate: true });
  run(["plugin", "marketplace", "add", PKG_ROOT]);
  run(["plugin", "uninstall", PLUGIN], { tolerate: true });
  run(["plugin", "install", `${PLUGIN}@${MARKETPLACE}`]);
  process.stdout.write(`✅ Updated ${PLUGIN} to the latest released version.\n`);
  restartReminder();
}

function cmdCheckUpdate() {
  // Throttled, silent, never fatal — runs from the SessionStart hook, so it must
  // never block startup or print noise. One real network call per day at most.
  const stamp = path.join(os.tmpdir(), "pm-agent-update-check.json");
  const DAY = 24 * 60 * 60 * 1000;
  try {
    const prev = JSON.parse(readFileSync(stamp, "utf8"));
    if (Date.now() - (prev.checkedAt || 0) < DAY) return;
  } catch {
    /* no/invalid stamp — fall through and check now */
  }

  let installed;
  try {
    installed = JSON.parse(
      readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")
    ).version;
  } catch {
    return;
  }

  const r = spawnSync("npm", ["view", NPM_PKG, "version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    writeFileSync(stamp, JSON.stringify({ checkedAt: Date.now() }));
  } catch {
    /* best-effort throttle */
  }
  if (r.status !== 0) return;
  const latest = (r.stdout || "").trim();
  if (latest && cmpVer(latest, installed) > 0) {
    process.stdout.write(
      `[pm-agent] Update available: ${installed} → ${latest}. ` +
        `Tell the user they can run /pm:update to upgrade (then restart Claude Code).\n`
    );
  }
}

const RELEASE_LEVELS = new Set([
  "patch",
  "minor",
  "major",
  "prepatch",
  "preminor",
  "premajor",
  "prerelease",
]);

function cmdRelease(level, treeArg) {
  if (!level || !RELEASE_LEVELS.has(level)) {
    fail(`release needs a level: ${[...RELEASE_LEVELS].join(" | ")}.`);
  }
  const tree = resolveTree(treeArg);
  // Release only tags and publishes work that's already committed — it never
  // sweeps in loose changes. Stop if the tree is dirty.
  const status = runLocal("git", ["-C", tree, "status", "--porcelain"], {
    capture: true,
  });
  if (status.stdout) {
    fail(
      "Working tree has uncommitted changes. Commit (or stash) them first — " +
        "release only tags and publishes what's already committed."
    );
  }

  process.stdout.write(`▶ Bumping version (${level})…\n`);
  // `npm version` bumps package.json, runs the "version" script (which syncs
  // plugin.json and stages it), then makes the version commit and the vX.Y.Z tag.
  runLocal("npm", ["version", level], { cwd: tree });
  const version = JSON.parse(
    readFileSync(path.join(tree, "package.json"), "utf8")
  ).version;

  process.stdout.write(`▶ Pushing main + tag v${version}…\n`);
  runLocal("git", ["-C", tree, "push", "--follow-tags"]);

  process.stdout.write("▶ Publishing to npm…\n");
  runLocal("npm", ["publish"], { cwd: tree });

  process.stdout.write(
    `\n✅ Released v${version} — pushed to GitHub and published to npm.\n` +
      `   Users upgrade with \`pm-agent update\` (or /pm:update).\n`
  );
}

function cmdUninstall() {
  run(["plugin", "uninstall", PLUGIN], { tolerate: true });
  run(["plugin", "marketplace", "remove", MARKETPLACE], { tolerate: true });
  process.stdout.write(`✅ Removed ${PLUGIN} and the ${MARKETPLACE} marketplace.\n`);
  restartReminder();
}

function cmdDev(arg) {
  const tree = resolveTree(arg);
  // Repoint the single channel slot from GitHub (if set) to this working tree.
  run(["plugin", "marketplace", "remove", MARKETPLACE], { tolerate: true });
  run(["plugin", "marketplace", "add", tree]);
  run(["plugin", "uninstall", PLUGIN], { tolerate: true });
  run(["plugin", "install", `${PLUGIN}@${MARKETPLACE}`]);
  process.stdout.write(
    `✅ Dev mode: ${PLUGIN}@${MARKETPLACE} now tracks ${tree}.\n` +
      `   Edit files → \`pm-agent reload\` → restart Claude Code.\n`
  );
  restartReminder();
}

function cmdReload(arg) {
  const tree = resolveTree(arg);
  assertDevInstall();
  process.stdout.write("▶ Validating…\n");
  if (!run(["plugin", "validate", tree, "--strict"], { tolerate: true })) {
    fail("Validation failed — fix the manifest before reloading (nothing changed).");
  }
  run(["plugin", "marketplace", "update", MARKETPLACE], { tolerate: true });
  // Clean reinstall so an unchanged version string never no-ops the reload.
  run(["plugin", "uninstall", PLUGIN], { tolerate: true });
  run(["plugin", "install", `${PLUGIN}@${MARKETPLACE}`]);
  process.stdout.write(`✅ Reloaded ${PLUGIN} from ${tree}.\n`);
  restartReminder();
}

function cmdValidate(arg) {
  const tree = resolveTree(arg);
  run(["plugin", "validate", tree, "--strict"]);
}

function cmdVersion() {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
}

const argv = process.argv.slice(2);
const [cmd, arg] = argv;

switch (cmd) {
  case "install":
    cmdInstall();
    break;
  case "update":
    cmdUpdate();
    break;
  case "check-update":
    cmdCheckUpdate();
    break;
  case "release":
    cmdRelease(arg, argv[2]);
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case "dev":
    cmdDev(arg);
    break;
  case "reload":
    cmdReload(arg);
    break;
  case "validate":
    cmdValidate(arg);
    break;
  case "enable":
  case "disable":
  case "log":
  case "thread":
  case "timeline":
  case "inflight":
  case "loose":
  case "issue-title":
  case "config":
  case "context":
  case "observe":
  case "ingest":
  case "synthesize":
  case "recluster":
  case "serve": {
    // Lazily load the ledger (pulls in node:sqlite) so install/update stay dependency-light.
    const { runLedger } = await import("../packages/db/cli.js");
    await runLedger(cmd, argv.slice(1));
    break;
  }
  case "--version":
  case "-v":
    cmdVersion();
    break;
  case undefined:
  case "help":
  case "-h":
  case "--help":
    process.stdout.write(help);
    break;
  default:
    process.stderr.write(`Unknown command: ${cmd}\n${help}`);
    process.exit(1);
}
