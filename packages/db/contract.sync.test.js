// Guards the doc/code sync of the session-injected branch-hygiene contract:
// re-runs the sync script's extraction in-memory against docs/how-work-happens.md
// and asserts the generated packages/db/session-contract.js matches. If this
// fails, someone edited one side without the other — run `npm run sync:contract`
// (and if the module was edited by hand, move the change into the doc instead).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractContract,
  renderModule,
  DOC_PATH,
  MODULE_PATH,
} from "../../scripts/sync-session-contract.mjs";
import { branchHygieneContract } from "./session-contract.js";

test("session-contract.js matches docs/how-work-happens.md (else: npm run sync:contract)", () => {
  const expected = renderModule(extractContract(readFileSync(DOC_PATH, "utf8")));
  assert.equal(readFileSync(MODULE_PATH, "utf8"), expected);
});

test("exported contract paragraphs equal the doc extraction", () => {
  const paragraphs = extractContract(readFileSync(DOC_PATH, "utf8"));
  assert.ok(paragraphs.length >= 1, "doc contract section must not be empty");
  assert.deepEqual(branchHygieneContract, paragraphs);
});
