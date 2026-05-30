#!/usr/bin/env node
// pm-agent — npx entrypoint (bootstrapper).
//
// Today this only points you at the Claude Code plugin. As the tool grows, this
// becomes the one-command installer/launcher: register the marketplace, install
// the `pm` plugin, start the local server + DB, and open the web UI.
//
// Intentionally dependency-free so `npx pm-agent` works with zero install.

const REPO = "dmayman/pm-agent";

const help = `
pm-agent — work-orchestration tool with a Claude Code plugin

The Claude Code plugin (\`pm\`) is the only surface shipping today. Install it:

  claude plugin marketplace add ${REPO}
  claude plugin install pm@pm-agent
  # then restart Claude Code

Local development (track your working copy instead of GitHub):

  claude plugin marketplace add <path-to-this-repo>
  claude plugin install pm@pm-agent

Roadmap (not yet built): local database + self-hosted web UI to replace Linear,
launched from this command.

Docs: https://github.com/${REPO}
`;

const cmd = process.argv[2];

switch (cmd) {
  case undefined:
  case "help":
  case "-h":
  case "--help":
    process.stdout.write(help);
    break;
  case "--version":
  case "-v": {
    // Read version from the sibling package.json without importing JSON modules.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    break;
  }
  default:
    process.stderr.write(`Unknown command: ${cmd}\n${help}`);
    process.exit(1);
}
