#!/usr/bin/env node
// Single source of truth for the session-injected branch-hygiene contract:
// docs/how-work-happens.md carries the text between the session-contract markers,
// and this script extracts it into packages/db/session-contract.js — the generated
// module `pm-agent context` (cmdContext) imports. Edit the doc, then run
// `npm run sync:contract`. packages/db/contract.sync.test.js re-runs this
// extraction in-memory and fails `npm test` while doc and module drift.
//
// Import-safe: exports the extraction helpers with no side effects; only writes
// when executed directly.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DOC_PATH = path.join(root, "docs", "how-work-happens.md");
export const MODULE_PATH = path.join(root, "packages", "db", "session-contract.js");

const START = "<!-- session-contract:start -->";
const END = "<!-- session-contract:end -->";

// The contract paragraphs: the text between the markers, split on blank lines,
// with the doc's hard-wrapped lines rejoined into one injectable line each.
export function extractContract(docText) {
  const start = docText.indexOf(START);
  const end = docText.indexOf(END);
  if (start === -1 || end === -1 || end < start)
    throw new Error("session-contract markers not found in docs/how-work-happens.md");
  return docText
    .slice(start + START.length, end)
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

export function renderModule(paragraphs) {
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    "// Source: the session-contract section of docs/how-work-happens.md.",
    "// Regenerate with `npm run sync:contract` (scripts/sync-session-contract.mjs);",
    "// packages/db/contract.sync.test.js fails `npm test` while this file drifts",
    "// from the doc.",
    "",
    "export const branchHygieneContract = [",
    ...paragraphs.map((p) => `  ${JSON.stringify(p)},`),
    "];",
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const generated = renderModule(extractContract(readFileSync(DOC_PATH, "utf8")));
  let current = null;
  try {
    current = readFileSync(MODULE_PATH, "utf8");
  } catch {}
  if (current !== generated) {
    writeFileSync(MODULE_PATH, generated);
    console.log(`Synced ${path.relative(root, MODULE_PATH)} from docs/how-work-happens.md`);
  } else {
    console.log("session-contract.js already in sync");
  }
}
