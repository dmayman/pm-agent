// Tests for the distiller response parser. Run with `node --test` (Node >= 22.5, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSessionAnalysis } from "./observe.js";

test("new multi-goal shape → goals array used as-is", () => {
  const text = JSON.stringify({
    goals: [
      { text: "Ship the zone model", initiative: "Zone model", isNew: true },
      { text: "Deterministic dup cleanup", initiative: "Dup cleanup", isNew: true },
    ],
    events: [{ type: "decided", summary: "Framed three workstreams", thread: "Zone model" }],
  });
  const { goals, events } = extractSessionAnalysis(text);
  assert.equal(goals.length, 2);
  assert.equal(goals[0].text, "Ship the zone model");
  assert.equal(goals[1].initiative, "Dup cleanup");
  assert.equal(events.length, 1);
});

test("legacy singular-goal object → wrapped as one-element array", () => {
  const text = JSON.stringify({
    goal: { text: "Refine the coach behavior", initiative: "Coach exec layer", isNew: false },
    events: [{ type: "built", summary: "Wired the loop" }],
  });
  const { goals, events } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "Refine the coach behavior");
  assert.equal(goals[0].initiative, "Coach exec layer");
  assert.equal(events.length, 1);
});

test("bare array → events only, empty goals", () => {
  const text = JSON.stringify([
    { type: "tested", summary: "Ran the suite", thread: "CI" },
    { type: "note", summary: "Flaky test observed" },
  ]);
  const { goals, events } = extractSessionAnalysis(text);
  assert.deepEqual(goals, []);
  assert.equal(events.length, 2);
});

test("goals array filters out non-object / textless entries", () => {
  const text = JSON.stringify({
    goals: [
      { text: "Real goal", initiative: "X" },
      { initiative: "Y" }, // no text — dropped
      null, // dropped
      "just a string", // dropped
      { text: "", initiative: "Z" }, // empty text — dropped
    ],
    events: [],
  });
  const { goals } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "Real goal");
});

test("object with events but no goals key → empty goals", () => {
  const text = JSON.stringify({ events: [{ type: "note", summary: "hi" }] });
  const { goals, events } = extractSessionAnalysis(text);
  assert.deepEqual(goals, []);
  assert.equal(events.length, 1);
});

test("malformed / non-JSON input never throws → empty result", () => {
  for (const bad of ["", "not json at all", "{ goals: [", "```json\n{bad}\n```", null, undefined]) {
    const r = extractSessionAnalysis(bad);
    assert.ok(Array.isArray(r.goals), `goals array for input ${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(r.events), `events array for input ${JSON.stringify(bad)}`);
  }
});

test("goals present but events missing → events defaults to empty array", () => {
  const text = JSON.stringify({ goals: [{ text: "G", initiative: "I" }] });
  const { goals, events } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.deepEqual(events, []);
});

test("prose wrapping a JSON object is tolerated (tolerant slicing)", () => {
  const text = 'Here you go:\n{"goals":[{"text":"G","initiative":"I"}],"events":[]}\nHope that helps!';
  const { goals } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "G");
});
