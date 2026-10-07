// Logistics tab: every conveyor belt (conveyor lifts included) and pipe, grouped into networks (worked out by server.py from geometry), and
// every storage building (containers, boxes, fluid buffers, Dimensional Depot uploaders, crates - the shared Storage
// poll in map.js), linked: server.py lists the storage each network reaches, so picking a network lights up its
// storage and picking a storage lights up the belts and pipes into it. Beside one map, with segments by tier and the
// Dimensional Depot's contents under it.
"use strict";

const LogisticsTab = (() => {
  const root = $("tab-logistics");
  const ui = (() => { const d = { open: [], fill: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem("lg.ui") || "{}") }; } catch { return d; } })();
  const saveUi = () => { try { localStorage.setItem("lg.ui", JSON.stringify(ui)); } catch {} };
  if (!Array.isArray(ui.open)) ui.open = [];
  if (!Array.isArray(ui.fill)) ui.fill = [];
  let table, stTable, map, picked = null, pickedSt = null, inited = false;

  const net = id => Logistics.byId?.get(id);
  const feeds = n => n.p && n.w ? "both" : n.p ? "production" : n.w ? "power" : "other";
  const FEEDS = { production: ["Production", "var(--s1)"], power: ["Power", "var(--s4)"], both: ["Both", "var(--s3)", "Feeds production machines and generators"], other: ["Other", "var(--muted)"] };
  const tierKeys = n => Object.keys(n.tiers).map(t => `${n.kind}:${t}`);   // e.g. "belt:3", "pipe:1"
  const passes = n => !table || table.passes(n);   // the Networks table's column filters (the map follows them too)
  const km = m => m >= 1000 ? `${fmtNum(m / 1000, 1)} km` : `${fmtNum(m)} m`;
  const capText = n => n.cap ? `${fmtNum(n.cap)}${n.kind === "pipe" ? " m³" : ""}/min` : "–";
  const tierText = n => Object.entries(n.tiers).sort().map(([t, c]) => `Mk.${t}${Object.keys(n.tiers).length > 1 ? ` ×${c}` : ""}`).join(" · ");

  // storage helpers
  const FILLS = ["Empty", "Partly full", "Full"];
  const FILL_COLOR = { Empty: "var(--muted)", "Partly full": "var(--s1)", Full: "var(--warn)" };
  // an uploader always holds a stack or so; it's only stuck (full) when the depot can't take any more of its item
  const depotFull = s => { const i = s.items[0], c = i && Storage.cloud.find(x => x.name === i.name); return !!(c?.limit && c.amount >= c.limit); };
  const fillOf = s => !s.items.length ? "Empty" : s.kind === "crate" ? "Partly full" : (s.kind === "depot" ? depotFull(s) : s.frac >= (s.kind === "fluid" ? 0.98 : 0.999)) ? "Full" : "Partly full";
  const FLOWS = ["Filling", "Draining", "Idle", "Items"];
  const flowOf = s => s.kind !== "fluid" ? "Items" : s.fill - s.drain > 0.05 ? "Filling" : s.drain - s.fill > 0.05 ? "Draining" : "Idle";
  const stIcon = s => icon(STORAGE_TYPES[s.cls]?.[3] || s.type);
  const stPasses = s => !stTable || stTable.passes(s);

  // the links: storage id -> networks into it (rebuilt when /logistics updates)
  let linkSrc = null, stNets = new Map();
  const netsOf = id => {
    if (linkSrc !== Logistics.networks) {
      linkSrc = Logistics.networks; stNets = new Map();
      for (const n of linkSrc) for (const sid of n.st || []) (stNets.get(sid) || stNets.set(sid, []).get(sid)).push(n);
    }
    return stNets.get(id) || [];
  };
  const linkText = s => { const ns = netsOf(s.id), b = ns.filter(n => n.kind === "belt").length, p = ns.length - b;
    return [b && `${b} belt${b > 1 ? "s" : ""}`, p && `${p} pipe${p > 1 ? "s" : ""}`].filter(Boolean).join(" · "); };
  const linkValues = s => { const ns = netsOf(s.id); return ns.length ? [...new Set(ns.map(n => n.kind === "belt" ? "Belts" : "Pipes"))] : ["Not connected"]; };
  // what the current selection lights up in the other table
  const linkedSt = () => new Set(picked ? net(picked)?.st || [] : []);
  const linkedNets = () => new Set(pickedSt ? netsOf(pickedSt).map(n => n.id) : []);

  function emphasize() {   // on the map: the picked storage, or the picked network's storage, ringed; the rest fades
    const ids = pickedSt ? [pickedSt] : picked ? [...linkedSt()] : [];
    map.setEmphasis(ids.length ? new Map(ids.map(id => [id, "#fa9549"])) : null);
  }
  // select a network (row click or map click) or clear the selection (same one again, or id null).
  // fromMap: it's already in view where it was clicked, so the map doesn't move.
  function pick(id, fromMap = false) {
    picked = id && picked !== id ? id : null; pickedSt = null;
    emphasize(); render();
    const n = picked && net(picked);
    if (n) $("lgStore").scrollTop = 0;   // its storage is pinned to the top of the other table
    if (n) scrollRowIntoView($("lgNets").querySelector(`tr[data-net="${CSS.escape(n.id)}"]`));
    if (fromMap) return;
    if (n) map.fitBox([worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])], 60, true); else map.fit();
  }
  // same for a storage: the map flies to it, its belts and pipes are drawn on top
  function pickStorage(id, fromMap = false) {
    pickedSt = id && pickedSt !== id ? id : null; picked = null;
    emphasize(); render();
    if (pickedSt) $("lgNets").scrollTop = 0;
    if (pickedSt) scrollRowIntoView($("lgStore").querySelector(`tr[data-st="${CSS.escape(pickedSt)}"]`));
    if (fromMap) return;
    if (pickedSt) map.locate(pickedSt); else map.fit();
  }

  function render() {
    if (!inited) return;
    const nets = Logistics.networks, c = Logistics.counts || {}, list = Storage.list, cloud = Storage.cloud;
    const len = kind => nets.filter(n => n.kind === kind).reduce((a, n) => a + n.len, 0);
    const count = kind => nets.filter(n => n.kind === kind).length;
    const open = nets.reduce((a, n) => a + n.open, 0);
    const segs = (kind, t) => (kind === "belt" ? Logistics.belts : Logistics.pipes).filter(b => !t || b.t === t).length;
    const boxes = list.filter(s => s.kind === "items" || s.kind === "box"), tanks = list.filter(s => s.kind === "fluid");
    const slots = boxes.reduce((a, s) => a + s.slots, 0), used = boxes.reduce((a, s) => a + s.used, 0);
    const m3 = tanks.reduce((a, s) => a + s.content, 0), cap = tanks.reduce((a, s) => a + s.cap, 0);
    const full = list.filter(s => fillOf(s) === "Full").length;
    const atLimit = cloud.filter(i => i.limit && i.amount >= i.limit).length, uploaders = list.filter(s => s.kind === "depot").length;
    const fullOn = ui.fill.length === 1 && ui.fill[0] === "Full";
    $("lgTiles").innerHTML = `
      <div class="tile"><div class="t-label">Conveyor belts</div><div class="t-val">${fmtNum(segs("belt"))}</div><div class="t-sub">${km(len("belt"))} in ${count("belt")} networks · ${fmtNum(Logistics.lifts.length)} lifts · ${fmtNum(c.splitters || 0)} splitters · ${fmtNum(c.mergers || 0)} mergers</div></div>
      <div class="tile"><div class="t-label">Pipes</div><div class="t-val">${fmtNum(segs("pipe"))}</div><div class="t-sub">${km(len("pipe"))} in ${count("pipe")} networks · ${fmtNum(c.junctions || 0)} junctions · ${fmtNum(c.pumps || 0)} pumps · ${fmtNum(c.valves || 0)} valves</div></div>
      <div class="tile click${ui.open.length ? " on" : ""}" data-open title="Show only networks with an end that isn't connected to anything"><div class="t-label">Unconnected ends</div><div class="t-val">${fmtNum(open)}</div>
        <div class="t-sub">in ${nets.filter(n => n.open).length} networks · click to list them</div></div>
      <div class="tile"><div class="t-label">Storage containers &amp; boxes</div><div class="t-val">${fmtNum(boxes.length)}</div><div class="t-sub">${fmtNum(used)} of ${fmtNum(slots)} slots used${slots ? ` · ${Math.round(used / slots * 100)}%` : ""}</div></div>
      <div class="tile"><div class="t-label">Fluid buffers</div><div class="t-val">${fmtNum(tanks.length)}</div><div class="t-sub">${Storage.hasBuffers ? `${fmtNum(m3)} of ${fmtNum(cap)} m³ stored` : "needs the newer FRM build"}</div></div>
      <div class="tile"><div class="t-label">Dimensional Depot</div><div class="t-val">${fmtNum(cloud.length)} <small>items</small></div><div class="t-sub">${fmtNum(uploaders)} uploaders${atLimit ? ` · ${atLimit} items at the limit` : ""}</div></div>
      <div class="tile click${fullOn ? " on" : ""}" data-fill="Full" title="Show only storage with every slot (or the whole tank) used"><div class="t-label">Full storage</div><div class="t-val">${fmtNum(full)}</div><div class="t-sub">click to list them</div></div>`;
    // segments by tier
    const rows = [...[1, 2, 3, 4, 5, 6].map(t => ["belt", t]), ...[1, 2].map(t => ["pipe", t])].filter(([k, t]) => segs(k, t))
      .map(([k, t]) => { const n = segs(k, t), col = (k === "belt" ? BELT_COLOR : PIPE_COLOR)[t];
        return { label: `<span class="with-icon"><i class="sw-line" style="background:${col}"></i>Mk.${t} ${k}s</span>`, value: n, text: `<b>${fmtNum(n)}</b>`, color: col }; });
    const lift = t => Logistics.lifts.filter(l => l.t === t).length;   // lifts after the belts
    rows.splice(rows.findIndex(r => /pipes/.test(r.label)) >>> 0, 0, ...[1, 2, 3, 4, 5, 6].filter(lift).map(t => ({ value: lift(t), text: `<b>${fmtNum(lift(t))}</b>`, color: BELT_COLOR[t],
      label: `<span class="with-icon"><i class="sw-lift" style="background:${BELT_COLOR[t]}"></i>Mk.${t} lifts</span>` })));
    hbars($("lgTiers"), rows);
    // the depot: each item against its upload limit (bars are per item, since limits differ by stack size)
    const depot = [...cloud].sort((a, b) => (b.limit ? b.amount / b.limit : 0) - (a.limit ? a.amount / a.limit : 0) || b.amount - a.amount || a.name.localeCompare(b.name));
    $("lgDepot").innerHTML = depot.map(i => { const f = i.limit ? Math.min(1, i.amount / i.limit) : null;
      return `<div class="hb"><div class="hb-label"><span class="with-icon">${icon(i.name, "icon sm")}${esc(i.name)}</span></div>
        <div class="hb-track"><i style="width:${(f ?? 1) * 100}%;background:${f != null && f >= 1 ? "var(--warn)" : STORAGE_COLOR.depot}"></i></div>
        <div class="hb-val"><b>${fmtNum(i.amount)}</b>${i.limit ? ` <span class="muted">/ ${fmtNum(i.limit)}</span>` : ""}</div></div>`; }).join("")
      || `<div class="muted">Nothing uploaded yet.</div>`;
    $("lgDepotHint").textContent = cloud.length ? `${cloud.length} items${cloud[0]?.limit ? " · stored / limit" : ""}` : "";
    // the two tables; whatever the selection links to is pinned to the top and marked
    if (nets.length) table.render(nets);
    if (Storage.loaded) stTable.render(list);
    $("lgClear").disabled = !table.hasFilters();
    $("lgCount").textContent = `${table.filtered.length} of ${nets.length}` + (pickedSt ? ` · ${linkedNets().size} into the selected storage` : "");
    $("lgStClear").disabled = !stTable.hasFilters();
    $("lgStCount").textContent = `${stTable.filtered.length} of ${list.length}` + (picked ? ` · ${linkedSt().size} on the selected network` : "");
    $("statsLogi").innerHTML = (nets.length ? `<span class="stat"><b>${km(len("belt"))}</b>of belts</span><span class="stat"><b>${km(len("pipe"))}</b>of pipes</span>` : "") +
      (Storage.loaded ? `<span class="stat"><b>${fmtNum(list.length)}</b>storage</span>` : "") +
      (open ? `<span class="stat" style="color:var(--warn)"><b>${open}</b>unconnected ends</span>` : "") +
      (full ? `<span class="stat" style="color:var(--warn)"><b>${full}</b>full storage</span>` : "");
    map.renderButtons(); map.draw();
  }

  function init() {
    root.innerHTML = `
      <div class="tiles compact" id="lgTiles"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card lg-nets"><div class="card-head"><h2>Belt &amp; pipe networks</h2><span class="hint" id="lgCount"></span>
            <button class="b" id="lgClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="lgNets"></div></section>
          <section class="card lg-store"><div class="card-head"><h2>Storage</h2><span class="hint" id="lgStCount"></span>
            <button class="b" id="lgStClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="lgStore"></div></section>
        </div>
        <div class="pcol">
          <section class="card lg-map"><div id="lgMap"></div></section>
          <div class="lg-row">
            <section class="card lg-tiers"><div class="card-head"><h2>By tier</h2><span class="hint">segments</span></div><div class="card-body hbars" id="lgTiers"></div></section>
            <section class="card lg-depot"><div class="card-head"><h2>Dimensional Depot</h2><span class="hint" id="lgDepotHint"></span></div><div class="card-body hbars" id="lgDepot"></div></section>
          </div>
        </div>
      </div>`;
    table = new DataTable($("lgNets"), [
      { key: "kind", label: "Kind", minW: 86, filter: { value: r => r.kind, noun: "kinds", all: () => [{ value: "belt", label: "Belts" }, { value: "pipe", label: "Pipes" }] }, val: r => r.kind, cell: r => `<span class="with-icon"><i class="sw-line" style="background:${(r.kind === "belt" ? BELT_COLOR : PIPE_COLOR)[Math.max(...Object.keys(r.tiers).map(Number))]}"></i>${r.kind === "belt" ? "Belts" : "Pipes"}</span>` },
      { key: "feeds", label: "Feeds", minW: 90, val: r => feeds(r),
        filter: { value: r => feeds(r), noun: "feeds", all: () => Object.entries(FEEDS).map(([k, [l, c]]) => ({ value: k, label: `<i class="sw" style="background:${c}"></i> ${l}` })) }, cell: r => { const [l, c, t] = FEEDS[feeds(r)]; return `<span class="pill" style="color:${c};background:color-mix(in srgb, ${c} 14%, transparent)"${t ? ` title="${t}"` : ""}>${l}</span>`; } },
      { key: "touches", label: "Connects", minW: 140, title: "Buildings at the ends of this network, storage included",
        filter: { value: r => Object.keys(r.touches), noun: "buildings", label: v => icon(v, "icon sm") + esc(v) }, val: r => Object.keys(r.touches)[0] || "",
        cell: r => { const e = Object.entries(r.touches); return e.length ? e.slice(0, 3).map(([k, n]) => `${n} × ${esc(k)}`).join("<br>") + (e.length > 3 ? `<br><span class="muted sub">+${e.length - 3} more</span>` : "") : `<span class="muted">nothing found</span>`; } },
      { key: "len", label: "Length", num: true, minW: 74, val: r => r.len, cell: r => km(r.len) },
      { key: "segs", label: "Pieces", num: true, minW: 60, title: "Belt or pipe segments", val: r => r.segs, cell: r => fmtNum(r.segs) },
      { key: "lifts", label: "Lifts", num: true, minW: 54, title: "Conveyor lifts in this network (belt pieces that go up or down)", val: r => r.lifts || 0,
        filter: { value: r => r.kind === "pipe" ? "Pipes" : r.lifts ? "Has lifts" : "None", noun: "", all: () => [{ value: "Has lifts" }, { value: "None" }, { value: "Pipes", label: "Pipes (no lifts)" }], ord: true },
        cell: r => r.kind === "pipe" ? `<span class="muted">–</span>` : r.lifts ? fmtNum(r.lifts) : `<span class="muted">0</span>` },
      { key: "tiers", label: "Tiers", minW: 90, filter: { value: r => tierKeys(r), noun: "tiers", all: () => [...[1, 2, 3, 4, 5, 6].map(t => `belt:${t}`), ...[1, 2].map(t => `pipe:${t}`)].map(k => { const [kind, t] = k.split(":");
                  return { value: k, group: kind === "belt" ? "Belts" : "Pipes", label: `<i class="sw-line" style="background:${(kind === "belt" ? BELT_COLOR : PIPE_COLOR)[t]}"></i> Mk.${t} ${kind}s` }; }) }, val: r => Math.min(...Object.keys(r.tiers).map(Number)), cell: r => esc(tierText(r)) },
      { key: "cap", label: "Bottleneck", num: true, minW: 96, filter: { value: r => capText(r), noun: "" }, title: "Most this network can carry: its slowest tier", val: r => r.cap || 0, cell: r => capText(r) },
      { key: "open", label: "Open ends", num: true, minW: 80,
        filter: { value: r => r.open ? "Has open ends" : "None", noun: "", get: () => ui.open, set: v => { ui.open = v; saveUi(); },
                  all: () => [{ value: "Has open ends" }, { value: "None" }] }, title: "Ends not connected to anything", val: r => r.open, cell: r => r.open ? `<span class="warn-text">${r.open}</span>` : `<span class="muted">0</span>` },
    ], { sortKey: "len", dir: -1, storeKey: "lg.sort", onFilter: () => { render(); map.fit(); },
         pin: r => pickedSt && linkedNets().has(r.id) ? 0 : 1,
         rowAttrs: r => `data-net="${esc(r.id)}" class="${r.id === picked ? "sel" : pickedSt && linkedNets().has(r.id) ? "link" : ""}"` });
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
          : `<span class="nowrap"><span style="color:var(--ok)">+${fmtRate(r.fill)}</span> <span class="muted">/</span> <span style="color:var(--warn)">−${fmtRate(r.drain)}</span></span>` },
      { key: "links", label: "Belts / pipes", minW: 104, title: "Belt and pipe networks into or out of it", val: r => netsOf(r.id).length,
        filter: { value: linkValues, noun: "", all: () => ["Belts", "Pipes", "Not connected"].map(v => ({ value: v })), ord: true },
        cell: r => linkText(r) || `<span class="muted">none found</span>` },
    ], { sortKey: "type", dir: 1, storeKey: "lg.st", empty: "No storage found.",
         onFilter: () => { Storage.push(map); render(); map.fit(); },   // storage points are pushed to the map, not drawn live
         pin: r => picked && linkedSt().has(r.id) ? 0 : 1,
         rowAttrs: r => `data-st="${esc(r.id)}" class="${r.id === pickedSt ? "sel" : picked && linkedSt().has(r.id) ? "link" : ""}"` });
    map = new MapView($("lgMap"), {
      storeKey: "lg.map", layerMenu: true, players: true, layers: [],
      logistics: b => { const n = net(b.n); return !n || passes(n); },   // the map follows both tables' filters
      storage: s => stPasses(s),
      highlight: () => picked || (pickedSt ? [...linkedNets()] : null),
      hint: "hover a belt, pipe or storage to see it · click it (or a row) to select it and what it connects to",
      onNetClick: id => { if (id) pick(id, true); else if (picked) pick(null, true); else if (pickedSt) pickStorage(null, true); },   // empty map = clear
      onClick: p => { if (p.storage) pickStorage(p.storage, true); },
      onNetHover: id => {   // map hover -> the row lights up and scrolls into view
        for (const tr of $("lgNets").querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = id && $("lgNets").querySelector(`tr[data-net="${CSS.escape(id)}"]`);
        if (tr) { tr.classList.add("hl"); scrollRowIntoView(tr); }
      },
      onHover: p => {
        for (const tr of $("lgStore").querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = p?.storage && $("lgStore").querySelector(`tr[data-st="${CSS.escape(p.storage)}"]`);
        if (tr) { tr.classList.add("hl"); scrollRowIntoView(tr); }
      },
      // Fit frames what the two tables show
      fitTo: () => [...Logistics.networks.filter(n => passes(n)).flatMap(n => [worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])]),
                    ...Storage.list.filter(stPasses).map(s => worldToImg(s.loc.x, s.loc.y))],
    });

    root.addEventListener("click", e => {
      if (e.target.closest("#lgClear")) { table.clearFilters(); return; }
      if (e.target.closest("#lgStClear")) { stTable.clearFilters(); return; }
      if (e.target.closest("[data-open]")) { table.setFilter("open", ui.open.length ? [] : ["Has open ends"]); return; }
      const f = e.target.closest("[data-fill]"); if (f) { const want = f.dataset.fill; stTable.setFilter("fill", ui.fill.length === 1 && ui.fill[0] === want ? [] : [want]); return; }
      const tr = e.target.closest("tr[data-net]"); if (tr) { pick(tr.dataset.net); return; }
      const st = e.target.closest("tr[data-st]"); if (st) pickStorage(st.dataset.st);
    });
    Logistics.listeners.add(() => { emphasize(); render(); });   // a network's storage list can change
    Storage.listeners.add(render);
    inited = true;
  }

  return {
    show() { if (!inited) init(); Logistics.start(); Storage.start(); render(); setConn(true); },
    hide() {},
  };
})();
