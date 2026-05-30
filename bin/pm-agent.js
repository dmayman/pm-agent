#!/usr/bin/env node
// pm-agent — CLI / bootstrapper.
//
// Wraps the `claude plugin …` commands so install / update / local-dev are one
// command each. As the tool grows this also becomes the launcher for the local
// server + web UI. Dependency-free so `npx pm-agent` works with zero install.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = "dmayman/pm-agent"; // GitHub source for the stable channel
const MARKETPLACE = "pm-agent"; // marketplace.json "name" — the single channel slot
const PLUGIN = "pm"; // plugin.json "name"
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, "..");

const help = `
pm-agent — work-orchestration tool with a Claude Code plugin

USAGE
  pm-agent <command>

END-USER COMMANDS
  install            Register the GitHub marketplace and install the pm plugin
  update             Pull the latest plugin and update it (stable channel)
  uninstall          Remove the pm plugin and the marketplace

LOCAL-DEV COMMANDS
  dev [path]         Point the pm-agent channel at a working tree (default: cwd)
                       so Claude reads your live edits instead of GitHub
  reload [path]      Re-sync the working tree after edits (validate + clean
                       reinstall). Use this on every change while developing.
  validate [path]    Validate the marketplace + plugin manifests (--strict)

MISC
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
  // Bind the channel slot to GitHub (idempotent: re-point if already present).
  run(["plugin", "marketplace", "remove", MARKETPLACE], { tolerate: true });
  run(["plugin", "marketplace", "add", REPO]);
  run(["plugin", "install", `${PLUGIN}@${MARKETPLACE}`]);
  process.stdout.write(`✅ Installed ${PLUGIN}@${MARKETPLACE} from ${REPO}.\n`);
  restartReminder();
}

function cmdUpdate() {
  run(["plugin", "marketplace", "update", MARKETPLACE]); // git pull from GitHub
  run(["plugin", "update", PLUGIN]);
  process.stdout.write(`✅ Updated ${PLUGIN} to the latest published version.\n`);
  restartReminder();
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

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "install":
    cmdInstall();
    break;
  case "update":
    cmdUpdate();
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
