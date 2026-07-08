// Work model — the layer the user actually cares about: not individual commits, but the
// lifecycle of each unit of work (did a branch open, get committed to, and merge & close —
// or is it still open and unfinished?), and how related issues group into one root idea.
//
//   sync issue state (gh) + open branches (git) → per-issue status
//   cluster issues into initiatives (Haiku)      → thread = root idea
//   re-thread the commit/PR events by initiative → evidence under the story

import { execFileSync } from "node:child_process";
import * as S from "./store.js";
import { runHaiku } from "./haiku.js";

function sh(cmd, args, cwd) {
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
function ghJson(args, cwd) {
  const out = sh("gh", args, cwd);
  if (out == null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const branchIssue = (b) => {
  const m = /(\d+)/.exec(b || "");
  return m ? Number(m[1]) : null;
};

// Pull issue identity + state from gh. Returns count or null when gh is unavailable.
export function syncIssues(db, repo, { limit = 300 } = {}) {
  const issues = ghJson(
    ["issue", "list", "--state", "all", "--limit", String(limit), "--json", "number,title,state,createdAt,closedAt"],
    repo.root
  );
  if (!issues) return null;
  for (const i of issues) {
    S.upsertIssue(db, repo.id, {
      number: i.number,
      title: i.title,
      state: i.state, // OPEN | CLOSED
      opened_at: i.createdAt || null,
      closed_at: i.closedAt || null,
    });
  }
  return issues.length;
}

// Find branches with unmerged work (a branch opened for an issue that never merged into the
// default branch) and record them on their issue — this is what "unfinished" means.
export function syncOpenBranches(db, repo) {
  // Clear stale branch marks first, then re-mark from live unmerged branches.
  for (const iss of S.listIssues(db, repo.id)) {
    if (iss.branch) S.setIssueFields(db, repo.id, iss.number, { branch: null });
  }
  // GitHub knows a branch merged even when git ancestry doesn't: a squash-merge lands the
  // branch's work as one NEW commit on main, so the branch's own commits are never ancestors
  // and `git branch --no-merged` still lists it. Trust the merged-PR record to exclude those
  // stale-but-merged branches (otherwise they masquerade as loose threads). See feat/48.
  const mergedPrs = ghJson(
    ["pr", "list", "--state", "merged", "--limit", "200", "--json", "headRefName"],
    repo.root
  );
  const mergedBranches = new Set((mergedPrs || []).map((p) => p.headRefName));

  // Prefer origin's default branch as the merge base.
  const base =
    (sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], repo.root) || "")
      .trim()
      .replace(/^refs\/remotes\//, "") || "origin/main";
  const out = sh("git", ["branch", "-r", "--no-merged", base], repo.root);
  if (out == null) return 0;
  let n = 0;
  for (let line of out.split("\n")) {
    line = line.trim();
    if (!line || line.includes("->") || line.endsWith("/HEAD")) continue;
    const short = line.replace(/^origin\//, "");
    if (short === "main" || short === "master") continue;
    if (mergedBranches.has(short)) continue; // squash-merged: content is in main, not a loose end
    const issue = branchIssue(short);
    if (issue) {
      S.setIssueFields(db, repo.id, issue, { branch: short });
      n++;
    }
  }
  return n;
}

// Derive each issue's status from its lifecycle:
//   done        — issue closed (branch → commits → merged & closed, the clean finish)
//   in_progress — open, with an unmerged branch (started but unfinished — a loose thread)
//   shipped     — open, but its work already merged (a different loose end: never closed)
//   todo        — open, no work started
// Returns the set of thread ids whose issues changed status (so callers can re-synthesize
// exactly the affected thread summaries — the "what's next" line depends on these).
export function computeStatuses(db, repo) {
  const hasMerged = db.prepare(
    `SELECT COUNT(*) c FROM events
       WHERE repo_id = ? AND json_extract(refs, '$.issue') = ?
         AND (type = 'merged' OR json_extract(refs, '$.pr') IS NOT NULL)`
  );
  const changedThreads = new Set();
  for (const iss of S.listIssues(db, repo.id)) {
    let status;
    if (iss.state === "CLOSED") status = "done";
    else if (iss.branch) status = "in_progress";
    else if (hasMerged.get(repo.id, iss.number).c > 0) status = "shipped";
    else status = "todo";
    if (status !== iss.status) {
      if (iss.thread_id) changedThreads.add(iss.thread_id);
      S.setIssueFields(db, repo.id, iss.number, { status });
    }
  }
  return changedThreads;
}

// The deterministic git/GitHub refresh: re-pull issue state + open branches and recompute
// lifecycle. No Haiku, no clustering — cheap enough to run silently on a heartbeat. Returns
// { changedThreads, ghAvailable }. clusterIntoInitiatives is deliberately NOT called here:
// re-grouping is a heavier, less frequent operation left to `ingest`/`recluster`.
export function refreshLifecycle(db, repo) {
  const issues = syncIssues(db, repo); // open/closed state (null if gh unavailable)
  syncOpenBranches(db, repo); // unfinished-branch marks (uses merged-PR exclusion)
  const changedThreads = computeStatuses(db, repo);
  return { changedThreads, ghAvailable: issues !== null };
}

// Cluster issues into initiatives with Haiku, then rebuild threads so each thread is one
// initiative (root idea) and its issues' commit/PR events hang under it.
//
// Pins are honored: an issue whose membership was set by hand (pinned = 1) is never moved
// or re-asked about — its initiative and thread survive verbatim, and Haiku is only asked
// to group the *unpinned* remainder (told about the pinned initiatives so it can extend
// them rather than duplicate them). `guidance` steers the grouping; when omitted it falls
// back to the repo's stored cluster.guidance rubric.
export async function clusterIntoInitiatives(db, repo, { guidance } = {}) {
  if (guidance == null) guidance = S.effectiveConfig(db, repo.slug, "cluster.guidance", null);

  const all = S.listIssues(db, repo.id).filter((i) => i.title);
  if (!all.length) return 0;

  const pinned = all.filter((i) => i.pinned && i.thread_id);
  const unpinned = all.filter((i) => !(i.pinned && i.thread_id));

  // The locked initiatives the pinned issues define — seed the name→thread map and show
  // them to Haiku as groups it may extend.
  const pinnedByThread = new Map();
  for (const i of pinned) {
    if (!pinnedByThread.has(i.thread_id)) pinnedByThread.set(i.thread_id, []);
    pinnedByThread.get(i.thread_id).push(i);
  }
  const locked = [...pinnedByThread.entries()]
    .map(([threadId, issues]) => {
      const t = S.getThread(db, threadId);
      return t ? { threadId, name: t.title, issues } : null;
    })
    .filter(Boolean);

  // The current (soft) grouping: existing threads that already have issues attached —
  // including the observer's soft links — but that AREN'T pinned-locked above. We show these
  // to Haiku as initiatives to PREFER reusing (advisory, not locked) so it keeps the same
  // name when an issue still fits, rather than re-homing it and orphaning the thread. They're
  // deliberately NOT seeded into byName: name-matching in the rebuild reuses the thread by
  // title when Haiku keeps the name, and the empty-thread DELETE cleans it up when it doesn't.
  const lockedThreadIds = new Set(locked.map((l) => l.threadId));
  const advisoryByThread = new Map();
  for (const i of all) {
    if (!i.thread_id || lockedThreadIds.has(i.thread_id)) continue;
    if (!advisoryByThread.has(i.thread_id)) advisoryByThread.set(i.thread_id, []);
    advisoryByThread.get(i.thread_id).push(i);
  }
  const advisory = [...advisoryByThread.entries()]
    .map(([threadId, issues]) => {
      const t = S.getThread(db, threadId);
      return t ? { threadId, name: t.title, issues } : null;
    })
    .filter(Boolean);

  let groups = [];
  if (unpinned.length) {
    const list = unpinned.map((i) => `#${i.number} ${i.title}`).join("\n");
    const lockedBlock = locked.length
      ? `These initiatives already exist and are locked. Use the EXACT same name when an ` +
        `issue below clearly belongs to one; otherwise make new initiatives:\n` +
        locked.map((l) => `- ${l.name}: ${l.issues.map((i) => "#" + i.number).join(", ")}`).join("\n") +
        `\n\n`
      : "";
    const advisoryBlock = advisory.length
      ? `These initiatives already exist — PREFER reusing them: keep the same name when an ` +
        `issue below fits one, and only regroup when it's clearly a better home:\n` +
        advisory.map((a) => `- ${a.name}: ${a.issues.map((i) => "#" + i.number).join(", ")}`).join("\n") +
        `\n\n`
      : "";
    const guide = guidance ? `Grouping guidance from the user — follow it: ${guidance}\n\n` : "";
    const prompt =
      `Below is a list of GitHub issues from one project. Group them into "initiatives" — a ` +
      `small number of higher-level root ideas or feature arcs that several issues share (e.g. ` +
      `"data ingest pipeline", "the plan model", "coach behavior"). Every issue goes in exactly ` +
      `one initiative. Aim for a handful of meaningful groups, not one giant bucket and not one ` +
      `per issue. Give each initiative a short, human name (not an issue title).\n\n` +
      guide +
      lockedBlock +
      advisoryBlock +
      `Issues to group:\n${list}\n\n` +
      `Return ONLY a JSON array: [{"initiative":"<name>","issues":[<numbers>]}]`;

    const out = runHaiku(prompt, repo.root, {
      timeout: 90000,
      meter: { db, repoId: repo.id, kind: "cluster" },
    });
    if (out) {
      try {
        const s = out.indexOf("[");
        const e = out.lastIndexOf("]");
        const parsed = JSON.parse(out.slice(s, e + 1));
        if (Array.isArray(parsed)) groups = parsed;
      } catch {
        groups = [];
      }
    }
    // Nothing usable came back and there are no pins to preserve — leave threads as-is.
    if (!groups.length && !locked.length) return 0;
  }

  // Rebuild: detach only the UNPINNED issues (pins keep their thread), then slot the
  // clustered groups onto threads, reusing locked threads by name.
  const byName = new Map(locked.map((l) => [l.name, l.threadId]));
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE issue_titles SET thread_id = NULL WHERE repo_id = ? AND (pinned = 0 OR pinned IS NULL)"
    ).run(repo.id);

    for (const g of groups) {
      if (!g || !g.initiative || !Array.isArray(g.issues) || !g.issues.length) continue;
      const name = String(g.initiative);
      let threadId = byName.get(name);
      if (!threadId) {
        const existing = S.findThreadByTitle(db, repo.id, name);
        threadId = existing ? existing.id : S.createThread(db, repo.id, { title: name });
        byName.set(name, threadId);
      }
      for (const num of g.issues) {
        const row = db
          .prepare("SELECT pinned FROM issue_titles WHERE repo_id = ? AND number = ?")
          .get(repo.id, Number(num));
        if (row && row.pinned) continue; // never override a pin, even if Haiku names it
        S.setIssueFields(db, repo.id, Number(num), { thread_id: threadId });
      }
    }

    // Reattach every issue-tagged event to whatever thread its issue now lives on.
    db.prepare("UPDATE events SET thread_id = NULL WHERE repo_id = ?").run(repo.id);
    db.prepare(
      `UPDATE events SET thread_id = (
         SELECT it.thread_id FROM issue_titles it
          WHERE it.repo_id = events.repo_id
            AND it.number = json_extract(events.refs, '$.issue'))
       WHERE repo_id = ? AND json_extract(refs, '$.issue') IS NOT NULL`
    ).run(repo.id);

    // Drop threads that ended up with no issues and no events (the old per-issue buckets).
    db.prepare(
      `DELETE FROM threads WHERE repo_id = ?
         AND id NOT IN (SELECT thread_id FROM issue_titles WHERE thread_id IS NOT NULL)
         AND id NOT IN (SELECT thread_id FROM events WHERE thread_id IS NOT NULL)`
    ).run(repo.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return byName.size;
}

// ---------------------------------------------------------------------------
// Reclassify — sort threads into areas + initiatives (the librarian pass)
// ---------------------------------------------------------------------------

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // "no activity in 7d" → an initiative can close

// Derive an initiative's lifecycle deterministically from its work, NOT from Haiku:
//   planned — no events logged yet (nothing has happened)
//   closed  — every issue done (vacuously true when there are none) AND no activity in 7d
//   active  — anything else (in flight)
export function inferLifecycle(db, threadId) {
  const last = db.prepare("SELECT MAX(ts) AS ts FROM events WHERE thread_id = ?").get(threadId).ts;
  if (!last) return "planned";
  const issues = S.issuesForThread(db, threadId);
  const allDone = issues.every((i) => i.status === "done");
  const stale = Date.now() - new Date(last).getTime() > STALE_MS;
  return allDone && stale ? "closed" : "active";
}

// A short gist of a thread for the classifier — its synthesized summary's first sentence (bold
// stripped), else its genesis, truncated.
function threadGist(t) {
  const src = t.summary || t.genesis || "";
  return src
    .replace(/\*\*/g, "")
    .split(/(?<=\.)\s/)[0]
    .slice(0, 160);
}

// Ask Haiku to sort the unpinned threads into areas vs initiatives, parent each initiative to an
// area (reusing the names already in play), and infer a one-line motivation for each. Returns a
// plan array [{title, kind:'area'|'initiative', area, why}] (empty on any failure).
function reclassifyPlan(db, repo, unpinned, existingAreas, guidance) {
  if (!unpinned.length) return [];
  const list = unpinned
    .map((t) => {
      const gist = threadGist(t);
      return `- "${t.title}" (${t.issue_count || 0} issues, ${t.event_count || 0} events)${gist ? ` — ${gist}` : ""}`;
    })
    .join("\n");
  const areaBlock = existingAreas.length
    ? `Areas that already exist — reuse these exact names when a thread fits one:\n` +
      existingAreas.map((a) => `- ${a.title}`).join("\n") +
      `\n\n`
    : "";
  const guide = guidance ? `Grouping guidance from the user — follow it: ${guidance}\n\n` : "";
  const prompt =
    `You are the librarian for a developer's work ledger. Each item below is a "thread" — an arc ` +
    `of work. Sort them into a two-level structure:\n` +
    `- An AREA is an evergreen domain of ongoing work that is never "done" (e.g. "Dashboard UI", ` +
    `"Observer & capture", "Developer tooling").\n` +
    `- An INITIATIVE is a bounded effort that lives inside one area and eventually finishes.\n\n` +
    `Most threads are initiatives. Create a small number of areas (reuse existing ones) and put ` +
    `each initiative under exactly one area. For every INITIATIVE, also infer a one-sentence ` +
    `"why" — the motivation or impact behind it — from its title and gist.\n\n` +
    guide +
    areaBlock +
    `Threads to classify:\n${list}\n\n` +
    `Return ONLY a JSON array, one object per thread above, using the EXACT titles:\n` +
    `[{"title":"<thread title>","kind":"area"|"initiative","area":"<area name, or null if kind is area>","why":"<one sentence, or null for areas>"}]`;
  const out = runHaiku(prompt, repo.root, {
    timeout: 90000,
    meter: { db, repoId: repo.id, kind: "cluster" },
  });
  if (!out) return [];
  try {
    const s = out.indexOf("[");
    const e = out.lastIndexOf("]");
    const parsed = JSON.parse(out.slice(s, e + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The librarian migration: sort existing threads into areas/initiatives, parent each initiative
// to an area (creating areas as needed), set lifecycle deterministically, and seed an inferred
// `why` (source='librarian') — WITHOUT ever moving a hand/agent-pinned placement or overwriting
// an agent-seeded why. Idempotent: reuses areas by name, recomputes lifecycle from live state.
// `plan` may be injected (tests) to bypass the Haiku call. Returns { areas, initiatives, moved }.
export async function reclassifyThreads(db, repo, { guidance, plan } = {}) {
  if (guidance == null) guidance = S.effectiveConfig(db, repo.slug, "cluster.guidance", null);

  const all = S.listThreads(db, repo.id).filter((t) => t.title);
  const pinned = all.filter((t) => t.placement_pinned);
  const unpinned = all.filter((t) => !t.placement_pinned);

  // Areas already in play (pinned or previously librarian-set) seed the reuse set + name cache.
  const areaCache = new Map();
  const existingAreas = all.filter((t) => t.kind === "area");
  for (const a of existingAreas) areaCache.set(a.title, a.id);

  if (!Array.isArray(plan)) plan = reclassifyPlan(db, repo, unpinned, existingAreas, guidance);
  const byTitle = new Map(plan.map((p) => [String(p.title), p]));

  // Resolve (creating if needed) the area thread for a name, marking it kind='area' unless it's
  // pinned to something else. Left UNpinned so a later reclassify can still adjust it.
  const ensureArea = (name) => {
    if (areaCache.has(name)) return areaCache.get(name);
    const existing = S.findThreadByTitle(db, repo.id, name);
    const id = existing ? existing.id : S.createThread(db, repo.id, { title: name });
    const cur = S.getThread(db, id);
    if (!cur.placement_pinned) S.setThreadPlacement(db, id, { kind: "area", parentId: null, pinned: false });
    areaCache.set(name, id);
    return id;
  };

  let moved = 0;
  // Unpinned threads follow the plan.
  for (const t of unpinned) {
    const p = byTitle.get(t.title);
    if (!p) continue; // Haiku omitted it — leave as-is.
    if (p.kind === "area") {
      S.setThreadPlacement(db, t.id, { kind: "area", parentId: null, pinned: false });
      areaCache.set(t.title, t.id);
      moved++;
      continue;
    }
    // An initiative: parent it to its (created-if-missing) area, set lifecycle, seed why.
    const areaId = p.area ? ensureArea(String(p.area)) : null;
    S.setThreadPlacement(db, t.id, { kind: "initiative", parentId: areaId, pinned: false });
    S.setThreadLifecycle(db, t.id, inferLifecycle(db, t.id));
    if (p.why && S.whySource(db, t.id) !== "agent") {
      S.setThreadNarrative(db, t.id, { why: String(p.why), source: "librarian" });
    }
    moved++;
  }

  // Pinned threads keep their placement + why untouched, but still get a lifecycle if they're an
  // initiative missing one (so the migration leaves nothing un-lifecycled).
  for (const t of pinned) {
    if (t.kind === "initiative" && !t.lifecycle) S.setThreadLifecycle(db, t.id, inferLifecycle(db, t.id));
  }

  return { areas: areaCache.size, initiatives: moved, moved };
}

// Roll up a thread's issue lifecycle into a status summary for the UI.
export function threadWorkStatus(db, threadId) {
  const issues = S.issuesForThread(db, threadId);
  const by = (s) => issues.filter((i) => i.status === s);
  const inProgress = by("in_progress");
  const shipped = by("shipped");
  return {
    total: issues.length,
    done: by("done").length,
    shipped: shipped.length,
    todo: by("todo").length,
    inProgress: inProgress.length,
    // The loose ends: started-but-unmerged branches, plus merged-but-never-closed issues.
    unfinished: [...inProgress, ...shipped].map((i) => ({
      number: i.number,
      title: i.title,
      status: i.status,
      branch: i.branch,
    })),
  };
}
