// Belts tab and Pipes tab: one builder, two tabs. Each shows its networks (worked out by server.py from what every
// piece is plugged into) and the storage on that side - item storage (containers, boxes, Dimensional Depot
// uploaders, crates) with the belts, fluid buffers with the pipes - linked: picking a network lights up its storage
// and picking a storage lights up the networks into it. Beside one map, with pieces by tier under it, and the
// Dimensional Depot (belts) or the pumps (pipes). The Pipes tab also shows head lift: pipes higher than whatever
// pushes the fluid can reach.
"use strict";

function makeNetTab(kind) {
  const BELT = kind === "belt", P = BELT ? "bt" : "pp", tabName = BELT ? "belts" : "pipes";
  const root = $("tab-" + tabName), id = s => P + s;   // element ids: btNets, ppNets…
  const ui = (() => { const d = { open: [], fill: [], hl: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem(P + ".ui") || "{}") }; } catch { return d; } })();
  const saveUi = () => { try { localStorage.setItem(P + ".ui", JSON.stringify(ui)); } catch {} };
  for (const k of ["open", "fill", "hl"]) if (!Array.isArray(ui[k])) ui[k] = [];
  let table, stTable, map, picked = null, pickedSt = null, inited = false;

  const net = nid => Logistics.byId?.get(nid);
  const myNets = () => Logistics.networks.filter(n => n.kind === kind);
  const mySegs = () => BELT ? Logistics.belts : Logistics.pipes;
  const COLOR = BELT ? BELT_COLOR : PIPE_COLOR, TIERS = BELT ? [1, 2, 3, 4, 5, 6] : [1, 2];
  const noun = BELT ? "belt" : "pipe";
  const feeds = n => n.p && n.w ? "both" : n.p ? "production" : n.w ? "power" : "other";
  const FEEDS = { production: ["Production", "var(--s1)"], power: ["Power", "var(--s4)"], both: ["Both", "var(--s3)", "Feeds production machines and generators"], other: ["Other", "var(--muted)"] };
  const passes = n => !table || table.passes(n);   // the Networks table's column filters (the map follows them too)
  const km = m => m >= 1000 ? `${fmtNum(m / 1000, 1)} km` : `${fmtNum(m)} m`;
  const capText = n => n.cap ? `${fmtNum(n.cap)}${BELT ? "" : " m³"}/min` : "–";
  const tierText = n => Object.entries(n.tiers).sort().map(([t, c]) => `Mk.${t}${Object.keys(n.tiers).length > 1 ? ` ×${c}` : ""}`).join(" · ");

  // pipes: the fluid in each network (most of its pieces), worked out again when /logistics updates
  let fluidSrc = null, fluidOf = new Map();
  const fluid = n => {
    if (fluidSrc !== Logistics.pipes) {
      fluidSrc = Logistics.pipes; const cnt = new Map();
      for (const s of fluidSrc) if (s.fl) { const m = cnt.get(s.n) || cnt.set(s.n, new Map()).get(s.n); m.set(s.fl, (m.get(s.fl) || 0) + 1); }
      fluidOf = new Map([...cnt].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
    }
    return fluidOf.get(n.id) || "";
  };
  // pipes: head lift per network (server.py): its worst pipe run or pump
  const HL_VALUES = ["Too high", "Near limit", "OK"], HL_PROBLEMS = ["Too high", "Near limit"];
  const hlOf = n => HL_TEXT[n.hl] || "OK";

  // storage on this side
  const mine = s => BELT ? s.kind !== "fluid" : s.kind === "fluid";
  const myStorage = () => Storage.list.filter(mine);
  const FILLS = ["Empty", "Partly full", "Full"];
  const FILL_COLOR = { Empty: "var(--muted)", "Partly full": "var(--s1)", Full: "var(--warn)" };
  // an uploader always holds a stack or so; it's only stuck (full) when the depot can't take any more of its item
  const depotFull = s => { const i = s.items[0], c = i && Storage.cloud.find(x => x.name === i.name); return !!(c?.limit && c.amount >= c.limit); };
  const fillOf = s => !s.items.length ? "Empty" : s.kind === "crate" ? "Partly full" : (s.kind === "depot" ? depotFull(s) : s.frac >= (s.kind === "fluid" ? 0.98 : 0.999)) ? "Full" : "Partly full";
  const FLOWS = ["Filling", "Draining", "Idle"];
  const flowOf = s => s.fill - s.drain > 0.05 ? "Filling" : s.drain - s.fill > 0.05 ? "Draining" : "Idle";
  const stIcon = s => icon(STORAGE_TYPES[s.cls]?.[3] || s.type);
  const stPasses = s => !stTable || stTable.passes(s);
  const STORAGE_TYPES_HERE = () => STORAGE_ORDER.filter(t => (storageKind(t) === "fluid") !== BELT);

  // the links: storage id -> this tab's networks into it (rebuilt when /logistics updates)
  let linkSrc = null, stNets = new Map();
  const netsOf = sid => {
    if (linkSrc !== Logistics.networks) {
      linkSrc = Logistics.networks; stNets = new Map();
      for (const n of linkSrc) if (n.kind === kind) for (const x of n.st || []) (stNets.get(x) || stNets.set(x, []).get(x)).push(n);
    }
    return stNets.get(sid) || [];
  };
  const linkText = s => { const c = netsOf(s.id).length; return c ? `${c} ${noun}${c > 1 ? "s" : ""}` : ""; };
  const linkedSt = () => new Set(picked ? net(picked)?.st || [] : []);
  const linkedNets = () => new Set(pickedSt ? netsOf(pickedSt).map(n => n.id) : []);

  function emphasize() {   // on the map: the picked storage, or the picked network's storage, ringed; the rest fades
    const ids = pickedSt ? [pickedSt] : picked ? [...linkedSt()] : [];
    map.setEmphasis(ids.length ? new Map(ids.map(x => [x, "#fa9549"])) : null);
  }
  // select a network (row click or map click) or clear the selection (same one again, or id null).
  // fromMap: it's already in view where it was clicked, so the map doesn't move.
  function pick(nid, fromMap = false) {
    const n0 = nid && net(nid);
    if (n0 && n0.kind !== kind) return;   // a network of the other kind (can't happen: this map only draws its own)
    picked = nid && picked !== nid ? nid : null; pickedSt = null;
    emphasize(); render();
    const n = picked && net(picked);
    if (n) $(id("Store")).scrollTop = 0;   // its storage is pinned to the top of the other table
    if (n) scrollRowIntoView($(id("Nets")).querySelector(`tr[data-net="${CSS.escape(n.id)}"]`));
    if (fromMap) return;
    if (n) map.fitBox([worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])], 60, true); else map.fit();
  }
  // same for a storage: the map flies to it, its networks are drawn on top
  function pickStorage(sid, fromMap = false) {
    pickedSt = sid && pickedSt !== sid ? sid : null; picked = null;
    emphasize(); render();
    if (pickedSt) $(id("Nets")).scrollTop = 0;
    if (pickedSt) scrollRowIntoView($(id("Store")).querySelector(`tr[data-st="${CSS.escape(pickedSt)}"]`));
    if (fromMap) return;
    if (pickedSt) map.locate(pickedSt); else map.fit();
  }

  function tiles(nets, list) {
    const c = Logistics.counts || {}, segs = mySegs();
    const len = nets.reduce((a, n) => a + n.len, 0), open = nets.reduce((a, n) => a + n.open, 0);
    const full = list.filter(s => fillOf(s) === "Full").length, fullOn = ui.fill.length === 1 && ui.fill[0] === "Full";
    const openTile = `<div class="tile click${ui.open.length ? " on" : ""}" data-open title="Show only networks with an end that isn't connected to anything"><div class="t-label">Unconnected ends</div><div class="t-val">${fmtNum(open)}</div>
        <div class="t-sub">in ${nets.filter(n => n.open).length} networks · click to list them</div></div>`;
    const fullTile = (label, what) => `<div class="tile click${fullOn ? " on" : ""}" data-fill="Full" title="Show only ${what}"><div class="t-label">${label}</div><div class="t-val">${fmtNum(full)}</div><div class="t-sub">click to list them</div></div>`;
    if (BELT) {
      const boxes = list.filter(s => s.kind === "items" || s.kind === "box"), cloud = Storage.cloud;
      const slots = boxes.reduce((a, s) => a + s.slots, 0), used = boxes.reduce((a, s) => a + s.used, 0);
      const atLimit = cloud.filter(i => i.limit && i.amount >= i.limit).length, uploaders = list.filter(s => s.kind === "depot").length;
      return `
      <div class="tile"><div class="t-label">Conveyor belts</div><div class="t-val">${fmtNum(segs.length)}</div><div class="t-sub">${km(len)} in ${nets.length} networks</div></div>
      <div class="tile"><div class="t-label">Lifts, splitters &amp; mergers</div><div class="t-val">${fmtNum(Logistics.lifts.length)} <small>lifts</small></div><div class="t-sub">${fmtNum(c.splitters || 0)} splitters · ${fmtNum(c.mergers || 0)} mergers</div></div>
      ${openTile}
      <div class="tile"><div class="t-label">Storage containers &amp; boxes</div><div class="t-val">${fmtNum(boxes.length)}</div><div class="t-sub">${fmtNum(used)} of ${fmtNum(slots)} slots used${slots ? ` · ${Math.round(used / slots * 100)}%` : ""}</div></div>
      <div class="tile"><div class="t-label">Dimensional Depot</div><div class="t-val">${fmtNum(cloud.length)} <small>items</small></div><div class="t-sub">${fmtNum(uploaders)} uploaders${atLimit ? ` · ${atLimit} items at the limit` : ""}</div></div>
      ${fullTile("Full storage", "storage with every slot used")}`;
    }
    const hl = Logistics.headlift, runs = (hl?.runs || []).filter(r => r.sev !== "ok"), badPumps = (hl?.pumps || []).filter(p => p.sev !== "ok");
    const pumps = (hl?.pumps || []).filter(p => !p.valve), problems = runs.length + badPumps.length;
    const hlOn = ui.hl.length && ui.hl.every(v => HL_PROBLEMS.includes(v)), bad = runs.filter(r => r.sev === "bad").length + badPumps.length;
    const m3 = list.reduce((a, s) => a + s.content, 0), cap = list.reduce((a, s) => a + s.cap, 0);
    return `
      <div class="tile"><div class="t-label">Pipes</div><div class="t-val">${fmtNum(segs.length)}</div><div class="t-sub">${km(len)} in ${nets.length} networks · ${fmtNum(c.junctions || 0)} junctions</div></div>
      <div class="tile"><div class="t-label">Pumps &amp; valves</div><div class="t-val">${fmtNum(c.pumps || 0)} <small>pumps</small></div>
        <div class="t-sub">${fmtNum(c.valves || 0)} valves${hl ? ` · ${fmtNum(pumps.filter(p => p.flow > 0.5).length)} pumping · ${fmtNum(pumps.reduce((a, p) => a + p.mw, 0))} MW` : ""}</div></div>
      <div class="tile click${hlOn ? " on" : ""}${bad ? " bad" : problems ? " warn" : ""}" data-hl title="Pipes higher than their pump, extractor, machine or buffer can push the fluid — click to list those networks">
        <div class="t-label">Head lift problems</div><div class="t-val">${hl ? fmtNum(problems) : "–"}</div>
        <div class="t-sub">${!hl ? "needs the newer FRM build" : problems ? [runs.filter(r => r.sev === "bad").length && `${runs.filter(r => r.sev === "bad").length} too high`, runs.filter(r => r.sev === "warn").length && `${runs.filter(r => r.sev === "warn").length} near limit`, badPumps.length && `${badPumps.length} pump${badPumps.length > 1 ? "s" : ""} without power`].filter(Boolean).join(" · ") + " · click to list" : "every pipe within reach"}</div></div>
      ${openTile}
      <div class="tile"><div class="t-label">Fluid buffers</div><div class="t-val">${fmtNum(list.length)}</div><div class="t-sub">${Storage.hasBuffers ? `${fmtNum(m3)} of ${fmtNum(cap)} m³ stored` : "needs the newer FRM build"}</div></div>
      ${fullTile("Full buffers", "fluid buffers that are full")}`;
  }

  function under() {   // the two cards under the map
    const segs = mySegs();
    const rows = TIERS.filter(t => segs.some(b => b.t === t)).map(t => { const n = segs.filter(b => b.t === t).length;
      return { label: `<span class="with-icon"><i class="sw-line" style="background:${COLOR[t]}"></i>Mk.${t} ${noun}s</span>`, value: n, text: `<b>${fmtNum(n)}</b>`, color: COLOR[t] }; });
    if (BELT) for (const t of TIERS) { const n = Logistics.lifts.filter(l => l.t === t).length;
      if (n) rows.push({ value: n, text: `<b>${fmtNum(n)}</b>`, color: BELT_COLOR[t], label: `<span class="with-icon"><i class="sw-lift" style="background:${BELT_COLOR[t]}"></i>Mk.${t} lifts</span>` }); }
    hbars($(id("Tiers")), rows);
    if (BELT) {   // the depot: each item against its upload limit (bars are per item, since limits differ by stack size)
      const cloud = Storage.cloud;
      const depot = [...cloud].sort((a, b) => (b.limit ? b.amount / b.limit : 0) - (a.limit ? a.amount / a.limit : 0) || b.amount - a.amount || a.name.localeCompare(b.name));
      $(id("Side")).innerHTML = depot.map(i => { const f = i.limit ? Math.min(1, i.amount / i.limit) : null;
        return `<div class="hb"><div class="hb-label"><span class="with-icon">${icon(i.name, "icon sm")}${esc(i.name)}</span></div>
          <div class="hb-track"><i style="width:${(f ?? 1) * 100}%;background:${f != null && f >= 1 ? "var(--warn)" : STORAGE_COLOR.depot}"></i></div>
          <div class="hb-val"><b>${fmtNum(i.amount)}</b>${i.limit ? ` <span class="muted">/ ${fmtNum(i.limit)}</span>` : ""}</div></div>`; }).join("")
        || `<div class="muted">Nothing uploaded yet.</div>`;
      $(id("SideHint")).textContent = cloud.length ? `${cloud.length} items${cloud[0]?.limit ? " · stored / limit" : ""}` : "";
      return;
    }
    // pumps: each one's head-lift gauge (how hard it's pushing, of where its flow stops) and flow; click = show it on the map
    const pumps = (Logistics.headlift?.pumps || []).filter(p => !p.valve && (!picked || p.n === picked))
      .sort((a, b) => (b.hl || 0) / (b.max || 1) - (a.hl || 0) / (a.max || 1) || b.flow - a.flow);
    $(id("Side")).innerHTML = pumps.map(p => { const f = p.max ? Math.min(1, (p.hl || 0) / p.max) : 0;
      const col = !p.on ? "var(--bad)" : PIPE_COLOR[1];   // past its design isn't a warning: a full, backed-up line reads its max too
      return `<div class="hb click" data-pump="${esc(p.id)}" title="${esc(p.name)} · ${p.on ? `pushing ${fmtNum(p.hl, 1)} m of ${fmtNum(p.design)} m design (flow stops at ${fmtNum(p.max)} m)` : "no power"} · click to show it on the map">
        <div class="hb-label"><span class="with-icon">${icon(p.fluid || p.name, "icon sm")}${esc(p.name.replace("Pipeline Pump ", "Pump "))}</span></div>
        <div class="hb-track"><i style="width:${f * 100}%;background:${col}"></i></div>
        <div class="hb-val"><b>${p.on ? fmtNum(p.hl, 1) : "off"}</b> <span class="muted">/ ${fmtNum(p.design)} m · ${fmtRate(p.flow || 0)} m³/min</span></div></div>`; }).join("")
      || `<div class="muted">${Logistics.headlift ? (picked ? "No pumps on this network." : "No pumps.") : "Pumps need the newer FRM build."}</div>`;
    $(id("SideHint")).textContent = pumps.length ? "head lift now / design · flow" : "";
  }

  function render() {
    if (!inited) return;
    const nets = myNets(), list = myStorage();
    $(id("Tiles")).innerHTML = tiles(nets, list);
    under();
    if (nets.length) table.render(nets);
    if (Storage.loaded) stTable.render(list);
    $(id("Clear")).disabled = !table.hasFilters();
    $(id("Count")).textContent = `${table.filtered.length} of ${nets.length}` + (pickedSt ? ` · ${linkedNets().size} into the selected storage` : "");
    $(id("StClear")).disabled = !stTable.hasFilters();
    $(id("StCount")).textContent = `${stTable.filtered.length} of ${list.length}` + (picked ? ` · ${linkedSt().size} on the selected network` : "");
    const open = nets.reduce((a, n) => a + n.open, 0), full = list.filter(s => fillOf(s) === "Full").length;
    const hl = !BELT && Logistics.headlift, probs = hl ? hl.runs.filter(r => r.sev !== "ok").length + hl.pumps.filter(p => p.sev !== "ok").length : 0;
    const hlBad = hl && (hl.runs.some(r => r.sev === "bad") || hl.pumps.some(p => p.sev === "bad"));
    $(BELT ? "statsBelts" : "statsPipes").innerHTML = (nets.length ? `<span class="stat"><b>${km(nets.reduce((a, n) => a + n.len, 0))}</b>of ${noun}s</span>` : "") +
      (Storage.loaded ? `<span class="stat"><b>${fmtNum(list.length)}</b>${BELT ? "storage" : "fluid buffers"}</span>` : "") +
      (probs ? `<span class="stat" style="color:var(--${hlBad ? "bad" : "warn"})"><b>${probs}</b>head lift problems</span>` : "") +
      (open ? `<span class="stat" style="color:var(--warn)"><b>${open}</b>unconnected ends</span>` : "") +
      (full ? `<span class="stat" style="color:var(--warn)"><b>${full}</b>full ${BELT ? "storage" : "buffers"}</span>` : "");
    map.renderButtons(); map.draw();
  }

  function init() {
    root.classList.add("lg-tab");
    root.innerHTML = `
      <div class="tiles compact" id="${id("Tiles")}"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card lg-nets"><div class="card-head"><h2>${BELT ? "Belt" : "Pipe"} networks</h2><span class="hint" id="${id("Count")}"></span>
            <button class="b" id="${id("Clear")}">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="${id("Nets")}"></div></section>
          <section class="card lg-store"><div class="card-head"><h2>${BELT ? "Storage" : "Fluid buffers"}</h2><span class="hint" id="${id("StCount")}"></span>
            <button class="b" id="${id("StClear")}">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="${id("Store")}"></div></section>
        </div>
        <div class="pcol">
          <section class="card lg-map"><div id="${id("Map")}"></div></section>
          <div class="lg-row">
            <section class="card lg-tiers"><div class="card-head"><h2>By tier</h2><span class="hint">${BELT ? "pieces" : "pipe pieces"}</span></div><div class="card-body hbars" id="${id("Tiers")}"></div></section>
            <section class="card lg-side"><div class="card-head"><h2>${BELT ? "Dimensional Depot" : "Pumps"}</h2><span class="hint" id="${id("SideHint")}"></span></div><div class="card-body hbars" id="${id("Side")}"></div></section>
          </div>
        </div>
      </div>`;
    const cols = [
      ...(BELT ? [] : [{ key: "fluid", label: "Fluid", minW: 104, val: r => fluid(r) || "~",
        filter: { value: r => fluid(r) || "Empty", noun: "fluids", label: v => v === "Empty" ? v : icon(v, "icon sm") + esc(v) },
        cell: r => fluid(r) ? `<span class="with-icon">${icon(fluid(r), "icon sm")}${esc(fluid(r))}</span>` : `<span class="muted">empty</span>` }]),
      { key: "feeds", label: "Feeds", minW: 90, val: r => feeds(r),
        filter: { value: r => feeds(r), noun: "feeds", all: () => Object.entries(FEEDS).map(([k, [l, c]]) => ({ value: k, label: `<i class="sw" style="background:${c}"></i> ${l}` })) }, cell: r => { const [l, c, t] = FEEDS[feeds(r)]; return `<span class="pill" style="color:${c};background:color-mix(in srgb, ${c} 14%, transparent)"${t ? ` title="${t}"` : ""}>${l}</span>`; } },
      { key: "touches", label: "Connects", minW: BELT ? 140 : 120, title: "Buildings at the ends of this network, storage included",
        filter: { value: r => Object.keys(r.touches), noun: "buildings", label: v => icon(v, "icon sm") + esc(v) }, val: r => Object.keys(r.touches)[0] || "",
        cell: r => { const e = Object.entries(r.touches); return e.length ? e.slice(0, 3).map(([k, n]) => `${n} × ${esc(k)}`).join("<br>") + (e.length > 3 ? `<br><span class="muted sub">+${e.length - 3} more</span>` : "") : `<span class="muted">nothing found</span>`; } },
      { key: "len", label: "Length", num: true, minW: 74, val: r => r.len, cell: r => km(r.len) },
      { key: "segs", label: "Pieces", num: true, minW: 60, title: `${BELT ? "Belt" : "Pipe"} segments`, val: r => r.segs, cell: r => fmtNum(r.segs) },
      ...(BELT ? [{ key: "lifts", label: "Lifts", num: true, minW: 54, title: "Conveyor lifts in this network (belt pieces that go up or down)", val: r => r.lifts || 0,
        filter: { value: r => r.lifts ? "Has lifts" : "None", noun: "", all: () => [{ value: "Has lifts" }, { value: "None" }], ord: true },
        cell: r => r.lifts ? fmtNum(r.lifts) : `<span class="muted">0</span>` }] : []),
      { key: "tiers", label: "Tiers", minW: BELT ? 90 : 80, filter: { value: r => Object.keys(r.tiers), noun: "tiers", all: () => TIERS.map(t => ({ value: String(t), label: `<i class="sw-line" style="background:${COLOR[t]}"></i> Mk.${t} ${noun}s` })) },
        val: r => Math.min(...Object.keys(r.tiers).map(Number)), cell: r => esc(tierText(r)) },
      { key: "cap", label: "Bottleneck", num: true, minW: 96, filter: { value: r => capText(r), noun: "" }, title: "Most this network can carry: its slowest tier", val: r => r.cap || 0, cell: r => capText(r) },
      { key: "open", label: "Open ends", num: true, minW: BELT ? 80 : 72,
        filter: { value: r => r.open ? "Has open ends" : "None", noun: "", get: () => ui.open, set: v => { ui.open = v; saveUi(); },
                  all: () => [{ value: "Has open ends" }, { value: "None" }] }, title: "Ends not connected to anything", val: r => r.open, cell: r => r.open ? `<span class="warn-text">${r.open}</span>` : `<span class="muted">0</span>` },
      ...(BELT ? [] : [{ key: "hl", label: "Head lift", minW: 84, title: "Can the pumps, extractors, machines and buffers push the fluid up to every pipe? (hover the map's ⚠ for details)",
        val: r => ({ bad: 2, warn: 1 }[r.hl] || 0),
        filter: { value: hlOf, noun: "", get: () => ui.hl, set: v => { ui.hl = v; saveUi(); },
                  all: () => HL_VALUES.map(v => ({ value: v, label: `<i class="sw" style="background:${{ "Too high": "var(--bad)", "Near limit": "var(--warn)", OK: "var(--ok)" }[v]}"></i> ${v}` })), ord: true },
        cell: r => !Logistics.headlift ? `<span class="muted">?</span>` : r.hl === "bad" ? `<span class="bad-text">Too high</span>` : r.hl === "warn" ? `<span class="warn-text">Near limit</span>` : `<span class="muted">OK</span>` }]),
    ];
    table = new DataTable($(id("Nets")), cols, { sortKey: "len", dir: -1, storeKey: P + ".sort", onFilter: () => { render(); map.fit(); },
         pin: r => pickedSt && linkedNets().has(r.id) ? 0 : 1,
         rowAttrs: r => `data-net="${esc(r.id)}" class="${r.id === picked ? "sel" : pickedSt && linkedNets().has(r.id) ? "link" : ""}"` });
    stTable = new DataTable($(id("Store")), [
      { key: "type", label: BELT ? "Storage" : "Buffer", minW: 150, val: r => STORAGE_ORDER.indexOf(r.type) + 1 || 99,
        filter: { value: r => r.type, noun: "types", label: v => icon(STORAGE_TYPES[Object.keys(STORAGE_TYPES).find(k => STORAGE_TYPES[k][0] === v)]?.[3] || v, "icon sm") + esc(v),
                  all: () => [...STORAGE_TYPES_HERE(), ...new Set(myStorage().map(s => s.type).filter(t => !STORAGE_ORDER.includes(t)))].map(v => ({ value: v })), ord: true },
        cell: r => `<span class="with-icon">${stIcon(r)}${esc(r.type)}</span>` },
      { key: "items", label: "Contents", minW: 170, val: r => r.items[0]?.name || "~",
        filter: { value: r => r.items.map(i => i.name), noun: BELT ? "items" : "fluids", label: v => icon(v, "icon sm") + esc(v) },
        cell: r => r.items.length ? r.items.slice(0, 3).map(i => `<span class="with-icon">${icon(i.name, "icon sm")}${fmtNum(i.amount, i.fluid ? 1 : 0)}${i.fluid ? " m³" : ""} ${esc(i.name)}</span>`).join("<br>") +
                   (r.items.length > 3 ? `<br><span class="muted sub">+${r.items.length - 3} more</span>` : "") : `<span class="muted">empty</span>` },
      { key: "fill", label: "Fill", num: true, minW: 104, title: BELT ? "Slots used" : "How much of the tank is full", val: r => r.kind === "crate" ? -1 : r.frac,
        filter: { value: fillOf, noun: "", get: () => ui.fill, set: v => { ui.fill = v; saveUi(); },
                  all: () => FILLS.map(v => ({ value: v, label: `<i class="sw" style="background:${FILL_COLOR[v]}"></i> ${v}` })), ord: true },
        cell: r => r.kind === "crate" ? `<span class="muted">–</span>` : `<span class="nowrap">${bar(r.frac, fillOf(r) === "Full" ? "var(--warn)" : "var(--s1)")} ${Math.round(r.frac * 100)}%</span>` },
      { key: "stored", label: "Stored", num: true, minW: 120, val: r => BELT ? r.used : r.content,
        filter: { text: r => storageFill(r), placeholder: BELT ? "e.g. slots" : "e.g. m³" }, cell: r => storageFill(r) },
      ...(BELT ? [] : [{ key: "flow", label: "Flow", num: true, minW: 120, title: "Filling / draining, m³ per minute", val: r => r.fill - r.drain,
        filter: { value: flowOf, noun: "", all: () => FLOWS.map(v => ({ value: v })), ord: true },
        cell: r => r.fill < 0.05 && r.drain < 0.05 ? `<span class="muted">idle</span>`
          : `<span class="nowrap"><span style="color:var(--ok)">+${fmtRate(r.fill)}</span> <span class="muted">/</span> <span style="color:var(--warn)">−${fmtRate(r.drain)}</span></span>` }]),
      { key: "links", label: BELT ? "Belts" : "Pipes", minW: 90, title: `${BELT ? "Belt" : "Pipe"} networks into or out of it`, val: r => netsOf(r.id).length,
        filter: { value: r => netsOf(r.id).length ? "Connected" : "Not connected", noun: "", all: () => ["Connected", "Not connected"].map(v => ({ value: v })), ord: true },
        cell: r => linkText(r) || `<span class="muted">none found</span>` },
    ], { sortKey: "type", dir: 1, storeKey: P + ".st", empty: BELT ? "No storage found." : "No fluid buffers found.",
         onFilter: () => { Storage.push(map); render(); map.fit(); },   // storage points are pushed to the map, not drawn live
         pin: r => picked && linkedSt().has(r.id) ? 0 : 1,
         rowAttrs: r => `data-st="${esc(r.id)}" class="${r.id === pickedSt ? "sel" : picked && linkedSt().has(r.id) ? "link" : ""}"` });
    map = new MapView($(id("Map")), {
      storeKey: P + ".map", layerMenu: true, players: true, hypertubes: () => true, layers: [], only: kind,
      logistics: b => { const n = net(b.n); return !!n && n.kind === kind && passes(n); },   // the map follows both tables' filters
      storage: s => mine(s) && stPasses(s),
      highlight: () => picked || (pickedSt ? [...linkedNets()] : null),
      hint: `hover a ${noun}${BELT ? "" : ", pump"} or ${BELT ? "storage" : "buffer"} to see it · click it (or a row) to select it and what it connects to`,
      onNetClick: nid => { if (nid) pick(nid, true); else if (picked) pick(null, true); else if (pickedSt) pickStorage(null, true); },   // empty map = clear
      onClick: p => { if (p.storage) pickStorage(p.storage, true); else if (p.net && net(p.net)) pick(p.net, true); else if (p.pump?.n) pick(p.pump.n, true); },
      onNetHover: nid => {   // map hover -> the row lights up and scrolls into view
        for (const tr of $(id("Nets")).querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = nid && $(id("Nets")).querySelector(`tr[data-net="${CSS.escape(nid)}"]`);
        if (tr) { tr.classList.add("hl"); scrollRowIntoView(tr); }
      },
      onHover: p => {
        for (const tr of $(id("Store")).querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = p?.storage && $(id("Store")).querySelector(`tr[data-st="${CSS.escape(p.storage)}"]`);
        if (tr) { tr.classList.add("hl"); scrollRowIntoView(tr); }
      },
      // Fit frames what the two tables show
      fitTo: () => [...myNets().filter(n => passes(n)).flatMap(n => [worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])]),
                    ...myStorage().filter(stPasses).map(s => worldToImg(s.loc.x, s.loc.y))],
    });

    root.addEventListener("click", e => {
      if (e.target.closest("#" + id("Clear"))) { table.clearFilters(); return; }
      if (e.target.closest("#" + id("StClear"))) { stTable.clearFilters(); return; }
      if (e.target.closest("[data-open]")) { table.setFilter("open", ui.open.length ? [] : ["Has open ends"]); return; }
      if (e.target.closest("[data-hl]")) { table.setFilter("hl", ui.hl.length ? [] : HL_PROBLEMS); return; }
      const f = e.target.closest("[data-fill]"); if (f) { const want = f.dataset.fill; stTable.setFilter("fill", ui.fill.length === 1 && ui.fill[0] === want ? [] : [want]); return; }
      const pu = e.target.closest("[data-pump]"); if (pu) { map.locate(pu.dataset.pump); return; }
      const tr = e.target.closest("tr[data-net]"); if (tr) { pick(tr.dataset.net); return; }
      const st = e.target.closest("tr[data-st]"); if (st) pickStorage(st.dataset.st);
    });
    Logistics.listeners.add(() => { if (activeTab === tabName) { emphasize(); render(); } });   // a network's storage list can change
    Storage.listeners.add(() => { if (activeTab === tabName) render(); });
    inited = true;
  }

  return {
    show() { if (!inited) init(); Logistics.start(); Storage.start(); emphasize(); render(); setConn(true); },
    hide() {},
  };
}
const BeltsTab = makeNetTab("belt"), PipesTab = makeNetTab("pipe");
