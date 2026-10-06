// Production tab: every machine (manufacturers + extractors), what each item's factory-wide production
// and consumption is, and how that changed over time (history recorded by server.py).
"use strict";

const Production = (() => {
  const POLL_MS = 5000;
  const RANGES = [["10m", 10], ["1h", 60], ["6h", 360], ["24h", 1440]];
  // machine states, worst first; colours are status colours (each always shown with its label)
  const M_STATUS = {
    nopower: { label: "No power", color: "var(--bad)", title: "Fuse tripped or not connected to a grid" },
    starved: { label: "Starved", color: "var(--serious)", title: "Stopped: waiting for input" },
    full:    { label: "Output full", color: "var(--info)", title: "Stopped: output is backed up" },
    partial: { label: "Partial", color: "var(--warn)", title: "Running, but below 90% productivity (input arrives too slowly or output backs up now and then)" },
    running: { label: "Running", color: "var(--ok)", title: "Running at 90% productivity or more" },
    paused:  { label: "Paused", color: "var(--muted)", title: "Switched off (standby)" },
    norecipe:{ label: "No recipe", color: "var(--muted)", title: "No recipe set" },
  };
  const WASTE = { "Uranium Fuel Rod": ["Uranium Waste", 50], "Plutonium Fuel Rod": ["Plutonium Waste", 10] };

  let machines = [], items = new Map(), loaded = false, timer = null;
  let selected = "";   // the item clicked in the Items table (details + highlighted machines); "" = none
  const ui = (() => { const d = { mode: "all", range: 60, bld: [], st: [], items: [], q: "" };
    try { return { ...d, ...JSON.parse(localStorage.getItem("pt.ui") || "{}") }; } catch { return d; } })();
  const saveUi = () => { try { localStorage.setItem("pt.ui", JSON.stringify(ui)); } catch {} };
  let itemTable, machineTable, chart, map, selMachine = null, itemPick, bldPick;
  let focusItem = null;   // item clicked in the Items table: its machines are highlighted (click again to clear)
  const relation = m => !focusItem ? null : m.outputs.some(o => o.name === focusItem) ? "make" : m.inputs.some(i => i.name === focusItem) ? "use" : null;
  // every production machine / extractor in the game, for the Building filter (ones you haven't built are greyed out)
  const GAME_BUILDINGS = ["Smelter", "Foundry", "Constructor", "Assembler", "Manufacturer", "Refinery", "Packager", "Blender",
    "Particle Accelerator", "Converter", "Quantum Encoder", "Miner Mk.1", "Miner Mk.2", "Miner Mk.3", "Water Extractor",
    "Oil Extractor", "Resource Well Extractor"];
  const root = $("tab-production");

  // ---- data -----------------------------------------------------------------------------
  const energy = name => gameItems.find(i => i.name === name)?.energy;
  const isFluid = name => fluidSet.has(name);
  const unitOf = name => isFluid(name) ? "m³/min" : "/min";

  function machineStatus(m, prod) {
    if (!m.IsConfigured) return "norecipe";
    if (m.IsPaused) return "paused";
    if (m.PowerInfo?.FuseTriggered || m.PowerInfo?.CircuitID === -1) return "nopower";
    if (m.IsProducing) return m.eff >= 90 ? "running" : "partial";
    const out = (m.OutputInventory?.length ? m.OutputInventory : prod) || [];
    if (out.some(o => o.MaxAmount > 0 && o.Amount >= o.MaxAmount * 0.9)) return "full";
    // between cycles while waiting for input: only "starved" if it has barely produced lately (productivity is a moving average)
    return m.eff >= 10 ? "partial" : "starved";
  }
  function fromMachine(m, extractor) {
    const outputs = (m.production || []).map(p => ({ name: p.Name, cur: p.CurrentProd || 0, max: p.MaxProd || 0 }));
    const inputs = (m.ingredients || []).map(p => ({ name: p.Name, cur: p.CurrentConsumed || 0, max: p.MaxConsumed || 0 }));
    const eff = m.Productivity ?? m.production?.[0]?.ProdPercent ?? 0;
    const o = { id: m.ID, building: m.Name, recipe: m.Recipe || "", extractor, outputs, inputs, eff,
      clock: m.ManuSpeed ?? 100, shards: m.PowerShards || 0, sloops: m.Somersloops || 0,
      mw: m.PowerInfo?.PowerConsumed || 0, maxMw: m.PowerInfo?.MaxPowerConsumed || 0, circuit: m.PowerInfo?.CircuitGroupID,
      inv: { in: m.InputInventory || [], out: m.OutputInventory || (extractor ? m.production : []) || [] }, loc: m.location };
    o.status = machineStatus({ ...m, eff }, m.production);
    if (o.status !== "running" && o.status !== "partial") o.eff = m.IsConfigured && !m.IsPaused ? eff : 0;
    return o;
  }

  function aggregate(machines, gens) {
    const map = new Map();
    const get = name => {
      if (!map.has(name)) map.set(name, { id: name, name, fluid: isFluid(name), prod: 0, cons: 0, maxProd: 0, maxCons: 0, producers: new Map(), consumers: new Map() });
      return map.get(name);
    };
    const group = (g, key, building, recipe, cur, max) => {
      const e = g.get(key) || { building, recipe, n: 0, cur: 0, max: 0 };
      e.n++; e.cur += cur; e.max += max; g.set(key, e);
    };
    for (const m of machines) {
      for (const o of m.outputs) { const it = get(o.name); it.prod += o.cur; it.maxProd += o.max; group(it.producers, m.building + "|" + m.recipe, m.building, m.recipe, o.cur, o.max); }
      for (const i of m.inputs) { const it = get(i.name); it.cons += i.cur; it.maxCons += i.max; group(it.consumers, m.building + "|" + m.recipe, m.building, m.recipe, i.cur, i.max); }
    }
    // generators burn fuel (and coal/nuclear ones drink water); same maths as server.py
    for (const g of gens) {
      const mw = g.RegulatedDemandProd || 0, cap = g.ProductionCapacity || 0;
      const fuel = (g.FuelInventory || []).find(f => f.Amount > 0 && energy(f.Name));
      if (fuel) {
        const e = energy(fuel.Name), rate = mw * 60 / e, max = cap * 60 / e, it = get(fuel.Name);
        it.cons += rate; it.maxCons += max; group(it.consumers, g.Name + "|fuel", g.Name, "fuel", rate, max);
        if (WASTE[fuel.Name]) {
          const [w, per] = WASTE[fuel.Name], wt = get(w);
          wt.prod += rate * per; wt.maxProd += max * per; group(wt.producers, g.Name + "|waste", g.Name, "spent fuel", rate * per, max * per);
        }
      }
      const s = g.Supplement;
      if (s && s.Name && s.Name !== "N/A" && (s.MaxConsumed || s.CurrentConsumed)) {
        const it = get(s.Name); it.cons += s.CurrentConsumed || 0; it.maxCons += s.MaxConsumed || 0;
        group(it.consumers, g.Name + "|supplement", g.Name, "cooling", s.CurrentConsumed || 0, s.MaxConsumed || 0);
      }
    }
    for (const it of map.values()) it.net = it.prod - it.cons;
    return map;
  }

  async function poll() {
    try {
      ({ machines, items } = await snapshot());
      loaded = true;
      setConn(true);
      render();
    } catch (e) { setConn(false, e.message); }
  }

  // machines + per-item totals, also used by the Overview tab
  async function snapshot() {
    const [fac, ext, gens] = await Promise.all([getJSON("getFactory"), getJSON("getExtractor"), getJSON("getGenerators").catch(() => [])]);
    const ms = fac.map(m => fromMachine(m, false)).concat(ext.map(m => fromMachine(m, true)));
    return { machines: ms, items: aggregate(ms, gens), gens };
  }
  const isShort = it => it.net < -Math.max(0.01, it.prod * 0.015);
  const count = groups => [...groups.values()].reduce((a, g) => a + g.n, 0);

  async function pollHistory() {
    if (!selected) { chart.emptyText = "Click an item to see its history and machines."; return chart.update(null); }
    chart.emptyText = "No history yet — the server records it while it runs.";
    try {
      const range = ui.range, item = selected;
      const h = await (await fetch(`/hist/production?mins=${range}`, { cache: "no-store" })).json();
      if (range !== ui.range || item !== selected) return;   // a newer request replaced this one
      const it = h.items[selected];
      const zeros = h.t.map(() => 0);
      chart.unit = unitOf(selected);
      chart.update({ t: h.t, interval: h.interval, series: [
        { key: "p", name: "Produced", color: "var(--s1)", values: it ? it.p : zeros },
        { key: "c", name: "Consumed", color: "var(--s2)", values: it ? it.c : zeros },
      ] });
    } catch { /* keep the last chart */ }
  }

  // ---- render ----------------------------------------------------------------------------
  const statusPill = s => `<span class="pill" style="color:${M_STATUS[s].color};background:color-mix(in srgb, ${M_STATUS[s].color} 14%, transparent)" title="${M_STATUS[s].title}">${M_STATUS[s].label}</span>`;
  const rateCell = (v, name) => `${fmtRate(v)}${isFluid(name) ? ` <span class="muted u">m³</span>` : ""}`;
  const netCell = it => {
    const v = it.net, eps = Math.max(0.01, it.prod * 0.015);
    if (Math.abs(v) < eps) return `<span class="muted">0</span>`;
    return `<span style="color:${v > 0 ? "var(--ok)" : "var(--bad)"}">${v > 0 ? "+" : "−"}${fmtRate(Math.abs(v))}</span>`;
  };

  function visibleItems() {
    const q = ui.q.trim().toLowerCase();
    return [...items.values()].filter(it =>
      (ui.mode === "all" || (ui.mode === "short" && it.net < -Math.max(0.01, it.prod * 0.015)) || (ui.mode === "fluid" && it.fluid) || (ui.mode === "solid" && !it.fluid))
      && (!ui.items.length || ui.items.includes(it.name))
      && (!q || it.name.toLowerCase().includes(q)));
  }
  function visibleMachines() {
    const q = ui.q.trim().toLowerCase();
    return machines.filter(m => (!ui.bld.length || ui.bld.includes(m.building)) && (!ui.st.length || ui.st.includes(m.status))
      && (!q || [m.building, m.recipe, ...m.outputs.map(o => o.name), ...m.inputs.map(i => i.name)].some(s => s.toLowerCase().includes(q))));
  }

  // Summary tiles double as filters: clicking a tile (or a count inside one) filters or sorts the tables below;
  // a tile whose filter is active is highlighted, and clicking it again clears it.
  const STOPPED = ["starved", "full", "nopower", "paused", "norecipe"];
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const bldsOf = extractor => [...new Set(machines.filter(m => m.extractor === extractor).map(m => m.building))].sort();
  const statusAct = list => ({ on: () => sameSet(ui.st, list()), run: on => { ui.st = on ? [] : list(); } });
  const bldAct = extractor => ({ on: () => ui.bld.length > 0 && sameSet(ui.bld, bldsOf(extractor)), run: on => { ui.bld = on ? [] : bldsOf(extractor); } });
  const sortAct = (key, dir) => ({ on: () => machineTable.sort.key === key && machineTable.sort.dir === dir,
                                   run: on => { machineTable.sort = on ? { key: "status", dir: 1 } : { key, dir }; } });
  const TILE_ACTS = {
    // "Machines" is a reset, so it's never shown as active
    all: { on: () => false, run: () => { ui.st = []; ui.bld = []; selected = ""; focusItem = null; ui.mode = "all"; pollHistory(); } },
    production: bldAct(false), extractors: bldAct(true),
    working: statusAct(() => ["running", "partial"]), partial: statusAct(() => ["partial"]),
    stopped: statusAct(() => STOPPED),
    ...Object.fromEntries(STOPPED.map(k => [k, statusAct(() => [k])])),
    eff: sortAct("eff", 1), mw: sortAct("mw", -1),
    short: { on: () => ui.mode === "short", run: on => { ui.mode = on ? "all" : "short"; } },
  };
  function tileAction(act) {
    const a = TILE_ACTS[act]; if (!a) return;
    a.run(a.on());
    if (act === "all") machineTable.sort = { key: "status", dir: 1 };
    saveUi(); render();
    $(act === "short" ? "pItems" : "pMachines").scrollTop = 0;
    if (!["short", "eff", "mw"].includes(act)) map.fit();   // frame the machines the filter left on the map
  }
  const tileOn = act => TILE_ACTS[act].on() ? " on" : "";
  const tl = (act, text, title) => `<span class="tl${tileOn(act)}" data-act="${act}" title="${esc(title)}">${text}</span>`;

  function renderTiles() {
    const counts = {}; for (const k in M_STATUS) counts[k] = 0;
    machines.forEach(m => counts[m.status]++);
    const active = counts.running + counts.partial, configured = machines.filter(m => m.status !== "norecipe" && m.status !== "paused");
    const avgEff = configured.length ? configured.reduce((a, m) => a + m.eff, 0) / configured.length : 0;
    const mw = machines.reduce((a, m) => a + m.mw, 0);
    const shorts = [...items.values()].filter(it => it.net < -Math.max(0.01, it.prod * 0.015)).length;
    const idle = STOPPED.filter(k => counts[k]).map(k => tl(k, `${counts[k]} ${M_STATUS[k].label.toLowerCase()}`, `Show only ${M_STATUS[k].label.toLowerCase()} machines`)).join(" · ");
    const tile = (act, title, body) => `<div class="tile click${tileOn(act)}" data-act="${act}" title="${esc(title)}">${body}</div>`;
    $("pTiles").innerHTML =
      tile("all", "Show all machines (clear filters)", `<div class="t-label">Machines</div><div class="t-val">${fmtNum(machines.length)}</div>
        <div class="t-sub">${tl("production", `${fmtNum(machines.filter(m => !m.extractor).length)} production`, "Show only production machines")} · ${tl("extractors", `${fmtNum(machines.filter(m => m.extractor).length)} extractors`, "Show only extractors")}</div>`) +
      tile("working", "Show machines that are running", `<div class="t-label">Working</div><div class="t-val">${fmtNum(active)} <small>${pct(active / Math.max(1, machines.length) * 100)}</small></div>
        <div class="t-sub">${tl("partial", `${counts.partial} below 90% productivity`, "Show only machines below 90% productivity")}</div>`) +
      tile("stopped", "Show machines that are stopped", `<div class="t-label">Stopped</div><div class="t-val">${fmtNum(machines.length - active)}</div><div class="t-sub">${idle || "none"}</div>`) +
      tile("eff", "Sort machines by productivity, lowest first (average of machines that have a recipe and aren't paused)",
        `<div class="t-label">Average productivity</div><div class="t-val">${pct(avgEff)}</div><div class="t-sub">${bar(avgEff / 100, "var(--s1)")}across active machines</div>`) +
      tile("mw", "Sort machines by power draw, highest first", `<div class="t-label">Power draw</div><div class="t-val">${fmtNum(mw)} <small>MW</small></div><div class="t-sub">machines and extractors</div>`) +
      tile("short", "Show only items in shortfall", `<div class="t-label">Items in shortfall</div><div class="t-val">${shorts} <small>of ${items.size}</small></div><div class="t-sub">consumed faster than produced</div>`);
    $("statsProd").innerHTML = `<span class="stat"><b>${machines.length}</b>machines</span><span class="stat" style="color:var(--ok)"><b>${active}</b>working</span>` +
      `<span class="stat muted"><b>${machines.length - active}</b>stopped</span><span class="stat"><b>${pct(avgEff)}</b>avg productivity</span>`;
  }


  // machine status views for the toolbar's Machines control (each is a set of statuses; the tiles select these too)
  const statusViews = () => {
    const sc = {}; machines.forEach(m => sc[m.status] = (sc[m.status] || 0) + 1);
    const n = list => list.reduce((a, k) => a + (sc[k] || 0), 0);
    return [
      { v: "all", label: "All", st: [], n: machines.length, title: "Every machine" },
      { v: "working", label: "Working", st: ["running", "partial"], title: "Running or partly running" },
      { v: "partial", label: "Below 90%", st: ["partial"], dot: M_STATUS.partial.color, title: M_STATUS.partial.title },
      { v: "stopped", label: "Stopped", st: STOPPED, title: "Not producing, for any reason" },
      ...STOPPED.filter(k => sc[k]).map(k => ({ v: k, label: M_STATUS[k].label, st: [k], dot: M_STATUS[k].color, title: M_STATUS[k].title })),
    ].map(o => ({ ...o, n: o.n ?? n(o.st) }));
  };
  const seg = segControl;

  function renderChips() {
    const short = [...items.values()].filter(isShort).length;
    const modes = [{ v: "all", label: "All" }, { v: "short", label: "Shortfalls", n: short, dot: short ? "var(--bad)" : null, title: "Consumed faster than produced" },
                   { v: "solid", label: "Solids" }, { v: "fluid", label: "Fluids" }];
    setSeg($("pModes"), seg("mode", modes, o => ui.mode === o.v));
    setSeg($("pStSeg"), seg("view", statusViews(), o => sameSet(ui.st, o.st)));
    setSeg($("pRange"), seg("range", RANGES.map(([l, v]) => ({ v, label: l })), o => ui.range === o.v));
    itemPick.refresh(); bldPick.refresh();
    $("pClear").disabled = !(ui.bld.length || ui.st.length || focusItem);
  }

  function renderDetail() {
    const it = items.get(selected);
    $("pDetailTitle").innerHTML = selected ? `${icon(selected)}<span>${esc(selected)}</span>` : "Item details";
    if (!it) { $("pDetailBody").innerHTML = `<p class="muted">${selected ? `No machine makes or uses ${esc(selected)} right now.` : "Click an item in the Items table to see where it's made and used, and to highlight those machines."}</p>`; return; }
    const u = unitOf(it.name);
    const lines = (g, verb) => {
      const rows = [...g.values()].sort((a, b) => b.cur - a.cur);
      if (!rows.length) return `<p class="muted">Nothing ${verb} it.</p>`;
      return `<div class="glist">${rows.map(r => `<div class="g">${icon(r.building, "icon sm")}<span class="g-name">${r.n} × ${esc(r.building)}${r.recipe && r.recipe !== it.name ? ` <span class="muted">· ${esc(r.recipe)}</span>` : ""}</span>
        <span class="g-val"><b>${fmtRate(r.cur)}</b> <span class="muted">/ ${fmtRate(r.max)} ${u}</span></span></div>`).join("")}</div>`;
    };
    $("pDetailBody").innerHTML = `
      <div class="kv"><div><span class="muted">Producing</span><b>${fmtRate(it.prod)}</b> <span class="muted">${u}</span></div>
        <div><span class="muted">Consuming</span><b>${fmtRate(it.cons)}</b> <span class="muted">${u}</span></div>
        <div><span class="muted">Net</span><b>${netCell(it)}</b> <span class="muted">${u}</span></div>
        <div><span class="muted">Capacity</span><b>${fmtRate(it.maxProd)}</b> <span class="muted">${u}</span></div></div>
      <div class="detail-lists"><div><h3>Made by</h3>${lines(it.producers, "makes")}</div><div><h3>Used by</h3>${lines(it.consumers, "uses")}</div></div>`;
  }

  function render() {
    if (!loaded) return;
    renderTiles(); renderChips();
    itemTable.render(visibleItems());
    const vm = visibleMachines();
    machineTable.body.classList.toggle("focus", !!focusItem);
    machineTable.render(vm);
    const mk = vm.filter(m => relation(m) === "make").length, us = vm.filter(m => relation(m) === "use").length;
    $("pMachCount").textContent = `${vm.length} of ${machines.length}`;
    $("pFocus").innerHTML = focusItem ? `<span class="key make"></span>${mk} make · <span class="key use"></span>${us} use ${icon(focusItem, "icon sm")}<b>${esc(focusItem)}</b>
      <span class="muted">— listed first and highlighted on the map</span> <button class="b" id="pUnfocus">Clear highlight</button>` : "";
    const byType = new Map(map.layers.filter(l => l.key.startsWith("b:")).map(l => [l.key, []]));
    for (const m of vm) if (m.loc) {
      const key = byType.has("b:" + m.building) ? "b:" + m.building : "b:Other";
      byType.get(key).push({ id: m.id, x: m.loc.x, y: m.loc.y, color: M_STATUS[m.status].color,
        label: `${m.building}${m.recipe ? " · " + m.recipe : ""} · ${M_STATUS[m.status].label}` });
    }
    for (const [key, pts] of byType) map.setPoints(key, pts);
    map.setEmphasis(focusItem ? new Map(vm.filter(relation).map(m => [m.id, relation(m) === "make" ? "var(--s1)" : "var(--s2)"])) : null);
    renderDetail();
  }

  // clicking an item row selects it (details, history) and highlights its machines; clicking it again clears
  // all of that, including the row's own highlight, and the map zooms back out to every machine shown
  function focus(name) {
    const off = selected === name;
    selected = focusItem = off ? "" : name;
    render(); pollHistory();
    if (off) map.fit(); else { map.fitEmphasis(); $("pMachines").scrollTop = 0; }
  }
  function unfocus() { if (selected) focus(selected); }

  const machinePop = m => `<div class="head">${esc(m.building)} ${esc(shortId(m.id))}${m.recipe ? " · " + esc(m.recipe) : ""} · ${M_STATUS[m.status].label} · ${pct(m.eff)} productive<br>` +
    `clock ${pct(m.clock)}${m.shards ? ` · ${m.shards} power shard${m.shards > 1 ? "s" : ""}` : ""}${m.sloops ? ` · ${m.sloops} Somersloop${m.sloops > 1 ? "s" : ""}` : ""} · ${fmtNum(m.mw, 1)} MW now, ${fmtNum(m.maxMw, 1)} MW max</div>` +
    (m.inv.in.length ? popSection("Input") + invRows(m.inv.in) : "") + popSection("Output") + invRows(m.inv.out);

  // ---- markup + events -----------------------------------------------------------------------
  function init() {
    root.innerHTML = `
      <div class="toolbar">
        <input class="f-input search" id="pSearch" placeholder="Search items, recipes, buildings…" value="${esc(ui.q)}">
        <div class="seg-group"><span class="lbl">Items</span><span id="pModes"></span></div>
        <div class="seg-group"><span class="lbl">Machines</span><span id="pStSeg"></span></div>
        <div class="seg-group right"><span class="lbl">History</span><span id="pRange"></span></div>
      </div>
      <div class="tiles compact" id="pTiles"></div>
      <!-- left: the two tables (items, machines); right: a big map with the item details under it -->
      <div class="pgrid">
        <div class="pcol">
          <section class="card p-items"><div class="card-head"><h2>Items</h2><button class="f-multi pick" id="pItemSel"></button>
            <span class="hint">per minute, fluids in m³ · click an item for its details and machines</span></div>
            <div class="table-wrap dtw" id="pItems"></div></section>
          <section class="card p-mach"><div class="card-head"><h2>Machines</h2><span class="hint" id="pMachCount"></span>
              <button class="f-multi pick" id="pBldSel"></button>
              <button class="b" id="pClear">Clear filters</button></div>
            <div class="focus-bar" id="pFocus"></div>
            <div class="table-wrap dtw tall" id="pMachines"></div></section>
        </div>
        <div class="pcol">
          <section class="card p-map"><div id="pMap"></div></section>
          <section class="card p-detail"><div class="card-head"><h2 id="pDetailTitle" class="with-icon"></h2></div>
            <div class="detail-grid"><div id="pChart"></div><div id="pDetailBody"></div></div></section>
        </div>
      </div>`;

    itemTable = new DataTable($("pItems"), [
      { key: "name", label: "Item", minW: 140, val: r => r.name, cell: r => `<span class="with-icon">${icon(r.name)}${esc(r.name)}</span>` },
      { key: "prod", label: "Producing", minW: 96, title: "Produced per minute right now, by all machines", num: true, val: r => r.prod, cell: r => rateCell(r.prod, r.name) },
      { key: "cons", label: "Consuming", minW: 100, title: "Consumed per minute right now, by machines and generators (fuel, water)", num: true, val: r => r.cons, cell: r => rateCell(r.cons, r.name) },
      { key: "net", label: "Net", minW: 58, title: "Producing − consuming, per minute (red = used faster than made)", num: true, val: r => r.net, cell: netCell },
      { key: "cap", label: "Capacity", minW: 86, title: "What the machines making it could produce per minute at 100% productivity; underneath, how much of that is in use", num: true,
        val: r => r.maxProd, cell: r => r.maxProd ? `${rateCell(r.maxProd, r.name)}<br><span class="muted sub">${pct(r.prod / r.maxProd * 100)} in use</span>` : `<span class="muted">–</span>` },
      { key: "np", label: "Producers", minW: 90, title: "Number of machines making it", num: true, val: r => count(r.producers), cell: r => count(r.producers) || `<span class="muted">0</span>` },
      { key: "nc", label: "Consumers", minW: 94, title: "Number of machines and generators using it", num: true, val: r => count(r.consumers), cell: r => count(r.consumers) || `<span class="muted">0</span>` },
    ], { sortKey: "prod", dir: -1, storeKey: "pt.itemSort", rowAttrs: r => `data-item="${esc(r.name)}" class="${r.name === selected ? "sel" : ""}"` });

    machineTable = new DataTable($("pMachines"), [
      { key: "building", label: "Building", minW: 128, val: r => r.building, cell: r => `<span class="with-icon">${icon(r.building)}<span>${esc(r.building)}<br><span class="muted sub">${esc(shortId(r.id))}</span></span></span>` },
      { key: "recipe", label: "Recipe", minW: 96, val: r => r.recipe, cell: r => r.recipe ? esc(r.recipe) : `<span class="muted">–</span>` },
      { key: "status", label: "Status", minW: 96, val: r => Object.keys(M_STATUS).indexOf(r.status), cell: r => statusPill(r.status) },
      { key: "eff", label: "Productivity", minW: 104, num: true, val: r => r.eff, cell: r => `${bar(r.eff / 100, "var(--s1)")}${pct(r.eff)}` },
      { key: "in", label: "Input /min", val: r => r.inputs[0]?.cur || 0, num: true,
        cell: r => r.inputs.map(o => `<div class="io">${fmtRate(o.cur)} <span class="muted">/ ${fmtRate(o.max)}</span> ${icon(o.name, "icon sm")}<span class="muted">${esc(o.name)}</span></div>`).join("") || `<span class="muted">–</span>` },
      { key: "out", label: "Output /min", title: "Now / at 100% productivity", val: r => r.outputs[0]?.cur || 0, num: true,
        cell: r => r.outputs.map(o => `<div class="io">${fmtRate(o.cur)} <span class="muted">/ ${fmtRate(o.max)}</span> ${icon(o.name, "icon sm")}<span class="muted">${esc(o.name)}</span></div>`).join("") || `<span class="muted">–</span>` },
      { key: "clock", label: "Clock", minW: 62, num: true, title: "Clock speed · power shards · Somersloops", val: r => r.clock,
        cell: r => `${pct(r.clock)}${r.shards ? `<br><span class="muted sub" title="Power shards">◆${r.shards}</span>` : ""}${r.sloops ? ` <span class="muted sub" title="Somersloops">✦${r.sloops}</span>` : ""}` },
      { key: "mw", label: "MW", minW: 58, num: true, title: "Power draw now (max)", val: r => r.mw, cell: r => `${fmtNum(r.mw, 1)}<br><span class="muted sub">max ${fmtNum(r.maxMw, 1)}</span>` },
    ], { sortKey: "status", storeKey: "pt.machSort", rowAttrs: r => `data-mid="${esc(r.id)}" class="${r.id === selMachine ? "sel" : ""}${relation(r) ? " rel-" + relation(r) : ""}"`,
         pin: r => relation(r) ? 0 : 1 });   // the clicked item's machines first, keeping the column sort among them

    itemPick = new MultiSelect($("pItemSel"), { noun: "items", search: "Search all items…",
      options: () => gameItems.map(i => { const it = items.get(i.name); return { value: i.name, label: icon(i.name, "icon sm") + esc(i.name),
        n: it ? fmtRate(it.prod) + "/min" : "", empty: !it || (!it.prod && !it.cons), group: i.kind === "fluid" ? "Fluids" : "Solids" }; }),
      selected: () => ui.items, onChange: v => { ui.items = v; saveUi(); render(); } });
    bldPick = new MultiSelect($("pBldSel"), { noun: "buildings", search: "Search buildings…",
      options: () => { const n = b => machines.filter(m => m.building === b).length;
        return [...new Set([...GAME_BUILDINGS, ...machines.map(m => m.building)])].map(b => ({ value: b, label: icon(b, "icon sm") + esc(b), n: n(b) || "", empty: !n(b) })); },
      selected: () => ui.bld, onChange: v => { ui.bld = v; saveUi(); render(); } });

    chart = new LineChart($("pChart"), { height: 150, fill: true });
    const hl = id => { for (const tr of $("pMachines").querySelectorAll("tr[data-mid]")) tr.classList.toggle("hl", tr.dataset.mid === id); };
    map = new MapView($("pMap"), {
      // one layer per machine type (with its icon) so the dropdown can show/hide each; markers stay coloured by status
      storeKey: "pt.map2", layerMenu: true, players: true, logistics: b => b.p,   // belts and pipes on production lines
      layers: [...GAME_BUILDINGS, "Other"].map(b => ({ key: "b:" + b, group: "Machines", label: b, color: "var(--ok)", size: 4, swatchHtml: b === "Other" ? "" : icon(b, "icon sm") })),
      hint: "markers follow the filters · click a machine row to find it",
      tooltip: p => { const m = machines.find(x => x.id === p.id); return m ? machinePop(m) : ""; },
      onHover: p => { hl(p && p.id); if (p) scrollRowIntoView($("pMachines").querySelector(`tr[data-mid="${CSS.escape(p.id)}"]`)); },
    });

    $("pSearch").addEventListener("input", e => { ui.q = e.target.value; saveUi(); render(); });
    $("pTiles").addEventListener("click", e => { const t = e.target.closest("[data-act]"); if (t) tileAction(t.dataset.act); });
    root.addEventListener("click", e => {
      const c = e.target.closest("[data-g]");
      if (c) {
        const g = c.dataset.g, v = c.dataset.v;
        if (g === "mode") ui.mode = v;
        else if (g === "range") { ui.range = +v; pollHistory(); }
        else if (g === "view") { ui.st = [...statusViews().find(o => o.v === v).st]; map.fit(); }
        saveUi(); render(); return;
      }
      if (e.target.closest("#pClear")) { ui.bld = []; ui.st = []; saveUi(); selected ? unfocus() : render(); return; }
      if (e.target.closest("#pUnfocus")) { unfocus(); return; }
      const tr = e.target.closest("tr[data-item]");
      if (tr) focus(tr.dataset.item);
      const mr = e.target.closest("tr[data-mid]");
      if (mr) { selMachine = mr.dataset.mid; map.locate(selMachine); for (const t of $("pMachines").querySelectorAll("tr.sel")) t.classList.remove("sel"); mr.classList.add("sel"); }
    });
    // hover a machine: its inventories
    $("pMachines").addEventListener("mousemove", e => {
      const tr = e.target.closest("tr[data-mid]"), m = tr && machines.find(x => x.id === tr.dataset.mid);
      map.highlight(m ? m.id : null);
      if (!m) return hideCargoPop();
      showPopAt(machinePop(m), e.clientX, e.clientY);
    });
    $("pMachines").addEventListener("mouseleave", () => map.highlight(null));
    $("pMachines").addEventListener("mouseleave", hideCargoPop);
    $("pMachines").addEventListener("scroll", hideCargoPop);
  }

  return {
    snapshot, isShort, M_STATUS,
    show() {
      if (!itemTable) init();
      poll(); pollHistory();
      timer = timer || setInterval(() => { poll(); }, POLL_MS);
      this.histTimer = this.histTimer || setInterval(pollHistory, 15000);
    },
    hide() { clearInterval(timer); clearInterval(this.histTimer); timer = this.histTimer = null; },
  };
})();
