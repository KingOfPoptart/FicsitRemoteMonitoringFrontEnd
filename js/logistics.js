// Logistics tab, two views beside one map:
//  - Belts & pipes: every conveyor belt and pipe, grouped into networks (worked out by server.py from geometry), with
//    what each network feeds and connects to, its length, tiers and bottleneck.
//  - Storage: every storage container, storage box, fluid buffer, Dimensional Depot uploader and crate (the shared
//    Storage poll in map.js), how full each is and what's in it, plus the Dimensional Depot's own contents.
"use strict";

const LogisticsTab = (() => {
  const root = $("tab-logistics");
  const ui = (() => { const d = { open: [], view: "nets", fill: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem("lg.ui") || "{}") }; } catch { return d; } })();
  const saveUi = () => { try { localStorage.setItem("lg.ui", JSON.stringify(ui)); } catch {} };
  if (!Array.isArray(ui.open)) ui.open = [];
  if (!Array.isArray(ui.fill)) ui.fill = [];
  let table, stTable, map, picked = null, pickedSt = null, inited = false;

  const net = id => Logistics.networks.find(n => n.id === id);
  const feeds = n => n.p && n.w ? "both" : n.p ? "production" : n.w ? "power" : "other";
  const FEEDS = { production: ["Production", "var(--s1)"], power: ["Power", "var(--s4)"], both: ["Both", "var(--s3)", "Feeds production machines and generators"], other: ["Other", "var(--muted)"] };
  const tierKeys = n => Object.keys(n.tiers).map(t => `${n.kind}:${t}`);   // e.g. "belt:3", "pipe:1"
  const passes = n => !table || table.passes(n);   // the Networks table's column filters (the map follows them too)
  const km = m => m >= 1000 ? `${fmtNum(m / 1000, 1)} km` : `${fmtNum(m)} m`;
  const capText = n => n.cap ? `${fmtNum(n.cap)}${n.kind === "pipe" ? " m³" : ""}/min` : "–";
  const tierText = n => Object.entries(n.tiers).sort().map(([t, c]) => `Mk.${t}${Object.keys(n.tiers).length > 1 ? ` ×${c}` : ""}`).join(" · ");

  // storage helpers
  const FILLS = ["Empty", "Partly full", "Full"];
  // an uploader always holds a stack or so; it's only stuck (full) when the depot can't take any more of its item
  const depotFull = s => { const i = s.items[0], c = i && Storage.cloud.find(x => x.name === i.name); return !!(c?.limit && c.amount >= c.limit); };
  const fillOf = s => !s.items.length ? "Empty" : s.kind === "crate" ? "Partly full" : (s.kind === "depot" ? depotFull(s) : s.frac >= (s.kind === "fluid" ? 0.98 : 0.999)) ? "Full" : "Partly full";
  const FILL_COLOR = { Empty: "var(--muted)", "Partly full": "var(--s1)", Full: "var(--warn)" };
  const FLOWS = ["Filling", "Draining", "Idle", "Items"];
  const flowOf = s => s.kind !== "fluid" ? "Items" : s.fill - s.drain > 0.05 ? "Filling" : s.drain - s.fill > 0.05 ? "Draining" : "Idle";
  const stIcon = s => icon(STORAGE_TYPES[s.cls]?.[3] || s.type);
  const stPasses = s => !stTable || stTable.passes(s);
  const isStorage = () => ui.view === "storage";

  // select a network (row click or map click) or clear the selection (same one again, or id null).
  // fromMap: the network is already in view where it was clicked, so the map doesn't move.
  function pick(id, fromMap = false) {
    picked = id && picked !== id ? id : null;
    render();
    const n = picked && net(picked);
    if (fromMap) { if (n) scrollRowIntoView($("lgNets").querySelector(`tr[data-net="${CSS.escape(n.id)}"]`)); return; }
    if (n) map.fitBox([worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])], 60, true); else map.fit();
  }
  // same for a storage: the row lights up, the map flies to it and rings it
  function pickStorage(id, fromMap = false) {
    pickedSt = id && pickedSt !== id ? id : null;
    map.setEmphasis(pickedSt ? new Map([[pickedSt, "#fa9549"]]) : null);
    render();
    if (fromMap) { if (pickedSt) scrollRowIntoView($("lgStore").querySelector(`tr[data-st="${CSS.escape(pickedSt)}"]`)); return; }
    if (pickedSt) map.locate(pickedSt); else map.fit();
  }
  function setView(v) {
    if (ui.view === v) return;
    ui.view = v; saveUi();
    picked = null; pickedSt = null; map.setEmphasis(null); Storage.push(map);   // the map shows only the filtered storage in this view
    render(); map.fit();
  }

  function renderNets() {
    const nets = Logistics.networks, c = Logistics.counts || {};
    const len = kind => nets.filter(n => n.kind === kind).reduce((a, n) => a + n.len, 0);
    const open = nets.reduce((a, n) => a + n.open, 0);
    const segs = (kind, t) => (kind === "belt" ? Logistics.belts : Logistics.pipes).filter(b => !t || b.t === t).length;
    $("lgTiles").innerHTML = `
      <div class="tile"><div class="t-label">Conveyor belts</div><div class="t-val">${fmtNum(segs("belt"))}</div><div class="t-sub">${km(len("belt"))} in ${nets.filter(n => n.kind === "belt").length} networks</div></div>
      <div class="tile"><div class="t-label">Pipes</div><div class="t-val">${fmtNum(segs("pipe"))}</div><div class="t-sub">${km(len("pipe"))} in ${nets.filter(n => n.kind === "pipe").length} networks</div></div>
      <div class="tile"><div class="t-label">Splitters · mergers</div><div class="t-val">${fmtNum(c.splitters || 0)} <small>· ${fmtNum(c.mergers || 0)}</small></div><div class="t-sub">on the belts</div></div>
      <div class="tile"><div class="t-label">Junctions · pumps · valves</div><div class="t-val">${fmtNum(c.junctions || 0)} <small>· ${fmtNum(c.pumps || 0)} · ${fmtNum(c.valves || 0)}</small></div><div class="t-sub">on the pipes</div></div>
      <div class="tile click${ui.open.length ? " on" : ""}" data-open title="Show only networks with an end that isn't connected to anything"><div class="t-label">Unconnected ends</div><div class="t-val">${fmtNum(open)}</div>
        <div class="t-sub">in ${nets.filter(n => n.open).length} networks · click to list them</div></div>`;
    // length by tier
    const rows = [...[1, 2, 3, 4, 5, 6].map(t => ["belt", t]), ...[1, 2].map(t => ["pipe", t])].filter(([k, t]) => segs(k, t))
      .map(([k, t]) => { const list = (k === "belt" ? Logistics.belts : Logistics.pipes).filter(b => b.t === t);
        return { label: `<span class="with-icon"><i class="sw-line" style="background:${(k === "belt" ? BELT_COLOR : PIPE_COLOR)[t]}"></i>Mk.${t} ${k}s</span>`, value: list.length,
                 text: `<b>${fmtNum(list.length)}</b>`, color: (k === "belt" ? BELT_COLOR : PIPE_COLOR)[t] }; });
    hbars($("lgTiers"), rows);
    table.render(nets);
    $("lgClear").disabled = !table.hasFilters();
    $("lgCount").textContent = `${table.filtered.length} of ${nets.length}`;
  }

  function renderStorage() {
    const list = Storage.list, cloud = Storage.cloud;
    const boxes = list.filter(s => s.kind === "items" || s.kind === "box"), tanks = list.filter(s => s.kind === "fluid");
    const slots = boxes.reduce((a, s) => a + s.slots, 0), used = boxes.reduce((a, s) => a + s.used, 0);
    const m3 = tanks.reduce((a, s) => a + s.content, 0), cap = tanks.reduce((a, s) => a + s.cap, 0);
    const full = list.filter(s => fillOf(s) === "Full").length, empty = list.filter(s => fillOf(s) === "Empty").length;
    const atLimit = cloud.filter(i => i.limit && i.amount >= i.limit).length, uploaders = list.filter(s => s.kind === "depot").length;
    const on = v => ui.fill.length === 1 && ui.fill[0] === v ? " on" : "";
    $("lgTiles").innerHTML = `
      <div class="tile"><div class="t-label">Storage containers &amp; boxes</div><div class="t-val">${fmtNum(boxes.length)}</div><div class="t-sub">${fmtNum(used)} of ${fmtNum(slots)} slots used${slots ? ` · ${Math.round(used / slots * 100)}%` : ""}</div></div>
      <div class="tile"><div class="t-label">Fluid buffers</div><div class="t-val">${fmtNum(tanks.length)}</div><div class="t-sub">${Storage.hasBuffers ? `${fmtNum(m3)} of ${fmtNum(cap)} m³ stored` : "needs the newer FRM build"}</div></div>
      <div class="tile"><div class="t-label">Dimensional Depot</div><div class="t-val">${fmtNum(cloud.length)} <small>items</small></div><div class="t-sub">${fmtNum(uploaders)} uploaders${atLimit ? ` · ${atLimit} at the limit` : ""}</div></div>
      <div class="tile click${on("Full")}" data-fill="Full" title="Show only storage with every slot (or the whole tank) used"><div class="t-label">Full</div><div class="t-val">${fmtNum(full)}</div><div class="t-sub">click to list them</div></div>
      <div class="tile click${on("Empty")}" data-fill="Empty" title="Show only empty storage"><div class="t-label">Empty</div><div class="t-val">${fmtNum(empty)}</div><div class="t-sub">click to list them</div></div>`;
    // the depot: each item against its upload limit (bars are per item, since limits differ by stack size)
    const rows = [...cloud].sort((a, b) => (b.limit ? b.amount / b.limit : 0) - (a.limit ? a.amount / a.limit : 0) || b.amount - a.amount || a.name.localeCompare(b.name));
    $("lgDepot").innerHTML = rows.map(i => { const f = i.limit ? Math.min(1, i.amount / i.limit) : null;
      return `<div class="hb"><div class="hb-label"><span class="with-icon">${icon(i.name, "icon sm")}${esc(i.name)}</span></div>
        <div class="hb-track"><i style="width:${(f ?? 1) * 100}%;background:${f != null && f >= 1 ? "var(--warn)" : STORAGE_COLOR.depot}"></i></div>
        <div class="hb-val"><b>${fmtNum(i.amount)}</b>${i.limit ? ` <span class="muted">/ ${fmtNum(i.limit)}</span>` : ""}</div></div>`; }).join("")
      || `<div class="muted">Nothing uploaded yet.</div>`;
    $("lgDepotHint").textContent = cloud.length ? `${cloud.length} items${cloud[0]?.limit ? " · stored / limit" : ""}` : "";
    stTable.render(list);
    $("lgStClear").disabled = !stTable.hasFilters();
    $("lgStCount").textContent = `${stTable.filtered.length} of ${list.length}`;
  }

  function render() {
    if (!inited) return;
    root.dataset.view = ui.view;
    setSeg($("lgView"), segControl("view", [{ v: "nets", label: "Belts &amp; pipes", n: Logistics.networks.length || null },
                                            { v: "storage", label: "Storage", n: Storage.loaded ? Storage.list.length : null }], o => ui.view === o.v));
    if (isStorage()) { if (Storage.loaded) renderStorage(); }
    else if (Logistics.networks.length) renderNets();
    const nets = Logistics.networks, len = kind => nets.filter(n => n.kind === kind).reduce((a, n) => a + n.len, 0);
    const open = nets.reduce((a, n) => a + n.open, 0), full = Storage.list.filter(s => fillOf(s) === "Full").length;
    $("statsLogi").innerHTML = (nets.length ? `<span class="stat"><b>${km(len("belt"))}</b>of belts</span><span class="stat"><b>${km(len("pipe"))}</b>of pipes</span>` : "") +
      (Storage.loaded ? `<span class="stat"><b>${fmtNum(Storage.list.length)}</b>storage</span>` : "") +
      (open ? `<span class="stat" style="color:var(--warn)"><b>${open}</b>unconnected ends</span>` : "") +
      (full ? `<span class="stat" style="color:var(--warn)"><b>${full}</b>full storage</span>` : "");
    map.renderButtons(); map.draw();
  }

  function init() {
    root.innerHTML = `
      <div class="toolbar"><div class="seg-group"><span class="lbl">Show</span><span id="lgView"></span></div></div>
      <div class="tiles compact" id="lgTiles"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card lg-tiers lg-n"><div class="card-head"><h2>By tier</h2><span class="hint">segments</span></div><div class="card-body hbars" id="lgTiers"></div></section>
          <section class="card lg-nets lg-n"><div class="card-head"><h2>Networks</h2><span class="hint" id="lgCount"></span>
            <button class="b" id="lgClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="lgNets"></div></section>
          <section class="card lg-store lg-s"><div class="card-head"><h2>Storage</h2><span class="hint" id="lgStCount"></span>
            <button class="b" id="lgStClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="lgStore"></div></section>
          <section class="card lg-depot lg-s"><div class="card-head"><h2>Dimensional Depot</h2><span class="hint" id="lgDepotHint"></span></div><div class="card-body hbars" id="lgDepot"></div></section>
        </div>
        <div class="pcol">
          <section class="card lg-map"><div id="lgMap"></div></section>
        </div>
      </div>`;
    table = new DataTable($("lgNets"), [
      { key: "kind", label: "Kind", minW: 92, filter: { value: r => r.kind, noun: "kinds", all: () => [{ value: "belt", label: "Belts" }, { value: "pipe", label: "Pipes" }] }, val: r => r.kind, cell: r => `<span class="with-icon"><i class="sw-line" style="background:${(r.kind === "belt" ? BELT_COLOR : PIPE_COLOR)[Math.max(...Object.keys(r.tiers).map(Number))]}"></i>${r.kind === "belt" ? "Belts" : "Pipes"}</span>` },
      { key: "feeds", label: "Feeds", minW: 96, val: r => feeds(r),
        filter: { value: r => feeds(r), noun: "feeds", all: () => Object.entries(FEEDS).map(([k, [l, c]]) => ({ value: k, label: `<i class="sw" style="background:${c}"></i> ${l}` })) }, cell: r => { const [l, c, t] = FEEDS[feeds(r)]; return `<span class="pill" style="color:${c};background:color-mix(in srgb, ${c} 14%, transparent)"${t ? ` title="${t}"` : ""}>${l}</span>`; } },
      { key: "touches", label: "Connects", minW: 160, title: "Buildings at the ends of this network",
        filter: { value: r => Object.keys(r.touches), noun: "buildings", label: v => icon(v, "icon sm") + esc(v) }, val: r => Object.keys(r.touches)[0] || "",
        cell: r => { const e = Object.entries(r.touches); return e.length ? e.slice(0, 3).map(([k, n]) => `${n} × ${esc(k)}`).join("<br>") + (e.length > 3 ? `<br><span class="muted sub">+${e.length - 3} more</span>` : "") : `<span class="muted">nothing found</span>`; } },
      { key: "len", label: "Length", num: true, minW: 74, val: r => r.len, cell: r => km(r.len) },
      { key: "segs", label: "Pieces", num: true, minW: 66, title: "Belt or pipe segments", val: r => r.segs, cell: r => fmtNum(r.segs) },
      { key: "tiers", label: "Tiers", minW: 90, filter: { value: r => tierKeys(r), noun: "tiers", all: () => [...[1, 2, 3, 4, 5, 6].map(t => `belt:${t}`), ...[1, 2].map(t => `pipe:${t}`)].map(k => { const [kind, t] = k.split(":");
                  return { value: k, group: kind === "belt" ? "Belts" : "Pipes", label: `<i class="sw-line" style="background:${(kind === "belt" ? BELT_COLOR : PIPE_COLOR)[t]}"></i> Mk.${t} ${kind}s` }; }) }, val: r => Math.min(...Object.keys(r.tiers).map(Number)), cell: r => esc(tierText(r)) },
      { key: "cap", label: "Bottleneck", num: true, minW: 96, filter: { value: r => capText(r), noun: "" }, title: "Most this network can carry: its slowest tier", val: r => r.cap || 0, cell: r => capText(r) },
      { key: "open", label: "Open ends", num: true, minW: 80,
        filter: { value: r => r.open ? "Has open ends" : "None", noun: "", get: () => ui.open, set: v => { ui.open = v; saveUi(); },
                  all: () => [{ value: "Has open ends" }, { value: "None" }] }, title: "Ends not connected to anything", val: r => r.open, cell: r => r.open ? `<span class="warn-text">${r.open}</span>` : `<span class="muted">0</span>` },
    ], { sortKey: "len", dir: -1, storeKey: "lg.sort", onFilter: () => { render(); map.fit(); }, rowAttrs: r => `data-net="${esc(r.id)}" class="${r.id === picked ? "sel" : ""}"` });
    stTable = new DataTable($("lgStore"), [
      { key: "type", label: "Storage", minW: 150, val: r => STORAGE_ORDER.indexOf(r.type) + 1 || 99,
        filter: { value: r => r.type, noun: "types", label: v => icon(STORAGE_TYPES[Object.keys(STORAGE_TYPES).find(k => STORAGE_TYPES[k][0] === v)]?.[3] || v, "icon sm") + esc(v),
                  all: () => [...STORAGE_ORDER, ...new Set(Storage.list.map(s => s.type).filter(t => !STORAGE_ORDER.includes(t)))].map(v => ({ value: v })), ord: true },
        cell: r => `<span class="with-icon">${stIcon(r)}${esc(r.type)}</span>` },
      { key: "items", label: "Contents", minW: 170, val: r => r.items[0]?.name || "~",
        filter: { value: r => r.items.map(i => i.name), noun: "items", label: v => icon(v, "icon sm") + esc(v) },
        cell: r => r.items.length ? r.items.slice(0, 3).map(i => `<span class="with-icon">${icon(i.name, "icon sm")}${fmtNum(i.amount, i.fluid ? 1 : 0)}${i.fluid ? " m³" : ""} ${esc(i.name)}</span>`).join("<br>") +
                   (r.items.length > 3 ? `<br><span class="muted sub">+${r.items.length - 3} more</span>` : "") : `<span class="muted">empty</span>` },
      { key: "fill", label: "Fill", num: true, minW: 104, title: "Slots used, or how much of the tank is full", val: r => r.kind === "crate" ? -1 : r.frac,
        filter: { value: fillOf, noun: "", get: () => ui.fill, set: v => { ui.fill = v; saveUi(); },
                  all: () => FILLS.map(v => ({ value: v, label: `<i class="sw" style="background:${FILL_COLOR[v]}"></i> ${v}` })), ord: true },
        cell: r => r.kind === "crate" ? `<span class="muted">–</span>` : `<span class="nowrap">${bar(r.frac, fillOf(r) === "Full" ? "var(--warn)" : "var(--s1)")} ${Math.round(r.frac * 100)}%</span>` },
      { key: "stored", label: "Stored", num: true, minW: 120, val: r => r.kind === "fluid" ? r.content : r.used,
        filter: { text: r => storageFill(r), placeholder: "e.g. m³" }, cell: r => storageFill(r) },
      { key: "flow", label: "Flow", num: true, minW: 120, title: "Fluid buffers: filling / draining, m³ per minute", val: r => r.kind === "fluid" ? r.fill - r.drain : -1e9,
        filter: { value: flowOf, noun: "", all: () => FLOWS.map(v => ({ value: v, label: v === "Items" ? "Items (no flow)" : v })), ord: true },
        cell: r => r.kind !== "fluid" ? `<span class="muted">–</span>` : r.fill < 0.05 && r.drain < 0.05 ? `<span class="muted">idle</span>`
          : `<span style="color:var(--ok)">+${fmtRate(r.fill)}</span> <span class="muted">/</span> <span style="color:var(--warn)">−${fmtRate(r.drain)}</span>` },
    ], { sortKey: "type", dir: 1, storeKey: "lg.st", empty: "No storage found.",
         onFilter: () => { Storage.push(map); render(); map.fit(); },   // storage points are pushed to the map, not drawn live
         rowAttrs: r => `data-st="${esc(r.id)}" class="${r.id === pickedSt ? "sel" : ""}"` });
    map = new MapView($("lgMap"), {
      storeKey: "lg.map", layerMenu: true, players: true, layers: [],
      logistics: b => { const n = net(b.n); return !n || passes(n); },   // the map follows the filters
      storage: s => !isStorage() || stPasses(s),
      highlight: () => isStorage() ? null : picked, hint: "hover a belt, pipe or storage to see it · click it (or a row) to select it",
      onNetClick: id => { if (isStorage()) { if (!id && pickedSt) pickStorage(null, true); return; } pick(id, true); },   // click a belt/pipe = select its network; again or empty map = clear
      onClick: p => { if (!p.storage) return; if (!isStorage()) setView("storage"); pickStorage(p.storage, true); },
      onNetHover: id => {   // map hover -> the network's row lights up and scrolls into view
        for (const tr of $("lgNets").querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = id && !isStorage() && $("lgNets").querySelector(`tr[data-net="${CSS.escape(id)}"]`);
        if (tr) { tr.classList.add("hl"); scrollRowIntoView(tr); }
      },
      onHover: p => {   // same for a storage
        for (const tr of $("lgStore").querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = p?.storage && isStorage() && $("lgStore").querySelector(`tr[data-st="${CSS.escape(p.storage)}"]`);
        if (tr) { tr.classList.add("hl"); scrollRowIntoView(tr); }
      },
      // Fit frames the networks / storage the table shows
      fitTo: () => isStorage() ? Storage.list.filter(stPasses).map(s => worldToImg(s.loc.x, s.loc.y))
        : Logistics.networks.filter(n => passes(n)).flatMap(n => [worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])]),
    });

    root.addEventListener("click", e => {
      const v = e.target.closest("button[data-g=view]"); if (v) { setView(v.dataset.v); return; }
      if (e.target.closest("#lgClear")) { table.clearFilters(); return; }
      if (e.target.closest("#lgStClear")) { stTable.clearFilters(); return; }
      if (e.target.closest("[data-open]")) { table.setFilter("open", ui.open.length ? [] : ["Has open ends"]); return; }
      const f = e.target.closest("[data-fill]"); if (f) { const want = f.dataset.fill; stTable.setFilter("fill", ui.fill.length === 1 && ui.fill[0] === want ? [] : [want]); return; }
      const tr = e.target.closest("tr[data-net]"); if (tr) { pick(tr.dataset.net); return; }
      const st = e.target.closest("tr[data-st]"); if (st) pickStorage(st.dataset.st);
    });
    Logistics.listeners.add(render);
    Storage.listeners.add(render);
    inited = true;
  }

  return {
    show() { if (!inited) init(); Logistics.start(); Storage.start(); render(); setConn(true); },
    hide() {},
  };
})();
