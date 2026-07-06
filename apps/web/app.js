/* pm-agent — operator UI logic. Vanilla, read-only, offline.
   Fetches /api/*, renders a calm ledger, polls gently every 4s. */

"use strict";

// ---- event-type legend ------------------------------------------------------
const TYPES = {
  decided:  { label:"decided",  node:"solid"  },
  built:    { label:"built",    node:"solid"  },
  tested:   { label:"tested",   node:"solid"  },
  reviewed: { label:"reviewed", node:"solid"  },
  followup: { label:"followup", node:"hollow" },
  deferred: { label:"deferred", node:"hollow" },
  merged:   { label:"merged",   node:"glow"   },
  blocked:  { label:"blocked",  node:"alarm"  },
  note:     { label:"note",     node:"solid"  },
};
const TYPE_ORDER = ["decided","built","tested","reviewed","merged","blocked","followup","deferred","note"];
const hueVar = (t) => `var(--t-${TYPES[t] ? t : "note"})`;
const typeMeta = (t) => TYPES[t] || { label:t || "note", node:"solid" };

const STATUS = {
  active:    { label:"active",    pc:"var(--t-built)"    },
  in_review: { label:"in review", pc:"var(--t-reviewed)" },
  blocked:   { label:"blocked",   pc:"var(--t-blocked)"  },
  done:      { label:"done",      pc:"var(--t-merged)"   },
};
const statusMeta = (s) => STATUS[s] || { label:s || "—", pc:"var(--ink-mute)" };

// issue lifecycle: the arc branch -> commits -> merged & closed (done),
// or dangling (in_progress = open branch, shipped = merged-but-never-closed)
const LIFECYCLE = {
  done:        { label:"done",         short:"done",   pc:"var(--t-merged)"   },
  in_progress: { label:"in progress",  short:"branch", pc:"var(--t-followup)" },
  shipped:     { label:"shipped · open",short:"open",   pc:"var(--t-blocked)"  },
  todo:        { label:"todo",          short:"todo",   pc:"var(--t-deferred)" },
};
const lifeMeta = (s) => LIFECYCLE[s] || { label:s || "—", short:s || "—", pc:"var(--ink-mute)" };
const isUnfinished = (s) => s === "in_progress" || s === "shipped";
const emptyWork = { total:0, done:0, shipped:0, todo:0, inProgress:0, unfinished:[] };

// ---- tiny helpers -----------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;");

// Thread summaries lead with a **bold** headline sentence. Escape first (so the text is
// safe), then turn the surviving ** markers into <strong>. Nothing else is interpreted.
const fmtSummary = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// Split a summary into its leading **headline** (reads as a title) and the rest of the
// paragraph (a notch down in the hierarchy). No leading bold -> the whole thing is body.
function splitSummary(s){
  s = String(s == null ? "" : s).trim();
  const m = /^\*\*([\s\S]+?)\*\*\s*([\s\S]*)$/.exec(s);
  if(m) return { head: m[1].trim(), rest: m[2].trim() };
  return { head: null, rest: s };
}

// GitHub deep-links for refs. Base is the repo slug from /api/meta (owner/name); when it's
// missing we degrade to plain text rather than a broken link.
function ghBase(){
  const repo = state.meta && state.meta.repo;
  return repo ? "https://github.com/" + repo : null;
}
function ghUrl(kind, val){
  const base = ghBase();
  if(!base || val == null || val === "") return null;
  if(kind === "issue")  return base + "/issues/" + encodeURIComponent(val);
  if(kind === "pr")     return base + "/pull/" + encodeURIComponent(val);
  if(kind === "branch") return base + "/tree/" + String(val).split("/").map(encodeURIComponent).join("/");
  if(kind === "commit") return base + "/commit/" + encodeURIComponent(val);
  return null;
}

// Tag a request with the selected project so the server scopes it to that repo's ledger.
// The projects list itself is repo-agnostic, so it's left untagged.
function withProject(path){
  if(!state.project || path.startsWith("/api/projects")) return path;
  return path + (path.includes("?") ? "&" : "?") + "repo=" + encodeURIComponent(state.project);
}

async function api(path){
  const r = await fetch(withProject(path), { headers:{ accept:"application/json" } });
  if(!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}

// POST for the write endpoints (worktree create/checkout, dev-server start/stop, dev command).
// Same-origin, so the server's guard passes; returns the parsed {ok,...} / {error} body.
async function apiPost(path, body){
  try{
    const r = await fetch(withProject(path), {
      method:"POST",
      headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify(body || {}),
    });
    return await r.json();
  }catch(e){ return { ok:false, error:String(e && e.message) }; }
}

function pad2(n){ return n < 10 ? "0" + n : "" + n; }
function fmtTime(d){ return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

// compact token + cost formatting for the Cost view
function fmtTokens(n){
  n = Number(n) || 0;
  if(n >= 1e6) return (n/1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if(n >= 1e3) return (n/1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(n);
}
function fmtCost(n){
  n = Number(n) || 0;
  if(n === 0) return "$0";
  if(n < 0.01) return "$" + n.toFixed(4);
  if(n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEK = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
function dayKey(d){ return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }

function dayLabel(d){
  const today = startOfDay(new Date());
  const that  = startOfDay(d);
  const diff  = Math.round((today - that) / 86400000);
  const date  = MONTHS[d.getMonth()] + " " + d.getDate();
  if(diff === 0) return { label:"Today", date };
  if(diff === 1) return { label:"Yesterday", date };
  if(diff > 1 && diff < 7) return { label:WEEK[d.getDay()], date };
  return { label:MONTHS[d.getMonth()] + " " + d.getDate(), date:d.getFullYear() };
}

function fmtShortDate(iso){
  if(!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const s = MONTHS[d.getMonth()] + " " + d.getDate();
  return d.getFullYear() === now.getFullYear() ? s : s + ", " + d.getFullYear();
}

function relAge(iso){
  const then = new Date(iso).getTime();
  const s = Math.max(0, (Date.now() - then) / 1000);
  if(s < 45) return "just now";
  if(s < 3600) return Math.round(s/60) + "m";
  if(s < 86400) return Math.round(s/3600) + "h";
  const d = Math.round(s/86400);
  if(d < 30) return d + "d";
  return Math.round(d/7) + "w";
}

// A ref chip links to GitHub when we know the repo, else it's plain text.
function refChip(kind, cls, inner, val){
  const url = ghUrl(kind, val);
  return url
    ? `<a class="ref ${cls}" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`
    : `<span class="ref ${cls}">${inner}</span>`;
}
function refChips(refs){
  if(!refs || typeof refs !== "object") return "";
  const out = [];
  if(refs.issue != null) out.push(refChip("issue", "issue", `<span class="k">#</span>${esc(refs.issue)}`, refs.issue));
  if(refs.pr != null)    out.push(refChip("pr", "pr", `<span class="k">PR</span>${esc(refs.pr)}`, refs.pr));
  if(refs.branch)        out.push(refChip("branch", "branch", `<span class="k">⎇</span>${esc(refs.branch)}`, refs.branch));
  if(refs.commit)        out.push(refChip("commit", "commit", `${esc(String(refs.commit).slice(0,7))}`, refs.commit));
  return out.join("");
}

function nodeClass(t){
  const n = typeMeta(t).node;
  return n === "hollow" ? "node hollow" : n === "glow" ? "node glow" : n === "alarm" ? "node alarm" : "node";
}

// ---- app state --------------------------------------------------------------
const state = {
  view: "work",
  workMode: "days",        // days | threads | events
  filter: "all",           // all | unfinished
  threadId: null,
  meta: null,
  project: null,           // slug of the repo currently being viewed
  projects: [],            // all repos in the ledger (for the switcher)
  menuOpen: false,         // project switcher dropdown state
  seenEvents: new Set(),   // event ids we've already rendered (for new-flash)
  expanded: new Set(),     // "day:threadId" or "threadId" keys that are open
  threadCache: new Map(),  // id -> {thread, issues, events} (lazy, for expanders)
  primed: false,           // first render done -> flashing enabled
  sig: "",                 // last-rendered signature per view
  // worktrees panel (right rail on Work)
  wt: { menuBranch:null, editCmd:null, error:null, mergedOpen:false, busy:new Set() },
  wtData: null,            // last /api/worktrees payload (for no-network repaints)
  wtSig: "",               // last-rendered panel signature
};

const viewEl = $("#view");
const mainEl = $("#main");

// ---- routing ----------------------------------------------------------------
const WORK_MODES = ["days", "threads", "events"];
function parseHash(){
  const h = (location.hash || "#/work").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if(parts[0] === "thread" && parts[1]) return { view:"thread", threadId:parts[1] };
  if(parts[0] === "inflight") return { view:"inflight" };
  if(parts[0] === "usage") return { view:"usage" };
  if(parts[0] === "work"){
    const mode = WORK_MODES.includes(parts[1]) ? parts[1] : "days";
    return { view:"work", workMode:mode };
  }
  return { view:"work", workMode:"days" };
}

function syncNav(){
  // thread drill-in belongs to Work; usage stands alone
  const activeNav = state.view === "inflight" ? "inflight"
    : state.view === "usage" ? "usage" : "work";
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === activeNav);
  });
}

async function onRoute(){
  const r = parseHash();
  const changed = r.view !== state.view || r.threadId !== state.threadId
    || (r.view === "work" && r.workMode !== state.workMode);
  state.view = r.view;
  state.threadId = r.threadId || null;
  if(r.workMode) state.workMode = r.workMode;
  if(changed){ state.sig = ""; state.primed = false; state.seenEvents.clear(); mainEl.scrollTop = 0; }
  syncNav();
  viewEl.classList.toggle("wide", state.view === "inflight");
  await refresh(changed);
}

// ---- data + render orchestration -------------------------------------------
async function refresh(force){
  try{
    if(state.view === "inflight")     await renderInflight(force);
    else if(state.view === "thread")  await renderThread(force);
    else if(state.view === "usage")   await renderUsage(force);
    else                              await renderWork(force);
  }catch(err){
    if(!state.sig) viewEl.innerHTML = `<div class="empty"><div class="glyph"></div>`
      + `<div class="e-title">Couldn't reach the ledger</div>`
      + `<div class="e-sub">${esc(err.message)}</div></div>`;
  }
}

/* Re-render into `viewEl` while keeping the scroll position stable.
   New events prepend at the top and push content down; we compensate so the
   viewport doesn't jump — unless the user is already at the very top, where
   we let new arrivals slide into view. */
function paint(html, { scrollSafe, target } = {}){
  const el = target || viewEl;
  if(!scrollSafe){ el.innerHTML = html; return; }
  const nearTop = mainEl.scrollTop < 48;
  const prevTop = mainEl.scrollTop;
  const prevH = mainEl.scrollHeight;
  el.innerHTML = html;
  if(!nearTop){
    const delta = mainEl.scrollHeight - prevH;
    if(delta > 0) mainEl.scrollTop = prevTop + delta;
  }
}

// ---- timeline / thread rendering -------------------------------------------
function eventRow(ev, i){
  const d = new Date(ev.ts);
  const hue = hueVar(ev.type);
  const t = typeMeta(ev.type);
  const isNew = state.primed && !state.seenEvents.has(ev.id);
  const dim = ev.type === "note" || ev.type === "deferred";
  const delay = state.primed ? 0 : Math.min(i, 16) * 22;

  let chips = "";
  if(ev.thread_title && state.view !== "thread"){
    chips += `<a class="thread-chip" href="#/thread/${esc(ev.thread_id)}">${esc(ev.thread_title)}</a>`;
  }
  const refs = refChips(ev.refs);
  if(refs){
    if(chips) chips += `<span class="sep">·</span>`;
    chips += refs;
  }

  return `<div class="event ${isNew ? "is-new" : ""} ${dim ? "dim" : ""}" `
    + `style="--hue:${hue};--d:${delay}ms">`
    + `<div class="time">${fmtTime(d)}</div>`
    + `<div class="rail-col"><span class="${nodeClass(ev.type)}"></span></div>`
    + `<div class="body">`
    +   `<div class="summary">${esc(ev.summary)}</div>`
    +   `<div class="meta"><span class="type-tag">${esc(t.label)}</span>`
    +     (chips ? `<span class="sep">·</span>${chips}` : "")
    +   `</div>`
    + `</div></div>`;
}

function groupByDay(events){
  const groups = [];
  let cur = null;
  for(const ev of events){
    const k = dayKey(new Date(ev.ts));
    if(!cur || cur.key !== k){ cur = { key:k, when:new Date(ev.ts), items:[] }; groups.push(cur); }
    cur.items.push(ev);
  }
  return groups;
}

function renderDays(events){
  if(!events.length){
    return `<div class="empty"><div class="glyph"></div>`
      + `<div class="e-title">No activity in this window</div>`
      + `<div class="e-sub">events will appear here as work streams in</div></div>`;
  }
  let idx = 0;
  return groupByDay(events).map((g) => {
    const dl = dayLabel(g.when);
    const rows = g.items.map((ev) => eventRow(ev, idx++)).join("");
    return `<div class="day-group"><div class="day-head">`
      + `<span class="d-label">${esc(dl.label)}</span>`
      + `<span class="d-date">${esc(dl.date)}</span>`
      + `<span class="d-rule"></span>`
      + `<span class="d-count">${g.items.length}</span>`
      + `</div><div class="events">${rows}</div></div>`;
  }).join("");
}

function markSeen(events){ for(const ev of events) state.seenEvents.add(ev.id); state.primed = true; }

async function renderThread(force){
  const data = await api("/api/thread/" + encodeURIComponent(state.threadId));
  state.threadCache.set(String(state.threadId), data); // warm the cache for Work expanders
  const th = data.thread || {};
  const events = data.events || [];
  const issues = (data.issues || []).slice()
    .sort((a, b) => (isUnfinished(b.status) - isUnfinished(a.status)) || (b.number - a.number));
  const w = th.work || emptyWork;
  const sig = "th:" + state.threadId + ":" + events.length + ":" + issues.length
    + ":" + JSON.stringify(w);
  if(!force && sig === state.sig) return;

  const sm = statusMeta(th.status);
  const summary = th.summary
    ? `<p class="th-summary">${fmtSummary(th.summary)}</p>`
    : issues.length ? "" /* pure-backlog: the issue list carries the story */
    : `<p class="th-summary none">No synthesized summary yet — the story is still being distilled.</p>`;
  const genesis = th.genesis
    ? `<div class="th-genesis"><span class="rune">decisions</span><span>${esc(th.genesis)}</span></div>`
    : "";

  const head = `<div class="thread-head">`
    + `<div class="th-status-row">`
    +   `<span class="pill" style="--pc:${sm.pc}"><span class="pdot"></span>${esc(sm.label)}</span>`
    +   `<span class="th-title">${esc(th.title || "Untitled initiative")}</span>`
    + `</div>${summary}${genesis}`
    + lifecycleIndicator(w)
    + `</div>`;

  // the important part: issues with their lifecycle status
  const issuesSection = issues.length
    ? `<div class="section"><div class="section-head"><h2>Issues</h2><span class="rule"></span>`
      + `<span class="n">${issues.length}</span></div>`
      + `<div class="exp-issues detail">${issues.map(issueRow).join("")}</div></div>`
    : "";

  // commits & merges — demoted beneath the lifecycle
  const commitsSection = events.length
    ? `<div class="section"><div class="section-head"><h2>Commits &amp; merges</h2>`
      + `<span class="rule"></span><span class="n">${events.length}</span></div>`
      + renderDays(events) + `</div>`
    : "";

  setTopbar(`<a class="tb-back" href="#/work"><span class="arw">←</span>Work</a>`
    + `<span class="tb-title">${esc(th.title || "Initiative")}</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);

  paint(head + issuesSection + commitsSection, { scrollSafe: !force && state.primed });
  markSeen(events);
  state.sig = sig;
}

// ---- work: day-grouped initiatives, lifecycle-first --------------------------
// A single commit/merge — the deepest detail, demoted beneath the story.
function evidenceRow(ev, opts){
  const refs = refChips(ev.refs);
  const dot = typeMeta(ev.type).node === "hollow" ? "ev-dot hollow" : "ev-dot";
  const time = (opts && opts.hideTime) ? ""
    : `<span class="ev-time">${fmtShortDate(ev.ts)}</span>`;
  return `<div class="ev-line" style="--hue:${hueVar(ev.type)}">`
    + time
    + `<span class="${dot}"></span>`
    + `<span class="ev-type">${esc(typeMeta(ev.type).label)}</span>`
    + `<span class="ev-sum">${esc(ev.summary)}</span>`
    + (refs ? `<span class="ev-refs">${refs}</span>` : "")
    + `</div>`;
}

// compact "4 done · 1 unfinished" lifecycle read-out + a proportional bar
function lifecycleIndicator(w){
  w = w || emptyWork;
  const unfin = (w.inProgress || 0) + (w.shipped || 0);
  const segs = [
    ["done", w.done], ["in_progress", w.inProgress], ["shipped", w.shipped], ["todo", w.todo],
  ].filter(([, n]) => n > 0);
  const total = w.total || segs.reduce((a, [, n]) => a + n, 0) || 1;
  const bar = segs.map(([k, n]) =>
    `<span class="lc-seg" style="--pc:${lifeMeta(k).pc};flex:${n}" title="${n} ${esc(lifeMeta(k).label)}"></span>`).join("");
  const parts = [];
  if(w.done) parts.push(`<span class="lc-n done">${w.done} done</span>`);
  if(unfin)  parts.push(`<span class="lc-n unfin">${unfin} unfinished</span>`);
  if(w.todo) parts.push(`<span class="lc-n todo">${w.todo} to&nbsp;do</span>`);
  const label = parts.length ? parts.join(`<span class="lc-dot">·</span>`) : `<span class="lc-n todo">no issues</span>`;
  return `<div class="lifecycle"><div class="lc-bar" aria-hidden="true">${bar || `<span class="lc-seg" style="--pc:var(--ink-whisper);flex:1"></span>`}</div>`
    + `<div class="lc-label">${label}</div></div>`;
}

// an issue row inside a thread expander — the lifecycle IS the content
function issueRow(iss){
  const lm = lifeMeta(iss.status);
  const unf = isUnfinished(iss.status);
  const numUrl = ghUrl("issue", iss.number);
  const num = numUrl
    ? `<a class="issue-num" href="${esc(numUrl)}" target="_blank" rel="noopener">#${esc(iss.number)}</a>`
    : `<span class="issue-num">#${esc(iss.number)}</span>`;
  const brUrl = iss.branch ? ghUrl("branch", iss.branch) : null;
  const branch = !iss.branch ? ""
    : brUrl
    ? `<a class="issue-branch" href="${esc(brUrl)}" target="_blank" rel="noopener"><span class="k">⎇</span>${esc(iss.branch)}</a>`
    : `<span class="issue-branch"><span class="k">⎇</span>${esc(iss.branch)}</span>`;
  return `<div class="issue-row ${unf ? "unfin" : ""}" style="--pc:${lm.pc}">`
    + `<span class="issue-pill"><span class="ip-dot"></span>${esc(lm.label)}</span>`
    + num
    + `<span class="issue-title">${esc(iss.title)}</span>`
    + branch
    + `</div>`;
}

// the body of an expanded thread: issues (lifecycle) first, commits demoted
function expanderBody(id){
  const openLink = `<a class="exp-open" href="#/thread/${esc(id)}">Open initiative<span class="arw"> →</span></a>`;
  const d = state.threadCache.get(String(id));
  if(!d) return `<div class="exp-loading">reading initiative…</div>`
    + `<div class="exp-foot">${openLink}</div>`;
  const issues = (d.issues || []).slice()
    .sort((a, b) => (isUnfinished(b.status) - isUnfinished(a.status))
      || (b.number - a.number));
  const events = d.events || [];
  const issuesHtml = issues.length
    ? `<div class="exp-issues">${issues.map(issueRow).join("")}</div>`
    : `<div class="exp-none">no issues linked to this initiative yet</div>`;
  const evId = "ev-" + id;
  // footer row: the commits disclosure sits at the left, "Open initiative" at the right;
  // the commit list (when toggled open) drops full-width beneath.
  const toggle = events.length
    ? `<button class="commits-toggle" data-target="${evId}" aria-expanded="false">`
      +   `<span class="chev">›</span> ${events.length} commit${events.length === 1 ? "" : "s"} &amp; merge${events.length === 1 ? "" : "s"}</button>`
    : `<span></span>`;
  const commitsList = events.length
    ? `<div class="commits-list" id="${evId}" hidden>${events.map((ev) => evidenceRow(ev)).join("")}</div>`
    : "";
  return issuesHtml + `<div class="exp-foot">${toggle}${openLink}</div>` + commitsList;
}

// a thread as a primary row (used in both Days and Threads modes)
function threadRow(th, key, i){
  const w = th.work || emptyWork;
  const open = state.expanded.has(key);
  // Hierarchy: the **headline** reads as the title; the rest of the paragraph sits below,
  // a notch down. No summary -> genesis or a plain backlog line as the body.
  let hero;
  if(th.summary){
    const { head, rest } = splitSummary(th.summary);
    hero = (head ? `<p class="tr-head">${esc(head)}</p>` : "")
      + (rest ? `<p class="tr-rest">${esc(rest)}</p>` : "")
      + (!head && !rest ? `<p class="tr-rest">${esc(th.summary)}</p>` : "");
  } else if(th.genesis){
    hero = `<p class="tr-rest is-genesis">${esc(th.genesis)}</p>`;
  } else {
    hero = `<p class="tr-rest none">Backlog initiative — ${w.total || 0} issue${w.total === 1 ? "" : "s"}, no summary yet.</p>`;
  }
  return `<article class="trow ${open ? "open" : ""}" data-href="#/thread/${esc(th.id)}" `
    + `style="--d:${Math.min(i, 12) * 26}ms">`
    + `<button class="trow-head" data-key="${esc(key)}" data-id="${esc(th.id)}" aria-expanded="${open}">`
    +   `<span class="chev">›</span>`
    +   `<span class="trow-body">`
    +     `<span class="trow-title">${esc(th.title || "Untitled initiative")}</span>`
    +     hero
    +     lifecycleIndicator(w)
    +   `</span>`
    + `</button>`
    + `<div class="trow-detail" ${open ? "" : "hidden"}>${open ? expanderBody(th.id) : ""}</div>`
    + `</article>`;
}

// the money panel: every dangling loose thread across the repo
function unfinishedPanel(items){
  if(!items.length){
    return `<div class="unf-panel clear">`
      + `<span class="unf-check">✓</span>`
      + `<span class="unf-clear-txt">Nothing dangling — every branch has landed and closed.</span>`
      + `</div>`;
  }
  const rows = items.map((u) => {
    const lm = lifeMeta(u.status);
    const kind = u.status === "shipped" ? "merged, never closed" : "open branch";
    return `<a class="unf-row" href="#/thread/${esc(u.thread.id)}" style="--pc:${lm.pc}">`
      + `<span class="unf-kind">${esc(kind)}</span>`
      + `<span class="unf-num">#${esc(u.number)}</span>`
      + `<span class="unf-title">${esc(u.title)}</span>`
      + (u.branch ? `<span class="unf-branch"><span class="k">⎇</span>${esc(u.branch)}</span>` : "")
      + `<span class="unf-thread">${esc(u.thread.title)}</span>`
      + `</a>`;
  }).join("");
  return `<div class="unf-panel">`
    + `<div class="unf-head"><span class="unf-pulse"></span>`
    +   `<span class="unf-title-lbl">Unfinished</span>`
    +   `<span class="unf-count">${items.length} loose thread${items.length === 1 ? "" : "s"}</span>`
    +   `<span class="unf-sub">open branches &amp; shipped-but-open — needs a landing</span></div>`
    + `<div class="unf-list">${rows}</div></div>`;
}

function workControls(){
  const modeBtn = (m, label) =>
    `<a class="seg ${state.workMode === m ? "on" : ""}" href="#/work/${m}">${label}</a>`;
  const filterBtn = (f, label) =>
    `<button class="seg ${state.filter === f ? "on" : ""}" data-filter="${f}">${label}</button>`;
  return `<span class="tb-title">Work</span>`
    + `<span class="tb-spacer"></span>`
    + `<div class="segmented" role="tablist">${modeBtn("days", "Days")}${modeBtn("threads", "Threads")}${modeBtn("events", "Events")}</div>`
    + `<div class="segmented filter">${filterBtn("all", "All")}${filterBtn("unfinished", "Unfinished")}</div>`
    + liveTag();
}

// The Work view is a two-column shell: the timeline on the left, the worktrees panel on the
// right. Built once per entry so the panel keeps its own state (open menus, focus) across the
// left column's 4s repaints.
function ensureWorkShell(){
  if($("#workCol")) return;
  viewEl.innerHTML = `<div class="work-wrap"><div class="work-col" id="workCol"></div>`
    + `<aside class="work-aside" id="workAside"></aside></div>`;
  state.sig = ""; state.wtSig = "";
}

async function renderWork(force){
  ensureWorkShell();
  renderWorktreePanel(force); // right rail — independent, runs concurrently

  const [threads, timeline] = await Promise.all([
    api("/api/threads"),
    api("/api/timeline?days=3650&limit=500"),
  ]);
  const unfilter = state.filter === "unfinished";
  const unfinishedItems = threads.flatMap((t) =>
    (t.work && t.work.unfinished ? t.work.unfinished : []).map((u) => ({ ...u, thread: t })));
  const unfinishedThreadIds = new Set(unfinishedItems.map((u) => u.thread.id));

  const sig = "wk:" + state.workMode + ":" + state.filter + ":" + threads.length + ":"
    + threads.map((t) => t.id + "@" + t.status + "@" + t.last_event_ts + "@"
        + (t.summary ? 1 : 0) + "@" + JSON.stringify(t.work || {})).join(",")
    + ":" + (timeline[0] ? timeline[0].id : 0);
  if(!force && sig === state.sig) return;

  const byId = new Map(threads.map((t) => [t.id, t]));
  let html = "";
  // only surface the unfinished panel when something is actually dangling — no zero-state
  if(!unfilter && unfinishedItems.length) html += unfinishedPanel(unfinishedItems);

  if(state.workMode === "events"){
    // flat chronological ledger — the "what happened when" lens
    let events = timeline;
    if(unfilter) events = events.filter((e) => e.thread_id != null && unfinishedThreadIds.has(e.thread_id));
    html += renderDays(events);
    markSeen(timeline);
  } else if(state.workMode === "threads"){
    // initiatives as a flat list, in-flight before done, newest first
    const rank = (s) => (s === "done" ? 1 : 0);
    const when = (t) => new Date(t.last_event_ts || t.updated_at || 0).getTime();
    let list = threads.slice().sort((a, b) => rank(a.status) - rank(b.status) || when(b) - when(a));
    if(unfilter) list = list.filter((t) => unfinishedThreadIds.has(t.id));
    html += list.length
      ? `<div class="wlist">${list.map((t, i) => threadRow(t, "t:" + t.id, i)).join("")}</div>`
      : emptyBlock("Nothing unfinished", "every initiative here has landed");
    state.primed = true;
  } else {
    // DAYS: initiatives grouped by the day they had activity
    const days = [];
    let cur = null;
    let idx = 0;
    for(const ev of timeline){
      const k = dayKey(new Date(ev.ts));
      if(!cur || cur.key !== k){ cur = { key:k, when:new Date(ev.ts), threads:new Map(), loose:[] }; days.push(cur); }
      if(ev.thread_id != null && byId.has(ev.thread_id)){
        if(!cur.threads.has(ev.thread_id)) cur.threads.set(ev.thread_id, []);
        cur.threads.get(ev.thread_id).push(ev);
      } else {
        cur.loose.push(ev);
      }
    }
    const groups = days.map((g) => {
      let entries = [...g.threads.keys()].map((tid) => byId.get(tid)).filter(Boolean);
      if(unfilter) entries = entries.filter((t) => unfinishedThreadIds.has(t.id));
      const rows = entries.map((t) => threadRow(t, g.key + ":" + t.id, idx++)).join("");
      const loose = (!unfilter && g.loose.length)
        ? `<div class="day-loose"><div class="day-loose-head">Other events</div>`
          + `${g.loose.map((ev) => evidenceRow(ev, { hideTime: true })).join("")}</div>`
        : "";
      if(!rows && !loose) return "";
      const dl = dayLabel(g.when);
      return `<div class="day-group"><div class="day-head">`
        + `<span class="d-label">${esc(dl.label)}</span><span class="d-date">${esc(dl.date)}</span>`
        + `<span class="d-rule"></span><span class="d-count">${entries.length + (loose ? g.loose.length : 0)}</span>`
        + `</div>${rows}${loose}</div>`;
    }).filter(Boolean).join("");
    html += groups || emptyBlock(
      unfilter ? "Nothing unfinished" : "No activity yet",
      unfilter ? "every branch has landed" : "initiatives appear here as work streams in");
    state.primed = true;
  }

  setTopbar(workControls());
  updateUnfinishedFoot(unfinishedItems.length);
  paint(html, { scrollSafe: !force && state.workMode === "events", target: $("#workCol") });
  state.sig = sig;
}

function emptyBlock(title, sub){
  return `<div class="empty"><div class="glyph"></div>`
    + `<div class="e-title">${esc(title)}</div><div class="e-sub">${esc(sub)}</div></div>`;
}

function updateUnfinishedFoot(n){
  const el = $("#looseFoot");
  if(!el) return;
  el.innerHTML = n
    ? `<span class="n">${n}</span> unfinished`
    : `nothing unfinished`;
}

// lazy-load a thread's issues/commits the first time its row is expanded
async function ensureThread(id){
  const key = String(id);
  if(state.threadCache.has(key)) return state.threadCache.get(key);
  const d = await api("/api/thread/" + encodeURIComponent(id));
  state.threadCache.set(key, d);
  return d;
}

// ---- in-flight rendering ----------------------------------------------------
function threadCard(th, events, i){
  const w = th.work || emptyWork;
  const unfin = (w.inProgress || 0) + (w.shipped || 0);
  const accent = unfin ? "var(--t-blocked)" : statusMeta(th.status).pc;
  const blurb = th.summary
    ? `<div class="card-summary">${fmtSummary(th.summary)}</div>`
    : th.genesis
    ? `<div class="card-genesis">${esc(th.genesis)}</div>`
    : `<div class="card-genesis none">backlog — ${w.total || 0} issue${w.total === 1 ? "" : "s"}</div>`;
  const badge = unfin
    ? `<span class="unfin-badge">${unfin} unfinished</span>`
    : `<span class="pill" style="--pc:${statusMeta(th.status).pc}"><span class="pdot"></span>${esc(statusMeta(th.status).label)}</span>`;
  return `<div class="card" data-href="#/thread/${esc(th.id)}" style="--accent:${accent};--d:${Math.min(i,8)*40}ms">`
    + `<div class="card-top"><span class="card-title">${esc(th.title || "Untitled thread")}</span>${badge}</div>`
    + blurb
    + lifecycleIndicator(w)
    + `</div>`;
}

async function renderInflight(force){
  const data = await api("/api/inflight");
  const threads = data.threads || [];
  const unfinishedItems = threads.flatMap((t) =>
    (t.work && t.work.unfinished ? t.work.unfinished : []).map((u) => ({ ...u, thread: t })));

  const sig = "if:" + threads.length + ":"
    + threads.map((t) => t.id + "@" + t.last_event_ts + "@" + JSON.stringify(t.work || {})).join(",");
  if(!force && sig === state.sig) return;

  // unfinished before finished; then newest activity first
  const rank = (t) => ((t.work && ((t.work.inProgress || 0) + (t.work.shipped || 0))) ? 0 : 1);
  const when = (t) => new Date(t.last_event_ts || t.updated_at || 0).getTime();
  const sorted = threads.slice().sort((a, b) => rank(a) - rank(b) || when(b) - when(a));

  let html = unfinishedPanel(unfinishedItems);

  html += `<div class="section"><div class="section-head"><h2>Initiatives in flight</h2>`
    + `<span class="rule"></span><span class="n">${threads.length}</span></div>`;
  html += threads.length
    ? `<div class="cards">${sorted.map((th, i) => threadCard(th, [], i)).join("")}</div>`
    : `<div class="empty"><div class="glyph"></div><div class="e-title">Nothing in flight</div>`
      + `<div class="e-sub">all initiatives are at rest</div></div>`;
  html += `</div>`;

  setTopbar(`<span class="tb-title">In flight</span>`
    + `<span class="tb-sub">${threads.length} initiative${threads.length === 1 ? "" : "s"} · ${unfinishedItems.length} unfinished</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);
  $("#inflightBadge").textContent = threads.length || "";
  updateUnfinishedFoot(unfinishedItems.length);

  paint(html);
  state.sig = sig;
}

// ---- worktrees panel (right rail on Work) ----------------------------------
// A live, write-capable view of git worktrees + branches for the current repo: which branch
// each worktree has checked out, each worktree's dev server (start/open/stop), and every local
// branch (make a worktree from it, or move an existing worktree onto it). Merged branches with
// no worktree collapse into a dropdown. Renders into #workAside beside the Work timeline.

// ahead/behind chip vs the default branch — the "how far has this diverged" read
function divergeChip(ab){
  if(!ab || (!ab.ahead && !ab.behind)) return "";
  const parts = [];
  if(ab.ahead)  parts.push(`<span class="wt-ahead">↑${ab.ahead}</span>`);
  if(ab.behind) parts.push(`<span class="wt-behind">↓${ab.behind}</span>`);
  return `<span class="wt-diverge">${parts.join("")}</span>`;
}

// one worktree: branch it's on, here/main tags, and its dev-server controls
function wtpItem(wt){
  const w = state.wt;
  const key = wt.path;
  const busy = w.busy.has("srv:" + key);
  const branch = wt.detached
    ? `<span class="wtp-branch detached">detached HEAD</span>`
    : `<span class="wtp-branch"><span class="k">⎇</span>${esc(wt.branch || "—")}</span>`;
  const tags = wt.isCurrent ? `<span class="wtp-tag here">here</span>`
    : wt.isMain ? `<span class="wtp-tag main">main tree</span>` : "";

  let srv;
  if(wt.serverState === "live" && wt.servers.length){
    const s = wt.servers[0];
    srv = `<div class="wtp-srv live">`
      + `<a class="wtp-open" href="${esc(s.url)}" target="_blank" rel="noopener"><span class="wtp-dot"></span>localhost:${esc(s.port)}<span class="arw"> ↗</span></a>`
      + `<button class="wtp-btn stop" data-act="stop" data-wt="${esc(key)}">stop</button></div>`;
  } else if(wt.serverState === "starting"){
    srv = `<div class="wtp-srv starting"><span class="wtp-spin"></span><span class="wtp-starting">starting…</span>`
      + `<button class="wtp-btn stop" data-act="stop" data-wt="${esc(key)}">stop</button></div>`;
  } else if(wt.devCommand){
    srv = `<div class="wtp-srv"><button class="wtp-btn start" data-act="start" data-wt="${esc(key)}" ${busy ? "disabled" : ""}>▶ dev server</button>`
      + `<button class="wtp-cmd" data-act="editcmd" data-wt="${esc(key)}" title="edit dev command"><code>${esc(wt.devCommand)}</code></button></div>`;
  } else {
    srv = `<div class="wtp-srv"><button class="wtp-btn ghost" data-act="editcmd" data-wt="${esc(key)}">set dev command…</button></div>`;
  }

  const editor = w.editCmd === key
    ? `<div class="wtp-editor"><input type="text" class="wtp-input" id="wtpCmdInput" value="${esc(wt.devCommand || "")}" placeholder="e.g. npm run dev" spellcheck="false" autocomplete="off" />`
      + `<button class="wtp-btn save" data-act="savecmd">save</button>`
      + `<button class="wtp-btn ghost" data-act="canceledit">cancel</button></div>`
    : "";

  return `<div class="wtp-item ${wt.serverState === "live" ? "live" : ""}">`
    + `<div class="wtp-row1">${branch}${divergeChip(wt.ahead)}<span class="sp"></span>${tags}</div>`
    + `<div class="wtp-path" title="${esc(wt.path)}">${esc(wt.name)}</div>`
    + srv + editor
    + `</div>`;
}

// the target picker for "move a branch into an existing worktree"
function wtpMoveMenu(branch){
  const wts = (state.wtData && state.wtData.worktrees) || [];
  const rows = wts.map((w) =>
    `<button class="wtp-menu-opt" data-act="checkout" data-wt="${esc(w.path)}" data-branch="${esc(branch)}">`
    + `<span class="wtp-menu-name">${esc(w.name)}</span>`
    + `<span class="wtp-menu-cur">${esc(w.branch || "detached")}</span></button>`).join("");
  return `<div class="wtp-menu">`
    + `<div class="wtp-menu-head">switch which worktree to ⎇${esc(branch)}?</div>`
    + (rows || `<span class="wtp-menu-empty">no worktrees</span>`) + `</div>`;
}

// one branch row: its checkout status, or actions to make/move a worktree onto it
function wtpBranchRow(b){
  const w = state.wt;
  const nm = `<span class="wtp-bname"><span class="k">⎇</span>${esc(b.name)}`
    + (b.isDefault ? `<span class="wtp-def">default</span>` : "") + `</span>`;
  let action;
  if(b.worktreePath){
    const base = b.worktreePath.split("/").pop();
    action = `<span class="wtp-inwt" title="checked out at ${esc(b.worktreePath)}"><span class="wtp-inwt-dot"></span>in ${esc(base)}</span>`;
  } else {
    const menuOpen = w.menuBranch === b.name;
    action = `<span class="wtp-actions">`
      + `<button class="wtp-mini" data-act="create" data-branch="${esc(b.name)}" title="create a worktree from this branch">＋ worktree</button>`
      + `<button class="wtp-mini ghost ${menuOpen ? "on" : ""}" data-act="move" data-branch="${esc(b.name)}" title="check this branch out in an existing worktree">move</button>`
      + (menuOpen ? wtpMoveMenu(b.name) : "")
      + `</span>`;
  }
  return `<div class="wtp-brow">${nm}${divergeChip(b.ahead)}<span class="sp"></span>${action}</div>`;
}

function panelHtml(worktrees, branches, data){
  const w = state.wt;
  const closed = branches.filter((b) => b.merged && !b.worktreePath && !b.isDefault);
  const closedSet = new Set(closed);
  const active = branches.filter((b) => !closedSet.has(b));
  const liveCount = worktrees.reduce((n, x) => n + (x.serverState === "live" ? 1 : 0), 0);

  let h = `<div class="wtp">`;
  h += `<div class="wtp-head"><span class="wtp-title">Worktrees</span>`
    + `<span class="wtp-sub">${liveCount ? `${liveCount} server${liveCount === 1 ? "" : "s"} live` : `${worktrees.length} tree${worktrees.length === 1 ? "" : "s"}`}</span></div>`;
  if(w.error) h += `<div class="wtp-err"><span class="wtp-err-msg">${esc(w.error)}</span><button class="wtp-x" data-act="dismiss" aria-label="dismiss">×</button></div>`;
  h += worktrees.map(wtpItem).join("") || `<div class="wtp-empty">no worktrees</div>`;
  if(data && !data.serverScanned) h += `<div class="wtp-note">dev-server scan unavailable (lsof)</div>`;

  h += `<div class="wtp-head mt"><span class="wtp-title">Branches</span><span class="wtp-sub">${active.length}</span></div>`;
  h += active.map(wtpBranchRow).join("") || `<div class="wtp-empty">no branches</div>`;
  if(closed.length){
    h += `<button class="wtp-merged-toggle" data-act="togglemerged" aria-expanded="${w.mergedOpen}">`
      + `<span class="chev">${w.mergedOpen ? "▾" : "▸"}</span> Merged <span class="wtp-sub">${closed.length}</span></button>`;
    if(w.mergedOpen) h += `<div class="wtp-merged">${closed.map(wtpBranchRow).join("")}</div>`;
  }
  h += `</div>`;
  return h;
}

// re-render the panel from the last-fetched data (no network) — for pure UI toggles
function repaintPanel(){
  const aside = $("#workAside");
  if(!aside || !state.wtData) return;
  aside.innerHTML = panelHtml(state.wtData.worktrees, state.wtData.branches, state.wtData);
  state.wtSig = ""; // let the next poll reconcile against fresh data
}

async function renderWorktreePanel(force){
  const aside = $("#workAside");
  if(!aside) return;
  let data;
  try{ data = await api("/api/worktrees"); }
  catch(e){ if(!state.wtData) aside.innerHTML = `<div class="wtp"><div class="wtp-empty">couldn't read git state</div></div>`; return; }
  // never clobber a field the user is typing in
  if(!force && aside.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;

  const worktrees = data.worktrees || [];
  const branches = data.branches || [];
  state.wtData = { worktrees, branches, serverScanned: data.serverScanned };

  const w = state.wt;
  const sig = "wtp:" + JSON.stringify({
    w: worktrees.map((x) => [x.path, x.branch, x.serverState, (x.servers || []).map((s) => s.port), x.devCommand, x.ahead]),
    b: branches.map((x) => [x.name, x.worktreePath, x.merged, x.ahead, x.committedAt]),
    ui: [w.menuBranch, w.editCmd, w.error, w.mergedOpen, [...w.busy]],
  });
  if(!force && sig === state.wtSig) return;
  aside.innerHTML = panelHtml(worktrees, branches, data);
  state.wtSig = sig;
}

// panel button dispatch (delegated from the Work view click handler)
async function handleWtAction(el){
  const w = state.wt;
  const act = el.dataset.act;
  const wt = el.dataset.wt;
  const branch = el.dataset.branch;

  if(act === "togglemerged"){ w.mergedOpen = !w.mergedOpen; return repaintPanel(); }
  if(act === "move"){ w.menuBranch = w.menuBranch === branch ? null : branch; return repaintPanel(); }
  if(act === "dismiss"){ w.error = null; return repaintPanel(); }
  if(act === "canceledit"){ w.editCmd = null; return repaintPanel(); }
  if(act === "editcmd"){
    w.editCmd = wt; repaintPanel();
    const i = $("#wtpCmdInput"); if(i){ i.focus(); i.select(); }
    return;
  }
  if(act === "savecmd"){
    const i = $("#wtpCmdInput");
    const r = await apiPost("/api/devcommand", { command: i ? i.value : "" });
    w.editCmd = null; w.error = r && r.error ? r.error : null;
    return renderWorktreePanel(true);
  }
  if(act === "start"){
    w.busy.add("srv:" + wt); repaintPanel();
    const r = await apiPost("/api/server/start", { worktree: wt });
    w.busy.delete("srv:" + wt);
    w.error = r && r.ok === false ? (r.error || "couldn't start server") : null;
    renderWorktreePanel(true);
    setTimeout(() => renderWorktreePanel(true), 1500); // catch the port once it binds
    return;
  }
  if(act === "stop"){
    const r = await apiPost("/api/server/stop", { worktree: wt });
    w.error = r && r.ok === false ? (r.error || null) : null;
    renderWorktreePanel(true);
    setTimeout(() => renderWorktreePanel(true), 800);
    return;
  }
  if(act === "create"){
    const r = await apiPost("/api/worktree/create", { branch });
    w.error = r && r.ok === false ? (r.error || "couldn't create worktree") : null;
    return renderWorktreePanel(true);
  }
  if(act === "checkout"){
    w.menuBranch = null;
    const r = await apiPost("/api/worktree/checkout", { worktree: wt, branch });
    w.error = r && r.ok === false ? (r.error || "couldn't move worktree") : null;
    return renderWorktreePanel(true);
  }
}

// ---- cost / token usage ----------------------------------------------------
function usageStat(value, label){
  return `<div class="ustat"><div class="ustat-v">${value}</div><div class="ustat-l">${esc(label)}</div></div>`;
}

// Total tokens processed, including the cached system-prompt reads/writes that dominate the
// cost of each `claude -p` call — so the token count and the dollar cost tell the same story.
function totalTokens(d){
  return (d.input || 0) + (d.output || 0) + (d.cache_read || 0) + (d.cache_creation || 0);
}

function usageDayRow(d, max){
  const tokens = totalTokens(d);
  const pct = max > 0 ? Math.max(2, Math.round((tokens / max) * 100)) : 0;
  const dt = new Date(d.day + "T00:00:00");
  const label = MONTHS[dt.getMonth()] + " " + dt.getDate();
  return `<div class="uday">`
    + `<div class="uday-date">${esc(label)}</div>`
    + `<div class="uday-bar"><span style="width:${pct}%"></span></div>`
    + `<div class="uday-tok">${fmtTokens(tokens)}</div>`
    + `<div class="uday-cost">${d.cost ? "≈" + fmtCost(d.cost) : "$0"}</div>`
    + `</div>`;
}

async function renderUsage(force){
  const data = await api("/api/usage?days=30");
  const days = data.days || [];
  const total = data.total || { input:0, output:0, cost:0, calls:0, since:null };
  const totTokens = totalTokens(total);

  const sig = "us:" + (total.calls || 0) + ":" + Math.round((total.cost || 0) * 1e6) + ":" + days.length;
  if(!force && sig === state.sig) return;

  const maxDay = days.reduce((m, d) => Math.max(m, totalTokens(d)), 0);
  const activeDays = days.filter((d) => totalTokens(d) > 0).length;
  const perDay = activeDays ? totTokens / activeDays : 0;

  const estCost = total.cost ? "≈" + fmtCost(total.cost) : "$0";
  let html = `<div class="usage">`;
  html += `<div class="ustats">`
    + usageStat(fmtTokens(totTokens), "tokens")
    + usageStat(estCost, "at API rates")
    + usageStat(String(total.calls || 0), "calls")
    + usageStat(fmtTokens(Math.round(perDay)), "tokens / active day")
    + `</div>`;
  html += `<div class="usage-note"><span class="ui-i">ⓘ</span> Dollar figures estimate `
    + `API list price — these run on your Claude subscription, which isn't billed per token.</div>`;

  if(days.length){
    html += `<div class="section"><div class="section-head"><h2>Per day</h2>`
      + `<span class="rule"></span><span class="n">last 30d</span></div>`;
    html += `<div class="udays">${days.map((d) => usageDayRow(d, maxDay)).join("")}</div></div>`;
  } else {
    html += `<div class="empty"><div class="glyph"></div>`
      + `<div class="e-title">No spend recorded yet</div>`
      + `<div class="e-sub">token usage shows up here after the tool runs Haiku (observing a turn, synthesizing a summary, or grouping issues)</div></div>`;
  }
  html += `</div>`;

  const sinceTxt = total.since ? " · since " + total.since : "";
  setTopbar(`<span class="tb-title">Usage</span>`
    + `<span class="tb-sub">what this tool has run through Haiku${sinceTxt}</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);
  $("#usageBadge").textContent = totTokens ? fmtTokens(totTokens) : "";

  paint(html);
  state.sig = sig;
}

// ---- chrome (topbar, rail, meta) -------------------------------------------
function liveTag(){
  const cap = state.meta && state.meta.capture ? state.meta.capture : "live";
  return `<span class="tb-live"><span class="pulse"></span>${esc(cap)}</span>`;
}
function setTopbar(html){ $("#topbar").innerHTML = html; }

function renderLegend(){
  $("#legend").innerHTML = TYPE_ORDER.map((t) => {
    const hollow = typeMeta(t).node === "hollow";
    return `<div class="legend-row"><span class="legend-dot ${hollow?"hollow":""}" `
      + `style="${hollow?`border-color:${hueVar(t)}`:`background:${hueVar(t)}`}"></span>`
      + `${esc(typeMeta(t).label)}</div>`;
  }).join("");
}

async function loadMeta(){
  try{
    const m = await api("/api/meta");
    state.meta = m;
    const repo = m.repo || "";
    const slash = repo.indexOf("/");
    $("#repoOwner").textContent = slash >= 0 ? repo.slice(0, slash + 1) : repo;
    $("#repoName").textContent = slash >= 0 ? repo.slice(slash + 1) : "";
    const cap = $("#capture");
    cap.hidden = false;
    cap.classList.toggle("explicit", m.capture === "explicit");
    $(".cap-label", cap).textContent = m.capture || "live";
    $("#workBadge").textContent = m.threads != null ? m.threads : "";
    $("#usageBadge").textContent = m.tokens ? fmtTokens(m.tokens) : "";
    $("#looseFoot").innerHTML = m.loose
      ? `<span class="n">${m.loose}</span> loose end${m.loose===1?"":"s"} open`
      : `no loose ends`;
  }catch(e){ /* meta is best-effort chrome; views still render */ }
}

// ---- project switcher -------------------------------------------------------
// The ledger is one DB spanning every repo on the machine; the server defaults to the repo
// it was launched in but can scope any request to another via ?repo=. This lets the operator
// hop between project dashboards from the rail.
function splitSlug(slug){
  const s = String(slug || "");
  const i = s.indexOf("/");
  return i >= 0 ? [s.slice(0, i + 1), s.slice(i + 1)] : [s, ""];
}

const savedProject = () => { try{ return localStorage.getItem("pm-project"); }catch(e){ return null; } };
const rememberProject = (s) => { try{ localStorage.setItem("pm-project", s); }catch(e){} };

async function loadProjects(){
  let d;
  try{ d = await api("/api/projects"); }catch(e){ return; }
  state.projects = d.projects || [];
  const known = (s) => !!s && state.projects.some((p) => p.slug === s);
  // Keep the current selection if it's still valid; else restore the last-viewed project;
  // else fall back to the most-recently-active one (listRepos already sorts by activity).
  if(!known(state.project)){
    const saved = savedProject();
    state.project = known(saved) ? saved
      : (state.projects[0] && state.projects[0].slug) || null;
  }
  renderSwitcher();
}

// Only offer the switcher when there's more than one project; otherwise the rail reads as
// a plain repo label, exactly as before.
function renderSwitcher(){
  const btn = $("#repoBtn");
  const chev = $("#repoChev");
  const multi = state.projects.length > 1;
  if(btn) btn.disabled = !multi;
  if(chev) chev.hidden = !multi;
  if(!multi) closeMenu();
  renderMenu();
}

function projHint(p){
  const n = p.threads || 0;
  return n ? n + " initiative" + (n === 1 ? "" : "s") : "no activity";
}

function renderMenu(){
  const menu = $("#repoMenu");
  if(!menu) return;
  menu.innerHTML = state.projects.map((p) => {
    const [owner, name] = splitSlug(p.slug);
    const sel = p.slug === state.project;
    return `<button class="repo-opt ${sel ? "sel" : ""}" type="button" role="option" `
      + `aria-selected="${sel}" data-slug="${esc(p.slug)}">`
      +   `<span class="ro-tick">${sel ? "✓" : ""}</span>`
      +   `<span class="ro-id"><span class="ro-owner">${esc(owner)}</span><span class="ro-name">${esc(name || owner)}</span></span>`
      +   `<span class="ro-hint">${esc(projHint(p))}</span>`
      + `</button>`;
  }).join("");
}

function openMenu(){
  if(state.menuOpen || state.projects.length < 2) return;
  state.menuOpen = true;
  $("#repoMenu").hidden = false;
  $("#repoBtn").setAttribute("aria-expanded", "true");
}
function closeMenu(){
  if(!state.menuOpen) return;
  state.menuOpen = false;
  const menu = $("#repoMenu");
  const btn = $("#repoBtn");
  if(menu) menu.hidden = true;
  if(btn) btn.setAttribute("aria-expanded", "false");
}

async function selectProject(slug){
  closeMenu();
  if(!slug || slug === state.project) return;
  state.project = slug;
  rememberProject(slug);
  // Wipe every per-project cache — we're looking at a different ledger now.
  state.sig = ""; state.primed = false;
  state.seenEvents.clear(); state.threadCache.clear(); state.expanded.clear();
  renderMenu();
  await loadMeta();
  // A thread id belongs to the old project; drop back to Work rather than 404. Otherwise
  // just re-render the current view against the new project.
  if(state.view === "thread"){ location.hash = "#/work"; }
  else { state.threadId = null; await refresh(true); }
}

// ---- interactions -----------------------------------------------------------
// expand a thread row: reveal its issues (lazy-fetched), commits demoted below
async function toggleRow(head){
  const key = head.dataset.key;
  const id = head.dataset.id;
  const row = head.closest(".trow");
  const detail = row.querySelector(".trow-detail");
  if(state.expanded.has(key)){
    state.expanded.delete(key);
    row.classList.remove("open");
    head.setAttribute("aria-expanded", "false");
    detail.hidden = true; detail.innerHTML = "";
    return;
  }
  state.expanded.add(key);
  row.classList.add("open");
  head.setAttribute("aria-expanded", "true");
  detail.hidden = false;
  detail.innerHTML = expanderBody(id); // "reading…" until cached
  try{ await ensureThread(id); }catch(e){ /* keep loading note */ }
  if(state.expanded.has(key) && detail.isConnected) detail.innerHTML = expanderBody(id);
}

function toggleCommits(btn){
  const box = document.getElementById(btn.dataset.target);
  if(!box) return;
  const opening = box.hasAttribute("hidden");
  if(opening) box.removeAttribute("hidden"); else box.setAttribute("hidden", "");
  btn.setAttribute("aria-expanded", opening ? "true" : "false");
}

function initInteractions(){
  viewEl.addEventListener("click", (e) => {
    // worktrees panel controls (buttons carry data-act; the open-server link is a plain <a>)
    const wtAct = e.target.closest("[data-act]");
    if(wtAct && wtAct.closest("#workAside")){ e.preventDefault(); handleWtAction(wtAct); return; }
    const commits = e.target.closest(".commits-toggle");
    if(commits){ e.preventDefault(); toggleCommits(commits); return; }
    const head = e.target.closest(".trow-head");
    if(head){ e.preventDefault(); toggleRow(head); return; }
    if(e.target.closest("a")) return; // let explicit links behave
    const card = e.target.closest(".card");
    if(card && card.dataset.href){
      if(window.getSelection && String(window.getSelection()).length) return; // reading
      location.hash = card.dataset.href;
    }
  });

  // Enter saves / Escape cancels the inline dev-command editor
  viewEl.addEventListener("keydown", (e) => {
    if(e.target.id !== "wtpCmdInput") return;
    if(e.key === "Enter"){ e.preventDefault(); handleWtAction({ dataset:{ act:"savecmd" } }); }
    else if(e.key === "Escape"){ e.preventDefault(); state.wt.editCmd = null; repaintPanel(); }
  });

  // view-mode links are anchors; the All/Unfinished filter is a stateful toggle
  $("#topbar").addEventListener("click", (e) => {
    const f = e.target.closest("[data-filter]");
    if(!f) return;
    e.preventDefault();
    if(state.filter !== f.dataset.filter){ state.filter = f.dataset.filter; refresh(true); }
  });

  // project switcher: the rail repo label opens a dropdown of every project in the ledger
  $("#repoBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if(state.projects.length < 2) return;
    state.menuOpen ? closeMenu() : openMenu();
  });
  $("#repoMenu").addEventListener("click", (e) => {
    const opt = e.target.closest(".repo-opt");
    if(!opt) return;
    e.preventDefault();
    selectProject(opt.dataset.slug);
  });
  // dismiss the menu on an outside click or Escape
  document.addEventListener("click", (e) => {
    if(state.menuOpen && !e.target.closest("#repoMenu") && !e.target.closest("#repoBtn")) closeMenu();
    // close the worktree "move" picker when clicking away from it
    if(state.wt.menuBranch && !e.target.closest(".wtp-menu") && !e.target.closest('[data-act="move"]')){
      state.wt.menuBranch = null; repaintPanel();
    }
  });
  document.addEventListener("keydown", (e) => { if(e.key === "Escape") closeMenu(); });
}

async function boot(){
  renderLegend();
  initInteractions();
  viewEl.innerHTML = `<div class="loading">reading the ledger…</div>`;
  await loadProjects();
  await loadMeta();
  window.addEventListener("hashchange", onRoute);
  await onRoute();
  // gentle live polling
  setInterval(() => { loadMeta(); refresh(false); }, 4000);
  // keep relative ages / dates fresh even without new data; also pick up new projects
  setInterval(() => {
    loadProjects();
    if(state.view === "inflight" || state.view === "work") refresh(true);
  }, 60000);
}

boot();
