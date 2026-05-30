#!/usr/bin/env node
// Keep plugins/pm/.claude-plugin/plugin.json's version in lockstep with
// package.json. Run automatically by the npm "version" lifecycle, so a single
// `npm version <patch|minor|major>` bumps both the package and the plugin.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const pluginPath = path.join(root, "plugins", "pm", ".claude-plugin", "plugin.json");
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));

if (plugin.version !== pkg.version) {
  plugin.version = pkg.version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`Synced plugin.json → ${pkg.version}`);
} else {
  console.log(`plugin.json already at ${pkg.version}`);
}
