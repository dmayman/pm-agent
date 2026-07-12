// Ledger subcommands for the pm-agent CLI. Lazily imported by bin/pm-agent.js so the
// sqlite dependency never loads for install/update/etc. Renders are deterministic; the
// web UI consumes the same JSON these commands emit with --json.

import * as S from "./store.js";

// --- tiny flag parser -------------------------------------------------------
// Splits argv into { _: [positionals], flags: {name: value|true} }. Long flags only
// (--name value or --name=value); a lone --name is boolean true.
function parseArgs(argv) {
  const flags = {};
  const _ = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
        else {
          flags[a.slice(2)] = next;
          i++;
        }
      }
    } else _.push(a);
  }
  return { _, flags };
}

// --- ANSI (skipped when not a TTY or NO_COLOR) ------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2");
const bold = c("1");
const paint = {
  decided: c("35"),
  built: c("32"),
  tested: c("36"),
  reviewed: c("34"),
  followup: c("33"),
  deferred: c("33"),
  merged: c("1;32"),
  blocked: c("31"),
  note: c("2"),
  derived: c("2"),
};
const badge = (type) => (paint[type] || ((s) => s))(type.padEnd(8));

const STATUS_LABEL = {
  active: c("32")("● active"),
  in_review: c("33")("◐ in review"),
  blocked: c("31")("■ blocked"),
  done: dim("○ done"),
};

// --- date grouping ----------------------------------------------------------
function dayKey(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
}
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(y.toISOString())) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function hhmm(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function refTag(refs) {
  if (!refs) return "";
  let r;
  try {
    r = typeof refs === "string" ? JSON.parse(refs) : refs;
  } catch {
    return "";
  }
  const parts = [];
  if (r.issue) parts.push(`#${r.issue}`);
  if (r.pr) parts.push(`PR#${r.pr}`);
  if (r.branch) parts.push(r.branch);
  if (r.commit) parts.push(String(r.commit).slice(0, 7));
  return parts.join(" ");
}

// --- context resolution -----------------------------------------------------
function requireRepo(db) {
  const repo = S.getRepo(db);
  if (!repo) {
    process.stderr.write("pm-agent: not inside a git repository.\n");
    process.exit(1);
  }
  return repo;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdLog(argv) {
  const { _, flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const summary = _.join(" ").trim() || (typeof flags.summary === "string" ? flags.summary : "");
  if (!summary) {
    process.stderr.write('pm-agent log: need a summary. e.g. pm-agent log --type built "added retry"\n');
    process.exit(1);
  }
  const type = S.normalizeType((typeof flags.type === "string" && flags.type) || "note");
  let threadId = null;
  if (flags.thread) {
    threadId = S.resolveThread(db, repo.id, flags.thread, {
      genesis: typeof flags.genesis === "string" ? flags.genesis : null,
    });
  }
  const refs = {};
  if (flags.issue) refs.issue = Number(flags.issue);
  if (flags.pr) refs.pr = Number(flags.pr);
  if (flags.branch) refs.branch = flags.branch;
  if (flags.commit) refs.commit = flags.commit;
  if (typeof flags.refs === "string") {
    try {
      Object.assign(refs, JSON.parse(flags.refs));
    } catch {}
  }
  const id = S.logEvent(db, repo.id, {
    threadId,
    type,
    summary,
    refs: Object.keys(refs).length ? refs : null,
    source: (typeof flags.source === "string" && flags.source) || "explicit",
    ts: typeof flags.ts === "string" ? flags.ts : null,
  });
  if (flags.json) print({ id, threadId });
  else process.stdout.write(dim(`logged #${id}${threadId ? ` → thread ${threadId}` : ""}\n`));
}

function cmdThread(argv) {
  const [sub, ...rest] = argv;
  const { _, flags } = parseArgs(rest);
  const db = S.openDb();
  const repo = requireRepo(db);
  if (sub === "new") {
    const title = _.join(" ").trim();
    if (!title) fail("pm-agent thread new: need a title");
    const id = S.createThread(db, repo.id, {
      title,
      genesis: typeof flags.genesis === "string" ? flags.genesis : null,
      status: typeof flags.status === "string" ? flags.status : "active",
    });
    if (flags.json) print({ id });
    else process.stdout.write(dim(`thread ${id}: ${title}\n`));
  } else if (sub === "set") {
    const id = Number(_[0]);
    if (!id) fail("pm-agent thread set: need a thread id");
    S.updateThread(db, id, {
      title: typeof flags.title === "string" ? flags.title : null,
      status: typeof flags.status === "string" ? flags.status : null,
      genesis: typeof flags.genesis === "string" ? flags.genesis : null,
    });
    process.stdout.write(dim(`thread ${id} updated\n`));
  } else if (sub === "list" || sub === undefined) {
    const rows = S.listThreads(db, repo.id, {
      status: typeof flags.status === "string" ? flags.status : null,
    });
    if (flags.json) return print(rows);
    for (const t of rows) {
      process.stdout.write(
        `${bold("#" + t.id)} ${t.title}  ${STATUS_LABEL[t.status] || t.status} ${dim(`· ${t.event_count} events`)}\n`
      );
    }
  } else fail(`unknown thread subcommand: ${sub}`);
}

// Parse "43,49" / "#43 #49" / "43 49" into [43, 49].
function parseIssueList(v) {
  if (v == null || v === true) return [];
  return String(v)
    .split(/[\s,]+/)
    .map((s) => s.replace(/^#/, "").trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Manual initiative control — what Claude drives mid-session ("group #43 and #49 into an
// initiative about X"). An initiative IS a thread; these subcommands additionally PIN the
// named issues so the auto-clusterer won't move them on the next recluster.
function cmdInitiative(argv) {
  const [sub, ...rest] = argv;
  const { _, flags } = parseArgs(rest);
  const db = S.openDb();
  const repo = requireRepo(db);

  // Seed the durable goal/why on an initiative as HIGH-TRUST (source='agent') — the observer's
  // inference will refine but never clobber these (#26).
  const applyGoalWhy = (id) => {
    if (typeof flags.goal === "string" && flags.goal.trim())
      S.setThreadGoal(db, id, { goal: flags.goal, source: "agent" });
    if (typeof flags.why === "string" && flags.why.trim())
      S.setThreadWhy(db, id, { why: flags.why, source: "agent" });
  };

  if (sub === "new") {
    const name = _.join(" ").trim();
    if (!name) fail('pm-agent initiative new: need a name, e.g. initiative new "auth hardening" --goal "..." --issues 43,49');
    const issues = parseIssueList(flags.issues);
    const id = S.createThread(db, repo.id, {
      title: name,
      genesis: typeof flags.genesis === "string" ? flags.genesis : null,
    });
    applyGoalWhy(id);
    for (const n of issues) S.pinIssueToThread(db, repo.id, n, id);
    if (flags.json) return print({ id, name, issues });
    process.stdout.write(dim(`initiative #${id} "${name}" · pinned ${issues.length} issue(s)\n`));
  } else if (sub === "add") {
    const ref = (_.join(" ").trim() || (typeof flags.to === "string" ? flags.to : "")).trim();
    if (!ref) fail('pm-agent initiative add: name or id of the initiative, e.g. initiative add "auth hardening" --issues 12');
    const issues = parseIssueList(flags.issues);
    const id = S.resolveThread(db, repo.id, ref);
    applyGoalWhy(id);
    for (const n of issues) S.pinIssueToThread(db, repo.id, n, id);
    if (!issues.length && !flags.goal && !flags.why)
      fail("pm-agent initiative add: give --issues, --goal, and/or --why");
    if (flags.json) return print({ id, issues });
    process.stdout.write(dim(`updated initiative #${id}${issues.length ? ` · pinned ${issues.length} issue(s)` : ""}\n`));
  } else if (sub === "remove") {
    const issues = parseIssueList(flags.issues);
    if (!issues.length) fail("pm-agent initiative remove: --issues is required");
    for (const n of issues) S.unpinIssue(db, repo.id, n);
    if (flags.json) return print({ unpinned: issues });
    process.stdout.write(dim(`unpinned ${issues.length} issue(s) (a recluster may re-home them)\n`));
  } else if (sub === "list" || sub === undefined) {
    const rows = S.initiativesWithIssues(db, repo.id);
    if (flags.json) return print(rows);
    for (const t of rows) {
      process.stdout.write(
        `${bold("#" + t.id)} ${t.title}  ${STATUS_LABEL[t.status] || t.status}\n`
      );
      for (const i of t.issues) {
        const pin = i.pinned ? c("36")(" ⚲ pinned") : "";
        process.stdout.write(dim(`    #${i.number} ${i.title}${pin}\n`));
      }
    }
  } else fail(`unknown initiative subcommand: ${sub}`);
}

function groupByDay(events) {
  const out = [];
  let cur = null;
  for (const e of events) {
    const label = dayLabel(e.ts);
    if (!cur || cur.label !== label) {
      cur = { label, events: [] };
      out.push(cur);
    }
    cur.events.push(e);
  }
  return out;
}

function cmdTimeline(argv) {
  const { flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  let since = typeof flags.since === "string" ? flags.since : null;
  if (flags.days) {
    const d = new Date();
    d.setDate(d.getDate() - Number(flags.days));
    since = d.toISOString();
  }
  const threadId = flags.thread ? S.resolveThread(db, repo.id, flags.thread) : null;
  const events = S.listEvents(db, repo.id, { since, threadId, limit: Number(flags.limit) || 500 });
  if (flags.json) return print(events);
  if (!events.length) {
    process.stdout.write(dim("No activity recorded yet.\n"));
    return;
  }
  process.stdout.write("\n");
  for (const day of groupByDay(events)) {
    process.stdout.write(`  ${bold(day.label)}\n`);
    for (const e of day.events) {
      const tag = refTag(e.refs);
      const thread = e.thread_title ? dim(` ┈ ${e.thread_title}`) : "";
      const meta = [tag && dim(tag), thread].filter(Boolean).join(" ");
      process.stdout.write(
        `    ${dim(hhmm(e.ts))}  ${badge(e.type)}  ${e.summary}${meta ? "  " + meta : ""}\n`
      );
    }
    process.stdout.write("\n");
  }
}

function cmdInflight(argv) {
  const { flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const threads = S.listThreads(db, repo.id).filter((t) => t.status !== "done");
  const loose = S.listLooseEnds(db, repo.id);
  if (flags.json) return print({ threads, loose });
  if (!threads.length) {
    process.stdout.write(dim("Nothing in flight.\n"));
    return;
  }
  process.stdout.write("\n");
  for (const t of threads) {
    const recent = S.listEvents(db, repo.id, { threadId: t.id, limit: 3 });
    process.stdout.write(`  ${STATUS_LABEL[t.status] || t.status}  ${bold(t.title)}\n`);
    if (t.genesis) process.stdout.write(`    ${dim(t.genesis)}\n`);
    for (const e of recent) {
      process.stdout.write(`    ${dim(hhmm(e.ts))} ${badge(e.type)} ${e.summary}\n`);
    }
    process.stdout.write("\n");
  }
  if (loose.length) {
    process.stdout.write(`  ${bold("Loose ends")}\n`);
    for (const e of loose)
      process.stdout.write(`    ${c("33")("•")} ${e.summary}${e.thread_title ? dim(`  ┈ ${e.thread_title}`) : ""}\n`);
    process.stdout.write("\n");
  }
}

function cmdLoose(argv) {
  const [sub, ...rest] = argv;
  const db = S.openDb();
  const repo = requireRepo(db);
  if (sub === "resolve") {
    const id = Number(rest[0]);
    if (!id) fail("pm-agent loose resolve: need an event id");
    S.resolveLooseEnd(db, id);
    process.stdout.write(dim(`resolved loose end #${id}\n`));
    return;
  }
  const { flags } = parseArgs(argv);
  const loose = S.listLooseEnds(db, repo.id);
  if (flags.json) return print(loose);
  if (!loose.length) return void process.stdout.write(dim("No loose ends.\n"));
  for (const e of loose)
    process.stdout.write(`  ${dim("#" + e.id)} ${c("33")("•")} ${e.summary}${e.thread_title ? dim(`  ┈ ${e.thread_title}`) : ""}\n`);
}

function cmdIssueTitle(argv) {
  const { _, flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const num = Number(_[0]);
  const title = _.slice(1).join(" ").trim();
  if (!num || !title) fail('pm-agent issue-title <n> <title...>');
  S.setIssueTitle(db, repo.id, num, title);
  if (flags.json) print({ number: num, title });
  else process.stdout.write(dim(`glossary: #${num} → ${title}\n`));
}

function cmdConfig(argv) {
  const { _, flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const [key, value] = _;
  const scope = flags.global ? "global" : repo.slug;
  if (!key) {
    // dump effective config for the known keys
    const keys = ["capture"];
    for (const k of keys)
      process.stdout.write(`${k} = ${S.effectiveConfig(db, repo.slug, k, dim("(unset)"))}\n`);
    return;
  }
  if (value === undefined) {
    process.stdout.write(`${S.effectiveConfig(db, repo.slug, key, "")}\n`);
    return;
  }
  S.setConfig(db, scope, key, value);
  process.stdout.write(dim(`${scope}:${key} = ${value}\n`));
}

// The SessionStart injection payload: the #-glossary + capture mode + the silent-owner
// instruction. Kept here (not hardcoded in hooks.json) so it can carry live data.
function cmdContext() {
  const db = S.openDb();
  const repo = S.getRepo(db);
  if (!repo) return; // silent when not a git repo
  const mode = S.effectiveConfig(db, repo.slug, "capture", "observer");
  const glossary = S.issueGlossary(db, repo.id, 40);
  const lines = [];
  lines.push(
    "[pm-agent ledger] You silently maintain this project's work ledger — the timeline of what's planned, in progress, and finished across ALL worktrees of this repo. This is yours to own: never announce that you're logging, never ask the user to manage it. Organize work into threads (a thread = one arc of work: its founding decisions, its events, its loose ends) and reorganize freely as your understanding sharpens."
  );
  lines.push(
    "If this repo has runnable services, keep `.pm/services.json` (repo root) current so the dashboard can start them — an array `services[]` of `{name, command, cwd, port, health|url}`. See `/pm:services`."
  );
  lines.push(
    'An initiative is defined by its GOAL, not its title — the durable thing the work is trying to achieve. The moment the user frames a goal in conversation (usually before any issue or branch exists), seed it: `pm-agent initiative new "<short name>" --goal "<one-line durable goal>" --why "<why it matters>"`. As the work reveals more, refine the same initiative (`pm-agent initiative add "<name-or-id>" --goal "<sharpened goal>"`) — hold the durable goal steady while the approach evolves. Goals you seed this way are high-trust and are never overwritten by the automatic observer. Do this silently, as part of owning the ledger.'
  );
  lines.push(
    "Threads are also called initiatives — the higher-level buckets issues group into. When the user asks to (re)group issues (e.g. \"#43 and #49 should be an initiative about auth\"), act on it: create or extend the initiative and pin those issues with `pm-agent initiative new \"<name>\" --issues 43,49` or `pm-agent initiative add \"<name-or-id>\" --issues 12`. Pinned issues are locked — the automatic clusterer will never move them — so this is durable, not a one-off. Then be proactive: look over the other known issues, and if any clearly belong to that same initiative, add them too and tell the user which ones you pinned and why (undo with `pm-agent initiative remove --issues N`). Use `pm-agent initiative list --json` to see current groupings."
  );
  if (mode === "explicit") {
    lines.push(
      "Capture mode = explicit: when something worth remembering happens — a decision, a build/test/review milestone, a followup, or a deferred loose end — record it with `pm-agent log --type <decided|built|tested|reviewed|followup|deferred|merged|blocked|note> [--thread \"<title or id>\"] [--issue N] [--commit SHA] \"<one line>\"`. Judgement over volume: log what your future self would want on the timeline, not every action."
    );
  } else {
    lines.push(
      "Capture mode = observer: an automatic Haiku pass records the timeline for you at the end of each turn, so you normally don't log by hand. Only run `pm-agent log ...` to capture something the observer can't see — e.g. a deferred loose end or a decision made purely in conversation."
    );
  }
  if (glossary.length) {
    lines.push(
      "When you reference an issue, name it, don't just cite a number the user won't recognize — say \"the token-refresh work (#53)\", not \"#53\". Known issues: " +
        glossary.map((g) => `#${g.number} ${g.title}`).join("; ") +
        "."
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------

async function cmdEnable(argv) {
  const { flags } = parseArgs(argv);
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const db = S.openDb();
  const repo = requireRepo(db);
  const mode = flags.explicit ? "explicit" : "observer";
  S.setConfig(db, repo.slug, "capture", mode);
  const dir = path.join(repo.root, ".claude");
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "pm-ledger.md");
  if (!existsSync(marker)) {
    writeFileSync(
      marker,
      `# pm-agent ledger\n\nThis repo's work is tracked in the pm-agent ledger (a global timeline\nClaude maintains silently). This marker opts the repo in; delete it or run\n\`pm-agent disable\` to opt out. Capture mode: \`pm-agent config capture\`.\n\nView the timeline: \`pm-agent timeline\` or \`pm-agent serve\`.\n`
    );
  }
  process.stdout.write(`${bold("pm-agent ledger enabled")} for ${repo.slug} (capture: ${mode})\n`);
  const { runFullIngest } = await import("./ingest.js");
  const phaseLabel = {
    issues: "syncing issues + state",
    commits: "backfilling commit history",
    prs: "recording merged PRs",
    lifecycle: "detecting unfinished branches",
    cluster: "grouping into initiatives (Haiku)",
  };
  const res = await runFullIngest(db, repo, {
    onPhase: (p) => process.stdout.write(dim(`  · ${phaseLabel[p] || p}…\n`)),
  });
  if (res.ghAvailable) {
    process.stdout.write(
      dim(`  ${res.issues} issues, ${res.commits} commits, ${res.branches} unfinished → ${res.initiatives} initiatives\n`)
    );
  } else {
    process.stdout.write(dim(`  backfilled ${res.commits} commits (gh unavailable — no issue lifecycle)\n`));
  }
  if (!flags["no-synth"]) {
    process.stdout.write(dim(`  · synthesizing summaries (Haiku)…\n`));
    const { synthesizeAll } = await import("./synthesize.js");
    const n = await synthesizeAll(db, repo, { staleOnly: true });
    process.stdout.write(dim(`  ${n} thread summaries written\n`));
  }
  process.stdout.write(
    `\n  view it:  ${dim("pm-agent serve")}\n  Restart Claude Code so the session hooks pick this up.\n`
  );
}

async function cmdRecluster(argv) {
  const { flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  // --guidance persists a standing rubric for how THIS repo wants work grouped; every
  // future auto-recluster reads it back. Pass --guidance "" to clear it.
  if (typeof flags.guidance === "string") {
    S.setConfig(db, repo.slug, "cluster.guidance", flags.guidance);
    process.stdout.write(
      dim(flags.guidance ? `grouping guidance saved for ${repo.slug}\n` : `grouping guidance cleared\n`)
    );
  }
  process.stdout.write(dim("re-grouping issues into initiatives (Haiku)…\n"));
  const { runFullIngest } = await import("./ingest.js");
  const res = await runFullIngest(db, repo, {});
  process.stdout.write(dim(`  ${res.initiatives} initiatives, ${res.branches} unfinished branches\n`));
  const { synthesizeAll } = await import("./synthesize.js");
  const n = await synthesizeAll(db, repo, { staleOnly: false });
  process.stdout.write(dim(`  ${n} thread summaries re-synthesized\n`));
}

async function cmdDisable() {
  const { unlinkSync, existsSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const db = S.openDb();
  const repo = requireRepo(db);
  const marker = path.join(repo.root, ".claude", "pm-ledger.md");
  if (existsSync(marker)) unlinkSync(marker);
  process.stdout.write(
    `pm-agent ledger disabled for ${repo.slug} (timeline data kept; re-enable with ${dim("pm-agent enable")}).\n`
  );
}

async function cmdSynthesize(argv) {
  const { flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const { synthesizeThread, synthesizeAll } = await import("./synthesize.js");
  if (flags.thread) {
    const id = S.resolveThread(db, repo.id, flags.thread);
    const ok = synthesizeThread(db, repo, id);
    process.stdout.write(ok ? dim(`synthesized thread ${id}\n`) : dim("nothing to synthesize\n"));
    return;
  }
  process.stdout.write(dim("synthesizing thread summaries (Haiku)…\n"));
  const n = await synthesizeAll(db, repo, {
    staleOnly: !flags.all,
    onProgress: (t) => process.stdout.write(dim(`  · ${t.title.slice(0, 70)}\n`)),
  });
  process.stdout.write(dim(`done — ${n} summaries written\n`));
}

async function cmdIngest(argv) {
  const { flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const { ingest } = await import("./ingest.js");
  const res = ingest(db, repo, { limit: Number(flags.limit) || undefined });
  if (flags.json) return print(res);
  if (!res.ghAvailable) {
    process.stdout.write(dim("gh unavailable or not authenticated — skipped derived ingest.\n"));
    return;
  }
  process.stdout.write(
    dim(
      `ingested: ${res.glossary ?? 0} issue titles, ${res.commits ?? 0} commits, ${res.merged ?? 0} merged-PR events\n`
    )
  );
}

// Silent, cheap lifecycle refresh (no Haiku clustering): re-pull issue/PR/branch state,
// recompute done/shipped/in-progress, and re-synthesize only the threads whose status flipped.
// Wired to SessionStart (backstop) and available manually. Deterministic + fast.
async function cmdRefresh(argv) {
  const { flags } = parseArgs(argv);
  const db = S.openDb();
  const repo = requireRepo(db);
  const { refreshLifecycle } = await import("./work.js");
  const { changedThreads, ghAvailable } = refreshLifecycle(db, repo);
  if (changedThreads.size) {
    const { synthesizeThread } = await import("./synthesize.js");
    for (const id of changedThreads) synthesizeThread(db, repo, id);
  }
  if (flags.json) return print({ changed: changedThreads.size, ghAvailable });
  process.stdout.write(
    dim(
      ghAvailable
        ? `lifecycle refreshed — ${changedThreads.size} thread${changedThreads.size === 1 ? "" : "s"} updated\n`
        : "gh unavailable — nothing refreshed\n"
    )
  );
}

function fail(msg) {
  process.stderr.write(`pm-agent: ${msg}\n`);
  process.exit(1);
}
function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const LEDGER_HELP = `
LEDGER COMMANDS
  log <summary...>       Record an event (--type, --thread, --issue, --commit, --branch, --pr)
  thread [list|new|set]  Inspect or manage threads (--status, --genesis, --title)
  initiative <sub>       Group issues into initiatives by hand (new|add|remove|list; --issues 43,49)
  timeline               The activity timeline (--days N, --since ISO, --thread REF, --json)
  inflight               Active threads + their recent events + loose ends (--json)
  loose [resolve <id>]   Open loose ends (--json)
  issue-title <n> <t..>  Set the #-glossary title for an issue
  config [key] [value]   Get/set config (capture=observer|explicit; --global)
  context                Emit the SessionStart injection payload (used by the hook)
  eval                   Grade live goal-first capture on a session (--session, --repo, --model, --out)
`;

export async function runLedger(cmd, argv) {
  switch (cmd) {
    case "log":
      return cmdLog(argv);
    case "thread":
      return cmdThread(argv);
    case "initiative":
      return cmdInitiative(argv);
    case "timeline":
      return cmdTimeline(argv);
    case "inflight":
      return cmdInflight(argv);
    case "loose":
      return cmdLoose(argv);
    case "issue-title":
      return cmdIssueTitle(argv);
    case "config":
      return cmdConfig(argv);
    case "context":
      return cmdContext(argv);
    case "ingest":
      return cmdIngest(argv);
    case "refresh":
      return cmdRefresh(argv);
    case "synthesize":
      return cmdSynthesize(argv);
    case "recluster":
      return cmdRecluster(argv);
    case "enable":
      return cmdEnable(argv);
    case "disable":
      return cmdDisable(argv);
    case "serve": {
      const { flags } = parseArgs(argv);
      const { serve } = await import("../../apps/server/server.js");
      serve({ port: Number(flags.port) || 4477 });
      return;
    }
    case "observe": {
      const { observe, observeWorker, replay } = await import("./observe.js");
      if (argv.includes("--replay")) {
        const { flags } = parseArgs(argv);
        return replay(flags);
      }
      const workerIdx = argv.indexOf("--worker");
      if (workerIdx !== -1) await observeWorker(argv[workerIdx + 1]);
      else observe();
      return;
    }
    case "eval": {
      const { flags } = parseArgs(argv);
      const { runEval } = await import("./eval.js");
      return runEval(argv, flags);
    }
    case "ledger-help":
      return void process.stdout.write(LEDGER_HELP);
    default:
      process.stderr.write(`Unknown ledger command: ${cmd}\n${LEDGER_HELP}`);
      process.exit(1);
  }
}

export { LEDGER_HELP };
