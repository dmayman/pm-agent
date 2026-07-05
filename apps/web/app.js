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

// ---- tiny helpers -----------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;");

async function api(path){
  const r = await fetch(path, { headers:{ accept:"application/json" } });
  if(!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}

function pad2(n){ return n < 10 ? "0" + n : "" + n; }
function fmtTime(d){ return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

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

function refChips(refs){
  if(!refs || typeof refs !== "object") return "";
  const out = [];
  if(refs.issue != null) out.push(`<span class="ref issue"><span class="k">#</span>${esc(refs.issue)}</span>`);
  if(refs.pr != null)    out.push(`<span class="ref pr"><span class="k">PR</span>${esc(refs.pr)}</span>`);
  if(refs.branch)        out.push(`<span class="ref branch"><span class="k">⎇</span>${esc(refs.branch)}</span>`);
  if(refs.commit)        out.push(`<span class="ref commit">${esc(String(refs.commit).slice(0,7))}</span>`);
  return out.join("");
}

function nodeClass(t){
  const n = typeMeta(t).node;
  return n === "hollow" ? "node hollow" : n === "glow" ? "node glow" : n === "alarm" ? "node alarm" : "node";
}

// ---- app state --------------------------------------------------------------
const state = {
  view: "timeline",
  threadId: null,
  meta: null,
  seenEvents: new Set(),   // event ids we've already rendered (for new-flash)
  primed: false,           // first render done -> flashing enabled
  sig: "",                 // last-rendered signature per view
};

const viewEl = $("#view");
const mainEl = $("#main");

// ---- routing ----------------------------------------------------------------
function parseHash(){
  const h = (location.hash || "#/timeline").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if(parts[0] === "thread" && parts[1]) return { view:"thread", threadId:parts[1] };
  if(parts[0] === "inflight") return { view:"inflight" };
  return { view:"timeline" };
}

function syncNav(){
  const activeNav = state.view === "inflight" ? "inflight" : "timeline";
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === activeNav);
  });
}

async function onRoute(){
  const r = parseHash();
  const changedView = r.view !== state.view || r.threadId !== state.threadId;
  state.view = r.view;
  state.threadId = r.threadId || null;
  if(changedView){ state.sig = ""; state.primed = false; state.seenEvents.clear(); mainEl.scrollTop = 0; }
  syncNav();
  viewEl.classList.toggle("wide", state.view === "inflight");
  await refresh(changedView);
}

// ---- data + render orchestration -------------------------------------------
async function refresh(force){
  try{
    if(state.view === "inflight")      await renderInflight(force);
    else if(state.view === "thread")   await renderThread(force);
    else                               await renderTimeline(force);
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
function paint(html, { scrollSafe } = {}){
  if(!scrollSafe){ viewEl.innerHTML = html; return; }
  const nearTop = mainEl.scrollTop < 48;
  const prevTop = mainEl.scrollTop;
  const prevH = mainEl.scrollHeight;
  viewEl.innerHTML = html;
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

async function renderTimeline(force){
  const events = await api("/api/timeline?days=30&limit=300");
  const sig = "tl:" + events.length + ":" + (events[0] ? events[0].id : 0);
  if(!force && sig === state.sig) return;

  setTopbar(`<span class="tb-title">Timeline</span>`
    + `<span class="tb-sub">${events.length} event${events.length === 1 ? "" : "s"} · 30d</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);

  paint(renderDays(events), { scrollSafe: !force && state.primed });
  markSeen(events);
  state.sig = sig;
}

async function renderThread(force){
  const data = await api("/api/thread/" + encodeURIComponent(state.threadId));
  const th = data.thread || {};
  const events = data.events || [];
  const sig = "th:" + state.threadId + ":" + events.length + ":" + (events[0] ? events[0].id : 0);
  if(!force && sig === state.sig) return;

  const sm = statusMeta(th.status);
  const genesis = th.genesis
    ? `<div class="th-genesis"><span class="rune">genesis</span><span>${esc(th.genesis)}</span></div>`
    : `<div class="th-genesis none">no recorded genesis for this thread</div>`;

  const head = `<div class="thread-head">`
    + `<div class="th-status-row">`
    +   `<span class="pill" style="--pc:${sm.pc}"><span class="pdot"></span>${esc(sm.label)}</span>`
    +   `<span class="th-title">${esc(th.title || "Untitled thread")}</span>`
    + `</div>${genesis}`
    + `<div class="th-meta"><span>${events.length} event${events.length===1?"":"s"}</span>`
    +   (th.updated_at ? `<span>updated ${esc(relAge(th.updated_at))} ago</span>` : "")
    + `</div></div>`;

  setTopbar(`<a class="tb-back" href="#/timeline"><span class="arw">←</span>All activity</a>`
    + `<span class="tb-title">${esc(th.title || "Thread")}</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);

  paint(head + renderDays(events), { scrollSafe: !force && state.primed });
  markSeen(events);
  state.sig = sig;
}

// ---- in-flight rendering ----------------------------------------------------
function miniRow(ev){
  const cls = typeMeta(ev.type).node === "hollow" ? "mini-dot hollow" : "mini-dot";
  return `<div class="mini-row" style="--hue:${hueVar(ev.type)}">`
    + `<span class="${cls}"></span>`
    + `<span class="mini-sum">${esc(ev.summary)}</span>`
    + `<span class="mini-age">${esc(relAge(ev.ts))}</span></div>`;
}

function threadCard(th, events, i){
  const sm = statusMeta(th.status);
  const recent = events.slice(0, 3);
  const genesis = th.genesis
    ? `<div class="card-genesis">${esc(th.genesis)}</div>`
    : `<div class="card-genesis none">no genesis recorded</div>`;
  const more = th.event_count > recent.length
    ? `<div class="card-more">+${th.event_count - recent.length} earlier</div>` : "";
  return `<div class="card" data-href="#/thread/${esc(th.id)}" style="--accent:${sm.pc};--d:${Math.min(i,8)*40}ms">`
    + `<div class="card-top"><span class="card-title">${esc(th.title || "Untitled thread")}</span>`
    +   `<span class="pill" style="--pc:${sm.pc}"><span class="pdot"></span>${esc(sm.label)}</span></div>`
    + genesis
    + (recent.length ? `<div class="mini">${recent.map(miniRow).join("")}</div>` : "")
    + more
    + `</div>`;
}

function looseRow(ev, i){
  return `<div class="loose-row" style="--hue:${hueVar(ev.type)};--d:${Math.min(i,8)*40}ms">`
    + `<span class="lnode"></span>`
    + `<div class="loose-body"><div class="loose-sum">${esc(ev.summary)}</div>`
    +   `<div class="loose-meta"><span class="type-tag">${esc(typeMeta(ev.type).label)}</span>`
    +     (ev.thread_title ? `<span>·</span><a href="#/thread/${esc(ev.thread_id)}">${esc(ev.thread_title)}</a>` : "")
    +   `</div></div>`
    + `<span class="loose-age">${esc(relAge(ev.ts))}</span></div>`;
}

async function renderInflight(force){
  const [data, timeline] = await Promise.all([
    api("/api/inflight"),
    api("/api/timeline?days=30&limit=300"),
  ]);
  const threads = data.threads || [];
  const loose = data.loose || [];
  const sig = "if:" + threads.length + ":" + loose.length + ":"
    + threads.map((t)=>t.id+"@"+t.last_event_ts).join(",") + ":" + (timeline[0]?timeline[0].id:0);
  if(!force && sig === state.sig) return;

  // recent events per thread, newest-first (timeline is already reverse-chron)
  const byThread = new Map();
  for(const ev of timeline){
    if(ev.thread_id == null) continue;
    if(!byThread.has(ev.thread_id)) byThread.set(ev.thread_id, []);
    byThread.get(ev.thread_id).push(ev);
  }

  let html = "";

  html += `<div class="section"><div class="section-head"><h2>In flight</h2>`
    + `<span class="rule"></span><span class="n">${threads.length} thread${threads.length===1?"":"s"}</span></div>`;
  if(threads.length){
    html += `<div class="cards">`
      + threads.map((th, i) => threadCard(th, byThread.get(th.id) || [], i)).join("")
      + `</div>`;
  }else{
    html += `<div class="empty"><div class="glyph"></div>`
      + `<div class="e-title">Nothing in flight</div>`
      + `<div class="e-sub">all threads are at rest</div></div>`;
  }
  html += `</div>`;

  html += `<div class="section"><div class="section-head"><h2>Loose ends</h2>`
    + `<span class="rule"></span><span class="n">${loose.length}</span></div>`;
  if(loose.length){
    html += `<div class="loose-list">` + loose.map(looseRow).join("") + `</div>`;
  }else{
    html += `<div class="empty"><div class="glyph"></div>`
      + `<div class="e-title">No loose ends</div>`
      + `<div class="e-sub">nothing deferred or dangling</div></div>`;
  }
  html += `</div>`;

  setTopbar(`<span class="tb-title">In flight</span>`
    + `<span class="tb-sub">${threads.length} active · ${loose.length} loose</span>`
    + `<span class="tb-spacer"></span>${liveTag()}`);

  paint(html); // full replace; cards are stable enough that scroll-jump isn't a concern
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
    $("#inflightBadge").textContent = m.threads != null ? m.threads : "";
    $("#looseFoot").innerHTML = m.loose
      ? `<span class="n">${m.loose}</span> loose end${m.loose===1?"":"s"} open`
      : `no loose ends`;
  }catch(e){ /* meta is best-effort chrome; views still render */ }
}

// ---- boot -------------------------------------------------------------------
function initInteractions(){
  // card click -> thread (delegated; cards aren't links so inner links still work)
  viewEl.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if(card && card.dataset.href && !e.target.closest("a")){ location.hash = card.dataset.href; }
  });
}

async function boot(){
  renderLegend();
  initInteractions();
  viewEl.innerHTML = `<div class="loading">reading the ledger…</div>`;
  await loadMeta();
  window.addEventListener("hashchange", onRoute);
  await onRoute();
  // gentle live polling
  setInterval(() => { loadMeta(); refresh(false); }, 4000);
  // keep relative ages fresh even without new data
  setInterval(() => { if(state.view === "inflight") refresh(true); }, 60000);
}

boot();
