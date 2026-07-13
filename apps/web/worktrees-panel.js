/* pm-agent — worktrees panel (the right rail beside the ledger views).
   A self-contained ES module: renders live git/worktree state into #workAside and owns the
   panel's action handlers (run/stop, services, checkout, the Primary/Preview slot, and the
   capture link). Extracted verbatim from app.js — shares its state + tiny helpers via
   module imports; the DOM morph/SSE machinery stays in app.js and is untouched. */

import { $, esc, icon, api, apiPost, state } from "./app.js";

// Coarse "how long ago" for the preview's last-synced label — minute/hour/day buckets are plenty
// here; the exact timestamp rides along in a title on hover.
function syncAgo(iso){
  const t = Date.parse(iso);
  if(!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if(s < 60) return "just now";
  const m = Math.floor(s / 60); if(m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if(h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

// ---- worktrees panel (right rail beside Initiatives/Timeline) ---------------
// Organized by BRANCH. A worktree can only hold one branch at a time, so "which worktree is on
// which branch" is really a property of the branch — every local branch is a card, pinned with
// the default branch first. A card's primary action (top line) is the Run split-button when it
// has a worktree to run from, or a ghost "+ worktree" button when it doesn't; which worktree it's
// checked into (the repo's own primary checkout, shown with ⌂, or a linked worktree's folder name)
// is secondary info on the second line, only present once a worktree exists. Merged branches with
// no worktree collapse into a dropdown. Renders into #workAside beside the ledger views.

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
    const allUp = wt.services.every((s) => s.state === "live" || s.state === "starting");
    const busyAll = state.wt.busy.has("svcall:" + wt.path);
    let foot = `<div class="wtp-svc-foot">`;
    if(!allUp) foot += `<button class="wtp-btn wtp-svc-all run" data-act="svc-start-all" data-wt="${esc(wt.path)}" ${busyAll ? "disabled" : ""}>${icon("play")}<span>Start all</span></button>`;
    if(anyUp) foot += `<button class="wtp-btn stop wtp-svc-all" data-act="svc-stop-all" data-wt="${esc(wt.path)}" ${busyAll ? "disabled" : ""}>Stop all</button>`;
    foot += `</div>`;
    // Non-primary worktrees run on shifted ports so two trees don't collide — say so, since the
    // ports shown won't match the checked-in .pm/services.json.
    const offNote = wt.portOffset > 0
      ? `<div class="wtp-svc-offset" title="This worktree is instance slot ${wt.slot}: every declared port is shifted +${wt.portOffset} so it runs independently of the primary worktree.">ports +${wt.portOffset}</div>`
      : "";
    return `<div class="wtp-svcs">${offNote}${rows}${foot}</div>`;
  }
  // no manifest — the backward-compatible single Run control, plus a gentle nudge
  return runControl(wt, runOpen)
    + `<div class="wtp-svc-nudge">No services declared — ask Claude to set up <code>.pm/services.json</code> (or run <code>/pm:services</code>).</div>`;
}

// the worktree/checkout indicator — a fixed-width column on the first line, rendered only when
// a worktree is checked out. Click it to open the same picker as the ghost "+ worktree" button.
function wtPill(b, wt, menuOpen){
  const on = menuOpen ? " on" : "";
  return `<button class="wtp-pill wtp-trigger${on}" data-act="wtmenu" data-branch="${esc(b.name)}" `
    + `title="checked out in ${esc(wt.path)} — click to change">`
    + `<span class="wtp-pill-txt">${esc(wtLabel(wt))}</span>`
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

// ---- Primary/Preview slots (opt-in restricted mode) -------------------------
// Opt-in via a checked-in `.pm/config.json` ({"worktreePanel":"primary-preview"}), surfaced on the
// /api/worktrees payload as `worktreePanel`. Repos without the flag are entirely unaffected — the
// panel's SHAPE never changes (still one column of branch cards, same wtpBranchRow for everyone
// else); only the per-branch "+ worktree" picker's CONTENTS do. Instead of "every real worktree +
// new worktree", each branch offers two fixed slots: Primary (valid only for the default branch —
// disabled everywhere else) and Preview (valid on any branch; picking it launches/re-points the
// existing preview environment at that branch immediately). This fits pm-agent's own convention:
// main stays checked out and clean in the primary checkout, and verifying other branches goes
// through the disposable preview server (#15/#16), never a checkout switch.

// The restricted picker menu: Primary (always disabled here — this menu only ever renders on a
// non-default row, since the default branch's row shows its pinned pill instead, never a picker)
// and Preview (always selectable; picking it launches right away).
function wtpSlotMenu(branch, baseName){
  return `<div class="wtp-menu">`
    + `<button class="wtp-menu-opt" disabled title="Primary is pinned to ${esc(baseName || "the default branch")}">`
    +   `<span class="wtp-menu-name">Primary</span><span class="wtp-menu-cur">pinned</span></button>`
    + `<button class="wtp-menu-opt" data-act="previewassign" data-branch="${esc(branch)}">`
    +   `<span class="wtp-menu-name">Preview</span><span class="wtp-menu-cur">launch here</span></button>`
    + `</div>`;
}

// The first-line indicator column, restricted-mode version: a static "Primary" pill on the default
// branch (nothing to click — it can't move), a static "Preview" pill on whichever branch currently
// holds that slot (tracking its launch state), or the same ghost "+ worktree" trigger the generic
// panel uses elsewhere — just opening wtpSlotMenu instead of wtpWtMenu.
function wtpSlotPill(b, baseName, menuOpen){
  if(b.isDefault){
    return `<span class="wtp-pill static" title="permanently pinned to ${esc(baseName || b.name)}">`
      + `<span class="wtp-pill-txt">Primary</span></span>`;
  }
  const p = state.wt.preview;
  if(p.branch === b.name){
    const starting = p.status === "launching";
    // Always amber, matching the preview environment's own banner — never the green "live" a real
    // dev-server gets, so this pill reads as "opens a scratch preview" at a glance, not "live infra".
    return `<span class="wtp-pill static preview${starting ? " starting" : ""}" title="preview slot">`
      + `<span class="wtp-pill-dot preview"></span><span class="wtp-pill-txt">Preview</span></span>`;
  }
  return wtGhostBtn(b.name, menuOpen);
}

// The second line for whichever branch currently holds Preview: a spinner while it (re)launches, a
// live link once /api/preview/state confirms it's up, or the error from a failed launch — the same
// spot/style a real worktree's Run controls would occupy, just reporting the preview server's
// state instead of a per-worktree dev server's.
function previewStatusHtml(){
  const p = state.wt.preview;
  if(p.status === "launching"){
    return `<div class="wtp-run starting"><span class="wtp-spin"></span>`
      + `<span class="wtp-starting">launching preview…</span></div>`;
  }
  if(p.status === "ready" && p.url){
    return `<div class="wtp-run preview"><a class="wtp-open preview" href="${esc(p.url)}" target="_blank" rel="noopener">`
      + `<span class="wtp-dot preview"></span>open preview<span class="arw preview">${icon("externalLink")}</span></a></div>`;
  }
  if(p.status === "error"){
    return `<div class="wtp-err"><span class="wtp-err-msg">${esc(p.error || "couldn't launch preview")}</span></div>`;
  }
  return "";
}

// The preview's manual DB-sync control: the scratch DB is seeded once and then kept, so this line
// says when prod was last copied in ("Never synced" if --fresh) and offers a Resync button that
// re-copies it on demand. Only shown once the preview is actually up — there's nothing to resync
// while it's still launching or errored.
function previewSyncHtml(){
  const p = state.wt.preview;
  if(p.status !== "ready") return "";
  const busy = state.wt.busy.has("pv-reseed");
  const label = p.lastSyncedAt ? "Last synced " + syncAgo(p.lastSyncedAt) : "Never synced";
  const title = p.lastSyncedAt
    ? "prod ledger last copied in " + new Date(p.lastSyncedAt).toLocaleString()
    : "the scratch DB has not been synced from prod";
  return `<div class="wtp-sync">`
    + `<span class="wtp-sync-lbl" title="${esc(title)}">${esc(label)}</span>`
    + `<button class="wtp-sync-btn"${busy ? " disabled" : ""} data-act="pv-reseed" `
    + `title="Re-copy the production ledger into this preview">`
    + `${busy ? `<span class="wtp-spin"></span>` : icon("refresh")}`
    + `<span>${busy ? "syncing…" : "Resync"}</span></button>`
    + `</div>`;
}

// The capture-link control, rendered on BOTH the Primary (real-ledger) card and the previewed-branch
// (preview-DB) card as a two-way TOGGLE: capture points at exactly one of them. The active target
// shows a grayed, disabled "Linked" with green dots; the other shows an actionable "Link" that
// switches to it. `kind` is "prod" (Primary) or "preview" (the previewed branch). Clicking prod's
// Link unlinks (back to your real ledger); clicking preview's Link links (npm-links the preview
// worktree + routes capture into its scratch DB). The state is global — the two cards stay in sync.
function captureLinkHtml(kind){
  const cl = state.wt.captureLink;
  if(!cl) return "";
  const busy = state.wt.busy.has("pv-link");
  const onPreview = !!cl.linked;                                   // capture currently on the preview branch
  const active = kind === "prod" ? !onPreview : onPreview;         // is THIS card the current target?
  const dot = active ? "live" : "stopped";
  const br = cl.branch || cl.previewBranch || "branch";
  let rows;
  if(kind === "prod"){
    rows = `<div class="wtp-link-row"><span class="wtp-svc-dot ${dot}"></span><span class="wtp-link-lbl">hooks → published code</span></div>`
         + `<div class="wtp-link-row"><span class="wtp-svc-dot ${dot}"></span><span class="wtp-link-lbl">capture → real ledger</span></div>`;
  }else{
    const dbLbl = (cl.db && cl.db.lastSyncedAt) ? `capture → preview DB · synced ${esc(syncAgo(cl.db.lastSyncedAt))}` : "capture → preview DB";
    rows = `<div class="wtp-link-row"><span class="wtp-svc-dot ${dot}"></span><span class="wtp-link-lbl">hooks → ${esc(br)} code</span></div>`
         + `<div class="wtp-link-row"><span class="wtp-svc-dot ${dot}"></span><span class="wtp-link-lbl">${dbLbl}</span></div>`;
  }
  let btn;
  if(active){
    btn = `<button class="wtp-btn wtp-link-btn linked" disabled title="capture is currently pointed here">`
        + `<span>Linked</span></button>`;
  }else{
    const canLink = kind === "preview" ? !!cl.previewBranch : true; // need a live preview to link onto it
    const act = kind === "preview" ? "pv-link" : "pv-unlink";
    const title = kind === "preview"
      ? (canLink ? `Route your hooks + capture onto the ${esc(cl.previewBranch)} preview` : "Start a preview first, then link")
      : "Point capture back at your real ledger (restores the published CLI)";
    btn = `<button class="wtp-btn wtp-link-btn act" data-act="${act}"${busy || !canLink ? " disabled" : ""} title="${title}">`
        + `${busy ? `<span class="wtp-spin"></span>` : icon("link")}<span>Link</span></button>`;
  }
  return `<div class="wtp-link${active ? " on" : ""}"><div class="wtp-link-rows">${rows}</div>${btn}</div>`;
}

// Primary's services, read-only: a status dot, name, and port — no open-link, no start/stop.
// Unlike every other row in this panel, Primary's declared services can include the dashboard's
// own process (pm-agent's "Observer"), and there's no sensible interactive control for that:
// "stop" would kill the very page serving this button, and "open" is redundant since you're
// already looking at it. So Primary always gets status-only rows, regardless of what's declared.
function primaryServicesHtml(wt){
  if(wt.servicesError){
    return `<div class="wtp-err"><span class="wtp-err-msg">${esc(wt.servicesError)}</span></div>`;
  }
  if(wt.servicesDeclared){
    const rows = wt.services.map((s) => `<div class="wtp-svc ${esc(s.state)}">`
      + `<span class="wtp-svc-dot ${esc(s.state)}"></span>`
      + `<span class="wtp-svc-name" title="${esc(s.name)}">${esc(s.name)}</span>`
      + (s.port ? `<span class="wtp-svc-port">:${esc(s.port)}</span>` : "")
      + `</div>`).join("");
    return `<div class="wtp-svcs">${rows}</div>`;
  }
  return `<div class="wtp-svc-nudge">No services declared — ask Claude to set up <code>.pm/services.json</code> (or run <code>/pm:services</code>).</div>`;
}

// One remote service row: a status dot (up / down / neutral-unprobed), the name + provider, the
// branch deployed there, and links to the provider console (dashboard) and the live service (url).
// No Start/Stop — you can't boot hosted infra from here.
function remoteServiceRow(r){
  // Map the probe state to the shared dot classes: "up" reuses live-green, "down" reuses stopped,
  // and everything else ("unprobed"/"declared") renders neutral — never falsely green or red.
  const dot = r.state === "up" ? "live" : r.state === "down" ? "down" : "unprobed";
  const title = r.state === "up" ? "reachable" : r.state === "down" ? "unreachable"
    : r.state === "declared" ? "no health check declared" : "checking…";
  const provider = r.provider ? `<span class="wtp-rsvc-prov">${esc(r.provider)}</span>` : "";
  const branch = r.branch ? `<span class="wtp-rsvc-branch" title="deployed branch/environment">${icon("branch")}${esc(r.branch)}</span>` : "";
  const dash = r.dashboard
    ? `<a class="wtp-svc-open" href="${esc(r.dashboard)}" target="_blank" rel="noopener" title="open console — ${esc(r.dashboard)}">${icon("gauge")}</a>` : "";
  const open = r.url
    ? `<a class="wtp-svc-open" href="${esc(r.url)}" target="_blank" rel="noopener" title="open service — ${esc(r.url)}">${icon("externalLink")}</a>` : "";
  return `<div class="wtp-svc wtp-rsvc ${esc(r.state)}">`
    + `<span class="wtp-svc-dot ${dot}" title="${esc(title)}"></span>`
    + `<span class="wtp-svc-name" title="${esc(r.name)}">${esc(r.name)}</span>${provider}`
    + `<span class="sp"></span>${branch}${dash}${open}</div>`;
}

// The repo-level Remote section — hosted infra (Fly/Neon/Vercel) declared in the primary's
// manifest. Shared across branches, so it renders once for the whole panel, not per branch, and
// only when there's at least one remote service to show.
function remoteServicesHtml(remotes){
  if(!remotes || !remotes.length) return "";
  const rows = remotes.map(remoteServiceRow).join("");
  return `<div class="wtp-remote">`
    + `<div class="wtp-remote-head">${icon("cloud")}<span>Remote</span></div>`
    + `<div class="wtp-svcs">${rows}</div></div>`;
}

// The restricted-mode branch row: same shell as wtpBranchRow (name, diverge chip, fixed-width
// indicator, optional second line) — but the indicator/second-line content comes from the
// Primary/Preview slot machinery above instead of real per-branch worktrees, except for the
// default branch, which still shows its own status.
function wtpBranchRowSlotted(b, worktrees, baseName){
  const w = state.wt;
  const menuOpen = !b.isDefault && w.openMenu && w.openMenu.type === "checkout" && w.openMenu.branch === b.name;
  // Primary is a fixed PLACE — the repo's own root checkout — not "whichever worktree happens to
  // currently have main checked out". Its branch can legitimately drift during dev work (as it is
  // right now, mid-feature-branch), so match by isMain rather than by branch/worktreePath — the
  // declared services live in that directory and run independent of which branch it's on.
  const primaryWt = b.isDefault ? worktrees.find((x) => x.isMain) : null;
  const holdsPreview = !b.isDefault && state.wt.preview.branch === b.name;
  const isLive = !!(primaryWt && wtIsLive(primaryWt));
  const nm = `<span class="wtp-bname"><span class="k">${icon("branch")}</span><span class="wtp-bname-txt">${esc(b.name)}</span>`
    + (b.isDefault ? `<span class="wtp-def">default</span>` : "") + `</span>`;

  // Preview's card outline is amber, not the green a real live worktree gets — matching the pill
  // and status link, which are always amber regardless of launching/ready state (see wtpSlotPill).
  let h = `<div class="wtp-brow${isLive ? " live" : ""}${holdsPreview ? " preview" : ""}">`;
  h += `<div class="wtp-brow-top">${nm}${divergeChip(b.ahead, baseName)}${wtpSlotPill(b, baseName, menuOpen)}</div>`;
  // The capture-link toggle: the Primary card is the "real ledger" half, the previewed branch is
  // the "preview DB" half. Exactly one is active; each renders its side of the switch.
  if(primaryWt){
    h += `<div class="wtp-brow-run">${primaryServicesHtml(primaryWt)}${captureLinkHtml("prod")}</div>`;
  }else if(holdsPreview){
    const status = previewStatusHtml();
    const sync = previewSyncHtml();
    h += `<div class="wtp-brow-run">${status}${sync}${captureLinkHtml("preview")}</div>`;
  }
  if(menuOpen) h += wtpSlotMenu(b.name, baseName);
  return h + `</div>`;
}

function panelHtml(worktrees, branches, data){
  const w = state.wt;
  const restricted = data && data.worktreePanel === "primary-preview";
  const baseName = data && data.defaultBranch;
  // the default branch is always the orientation point — pin it first regardless of recency.
  const ordered = branches.slice().sort((a, b) => (a.isDefault ? 0 : 1) - (b.isDefault ? 0 : 1));
  const closed = ordered.filter((b) => {
    if(b.isDefault || !b.merged) return false;
    // in restricted mode a real worktree isn't what keeps a branch "open" — holding the Preview
    // slot is, so a merged branch that's actively previewing stays visible instead of collapsing.
    return restricted ? state.wt.preview.branch !== b.name : !b.worktreePath;
  });
  const closedSet = new Set(closed);
  const active = ordered.filter((b) => !closedSet.has(b));
  const liveCount = restricted
    ? (worktrees.some((x) => baseName && x.branch === baseName && wtIsLive(x)) ? 1 : 0)
      + (state.wt.preview.status === "ready" ? 1 : 0)
    : worktrees.reduce((n, x) => n + wtLiveCount(x), 0);
  const row = restricted ? wtpBranchRowSlotted : wtpBranchRow;

  let h = `<div class="wtp">`;
  h += `<div class="wtp-head"><span class="wtp-title">Branches</span>`
    + `<span class="wtp-sub">${liveCount ? `${liveCount} server${liveCount === 1 ? "" : "s"} live` : `${active.length}`}</span></div>`;
  if(w.error) h += `<div class="wtp-err"><span class="wtp-err-msg">${esc(w.error)}</span><button class="wtp-x" data-act="dismiss" aria-label="dismiss">${icon("x")}</button></div>`;
  if(data && !data.serverScanned) h += `<div class="wtp-note">dev-server scan unavailable (lsof)</div>`;

  h += active.map((b) => row(b, worktrees, baseName)).join("") || `<div class="wtp-empty">no branches</div>`;
  if(closed.length){
    h += `<button class="wtp-merged-toggle" data-act="togglemerged" aria-expanded="${w.mergedOpen}">`
      + `<span class="chev">${icon(w.mergedOpen ? "chevronDown" : "chevronRight")}</span> Merged <span class="wtp-sub">${closed.length}</span></button>`;
    if(w.mergedOpen) h += `<div class="wtp-merged">${closed.map((b) => row(b, worktrees, baseName)).join("")}</div>`;
  }
  // Hosted infra is shared across branches, so it lives once at the panel level, below the branch list.
  h += remoteServicesHtml(data && data.remoteServices);
  h += `</div>`;
  return h;
}

// re-render the panel from the last-fetched data (no network) — for pure UI toggles
export function repaintPanel(){
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
export function showBnameTip(target){
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
export function hideBnameTip(){ if(bnameTipEl){ bnameTipEl.remove(); bnameTipEl = null; } }

// Both the checkout picker and the run-menu are position:fixed so the rail's scroll can't clip
// them — anchor to whichever trigger is open by hand, flipping above it when there's no room
// below. Reposition (rather than close) on scroll/resize so it stays glued and survives repaints.
function wtMenuReflow(){ if(state.wt.openMenu) positionWtMenu(); else detachWtMenu(); }
function detachWtMenu(){
  window.removeEventListener("scroll", wtMenuReflow, true);
  window.removeEventListener("resize", wtMenuReflow);
}
export function closeWtMenu(){
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

export async function renderWorktreePanel(force){
  const aside = $("#workAside");
  if(!aside) return;
  let data;
  try{ data = await api("/api/worktrees"); }
  catch(e){ if(!state.wtData) aside.innerHTML = `<div class="wtp"><div class="wtp-empty">couldn't read git state</div></div>`; return; }
  // never clobber a field the user is typing in
  if(!force && aside.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;

  const worktrees = data.worktrees || [];
  const branches = data.branches || [];
  const worktreePanel = data.worktreePanel || null;
  state.wt.captureLink = data.captureLink || null;
  const remoteServices = data.remoteServices || [];
  state.wtData = { worktrees, branches, remoteServices, serverScanned: data.serverScanned, defaultBranch: data.defaultBranch, worktreePanel };

  // Repos opted into the restricted layout: on first load, adopt whatever preview is already
  // running (if any) instead of showing an empty "choose a branch…" slot for something that's
  // actually up. Only once — after that the slot is driven purely by user selection + polling.
  if(worktreePanel === "primary-preview" && !state.wt.preview.hydrated){
    state.wt.preview.hydrated = true;
    hydratePreviewState();
  }

  const w = state.wt;
  const sig = "wtp:" + JSON.stringify({
    w: worktrees.map((x) => [x.path, x.branch, x.serverState, (x.servers || []).map((s) => s.port), x.devCommand, x.ahead,
      x.servicesDeclared, x.servicesError, (x.services || []).map((s) => [s.name, s.state])]),
    b: branches.map((x) => [x.name, x.worktreePath, x.merged, x.ahead, x.committedAt]),
    r: remoteServices.map((x) => [x.name, x.state, x.branch]),
    ui: [w.openMenu, w.editCmd, w.error, w.mergedOpen, [...w.busy]],
    p: worktreePanel,
    cl: w.captureLink,
  });
  if(!force && sig === state.wtSig) return;
  hideBnameTip(); // the hovered element is about to be thrown away — don't leave its tip stuck
  aside.innerHTML = panelHtml(worktrees, branches, data);
  if(state.wt.openMenu) positionWtMenu();
  state.wtSig = sig;
}

// ---- Preview slot: launch + poll --------------------------------------------

// Ask the PRIMARY server (not the preview itself — a cross-origin browser fetch to the preview's
// port would just get CORS-blocked) whether a preview is running and, if so, whether its HTTP
// server has actually come up yet.
async function fetchPreviewState(){
  try{ return await fetch("/api/preview/state", { cache:"no-store" }).then((r) => r.json()); }
  catch(e){ return null; }
}

// One-time adoption of whatever preview is already live when the panel first mounts.
async function hydratePreviewState(){
  const st = await fetchPreviewState();
  if(!st || !st.running) return;
  const p = state.wt.preview;
  p.branch = st.branch || null;
  p.status = st.ready ? "ready" : "launching";
  p.url = st.ready ? st.url : null;
  if("lastSyncedAt" in st) p.lastSyncedAt = st.lastSyncedAt;
  repaintPanel();
  if(!st.ready && p.branch) pollPreviewState(p.branch);
}

// Poll until `branch`'s preview reports ready, or give up after ~60s. `branch` is captured at call
// time (not re-read from state.wt.preview inside the async callback) so that if the user picks a
// DIFFERENT branch while a fetch is already in flight, the stale response is recognized as
// superseded and discarded instead of clobbering the newer selection's state.
function pollPreviewState(branch, attempt = 0){
  const p = state.wt.preview;
  if(p.pollTimer) clearTimeout(p.pollTimer);
  p.pollTimer = setTimeout(async () => {
    const st = await fetchPreviewState();
    if(state.wt.preview.branch !== branch) return; // superseded by a newer selection
    if(st && st.running && st.branch === branch && st.ready){
      p.status = "ready"; p.url = st.url; p.pollTimer = null;
      if("lastSyncedAt" in st) p.lastSyncedAt = st.lastSyncedAt;
      return repaintPanel();
    }
    if(attempt >= 60){
      p.status = "error"; p.error = "preview didn't come up in time"; p.pollTimer = null;
      return repaintPanel();
    }
    pollPreviewState(branch, attempt + 1);
  }, 1000);
}

// After a link/unlink, poll /api/worktrees until captureLink.linked matches what we asked for (the
// CLI's npm link / reinstall takes a few seconds to land), or give up after ~15s. renderWorktreePanel
// refreshes state.wt.captureLink; we clear the busy flag once it settles so the button un-spinners.
function pollCaptureLink(expectLinked, attempt = 0){
  const w = state.wt;
  if(w.clPollTimer) clearTimeout(w.clPollTimer);
  w.clPollTimer = setTimeout(async () => {
    await renderWorktreePanel(true);
    const settled = !!(w.captureLink && w.captureLink.linked) === expectLinked;
    if(settled || attempt >= 15){
      w.busy.delete("pv-link");
      w.clPollTimer = null;
      return renderWorktreePanel(true);
    }
    pollCaptureLink(expectLinked, attempt + 1);
  }, 1000);
}

// Selecting a branch in the Preview dropdown launches it immediately — no separate "start" step.
async function handlePreviewSelect(branch){
  branch = String(branch || "").trim();
  if(!branch) return;
  const p = state.wt.preview;
  if(p.pollTimer){ clearTimeout(p.pollTimer); p.pollTimer = null; }
  p.branch = branch; p.status = "launching"; p.url = null; p.error = null;
  repaintPanel();
  const r = await apiPost("/api/preview/launch", { branch });
  if(r && r.ok === false){
    p.status = "error"; p.error = r.error || "couldn't launch preview";
    return repaintPanel();
  }
  pollPreviewState(branch);
}

// panel button dispatch (delegated from the Work view click handler)
export async function handleWtAction(el){
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
  if(act === "previewassign"){
    // restricted-mode picker's "Preview" option — assign this branch to the one Preview slot and
    // launch it right away (same trigger behavior as before the picker-based redesign).
    w.openMenu = null;
    return handlePreviewSelect(branch);
  }
  if(act === "pv-link" || act === "pv-unlink"){
    // Route capture onto (or off) the previewed branch. The server shells out to the CLI, which
    // npm-links the preview worktree / reinstalls the published CLI — both take a few seconds — so
    // we mark busy, fire, then re-poll /api/worktrees a handful of times until captureLink settles.
    w.busy.add("pv-link"); repaintPanel();
    const r = await apiPost(act === "pv-link" ? "/api/preview/link" : "/api/preview/unlink", {});
    if(r && r.ok === false){
      w.busy.delete("pv-link");
      w.error = r.error || "couldn't change the capture link";
      return repaintPanel();
    }
    pollCaptureLink(act === "pv-link");
    return;
  }
  if(act === "pv-reseed"){
    // Resync the running preview's scratch DB from prod. The server reseeds by relaunching the
    // preview on its own branch/port, so it drops back to "launching" briefly; poll until it's up
    // again, at which point the fresh lastSyncedAt lands via preview state.
    const p = state.wt.preview;
    w.busy.add("pv-reseed"); repaintPanel();
    const r = await apiPost("/api/preview/reseed", {});
    w.busy.delete("pv-reseed");
    if(r && r.ok === false){
      p.status = "error"; p.error = r.error || "couldn't resync preview";
      return repaintPanel();
    }
    // Reseeding restarts the preview server. When THIS page IS that preview, we can't poll it
    // (it's coming down + back on the same port) — just reload once it's had time to rebind.
    if(p.self){
      p.status = "launching"; repaintPanel();
      setTimeout(() => location.reload(), 2500);
      return;
    }
    if(p.branch){
      if(p.pollTimer){ clearTimeout(p.pollTimer); p.pollTimer = null; }
      p.status = "launching"; p.url = null; p.error = null;
      repaintPanel();
      pollPreviewState(p.branch);
    } else {
      repaintPanel();
    }
    return;
  }
}
