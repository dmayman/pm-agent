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

// initiative lifecycle (the new model): planned -> active -> closed. Distinct from the per-issue
// LIFECYCLE above; drives the pill on Update cards, area/initiative rows, and the initiative header.
const INIT_LIFECYCLE = {
  planned: { label:"planned", pc:"var(--t-deferred)" },
  active:  { label:"active",  pc:"var(--t-built)"    },
  closed:  { label:"closed",  pc:"var(--t-merged)"   },
};
const initLifeMeta = (s) => INIT_LIFECYCLE[s] || { label:s || "—", pc:"var(--ink-mute)" };

// ---- tiny helpers -----------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;");

// Inline icon set (Lucide's outline glyphs, vendored as bare SVG — no bundler in this app, so a
// package-manager dependency isn't reachable; this is the same markup `import`ing the library
// would hand you). Sized in em units so each one scales with its surrounding text, and rendered
// as real vector shapes instead of Unicode glyphs, which vary in weight/baseline across fonts.
const ICON_PATHS = {
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  externalLink: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
};
function icon(name, cls){
  return `<svg class="icon${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

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
  if(refs.branch)        out.push(refChip("branch", "branch", `<span class="k">${icon("branch")}</span>${esc(refs.branch)}`, refs.branch));
  if(refs.commit)        out.push(refChip("commit", "commit", `${esc(String(refs.commit).slice(0,7))}`, refs.commit));
  return out.join("");
}

function nodeClass(t){
  const n = typeMeta(t).node;
  return n === "hollow" ? "node hollow" : n === "glow" ? "node glow" : n === "alarm" ? "node alarm" : "node";
}

// ---- app state --------------------------------------------------------------
const state = {
  view: "timeline",        // timeline | areas | initiative | area | usage
  paramId: null,           // :id for the initiative/area drill-in views
  meta: null,
  project: null,           // slug of the repo currently being viewed
  projects: [],            // all repos in the ledger (for the switcher)
  menuOpen: false,         // project switcher dropdown state
  seenEvents: new Set(),   // event ids we've already rendered (for new-flash)
  primed: false,           // first render done -> flashing enabled
  sig: "",                 // last-rendered signature per view
  // worktrees panel (right rail on Timeline)
  wt: { openMenu:null, editCmd:null, error:null, mergedOpen:false, busy:new Set() },
  wtData: null,            // last /api/worktrees payload (for no-network repaints)
  wtSig: "",               // last-rendered panel signature
};

const viewEl = $("#view");
const mainEl = $("#main");

// ---- routing ----------------------------------------------------------------
// Two primary views (Timeline, Areas) + their drill-ins (initiative/:id, area/:id) + Usage.
// Legacy hashes (#/work, #/inflight, #/thread/:id) fold onto the new model so old links resolve.
function parseHash(){
  const h = (location.hash || "#/timeline").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if(parts[0] === "initiative" && parts[1]) return { view:"initiative", paramId:parts[1] };
  if(parts[0] === "area" && parts[1])       return { view:"area", paramId:parts[1] };
  if(parts[0] === "areas")   return { view:"areas" };
  if(parts[0] === "usage")   return { view:"usage" };
  if(parts[0] === "timeline") return { view:"timeline" };
  if(parts[0] === "thread" && parts[1]) return { view:"initiative", paramId:parts[1] }; // legacy
  return { view:"timeline" }; // work / inflight / anything else -> the stream
}

function syncNav(){
  // initiative/area drill-ins belong to Areas; usage stands alone; everything else is Timeline
  const activeNav = state.view === "usage" ? "usage"
    : (state.view === "areas" || state.view === "area" || state.view === "initiative") ? "areas"
    : "timeline";
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === activeNav);
  });
}

async function onRoute(){
  const r = parseHash();
  const changed = r.view !== state.view || r.paramId !== state.paramId;
  state.view = r.view;
  state.paramId = r.paramId || null;
  if(changed){ state.sig = ""; state.primed = false; state.seenEvents.clear(); mainEl.scrollTop = 0; }
  syncNav();
  await refresh(changed);
}

// ---- data + render orchestration -------------------------------------------
async function refresh(force){
  try{
    if(state.view === "areas")           await renderAreas(force);
    else if(state.view === "initiative") await renderInitiative(force);
    else if(state.view === "area")       await renderArea(force);
    else if(state.view === "usage")      await renderUsage(force);
    else                                 await renderTimeline(force);
  }catch(err){
    if(!state.sig) viewEl.innerHTML = `<div class="empty"><div class="glyph"></div>`
      + `<div class="e-title">Couldn't reach the ledger</div>`
      + `<div class="e-sub">${esc(err.message)}</div></div>`;
  }
}

/* Re-render into `viewEl` while keeping the scroll position stable.
   New events prepend at the top and push content down; we compensate so the
   viewport doesn't jump — unless the user is already at the very top, where
   we let new arrivals slide into view.
   Rendering goes through morphInto (not innerHTML=) so unchanged rows keep their
   DOM identity: only genuinely new/changed nodes are touched, which is what stops
   the whole view flashing (and re-running its entry animations) on every refresh. */
function paint(html, { scrollSafe, target } = {}){
  const el = target || viewEl;
  if(!scrollSafe){ morphInto(el, html); return; }
  const nearTop = mainEl.scrollTop < 48;
  const prevTop = mainEl.scrollTop;
  const prevH = mainEl.scrollHeight;
  morphInto(el, html);
  if(!nearTop){
    const delta = mainEl.scrollHeight - prevH;
    if(delta > 0) mainEl.scrollTop = prevTop + delta;
  }
}

// ---- keyed DOM morph (dependency-free, ~a tiny morphdom) --------------------
// Reconcile `el`'s children to match `html`, reusing existing nodes instead of rebuilding the
// subtree. Repeated rows carry a data-key (event id, thread id, day) so a prepended or reordered
// row reuses its node rather than shifting every sibling; unkeyed nodes match positionally by
// tag + first class, so a structural swap (a list becoming an empty state) cleanly replaces.
// The payoff: steady-state refreshes mutate nothing, and new arrivals are the only nodes
// inserted — so CSS entry animations fire once, for real changes, and never as a full-view flash.
function morphInto(el, html){
  const tmp = el.cloneNode(false); // empty same-type container = correct parsing context
  tmp.innerHTML = html;
  morphChildren(el, tmp);
}

function keyOf(n){ return n.nodeType === 1 ? n.getAttribute("data-key") : null; }
function firstClass(n){ return (n.getAttribute("class") || "").split(" ")[0] || ""; }
function sameType(a, b){
  if(a.nodeType !== b.nodeType) return false;
  if(a.nodeType !== 1) return true;                 // text/comment: node type alone is enough
  return a.nodeName === b.nodeName && firstClass(a) === firstClass(b);
}

function morphEl(from, to){
  // sync attributes both ways
  const fa = from.attributes, ta = to.attributes;
  for(let i = fa.length - 1; i >= 0; i--){ if(!to.hasAttribute(fa[i].name)) from.removeAttribute(fa[i].name); }
  for(let i = 0; i < ta.length; i++){ const a = ta[i]; if(from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value); }
  // never stomp a field the user is typing in (its value/caret live in the DOM, not the html)
  const tag = from.tagName;
  if(from === document.activeElement && (tag === "INPUT" || tag === "TEXTAREA")) return;
  morphChildren(from, to);
}

function morphChildren(from, to){
  // Bucket the current children: keyed by their key, unkeyed in document order.
  const oldKeyed = new Map();
  const oldUnkeyed = [];
  for(let c = from.firstChild; c; c = c.nextSibling){
    const k = keyOf(c);
    if(k) oldKeyed.set(k, c); else oldUnkeyed.push(c);
  }
  // Walk the desired children, reusing a matched node (morphing it) or importing a fresh one.
  let u = 0;
  const result = [];
  for(let n = to.firstChild; n; n = n.nextSibling){
    const k = keyOf(n);
    let match = null;
    if(k){
      if(oldKeyed.has(k)){ match = oldKeyed.get(k); oldKeyed.delete(k); }
    } else {
      while(u < oldUnkeyed.length){
        const cand = oldUnkeyed[u++];
        if(sameType(cand, n)){ match = cand; break; } // else: incompatible — let it be dropped
      }
    }
    if(match){
      if(match.nodeType === 1) morphEl(match, n);
      else if(match.nodeValue !== n.nodeValue) match.nodeValue = n.nodeValue;
      result.push(match);
    } else {
      result.push(document.importNode(n, true)); // brand-new node → entry animation fires here
    }
  }
  // Drop any current child not being kept, then splice `from` into exactly `result` order,
  // reusing nodes (insertBefore moves an existing node rather than cloning it).
  const keep = new Set(result);
  for(let c = from.firstChild; c;){ const next = c.nextSibling; if(!keep.has(c)) from.removeChild(c); c = next; }
  let ref = from.firstChild;
  for(const node of result){
    if(node === ref){ ref = ref.nextSibling; continue; }
    from.insertBefore(node, ref);
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

  return `<div class="event ${isNew ? "is-new" : ""} ${dim ? "dim" : ""}" data-key="ev-${esc(ev.id)}" `
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

// ---- update cards + areas/initiative views ---------------------------------
// A time range for an update — one date when it's a single day, "start – end" across days.
function fmtRange(a, b){
  const sa = fmtShortDate(a), sb = fmtShortDate(b);
  if(!sa && !sb) return "";
  if(!sa) return sb;
  if(!sb) return sa;
  return sa === sb ? sa : sa + " – " + sb;
}

// A loose event — one that belongs to no update. A lightweight dashed row (existing .loose-row
// styling), quieter than an Update card.
function looseRow(ev, i){
  const refs = refChips(ev.refs);
  const t = typeMeta(ev.type);
  return `<div class="loose-row" data-key="ev-${esc(ev.id)}" style="--hue:${hueVar(ev.type)};--d:${Math.min(i, 12) * 26}ms">`
    + `<span class="lnode"></span>`
    + `<div class="loose-body">`
    +   `<div class="loose-sum">${esc(ev.summary)}</div>`
    +   `<div class="loose-meta"><span class="type-tag">${esc(t.label)}</span>`
    +     (refs ? `<span class="sep">·</span>${refs}` : "")
    +   `</div>`
    + `</div>`
    + `<span class="loose-age">${esc(relAge(ev.ts))}</span>`
    + `</div>`;
}

// The heart of the Timeline: one Update — a time-bound cluster of events under a thread. Shows
// the thread title + area chip + lifecycle pill (its "head", suppressed on a thread page where
// that context is already the header), the succinct why+outcome summary, a time range, and a
// collapsed "N events" disclosure that expands to the raw event rows (reused eventRow + nodes).
function updateCard(u, i, opts){
  opts = opts || {};
  const events = u.events || [];
  const n = u.event_count != null ? u.event_count : events.length;
  const hasEvents = events.length > 0;
  const range = fmtRange(u.ts_start, u.ts_end);
  const evId = "updev-" + esc(u.id);

  let head = "";
  if(opts.showHead !== false){
    const isArea = u.thread_kind === "area";
    const href = (isArea ? "#/area/" : "#/initiative/") + encodeURIComponent(u.thread_id);
    const areaChip = (!isArea && u.area_id != null)
      ? `<a class="area-chip" href="#/area/${encodeURIComponent(u.area_id)}">${esc(u.area_title || "area")}</a>`
      : "";
    const lm = initLifeMeta(u.lifecycle);
    const life = (!isArea && u.lifecycle)
      ? `<span class="pill" style="--pc:${lm.pc}"><span class="pdot"></span>${esc(lm.label)}</span>`
      : "";
    const live = u.sealed ? "" : `<span class="upd-live">open</span>`;
    head = `<div class="upd-head">`
      + `<a class="upd-title" href="${href}">${esc(u.thread_title || "Untitled")}</a>`
      + areaChip + life + `<span class="sp"></span>` + live
      + `</div>`;
  }

  const summary = u.summary
    ? `<div class="upd-summary">${fmtSummary(u.summary)}</div>`
    : `<div class="upd-summary none">No summary distilled for this update yet.</div>`;

  const toggle = hasEvents
    ? `<button class="commits-toggle" data-target="${evId}" aria-expanded="false">`
      + `<span class="chev">›</span> ${n} event${n === 1 ? "" : "s"}</button>`
    : "";
  const meta = (range || toggle)
    ? `<div class="upd-meta">${range ? `<span class="upd-range">${esc(range)}</span>` : ""}${toggle}</div>`
    : "";
  const evList = hasEvents
    ? `<div class="events" id="${evId}" hidden>${events.map((ev, j) => eventRow(ev, j)).join("")}</div>`
    : "";

  return `<article class="upd-card" data-key="upd-${esc(u.id)}" style="--d:${Math.min(i, 12) * 26}ms">`
    + head + summary + meta + evList + `</article>`;
}

// an issue row inside a thread — the lifecycle IS the content
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
    ? `<a class="issue-branch" href="${esc(brUrl)}" target="_blank" rel="noopener"><span class="k">${icon("branch")}</span>${esc(iss.branch)}</a>`
    : `<span class="issue-branch"><span class="k">${icon("branch")}</span>${esc(iss.branch)}</span>`;
  return `<div class="issue-row ${unf ? "unfin" : ""}" style="--pc:${lm.pc}">`
    + `<span class="issue-pill"><span class="ip-dot"></span>${esc(lm.label)}</span>`
    + num
    + `<span class="issue-title">${esc(iss.title)}</span>`
    + branch
    + `</div>`;
}

function emptyBlock(title, sub){
  return `<div class="empty"><div class="glyph"></div>`
    + `<div class="e-title">${esc(title)}</div><div class="e-sub">${esc(sub)}</div></div>`;
}

function markSeenUpdates(updates, loose){
  for(const u of updates) for(const ev of (u.events || [])) state.seenEvents.add(ev.id);
  for(const ev of (loose || [])) state.seenEvents.add(ev.id);
  state.primed = true;
}

// ---- Timeline: the stream of Update cards (default view) --------------------
// Timeline is the one view that spans full width: the stream fills the space up to the worktrees
// panel pinned at the right edge. Built once per entry so the panel keeps its own state across
// the stream's live repaints.
function ensureTimelineShell(){
  if($("#timelineCol")) return;
  viewEl.innerHTML = `<div class="work-wrap"><div class="work-col" id="timelineCol"></div>`
    + `<aside class="work-aside" id="workAside"></aside></div>`;
  state.sig = ""; state.wtSig = "";
}

async function renderTimeline(force){
  ensureTimelineShell();
  renderWorktreePanel(force); // right rail — independent, runs concurrently

  const data = await api("/api/timeline");
  // Code defensively against the seam: the new shape is { updates, loose }; tolerate a bare array
  // (the old events-only endpoint) by treating it as loose events.
  let updates, loose;
  if(Array.isArray(data)){ updates = []; loose = data; }
  else { updates = data.updates || []; loose = data.loose || []; }

  const sig = "tl:" + updates.length + ":" + loose.length + ":"
    + updates.map((u) => u.id + "@" + u.ts_end + "@" + (u.sealed ? 1 : 0)
        + "@" + (u.summary ? 1 : 0) + "@" + (u.event_count || (u.events || []).length)).join(",")
    + ":" + loose.map((e) => e.id).join(",");
  if(!force && sig === state.sig) return;

  let html = "";
  if(updates.length || loose.length){
    if(updates.length){
      html += `<div class="upd-stream">${updates.map((u, i) => updateCard(u, i, { context:"timeline" })).join("")}</div>`;
    }
    if(loose.length){
      html += `<div class="section loose-section"><div class="section-head"><h2>Loose events</h2>`
        + `<span class="rule"></span><span class="n">${loose.length}</span></div>`
        + `<div class="loose-list">${loose.map((e, i) => looseRow(e, i)).join("")}</div></div>`;
    }
  } else {
    html += emptyBlock("No updates yet", "activity clusters into updates as work streams in");
  }

  setTopbar(`<span class="tb-title">Timeline</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);
  const tb = $("#timelineBadge"); if(tb) tb.textContent = updates.length || "";

  paint(html, { scrollSafe: !force && state.primed, target: $("#timelineCol") });
  markSeenUpdates(updates, loose);
  state.sig = sig;
}

// ---- Areas: evergreen threads, each with its initiatives --------------------
// one initiative, as a row inside an area card or an area page
function initRow(it){
  const lm = initLifeMeta(it.lifecycle);
  const age = it.last_event_ts ? `<span class="init-age">${esc(relAge(it.last_event_ts))}</span>` : "";
  const parts = [];
  if(it.issue_count) parts.push(it.issue_count + " issue" + (it.issue_count === 1 ? "" : "s"));
  if(it.event_count) parts.push(it.event_count + " event" + (it.event_count === 1 ? "" : "s"));
  const counts = parts.length ? `<span class="init-count">${esc(parts.join(" · "))}</span>` : "";
  return `<a class="init-row" href="#/initiative/${encodeURIComponent(it.id)}">`
    + `<span class="pill" style="--pc:${lm.pc}"><span class="pdot"></span>${esc(lm.label)}</span>`
    + `<span class="init-title">${esc(it.title || "Untitled initiative")}</span>`
    + counts + age
    + `</a>`;
}

function areaCard(a){
  const inits = a.initiatives || [];
  const desc = a.description ? `<p class="area-desc">${esc(a.description)}</p>` : "";
  const status = a.summary ? `<p class="area-status">${fmtSummary(a.summary)}</p>` : "";
  const age = a.last_event_ts ? `<span class="area-age">${esc(relAge(a.last_event_ts))}</span>` : "";
  const body = inits.length
    ? `<div class="area-inits">${inits.map(initRow).join("")}</div>`
    : `<div class="area-none">no initiatives yet</div>`;
  return `<article class="area-card" data-key="area-${esc(a.id)}">`
    + `<div class="area-top"><a class="area-title" href="#/area/${encodeURIComponent(a.id)}">${esc(a.title || "Untitled area")}</a>${age}</div>`
    + desc + status + body
    + `</article>`;
}

async function renderAreas(force){
  const data = await api("/api/areas");
  const areas = data.areas || [];

  const sig = "as:" + areas.length + ":"
    + areas.map((a) => a.id + "@" + (a.summary ? 1 : 0) + "@" + a.last_event_ts
        + "@" + (a.initiatives || []).map((it) => it.id + ":" + it.lifecycle + ":" + it.last_event_ts).join("+")).join(",");
  if(!force && sig === state.sig) return;

  const html = areas.length
    ? `<div class="area-list">${areas.map(areaCard).join("")}</div>`
    : emptyBlock("No areas yet", "areas group your initiatives — they'll appear here once the ledger is organized");

  setTopbar(`<span class="tb-title">Areas</span>`
    + `<span class="tb-sub">${areas.length} area${areas.length === 1 ? "" : "s"}</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);
  const ab = $("#areasBadge"); if(ab) ab.textContent = areas.length || "";

  paint(html);
  state.primed = true;
  state.sig = sig;
}

// ---- Initiative view: the why + issues + a stack of Update cards ------------
async function renderInitiative(force){
  const data = await api("/api/initiative/" + encodeURIComponent(state.paramId));
  const it = data.initiative || {};
  const updates = data.updates || [];
  const issues = (data.issues || []).slice()
    .sort((a, b) => (isUnfinished(b.status) - isUnfinished(a.status)) || ((b.number || 0) - (a.number || 0)));

  const sig = "in:" + state.paramId + ":" + it.lifecycle + ":" + issues.length + ":" + updates.length
    + ":" + updates.map((u) => u.id + "@" + u.ts_end + "@" + (u.sealed ? 1 : 0) + "@" + (u.summary ? 1 : 0)).join(",");
  if(!force && sig === state.sig) return;

  const lm = initLifeMeta(it.lifecycle);
  const areaChip = it.area_id != null
    ? `<a class="area-chip" href="#/area/${encodeURIComponent(it.area_id)}">${esc(it.area_title || "area")}</a>`
    : "";
  const why = it.why
    ? `<p class="th-summary">${fmtSummary(it.why)}</p>`
    : `<p class="th-summary none">No stated why yet — the motivation is still being distilled.</p>`;
  const desc = it.description
    ? `<div class="th-genesis"><span class="rune">detail</span><span>${esc(it.description)}</span></div>`
    : "";
  const head = `<div class="thread-head">`
    + `<div class="th-status-row">`
    +   (it.lifecycle ? `<span class="pill" style="--pc:${lm.pc}"><span class="pdot"></span>${esc(lm.label)}</span>` : "")
    +   `<span class="th-title">${esc(it.title || "Untitled initiative")}</span>`
    +   areaChip
    + `</div>${why}${desc}</div>`;

  const issuesSection = issues.length
    ? `<div class="section"><div class="section-head"><h2>Issues</h2><span class="rule"></span>`
      + `<span class="n">${issues.length}</span></div>`
      + `<div class="exp-issues detail">${issues.map(issueRow).join("")}</div></div>`
    : "";

  const updatesSection = `<div class="section"><div class="section-head"><h2>Updates</h2>`
    + `<span class="rule"></span>${updates.length ? `<span class="n">${updates.length}</span>` : ""}</div>`
    + (updates.length
      ? `<div class="upd-stream">${updates.map((u, i) => updateCard(u, i, { showHead:false })).join("")}</div>`
      : emptyBlock("No updates yet", "activity clusters into updates as work streams in"))
    + `</div>`;

  const backHref = it.area_id != null ? "#/area/" + encodeURIComponent(it.area_id) : "#/areas";
  const backLabel = it.area_title || "Areas";
  setTopbar(`<a class="tb-back" href="${backHref}"><span class="arw">←</span>${esc(backLabel)}</a>`
    + `<span class="tb-title">${esc(it.title || "Initiative")}</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);

  paint(head + issuesSection + updatesSection);
  markSeenUpdates(updates, []);
  state.sig = sig;
}

// ---- Area view: description + rolling status + initiatives + updates --------
async function renderArea(force){
  const data = await api("/api/area/" + encodeURIComponent(state.paramId));
  const a = data.area || {};
  const inits = data.initiatives || [];
  const updates = data.updates || [];

  const sig = "ar:" + state.paramId + ":" + (a.summary ? 1 : 0) + ":" + inits.length + ":" + updates.length
    + ":" + inits.map((it) => it.id + "@" + it.lifecycle + "@" + it.last_event_ts).join(",")
    + ":" + updates.map((u) => u.id + "@" + u.ts_end + "@" + (u.sealed ? 1 : 0)).join(",");
  if(!force && sig === state.sig) return;

  const desc = a.description ? `<p class="th-summary">${esc(a.description)}</p>` : "";
  const status = a.summary
    ? `<div class="th-genesis"><span class="rune">status</span><span>${fmtSummary(a.summary)}</span></div>`
    : "";
  const head = `<div class="thread-head">`
    + `<div class="th-status-row"><span class="th-title">${esc(a.title || "Untitled area")}</span></div>`
    + `${desc}${status}</div>`;

  const initsSection = `<div class="section"><div class="section-head"><h2>Initiatives</h2>`
    + `<span class="rule"></span>${inits.length ? `<span class="n">${inits.length}</span>` : ""}</div>`
    + (inits.length
      ? `<div class="area-inits flat">${inits.map(initRow).join("")}</div>`
      : emptyBlock("No initiatives yet", "initiatives under this area appear here"))
    + `</div>`;

  const updatesSection = updates.length
    ? `<div class="section"><div class="section-head"><h2>Recent updates</h2>`
      + `<span class="rule"></span><span class="n">${updates.length}</span></div>`
      + `<div class="upd-stream">${updates.map((u, i) => updateCard(u, i, { showHead:false })).join("")}</div></div>`
    : "";

  setTopbar(`<a class="tb-back" href="#/areas"><span class="arw">←</span>Areas</a>`
    + `<span class="tb-title">${esc(a.title || "Area")}</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);

  paint(head + initsSection + updatesSection);
  markSeenUpdates(updates, []);
  state.sig = sig;
}

// ---- worktrees panel (right rail on Timeline) ------------------------------
// Organized by BRANCH. A worktree can only hold one branch at a time, so "which worktree is on
// which branch" is really a property of the branch — every local branch is a card, pinned with
// the default branch first. A card's primary action (top line) is the Run split-button when it
// has a worktree to run from, or a ghost "+ worktree" button when it doesn't; which worktree it's
// checked into (the repo's own primary checkout, shown with ⌂, or a linked worktree's folder name)
// is secondary info on the second line, only present once a worktree exists. Merged branches with
// no worktree collapse into a dropdown. Renders into #workAside beside the Work timeline.

// ahead/behind chip vs the default branch — "↑2" = 2 commits ahead, "↓1" = 1 behind.
function divergeChip(ab, baseName){
  if(!ab || (!ab.ahead && !ab.behind)) return "";
  const base = baseName || "default";
  const parts = [];
  if(ab.ahead)  parts.push(`<span class="wt-ahead" title="${ab.ahead} commit${ab.ahead === 1 ? "" : "s"} ahead of ${esc(base)}">${icon("arrowUp")}${ab.ahead}</span>`);
  if(ab.behind) parts.push(`<span class="wt-behind" title="${ab.behind} commit${ab.behind === 1 ? "" : "s"} behind ${esc(base)}">${icon("arrowDown")}${ab.behind}</span>`);
  return `<span class="wt-diverge">${parts.join("")}</span>`;
}

// A worktree's human label: the repo's own checkout is "Primary"; linked ones show their folder.
function wtLabel(wt){ return wt.isMain ? "Primary" : wt.name; }

// worktree folder names are often <branch-slug>-<hash>; keep both ends readable on one line
// ("agent-…555d78") rather than clipping the tail, which is where the hash actually lives.
function midEllipsis(s, head = 10, tail = 8){
  s = String(s);
  return s.length <= head + tail + 1 ? s : s.slice(0, head) + "…" + s.slice(-tail);
}

// The Run split-button for a branch's worktree: live (open link + stop), starting (spinner +
// stop), or idle (▶Run + a caret that opens the run-menu — start disabled with no command yet).
function runControl(wt, menuOpen){
  const key = wt.path;
  const busy = state.wt.busy.has("srv:" + key);
  if(wt.serverState === "live" && wt.servers.length){
    const s = wt.servers[0];
    return `<div class="wtp-run live">`
      + `<a class="wtp-open" href="${esc(s.url)}" target="_blank" rel="noopener"><span class="wtp-dot"></span>localhost:${esc(s.port)}<span class="arw">${icon("externalLink")}</span></a>`
      + `<button class="wtp-btn stop" data-act="stop" data-wt="${esc(key)}">stop</button></div>`;
  }
  if(wt.serverState === "starting"){
    return `<div class="wtp-run starting"><span class="wtp-spin"></span><span class="wtp-starting">starting…</span>`
      + `<button class="wtp-btn stop" data-act="stop" data-wt="${esc(key)}">stop</button></div>`;
  }
  const title = wt.devCommand ? esc(wt.devCommand) : "no run command set";
  return `<div class="wtp-run split">`
    + `<button class="wtp-btn run-main" data-act="start" data-wt="${esc(key)}" ${busy || !wt.devCommand ? "disabled" : ""} title="${title}">${icon("play")}<span>Run</span></button>`
    + `<button class="wtp-btn run-caret wtp-trigger${menuOpen ? " on" : ""}" data-act="runmenu" data-wt="${esc(key)}" aria-label="run options">${icon("chevronDown")}</button>`
    + `</div>`;
}

// the run-menu: just "edit run command", or the inline editor once that's been clicked.
function runMenuHtml(wt){
  const key = wt.path;
  if(state.wt.editCmd === key){
    return `<div class="wtp-menu run-menu"><div class="wtp-editor">`
      + `<input type="text" class="wtp-input" id="wtpCmdInput" value="${esc(wt.devCommand || "")}" placeholder="e.g. npm run dev" spellcheck="false" autocomplete="off" />`
      + `<button class="wtp-btn save" data-act="savecmd">save</button>`
      + `<button class="wtp-btn ghost" data-act="canceledit">cancel</button></div></div>`;
  }
  return `<div class="wtp-menu run-menu">`
    + `<button class="wtp-menu-opt" data-act="editcmd" data-wt="${esc(key)}"><span class="wtp-menu-name">Edit run command</span></button>`
    + `</div>`;
}

// A worktree is "live" if its fallback dev server is up OR any declared service is running.
function wtIsLive(wt){
  return wt.serverState === "live" || (wt.services || []).some((s) => s.state === "live");
}
// Count of live services in a worktree (declared services if any, else the fallback dev server).
function wtLiveCount(wt){
  if(wt.servicesDeclared) return (wt.services || []).filter((s) => s.state === "live").length;
  return wt.serverState === "live" ? 1 : 0;
}

// One declared service: a status dot (live/starting/stopped), its name (+ :port), an open-link
// shown only when live, and a per-service Run (▶) / Stop (■) button.
function serviceRow(wt, s){
  const key = wt.path;
  const busy = state.wt.busy.has("svc:" + key + "|" + s.name) || state.wt.busy.has("svcall:" + key);
  const live = s.state === "live";
  const open = (live && s.liveUrl)
    ? `<a class="wtp-svc-open" href="${esc(s.liveUrl)}" target="_blank" rel="noopener" title="${esc(s.liveUrl)}">${icon("externalLink")}</a>`
    : "";
  const ctrl = live
    ? `<button class="wtp-btn stop wtp-svc-btn" data-act="svc-stop" data-wt="${esc(key)}" data-svc="${esc(s.name)}" ${busy ? "disabled" : ""} aria-label="stop ${esc(s.name)}">${icon("stop")}</button>`
    : `<button class="wtp-btn run wtp-svc-btn" data-act="svc-start" data-wt="${esc(key)}" data-svc="${esc(s.name)}" ${busy ? "disabled" : ""} title="${esc(s.command)}" aria-label="start ${esc(s.name)}">${icon("play")}</button>`;
  return `<div class="wtp-svc ${esc(s.state)}">`
    + `<span class="wtp-svc-dot ${esc(s.state)}"></span>`
    + `<span class="wtp-svc-name" title="${esc(s.name)}">${esc(s.name)}</span>`
    + (s.port ? `<span class="wtp-svc-port">:${esc(s.port)}</span>` : "")
    + `<span class="sp"></span>${open}${ctrl}</div>`;
}

// The per-worktree run area: the declared services list (rows + Start/Stop all footer) when a
// manifest is present; otherwise the legacy single auto-detected "dev" command, plus a nudge to
// declare services. A manifest parse error shows in the usual .wtp-err style.
function servicesControl(wt, runOpen){
  if(wt.servicesError){
    return `<div class="wtp-err"><span class="wtp-err-msg">${esc(wt.servicesError)}</span></div>`;
  }
  if(wt.servicesDeclared){
    const rows = wt.services.map((s) => serviceRow(wt, s)).join("");
    const anyUp = wt.services.some((s) => s.state === "live" || s.state === "starting");
    const busyAll = state.wt.busy.has("svcall:" + wt.path);
    let foot = `<div class="wtp-svc-foot">`
      + `<button class="wtp-btn wtp-svc-all run" data-act="svc-start-all" data-wt="${esc(wt.path)}" ${busyAll ? "disabled" : ""}>${icon("play")}<span>Start all</span></button>`;
    if(anyUp) foot += `<button class="wtp-btn stop wtp-svc-all" data-act="svc-stop-all" data-wt="${esc(wt.path)}" ${busyAll ? "disabled" : ""}>Stop all</button>`;
    foot += `</div>`;
    return `<div class="wtp-svcs">${rows}${foot}</div>`;
  }
  // no manifest — the backward-compatible single Run control, plus a gentle nudge
  return runControl(wt, runOpen)
    + `<div class="wtp-svc-nudge">No services declared — ask Claude to set up <code>.pm/services.json</code> (or run <code>/pm:services</code>).</div>`;
}

// the worktree/checkout indicator — a fixed-width column on the first line, rendered only when
// a worktree is checked out. Click it to open the same picker as the ghost "+ worktree" button.
function wtPill(b, wt, menuOpen){
  const on = menuOpen ? " on" : "";
  const live = wtIsLive(wt) ? " live" : "";
  return `<button class="wtp-pill wtp-trigger${on}" data-act="wtmenu" data-branch="${esc(b.name)}" `
    + `title="checked out in ${esc(wt.path)} — click to change">`
    + `<span class="wtp-pill-dot${live}"></span><span class="wtp-pill-txt">${esc(wtLabel(wt))}</span>`
    + `<span class="wtp-pill-cv">${icon("chevronDown")}</span></button>`;
}

// no worktree yet — the top-line primary action is to get one.
function wtGhostBtn(branch, menuOpen){
  const on = menuOpen ? " on" : "";
  return `<button class="wtp-pill ghost wtp-trigger${on}" data-act="wtmenu" data-branch="${esc(branch)}" `
    + `title="check this branch out in a worktree">${icon("plus")} worktree</button>`;
}

// the picker: every worktree (and where it points) + a "new worktree" option, for one branch.
function wtpWtMenu(branch, worktrees, currentPath){
  const rows = worktrees.map((wt) => {
    const holds = wt.path === currentPath;
    const where = wt.detached ? `detached` : `${icon("branch")}${esc(wt.branch || "—")}`;
    const label = wtLabel(wt);
    return `<button class="wtp-menu-opt${holds ? " cur" : ""}" data-act="checkout" data-wt="${esc(wt.path)}" data-branch="${esc(branch)}">`
      + `<span class="wtp-menu-name" title="${esc(label)}">${esc(midEllipsis(label))}</span>`
      + `<span class="wtp-menu-cur">${where}</span></button>`;
  }).join("");
  return `<div class="wtp-menu">`
    + (rows || `<span class="wtp-menu-empty">no worktrees</span>`)
    + `<button class="wtp-menu-opt add" data-act="create" data-branch="${esc(branch)}">`
    + `<span class="wtp-menu-name">${icon("plus")} new worktree</span>`
    + `<span class="wtp-menu-cur">from this branch</span></button>`
    + `</div>`;
}

// one branch card: name + divergence + the worktree indicator (fixed width, so it lines up down
// the list) on top; the Run control — only once a worktree exists — on the line beneath it.
function wtpBranchRow(b, worktrees, baseName){
  const w = state.wt;
  const wtOnBranch = b.worktreePath ? worktrees.find((x) => x.path === b.worktreePath) : null;
  const checkoutOpen = w.openMenu && w.openMenu.type === "checkout" && w.openMenu.branch === b.name;
  const runOpen = !!(wtOnBranch && w.openMenu && w.openMenu.type === "run" && w.openMenu.wt === wtOnBranch.path);
  const live = !!(wtOnBranch && wtIsLive(wtOnBranch));
  const nm = `<span class="wtp-bname"><span class="k">${icon("branch")}</span><span class="wtp-bname-txt">${esc(b.name)}</span>`
    + (b.isDefault ? `<span class="wtp-def">default</span>` : "") + `</span>`;

  let h = `<div class="wtp-brow${live ? " live" : ""}">`;
  h += `<div class="wtp-brow-top">${nm}${divergeChip(b.ahead, baseName)}`
    + (wtOnBranch ? wtPill(b, wtOnBranch, checkoutOpen) : wtGhostBtn(b.name, checkoutOpen)) + `</div>`;
  if(wtOnBranch) h += `<div class="wtp-brow-run">${servicesControl(wtOnBranch, runOpen)}</div>`;
  if(runOpen && wtOnBranch && !wtOnBranch.servicesDeclared) h += runMenuHtml(wtOnBranch);
  if(checkoutOpen) h += wtpWtMenu(b.name, worktrees, b.worktreePath);
  return h + `</div>`;
}

function panelHtml(worktrees, branches, data){
  const w = state.wt;
  // the default branch is always the orientation point — pin it first regardless of recency.
  const ordered = branches.slice().sort((a, b) => (a.isDefault ? 0 : 1) - (b.isDefault ? 0 : 1));
  const closed = ordered.filter((b) => b.merged && !b.worktreePath && !b.isDefault);
  const closedSet = new Set(closed);
  const active = ordered.filter((b) => !closedSet.has(b));
  const liveCount = worktrees.reduce((n, x) => n + wtLiveCount(x), 0);
  const baseName = data && data.defaultBranch;

  let h = `<div class="wtp">`;
  h += `<div class="wtp-head"><span class="wtp-title">Branches</span>`
    + `<span class="wtp-sub">${liveCount ? `${liveCount} server${liveCount === 1 ? "" : "s"} live` : `${active.length}`}</span></div>`;
  if(w.error) h += `<div class="wtp-err"><span class="wtp-err-msg">${esc(w.error)}</span><button class="wtp-x" data-act="dismiss" aria-label="dismiss">${icon("x")}</button></div>`;
  if(data && !data.serverScanned) h += `<div class="wtp-note">dev-server scan unavailable (lsof)</div>`;

  h += active.map((b) => wtpBranchRow(b, worktrees, baseName)).join("") || `<div class="wtp-empty">no branches</div>`;
  if(closed.length){
    h += `<button class="wtp-merged-toggle" data-act="togglemerged" aria-expanded="${w.mergedOpen}">`
      + `<span class="chev">${icon(w.mergedOpen ? "chevronDown" : "chevronRight")}</span> Merged <span class="wtp-sub">${closed.length}</span></button>`;
    if(w.mergedOpen) h += `<div class="wtp-merged">${closed.map((b) => wtpBranchRow(b, worktrees, baseName)).join("")}</div>`;
  }
  h += `</div>`;
  return h;
}

// re-render the panel from the last-fetched data (no network) — for pure UI toggles
function repaintPanel(){
  const aside = $("#workAside");
  if(!aside || !state.wtData) return;
  hideBnameTip(); // the hovered element is about to be thrown away — don't leave its tip stuck
  aside.innerHTML = panelHtml(state.wtData.worktrees, state.wtData.branches, state.wtData);
  if(state.wt.openMenu) positionWtMenu();
  state.wtSig = ""; // let the next poll reconcile against fresh data
}

// A truncated branch name's full text, shown the instant the pointer lands — a native `title`
// tooltip has a multi-hundred-ms OS delay, which reads as sluggish for something this frequent.
let bnameTipEl = null;
function showBnameTip(target){
  const txt = target.querySelector(".wtp-bname-txt");
  if(!txt || txt.scrollWidth <= txt.clientWidth) return; // not actually truncated — nothing to add
  hideBnameTip();
  bnameTipEl = document.createElement("div");
  bnameTipEl.className = "wtp-tip";
  bnameTipEl.textContent = txt.textContent;
  document.body.appendChild(bnameTipEl);
  const r = target.getBoundingClientRect();
  const tw = bnameTipEl.offsetWidth, th = bnameTipEl.offsetHeight; // forces layout
  const left = Math.max(6, Math.min(r.left, window.innerWidth - tw - 6));
  let top = r.top - th - 6;
  if(top < 6) top = r.bottom + 6;
  bnameTipEl.style.left = left + "px";
  bnameTipEl.style.top = top + "px";
}
function hideBnameTip(){ if(bnameTipEl){ bnameTipEl.remove(); bnameTipEl = null; } }

// Both the checkout picker and the run-menu are position:fixed so the rail's scroll can't clip
// them — anchor to whichever trigger is open by hand, flipping above it when there's no room
// below. Reposition (rather than close) on scroll/resize so it stays glued and survives repaints.
function wtMenuReflow(){ if(state.wt.openMenu) positionWtMenu(); else detachWtMenu(); }
function detachWtMenu(){
  window.removeEventListener("scroll", wtMenuReflow, true);
  window.removeEventListener("resize", wtMenuReflow);
}
function closeWtMenu(){
  detachWtMenu();
  if(state.wt.openMenu){ state.wt.openMenu = null; state.wt.editCmd = null; repaintPanel(); }
}
function positionWtMenu(){
  const menu = $("#workAside .wtp-menu");
  const pill = $("#workAside .wtp-trigger.on");
  if(!menu || !pill){ detachWtMenu(); return; }
  const r = pill.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight; // forces layout — coords are now valid
  const left = Math.max(12, Math.min(r.right - mw, window.innerWidth - mw - 12));
  let top = r.bottom + 6;
  if(top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  window.removeEventListener("scroll", wtMenuReflow, true);
  window.addEventListener("scroll", wtMenuReflow, true);
  window.removeEventListener("resize", wtMenuReflow);
  window.addEventListener("resize", wtMenuReflow);
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
    w: worktrees.map((x) => [x.path, x.branch, x.serverState, (x.servers || []).map((s) => s.port), x.devCommand, x.ahead,
      x.servicesDeclared, x.servicesError, (x.services || []).map((s) => [s.name, s.state])]),
    b: branches.map((x) => [x.name, x.worktreePath, x.merged, x.ahead, x.committedAt]),
    ui: [w.openMenu, w.editCmd, w.error, w.mergedOpen, [...w.busy]],
  });
  if(!force && sig === state.wtSig) return;
  hideBnameTip(); // the hovered element is about to be thrown away — don't leave its tip stuck
  aside.innerHTML = panelHtml(worktrees, branches, data);
  if(state.wt.openMenu) positionWtMenu();
  state.wtSig = sig;
}

// panel button dispatch (delegated from the Work view click handler)
async function handleWtAction(el){
  const w = state.wt;
  const act = el.dataset.act;
  const wt = el.dataset.wt;
  const branch = el.dataset.branch;

  if(act === "togglemerged"){ w.mergedOpen = !w.mergedOpen; return repaintPanel(); }
  if(act === "wtmenu"){
    const open = w.openMenu && w.openMenu.type === "checkout" && w.openMenu.branch === branch;
    w.openMenu = open ? null : { type:"checkout", branch };
    return repaintPanel();
  }
  if(act === "runmenu"){
    const open = w.openMenu && w.openMenu.type === "run" && w.openMenu.wt === wt;
    w.openMenu = open ? null : { type:"run", wt };
    w.editCmd = null; // fresh open shows the menu, not straight into editing
    return repaintPanel();
  }
  if(act === "dismiss"){ w.error = null; return repaintPanel(); }
  if(act === "canceledit"){ w.editCmd = null; w.openMenu = null; return repaintPanel(); }
  if(act === "editcmd"){
    w.editCmd = wt; repaintPanel();
    const i = $("#wtpCmdInput"); if(i){ i.focus(); i.select(); }
    return;
  }
  if(act === "savecmd"){
    const i = $("#wtpCmdInput");
    const r = await apiPost("/api/devcommand", { command: i ? i.value : "" });
    w.editCmd = null; w.openMenu = null; w.error = r && r.error ? r.error : null;
    return renderWorktreePanel(true);
  }
  if(act === "start"){
    w.busy.add("srv:" + wt); repaintPanel();
    const r = await apiPost("/api/server/start", { worktree: wt });
    w.busy.delete("srv:" + wt);
    if(r && r.ok === false){
      // The server now waits out a grace window and reports fast failures with a log tail — show
      // the real reason (bad command, missing script, port in use) instead of silently reverting.
      const tail = Array.isArray(r.log) && r.log.length ? " — " + r.log[r.log.length - 1] : "";
      w.error = (r.error || "couldn't start server") + tail;
    } else {
      w.error = null;
    }
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
  if(act === "svc-start"){
    const svc = el.dataset.svc;
    const bk = "svc:" + wt + "|" + svc;
    w.busy.add(bk); repaintPanel();
    const r = await apiPost("/api/service/start", { worktree: wt, name: svc });
    w.busy.delete(bk);
    if(r && r.ok === false){
      const tail = Array.isArray(r.log) && r.log.length ? " — " + r.log[r.log.length - 1] : "";
      w.error = (svc + ": " + (r.error || "couldn't start")) + tail;
    } else w.error = null;
    renderWorktreePanel(true);
    setTimeout(() => renderWorktreePanel(true), 1500); // catch the port once it binds
    return;
  }
  if(act === "svc-stop"){
    const svc = el.dataset.svc;
    const bk = "svc:" + wt + "|" + svc;
    w.busy.add(bk); repaintPanel();
    const r = await apiPost("/api/service/stop", { worktree: wt, name: svc });
    w.busy.delete(bk);
    w.error = r && r.ok === false ? (r.error || null) : null;
    renderWorktreePanel(true);
    setTimeout(() => renderWorktreePanel(true), 800);
    return;
  }
  if(act === "svc-start-all"){
    const bk = "svcall:" + wt;
    w.busy.add(bk); repaintPanel();
    const r = await apiPost("/api/services/start-all", { worktree: wt });
    w.busy.delete(bk);
    const fail = r && Array.isArray(r.results) ? r.results.find((x) => x.ok === false) : null;
    if(fail){
      const tail = Array.isArray(fail.log) && fail.log.length ? " — " + fail.log[fail.log.length - 1] : "";
      w.error = (fail.name + ": " + (fail.error || "failed")) + tail;
    } else w.error = r && r.ok === false ? (r.error || "couldn't start services") : null;
    renderWorktreePanel(true);
    setTimeout(() => renderWorktreePanel(true), 1500);
    return;
  }
  if(act === "svc-stop-all"){
    const bk = "svcall:" + wt;
    w.busy.add(bk); repaintPanel();
    const r = await apiPost("/api/services/stop-all", { worktree: wt });
    w.busy.delete(bk);
    w.error = r && r.ok === false ? (r.error || null) : null;
    renderWorktreePanel(true);
    setTimeout(() => renderWorktreePanel(true), 800);
    return;
  }
  if(act === "create"){
    w.openMenu = null;
    const r = await apiPost("/api/worktree/create", { branch });
    w.error = r && r.ok === false ? (r.error || "couldn't create worktree") : null;
    return renderWorktreePanel(true);
  }
  if(act === "checkout"){
    w.openMenu = null;
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
    // Do this first: the chrome updates below touch view-rendered elements that may not exist yet
    // at first boot, and loadMeta swallows throws — so keep the preview banner out of that blast
    // radius, or a first-load race leaves it missing.
    applyPreviewChrome(m.preview);
    const repo = m.repo || "";
    const slash = repo.indexOf("/");
    $("#repoOwner").textContent = slash >= 0 ? repo.slice(0, slash + 1) : repo;
    $("#repoName").textContent = slash >= 0 ? repo.slice(slash + 1) : "";
    const cap = $("#capture");
    if(cap){
      cap.hidden = false;
      cap.classList.toggle("explicit", m.capture === "explicit");
      const cl = $(".cap-label", cap); if(cl) cl.textContent = m.capture || "live";
    }
    const usageBadge = $("#usageBadge");
    if(usageBadge) usageBadge.textContent = m.tokens ? fmtTokens(m.tokens) : "";
    const foot = $("#looseFoot");
    if(foot) foot.innerHTML = m.loose
      ? `<span class="n">${m.loose}</span> loose end${m.loose===1?"":"s"} open`
      : `no loose ends`;
  }catch(e){ /* meta is best-effort chrome; views still render */ }
}

// Preview mode has two faces. When THIS dashboard is the preview, pin a loud banner (with a branch
// picker to re-point it) so it's never mistaken for the real ledger. Either way, render the
// top-right environment switch that toggles prod ↔ preview.
function applyPreviewChrome(preview){
  state.preview = preview || null;
  let banner = $("#previewBanner");
  if(preview && preview.self){
    document.body.classList.add("preview-mode");
    if(!banner){
      banner = document.createElement("div");
      banner.id = "previewBanner";
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.innerHTML = `<span class="pv-dot"></span>`
      + `<span class="pv-label">PREVIEW</span>`
      + `<div class="pv-branch-wrap">`
      +   `<button class="pv-branch" data-act="pvbranch" title="preview a different branch">`
      +     `${esc(preview.branch || "branch")}<span class="pv-caret">▾</span></button>`
      +   `<div class="pv-branch-menu" id="pvBranchMenu" hidden></div>`
      + `</div>`
      + `<span class="pv-note">scratch copy of your ledger — not the real one</span>`;
  }else{
    document.body.classList.remove("preview-mode");
    if(banner) banner.remove();
  }
  renderEnvSwitch(preview);
  wirePreviewMenus();
}

// The top-right environment switch. Shows the current environment and, in its menu, a link to the
// other one — so prod and its live preview are one click apart on both dashboards. Hidden on the
// real dashboard when no preview is running (nothing to switch to).
function renderEnvSwitch(preview){
  let el = $("#envSwitch");
  let isPrev, current, other;
  if(preview && preview.self){
    isPrev = true;
    current = { label:"Preview", sub: preview.branch || "" };
    other = preview.parentUrl ? { label:"Production", sub:"", url: preview.parentUrl } : null;
  }else if(preview && !preview.self && preview.link){
    isPrev = false;
    current = { label:"Production", sub:"" };
    other = { label:"Preview", sub: preview.link.branch || "", url: preview.link.url };
  }else{
    document.body.classList.remove("has-envswitch");
    if(el) el.remove();
    return;
  }
  if(!el){ el = document.createElement("div"); el.id = "envSwitch"; document.body.appendChild(el); }
  el.className = isPrev ? "env-preview" : "env-prod";
  document.body.classList.toggle("has-envswitch", !isPrev);
  const opt = (o, cur) => o
    ? `<a class="env-opt${cur?" is-current":""}" ${cur?"":`href="${esc(o.url)}"`}>`
      + `<span class="env-dot${cur?"":" alt"}"></span><span class="env-opt-txt">${esc(o.label)}`
      + `${o.sub?` <span class="env-sub">${esc(o.sub)}</span>`:""}</span>${cur?`<span class="env-check">✓</span>`:""}</a>`
    : `<div class="env-opt disabled">No preview running</div>`;
  el.innerHTML = `<button class="env-btn" data-act="envtoggle" aria-haspopup="true">`
    + `<span class="env-dot"></span><span class="env-cur">${esc(current.label)}`
    + `${current.sub?` <span class="env-sub">${esc(current.sub)}</span>`:""}</span><span class="env-caret">▾</span></button>`
    + `<div class="env-menu" id="envMenu" hidden>`
    +   opt({ ...current }, true)
    +   opt(other, false)
    + `</div>`;
}

// One document-level handler drives both the env menu and the preview branch picker (open/close,
// click-away, and the actual branch switch). Attached once.
let pvWired = false;
function wirePreviewMenus(){
  if(pvWired) return;
  pvWired = true;
  document.addEventListener("click", async (e) => {
    const envMenu = $("#envMenu"), pvMenu = $("#pvBranchMenu");
    const branchOpt = e.target.closest('[data-act="pvswitch"]');
    if(branchOpt){ e.preventDefault(); pvSwitchBranch(branchOpt.dataset.branch); return; }
    if(e.target.closest('[data-act="envtoggle"]')){
      e.preventDefault();
      if(envMenu) envMenu.hidden = !envMenu.hidden;
      if(pvMenu) pvMenu.hidden = true;
      return;
    }
    if(e.target.closest('[data-act="pvbranch"]')){
      e.preventDefault();
      if(pvMenu){ pvMenu.hidden = !pvMenu.hidden; if(!pvMenu.hidden) await fillPvBranchMenu(pvMenu); }
      if(envMenu) envMenu.hidden = true;
      return;
    }
    if(envMenu && !e.target.closest("#envSwitch")) envMenu.hidden = true;
    if(pvMenu && !e.target.closest(".pv-branch-wrap")) pvMenu.hidden = true;
  });
}

// Fill the branch picker from live git state (the same /api/worktrees the panel uses). Open
// branches (unmerged) plus the current one; current first, disabled.
async function fillPvBranchMenu(menu){
  menu.innerHTML = `<div class="pv-menu-msg">loading…</div>`;
  let data;
  // Query the preview server's OWN repo (the worktree it serves), not the project you're viewing
  // in the rail — the previewed branch belongs to the served repo, so no ?repo override.
  try{ data = await fetch("/api/worktrees", { cache:"no-store" }).then((r) => r.json()); }
  catch(e){ menu.innerHTML = `<div class="pv-menu-msg">unavailable</div>`; return; }
  const cur = state.preview && state.preview.branch;
  const branches = (data.branches || [])
    .filter((b) => !b.merged || b.name === cur)
    .sort((a, b) => (a.name === cur ? 0 : 1) - (b.name === cur ? 0 : 1) || String(a.name).localeCompare(b.name));
  menu.innerHTML = branches.map((b) => {
    const isCur = b.name === cur;
    return `<button class="pv-menu-opt${isCur?" is-current":""}" data-act="pvswitch" data-branch="${esc(b.name)}"${isCur?" disabled":""}>`
      + `<span class="pv-dot${isCur?"":" alt"}"></span><span class="pv-menu-name">${esc(b.name)}</span>`
      + (b.isDefault?`<span class="pv-menu-tag">default</span>`:"")
      + (isCur?`<span class="env-check">✓</span>`:"")
      + `</button>`;
  }).join("") || `<div class="pv-menu-msg">no branches</div>`;
}

// Re-point the preview at another branch: tell the server to relaunch, show a restarting overlay,
// then poll until the preview is back up on the new branch and reload.
async function pvSwitchBranch(name){
  if(!name || (state.preview && name === state.preview.branch)) return;
  const pvMenu = $("#pvBranchMenu"); if(pvMenu) pvMenu.hidden = true;
  showPreviewSwitching(name);
  try{ await apiPost("/api/preview/switch", { branch:name }); }catch(e){}
  // The preview server restarts on the same port: it goes DOWN, then comes back UP on the new
  // branch. Reload the moment it's back — works whether or not the target branch knows about the
  // preview API (older branches can't report preview.branch, so don't gate on it).
  let sawDown = false;
  for(let i=0;i<60;i++){
    await new Promise((r)=>setTimeout(r,300));
    let up = false;
    try{ up = (await fetch("/api/meta",{cache:"no-store"})).ok; }catch(e){ up = false; }
    if(!up){ sawDown = true; continue; }
    if(sawDown){ location.reload(); return; }
  }
  location.reload();
}

function showPreviewSwitching(name){
  let o = $("#pvSwitching");
  if(!o){ o = document.createElement("div"); o.id = "pvSwitching"; document.body.appendChild(o); }
  o.innerHTML = `<div class="pvs-card"><div class="pvs-spin"></div>`
    + `<div class="pvs-txt">Switching preview to <b>${esc(name)}</b></div>`
    + `<div class="pvs-sub">restarting the preview server…</div></div>`;
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
  state.seenEvents.clear();
  renderMenu();
  await loadMeta();
  // An initiative/area id belongs to the old project; drop back to the Timeline rather than 404.
  // Otherwise just re-render the current view against the new project.
  if(state.view === "initiative" || state.view === "area"){ location.hash = "#/timeline"; }
  else { state.paramId = null; await refresh(true); }
}

// ---- interactions -----------------------------------------------------------
// toggle an inline disclosure (the "N events" list on an Update card, or a commits list)
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
    // everything else (Update cards, area/initiative rows) navigates via explicit <a> links
  });

  // Enter saves / Escape cancels the inline dev-command editor
  viewEl.addEventListener("keydown", (e) => {
    if(e.target.id !== "wtpCmdInput") return;
    if(e.key === "Enter"){ e.preventDefault(); handleWtAction({ dataset:{ act:"savecmd" } }); }
    else if(e.key === "Escape"){ e.preventDefault(); state.wt.editCmd = null; state.wt.openMenu = null; repaintPanel(); }
  });

  // truncated branch names get an instant custom tip instead of the OS's delayed `title` tooltip
  viewEl.addEventListener("mouseover", (e) => {
    const nm = e.target.closest(".wtp-bname");
    if(nm && nm.closest("#workAside")) showBnameTip(nm);
  });
  viewEl.addEventListener("mouseout", (e) => {
    const nm = e.target.closest(".wtp-bname");
    if(nm && (!e.relatedTarget || !nm.contains(e.relatedTarget))) hideBnameTip();
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
    // close the checkout picker or run-menu when clicking away from it
    if(state.wt.openMenu && !e.target.closest(".wtp-menu") && !e.target.closest(".wtp-trigger")){
      closeWtMenu();
    }
  });
  document.addEventListener("keydown", (e) => { if(e.key === "Escape"){ closeMenu(); closeWtMenu(); } });
}

async function boot(){
  renderLegend();
  initInteractions();
  viewEl.innerHTML = `<div class="loading">reading the ledger…</div>`;
  await loadProjects();
  await loadMeta();
  window.addEventListener("hashchange", onRoute);
  await onRoute();
  startLiveUpdates();
  // keep relative ages / dates fresh even without new data; also pick up new projects. With
  // morph rendering this forced pass no longer flashes — it just reconciles what actually moved.
  setInterval(() => {
    loadProjects();
    if(state.view === "timeline" || state.view === "areas") refresh(true);
  }, 60000);
}

// Live updates over a single Server-Sent Events stream: the server pushes a frame whenever the
// ledger changes, so new data lands in ~1s with no polling. EventSource reconnects on its own
// after a server restart (honoring the server's `retry:` hint); a slow fallback poll covers the
// rare case where the stream never opens (e.g. a proxy that buffers text/event-stream).
function startLiveUpdates(){
  const pull = () => { loadMeta(); refresh(false); };
  let fallback = null;
  const startFallback = () => { if(!fallback) fallback = setInterval(pull, 8000); };
  const stopFallback = () => { if(fallback){ clearInterval(fallback); fallback = null; } };
  if(typeof EventSource === "undefined"){ startFallback(); return; } // very old browser
  let es;
  try{ es = new EventSource(withProject("/api/stream")); }
  catch(e){ startFallback(); return; }
  es.onopen = stopFallback;                 // stream is live — the poll isn't needed
  es.onmessage = pull;                       // hello + every change frame → refetch current view
  es.onerror = startFallback;                // dropped; EventSource retries, poll bridges the gap
}

boot();
