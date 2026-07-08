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

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  preview            Launch a throwaway PREVIEW dashboard for THIS checkout's
                       branch, on its own port, against a scratch copy of your
                       real ledger — verify a change before merging without
                       touching your live observer. --stop | --fresh | --port N
  validate [path]    Validate the marketplace + plugin manifests (--strict)
  release <level>    Cut a release: bump (patch|minor|major), tag, push, publish
                       to npm. Run from the repo (or pass its path).

SET UP A REPO
  setup              Full setup in one shot: enable the ledger, scaffold the
                       GitHub-issues grooming workflow, and point you to the
                       dashboard. Flags: --explicit, --no-issues, --serve, --port N
  enable             Ledger only — opt this repo into the timeline
                       (--explicit for manual capture)
  disable            Opt this repo out (keeps the timeline data)
  setup-issues       Grooming workflow only — enable Issues, create the
                       idea→ready→status:in-progress labels, and drop in the 💡 Idea
                       template. Needs an authenticated \`gh\`. Idempotent.

SET UP THE MACHINE (once, macOS)
  observer-url       Make the dashboard reachable at a bare http://observer
                       (maps /etc/hosts + redirects :80→:4477). Needs \`sudo\`;
                       run once per machine, not per repo. --uninstall to revert.
  observer-autostart Keep the dashboard server always running (a login LaunchAgent,
                       so you never run \`serve\` by hand). Run WITHOUT sudo.
                       --uninstall to revert. Pair with observer-url for \`observer/\`.

LEDGER COMMANDS (the observational timeline — see docs/ledger.md)
  timeline           Show the activity timeline (--days N, --thread REF, --json)
  inflight           Active threads, recent events, and loose ends
  loose              Open loose ends (loose resolve <id> to close one)
  log <summary...>   Record an event (--type, --thread, --issue, --commit …)
  thread             list | new <title> | set <id> (--status, --genesis …)
  initiative         Group issues by hand: new "<name>" --issues 43,49 | add | remove | list
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

// The three repo-agnostic grooming labels — the workflow an issue moves through:
// captured as an `idea`, scoped to `ready`, then claimed by a live coding session.
// Repo-specific `area:*` domain labels are intentionally left for you to add by hand.
const WORKFLOW_LABELS = [
  ["idea", "C5DEF5", "Raw idea — captured, not yet scoped or prioritized"],
  ["ready", "0E8A16", "Scoped and ready to be picked up"],
  ["status:in-progress", "E99695", "Claimed by a live coding session"],
];

const ISSUE_TEMPLATE_CONFIG = `blank_issues_enabled: true\n`;

const IDEA_TEMPLATE = `---
name: 💡 Idea
about: Capture a new idea or improvement — rough is fine, scoping comes later
title: ""
labels: ["idea"]
---

## What

<!-- The idea in a sentence or two. What would change, or what would exist that doesn't today? -->

## Why / the itch

<!-- What prompted this? What's annoying, missing, or limiting right now? -->

## Notes & open questions

<!-- Optional: half-formed thoughts, links, alternatives, things to decide before this is "ready". -->

<!--
Add an area:* label for this repo's domain, if you use them.
When it's been thought through and is ready to build, swap the \`idea\` label → \`ready\`.
-->
`;

// Scaffold the GitHub-issues grooming workflow: enable Issues, create the
// idea→ready→status:in-progress labels, and write the 💡 Idea template. This is the
// repo-agnostic half of "set up pm-agent on a repo" (the other half is the ledger,
// via `pm-agent enable`). Deterministic and idempotent; needs an authenticated `gh`.
function cmdSetupIssues() {
  if (!runLocal("gh", ["auth", "status"], { capture: true, tolerate: true }).ok) {
    fail("`gh` not found or not authenticated. Install the GitHub CLI and run `gh auth login`, then retry.");
  }
  const view = runLocal(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,hasIssuesEnabled,deleteBranchOnMerge"],
    { capture: true, tolerate: true }
  );
  if (!view.ok) fail("Not inside a GitHub repository gh can resolve (need an `origin` remote).");
  const { nameWithOwner: slug, hasIssuesEnabled, deleteBranchOnMerge } = JSON.parse(view.stdout);
  const top = runLocal("git", ["rev-parse", "--show-toplevel"], { capture: true, tolerate: true });
  if (!top.ok) fail("Not inside a git working tree.");
  const root = top.stdout;

  process.stdout.write(`Setting up the issue-grooming workflow for ${slug}…\n`);

  // 1. Issues on.
  if (hasIssuesEnabled) {
    process.stdout.write("  · Issues already enabled\n");
  } else {
    runLocal("gh", ["repo", "edit", slug, "--enable-issues"]);
    process.stdout.write("  · enabled Issues\n");
  }

  // 1b. Auto-delete head branches on merge — otherwise merged PR branches (and
  // any leftover worktree checkouts of them) just pile up forever.
  if (deleteBranchOnMerge) {
    process.stdout.write("  · branch auto-delete-on-merge already enabled\n");
  } else {
    runLocal("gh", ["repo", "edit", slug, "--delete-branch-on-merge"]);
    process.stdout.write("  · enabled auto-delete-on-merge for merged branches\n");
  }

  // 2. Workflow labels — `--force` upserts, so re-running just refreshes color/description.
  for (const [name, color, description] of WORKFLOW_LABELS) {
    runLocal("gh", ["label", "create", name, "--color", color, "--description", description, "--force"], {
      tolerate: true,
    });
    process.stdout.write(`  · label ${name}\n`);
  }

  // 3. Issue template — write only if absent, so a repo's customized template is never clobbered.
  const tdir = path.join(root, ".github", "ISSUE_TEMPLATE");
  mkdirSync(tdir, { recursive: true });
  const configPath = path.join(tdir, "config.yml");
  const ideaPath = path.join(tdir, "idea.md");
  if (existsSync(ideaPath)) {
    process.stdout.write("  · issue template already present (left as-is)\n");
  } else {
    if (!existsSync(configPath)) writeFileSync(configPath, ISSUE_TEMPLATE_CONFIG);
    writeFileSync(ideaPath, IDEA_TEMPLATE);
    process.stdout.write("  · added .github/ISSUE_TEMPLATE/idea.md\n");
  }

  process.stdout.write(
    "\n  The grooming loop: capture ideas as issues (labeled `idea`), scope them to\n" +
      "  `ready`, and a coding session flips `ready` → `status:in-progress` when it starts.\n" +
      "  Add `area:*` labels by hand for this repo's domains.\n" +
      "  Commit .github/ISSUE_TEMPLATE/ to share the template with the repo.\n"
  );
}

// The one-shot repo setup: enable the ledger (backfills the timeline), scaffold the
// issue-grooming workflow, and leave the user at the dashboard. Each step is idempotent,
// so re-running is safe. Grooming is skipped cleanly (not fatally) when `gh` is missing
// or `--no-issues` is passed — the ledger still gets set up.
async function cmdSetup(argv) {
  const flags = new Set(
    argv.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")[0])
  );
  const { runLedger } = await import("../packages/db/cli.js");

  // 1. Ledger — opt in + backfill the timeline. This is what populates the dashboard.
  process.stdout.write("① Ledger\n");
  await runLedger("enable", flags.has("explicit") ? ["--explicit"] : []);

  // 2. Issue-grooming workflow — best-effort; the ledger is already set up regardless.
  process.stdout.write("\n② Issue grooming\n");
  if (flags.has("no-issues")) {
    process.stdout.write("  · skipped (--no-issues)\n");
  } else if (!runLocal("gh", ["auth", "status"], { capture: true, tolerate: true }).ok) {
    process.stdout.write(
      "  · skipped — `gh` not found or not authenticated.\n" +
        "    Run `gh auth login`, then `pm-agent setup-issues` to add it.\n"
    );
  } else {
    cmdSetupIssues();
  }

  // 3. Dashboard — the whole point is to end up looking at it.
  process.stdout.write("\n③ Dashboard\n");
  if (flags.has("serve")) {
    const portArgs = argv.filter((a) => a.startsWith("--port"));
    await runLedger("serve", portArgs); // blocks until Ctrl-C
  } else {
    // The pretty http://observer URL is a machine-global, once-per-machine step — surface
    // it here (offer it, or point at it) but never run its sudo from this per-repo setup.
    const url = observerWired() ? "type  observer/  in your browser" : "http://localhost:4477";
    const prettyHint = observerWired()
      ? ""
      : "\n     Tired of the port? One time, machine-wide:  sudo pm-agent observer-url\n" +
        "       — then you just type  observer/  in your browser (no port, ever).\n";
    process.stdout.write(
      "  ✅ Setup complete.\n\n" +
        `     See the dashboard:   pm-agent serve      → ${url}\n` +
        prettyHint +
        "     Restart Claude Code so the session hooks pick up the ledger.\n"
    );
  }
}

// Is the http://observer alias already wired into this machine? (Just the /etc/hosts half —
// enough to decide whether `setup` should offer the one-time step or point at the live URL.)
function observerWired() {
  try {
    return /^[^#\n]*\bobserver\b/m.test(readFileSync("/etc/hosts", "utf8"));
  } catch {
    return false;
  }
}

// Machine-global, one-time: make the operator UI reachable at a bare http://observer by
// wiring /etc/hosts + a loopback :80→:4477 pf redirect (+ a LaunchDaemon to re-arm pf on
// boot). Privileged and NOT per-repo, so it's its own command rather than part of `setup`.
// `--uninstall` reverts every change. macOS-only.
function cmdObserverUrl(rest) {
  if (process.platform !== "darwin") {
    fail(
      "observer-url is macOS-only (it uses /etc/hosts + pf). Elsewhere, add an\n" +
        "  /etc/hosts entry for `observer` and redirect :80 → :4477 with your own tooling."
    );
  }
  const undo = rest.includes("--uninstall") || rest.includes("--remove");
  const script = path.join(
    PKG_ROOT,
    "scripts",
    undo ? "observer-hostname-uninstall.sh" : "observer-hostname-setup.sh"
  );
  if (!existsSync(script)) fail(`missing ${script} (reinstall the package).`);
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    process.stderr.write(
      "This needs root — it edits /etc/hosts and /etc/pf.conf.\n" +
        `Re-run:  sudo pm-agent observer-url${undo ? " --uninstall" : ""}\n`
    );
    process.exit(1);
  }
  runLocal("sh", [script]);
}

// Keep the operator UI always-on via a user-level LaunchAgent (runs `pm-agent serve` at login,
// restarts if it dies). Unprivileged on purpose — the server writes the ledger as *you*, so
// this must NOT run under sudo (root-owned db files would lock the normal CLI out). Pairs with
// `observer-url` (the root port-80 redirect): together, `observer/` is always live.
function cmdObserverAutostart(rest) {
  if (process.platform !== "darwin") {
    fail("observer-autostart is macOS-only (it uses a launchd LaunchAgent).");
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    fail(
      "Don't run this with sudo — it installs a LaunchAgent that runs as YOU, so the\n" +
        "  ledger stays yours. Re-run without sudo:  pm-agent observer-autostart"
    );
  }
  const undo = rest.includes("--uninstall") || rest.includes("--remove");
  const home = os.homedir();
  const plist = path.join(home, "Library", "LaunchAgents", "com.pm-agent.observer-server.plist");
  const uid = process.getuid();
  const domain = `gui/${uid}`;

  if (undo) {
    runLocal("launchctl", ["bootout", `${domain}/com.pm-agent.observer-server`], {
      tolerate: true,
      capture: true,
    });
    runLocal("launchctl", ["unload", plist], { tolerate: true, capture: true });
    if (existsSync(plist)) {
      spawnSync("rm", ["-f", plist]);
    }
    process.stdout.write("✓ Auto-start removed. The server no longer runs on its own.\n");
    return;
  }

  // Point launchd straight at this node + CLI (its PATH is minimal, so no bare `pm-agent`).
  const node = process.execPath;
  const cli = path.join(HERE, "pm-agent.js");
  const log = path.join(home, "Library", "Logs", "pm-agent-observer.log");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pm-agent.observer-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
  mkdirSync(path.dirname(plist), { recursive: true });
  writeFileSync(plist, body);
  // Reload cleanly if it was already installed (swallow the "not loaded" noise), then
  // bootstrap into the GUI session.
  runLocal("launchctl", ["bootout", `${domain}/com.pm-agent.observer-server`], {
    tolerate: true,
    capture: true,
  });
  const boot = runLocal("launchctl", ["bootstrap", domain, plist], { tolerate: true, capture: true });
  if (!boot.ok) runLocal("launchctl", ["load", "-w", plist], { tolerate: true, capture: true });

  process.stdout.write(
    "✓ Auto-start installed. The dashboard server now runs at login and restarts if it\n" +
      "  stops — you never have to run `pm-agent serve` by hand again.\n" +
      `  Logs: ${log}\n\n` +
      (observerWired()
        ? "  Just type  observer/  in your browser, anytime.\n"
        : "  Add the memorable URL too:  sudo pm-agent observer-url  → then type  observer/\n")
  );
}

// The real ledger home (where the always-on observer reads/writes). The preview runs against a
// throwaway COPY of this, so its data never touches yours.
function realHome() {
  return process.env.PM_AGENT_HOME || path.join(os.homedir(), ".pm-agent");
}

// Is a pid still alive? (signal 0 = existence check; EPERM means alive but not ours.)
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Stop a running preview named by the rendezvous file, and remove the file. Quiet mode is for the
// idempotent restart path (relaunching `preview` tears down the old one first).
function stopPreview({ quiet = false } = {}) {
  const rendezvous = path.join(realHome(), "preview.json");
  let info = null;
  try {
    info = JSON.parse(readFileSync(rendezvous, "utf8"));
  } catch {
    if (!quiet) process.stdout.write("No preview is running.\n");
    return;
  }
  if (info?.pid && pidAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {}
  }
  try {
    unlinkSync(rendezvous);
  } catch {}
  if (!quiet) process.stdout.write(`✓ Stopped the preview (was ${info?.url || "?"}).\n`);
}

// Spin up a PREVIEW dashboard: a second observer serving THIS checkout's code (the branch under
// test) on its own port, against a scratch DB copied fresh from your real ledger — so you can
// click a link and verify a change before merging, without touching your always-on observer or
// its data. Idempotent: relaunching restarts + re-seeds. `--stop` tears it down; `--fresh` starts
// from an empty DB instead of copying prod; `--port N` overrides the port (default 4478).
// Poll until `pid` is gone (or the timeout lapses), so a restart never races the old server for
// the port. Naps ~80ms per turn via a throwaway node -e (no shell); this path runs briefly.
function waitForExit(pid, timeoutMs = 4000) {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},80)"]);
  }
}

// The URL of your real (always-on) observer, so the preview can link back to it. The real `serve`
// records it in observer.json on startup; fall back to the default port if it hasn't.
function parentObserverUrl(home) {
  try {
    const j = JSON.parse(readFileSync(path.join(home, "observer.json"), "utf8"));
    if (j && j.url) return j.url;
  } catch {}
  return "http://localhost:4477";
}

function cmdPreview(rest) {
  if (rest.includes("--stop") || rest.includes("--remove")) {
    stopPreview();
    return;
  }
  const home = realHome();
  mkdirSync(home, { recursive: true });

  const mainTree = process.cwd();
  if (!existsSync(path.join(mainTree, "bin", "pm-agent.js"))) {
    fail("Run `pm-agent preview` from the pm-agent repo checkout you want to preview.");
  }
  const branch =
    rest.find((a) => !a.startsWith("--")) ||
    runLocal("git", ["-C", mainTree, "rev-parse", "--abbrev-ref", "HEAD"], {
      capture: true,
      tolerate: true,
    }).stdout ||
    "HEAD";
  if (!runLocal("git", ["-C", mainTree, "rev-parse", "--verify", "--quiet", branch], { capture: true, tolerate: true }).ok) {
    fail(`No such branch: ${branch}`);
  }

  const portArg = rest.find((a) => a.startsWith("--port"));
  const port =
    Number((portArg && (portArg.split("=")[1] || rest[rest.indexOf(portArg) + 1])) || 0) || 4478;

  // Stop any prior preview and WAIT for it to release the port before we rebind it.
  let old = null;
  try {
    old = JSON.parse(readFileSync(path.join(home, "preview.json"), "utf8"));
  } catch {}
  stopPreview({ quiet: true });
  if (old && old.pid) waitForExit(old.pid);

  // The dedicated preview worktree, checked out DETACHED at the branch tip (detached so it can
  // mirror a branch that's also checked out in your main tree; git forbids two live checkouts).
  const previewTree = path.join(home, "preview-tree");
  if (existsSync(path.join(previewTree, ".git"))) {
    const sw = runLocal("git", ["-C", previewTree, "checkout", "--detach", branch], { capture: true, tolerate: true });
    if (!sw.ok) fail(`Couldn't point the preview worktree at ${branch}. Try: pm-agent preview --stop`);
  } else {
    rmSync(previewTree, { recursive: true, force: true });
    const add = runLocal("git", ["-C", mainTree, "worktree", "add", "--detach", previewTree, branch], {
      capture: true,
      tolerate: true,
    });
    if (!add.ok) fail(`Couldn't create the preview worktree at ${previewTree}.`);
  }

  // Reset the scratch home and re-seed from prod (unless --fresh).
  const scratchHome = path.join(home, "preview-home");
  rmSync(scratchHome, { recursive: true, force: true });
  mkdirSync(scratchHome, { recursive: true });
  const fresh = rest.includes("--fresh");
  if (!fresh) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = path.join(home, `pm.db${suffix}`);
      if (existsSync(src)) copyFileSync(src, path.join(scratchHome, `pm.db${suffix}`));
    }
  }

  // Detached `serve` from the preview worktree, pointed at the scratch home and flagged as a
  // preview (with the branch label and a link back to your real observer).
  const log = path.join(home, "preview.log");
  const out = openSync(log, "a");
  const child = spawn(process.execPath, [path.join(previewTree, "bin", "pm-agent.js"), "serve", "--port", String(port)], {
    cwd: previewTree,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      PM_AGENT_HOME: scratchHome,
      PM_AGENT_REAL_HOME: home,
      PM_AGENT_PREVIEW: "1",
      PM_AGENT_PREVIEW_BRANCH: branch,
      PM_AGENT_PARENT_URL: parentObserverUrl(home),
    },
  });
  child.unref();

  const url = `http://localhost:${port}`;
  writeFileSync(
    path.join(home, "preview.json"),
    JSON.stringify({ url, branch, port, pid: child.pid, tree: previewTree, startedAt: new Date().toISOString() })
  );
  process.stdout.write(
    `\n🔬 Preview live  ·  branch ${branch}\n` +
      `  -> ${url}\n\n` +
      `  ${fresh ? "Empty scratch DB" : "Scratch DB copied from your real ledger"} — changes here never touch prod.\n` +
      `  Serving the committed state of ${branch} from a hidden worktree; your real checkout is untouched.\n` +
      `  Switch branches from the preview's amber bar, or:  pm-agent preview <branch>\n` +
      `  Stop it with:  pm-agent preview --stop\n  Logs: ${log}\n`
  );
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
  case "setup":
    await cmdSetup(argv.slice(1));
    break;
  case "setup-issues":
    cmdSetupIssues();
    break;
  case "observer-url":
    cmdObserverUrl(argv.slice(1));
    break;
  case "observer-autostart":
    cmdObserverAutostart(argv.slice(1));
    break;
  case "preview":
    cmdPreview(argv.slice(1));
    break;
  case "enable":
  case "disable":
  case "log":
  case "thread":
  case "initiative":
  case "area":
  case "reclassify":
  case "timeline":
  case "inflight":
  case "loose":
  case "issue-title":
  case "config":
  case "context":
  case "observe":
  case "ingest":
  case "refresh":
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
