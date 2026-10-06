// Power tab: each power grid (FRM "circuit group") with the same four numbers as the in-game power graph
// (capacity, production, consumption, max consumption), batteries, fuse state, what generates the power
// and what uses it. History comes from server.py.
"use strict";

const Power = (() => {
  const POLL_MS = 2000, DETAIL_MS = 5000;
  const RANGES = [["10m", 10], ["1h", 60], ["6h", 360], ["24h", 1440]];
  const G_STATUS = {
    fuse:    { label: "Fuse tripped", color: "var(--bad)", title: "The grid's fuse blew; reset it at a power pole or generator" },
    nofuel:  { label: "No fuel", color: "var(--bad)", title: "Out of fuel" },
    lowfuel: { label: "Low fuel", color: "var(--serious)", title: "Fuel left, but not enough to keep running (supply too slow)" },
    nowater: { label: "No water", color: "var(--serious)", title: "Has fuel but too little water to run" },
    running: { label: "Running", color: "var(--ok)", title: "Producing power" },
    standby: { label: "Standby", color: "var(--muted)", title: "Fuelled, but nothing on the grid needs its power" },
  };
  let groups = [], gens = [], usage = [], hist = null, timer = null, detailTimer = null, histTimer = null, netTimer = null, loaded = false;
  const ui = (() => { try { return { range: 60, grid: "all", gq: "", ...JSON.parse(localStorage.getItem("pw.ui2") || "{}") }; } catch { return { range: 60, grid: "all", gq: "" }; } })();
  const saveUi = () => { try { localStorage.setItem("pw.ui2", JSON.stringify(ui)); } catch {} };
  let chart, battChart, genTable, map, selGen = null;
  const root = $("tab-power");
  const mw = v => `${v < 0 ? "−" : ""}${fmtNum(Math.abs(v), Math.abs(v) < 100 ? 1 : 0)} <small>MW</small>`;

  // ---- data ----------------------------------------------------------------------------------
  // the selected grid, or (All grids) every grid added together; batteries weighted by capacity
  function allGrids() {
    const sum = k => groups.reduce((a, g) => a + (g[k] || 0), 0), cap = sum("BatteryCapacity");
    const t = s => groups.map(g => g[s]).find(v => v && v !== "00:00:00") || "00:00:00";
    return { CircuitGroupID: "all", all: true, AssociatedCircuits: groups.flatMap(g => g.AssociatedCircuits || []),
      PowerProduction: sum("PowerProduction"), PowerConsumed: sum("PowerConsumed"), PowerCapacity: sum("PowerCapacity"), PowerMaxConsumed: sum("PowerMaxConsumed"),
      BatteryCapacity: cap, BatteryPercent: cap ? groups.reduce((a, g) => a + (g.BatteryPercent || 0) * (g.BatteryCapacity || 0), 0) / cap : 0,
      BatteryInput: sum("BatteryInput"), BatteryOutput: sum("BatteryOutput"), BatteryTimeEmpty: t("BatteryTimeEmpty"), BatteryTimeFull: t("BatteryTimeFull"),
      FuseTriggered: groups.some(g => g.FuseTriggered) };
  }
  const grid = () => ui.grid === "all" || groups.length <= 1 ? (groups.length === 1 ? groups[0] : allGrids())
                   : groups.find(g => String(g.CircuitGroupID) === String(ui.grid)) || allGrids();
  // A grid is named after what powers it, biggest share of its output first; types under 10% are counted as "+N".
  // Then consumption / production: "Nuclear 200/2,000 MW", "Nuclear + Fuel +2 1,850/9,400 MW".
  // No generators: "No generators · Train Station 151/151 MW" (its most common consumer). If nothing is producing,
  // the types are ordered by capacity instead.
  const short = n => n.replace(/-Powered Generator| Generator| Power Plant| Burner$/, "");
  function genMix(g) {
    const gs = gens.filter(x => onGrid(x.pi, g)), share = new Map();
    const running = gs.some(x => x.out > 0), val = x => running ? x.out : x.cap;
    for (const x of gs) share.set(short(x.type), (share.get(short(x.type)) || 0) + val(x));
    const total = [...share.values()].reduce((a, b) => a + b, 0);
    const sorted = [...share].sort((a, b) => b[1] - a[1]);
    const main = sorted.filter(([, v], i) => i === 0 || (total && v / total >= 0.1)).map(([k]) => k);
    return { types: sorted.length, label: main.join(" + ") + (sorted.length > main.length ? ` +${sorted.length - main.length}` : "") };
  }
  function baseName(g) {
    const mix = genMix(g);
    if (mix.types) return mix.label;
    const top = Object.entries(usage.filter(u => onGrid(u.PowerInfo, g) && u.PowerInfo.MaxPowerConsumed > 0)
      .reduce((a, u) => (a[u.Name] = (a[u.Name] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1])[0];
    return `No generators${top ? ` · ${top[0]}` : ""}`;
  }
  const mwPair = g => `${fmtNum(g.PowerConsumed)}/${fmtNum(g.PowerProduction)} MW`;
  // numbered only if two grids would otherwise read exactly the same
  function gridName(g) {
    if (groups.length <= 1) return `Main grid ${mwPair(g)}`;
    const full = x => `${baseName(x)} ${mwPair(x)}`, same = groups.filter(x => full(x) === full(g));
    return same.length > 1 ? `${baseName(g)} ${same.indexOf(g) + 1} ${mwPair(g)}` : full(g);
  }

  const onGrid = (pi, g) => pi && g && (g.all ? pi.CircuitID >= 0 : pi.CircuitGroupID === g.CircuitGroupID);
  // a switch / pole / line belongs to the selected grid if any of its circuits is one of the grid's
  const inGrid = circuits => { const g = grid(); return !!g && (circuits || []).some(c => (g.AssociatedCircuits || []).includes(c)); };
  const energy = name => gameItems.find(i => i.name === name)?.energy;

  function genStatus(g) {
    if (g.PowerInfo?.FuseTriggered) return "fuse";
    if ((g.RegulatedDemandProd || 0) > 0 || /GeoThermal/i.test(g.ClassName)) return "running";
    if (g.FuelResource === "None" || /AlienPower/i.test(g.ClassName)) return "standby";
    const fuel = (g.FuelInventory || []).filter(f => f.Amount > 0 && energy(f.Name));
    if (!fuel.length) return "nofuel";
    const s = g.Supplement;
    if (s && s.Name && s.Name !== "N/A" && s.PercentFull < 10) return "nowater";
    return (g.DynamicProdCapacity || 0) > 0 ? "standby" : "lowfuel";
  }
  function fromGen(g) {
    const fuel = (g.FuelInventory || []).find(f => energy(f.Name)) || null;
    const burn = fuel && g.RegulatedDemandProd ? g.RegulatedDemandProd * 60 / energy(fuel.Name) : 0;
    return { id: g.ID, type: g.Name, status: genStatus(g), out: g.RegulatedDemandProd || 0, cap: g.ProductionCapacity || 0,
      load: g.LoadPercentage || 0, clock: g.CurrentPotential ?? 100, shards: g.PowerShards || 0, fuel, burn,
      sup: g.Supplement && g.Supplement.Name !== "N/A" ? g.Supplement : null, pi: g.PowerInfo, raw: g };
  }

  async function poll() {
    try {
      groups = (await getJSON("getPower")).sort((a, b) => b.PowerCapacity - a.PowerCapacity || a.CircuitGroupID - b.CircuitGroupID);
      loaded = true; setConn(true); render();
    } catch (e) { setConn(false, e.message); }
  }
  async function pollDetail() {
    const [g, u] = await Promise.allSettled([getJSON("getGenerators"), getJSON("getPowerUsage")]);
    if (g.status === "fulfilled") gens = g.value.map(fromGen);
    if (u.status === "fulfilled") usage = u.value;
    render();
  }
  async function pollHistory() {
    try {
      const range = ui.range, h = await (await fetch(`/hist/power?mins=${range}`, { cache: "no-store" })).json();
      if (range === ui.range) { hist = h; renderCharts(); }   // ignore a reply for a range that's no longer selected
    } catch {}
  }

  // ---- render ----------------------------------------------------------------------------------
  const pill = s => `<span class="pill" style="color:${G_STATUS[s].color};background:color-mix(in srgb, ${G_STATUS[s].color} 14%, transparent)" title="${G_STATUS[s].title}">${G_STATUS[s].label}</span>`;

  // FRM reports 0 capacity while power still flows (seen with the "no power cost" sandbox setting): treat it as
  // unknown, not as an overload
  const capUnknown = g => !g.PowerCapacity && g.PowerProduction > 0 && !g.FuseTriggered;
  function renderTiles(g) {
    const unk = capUnknown(g);
    const load = g.PowerCapacity ? g.PowerConsumed / g.PowerCapacity : 0;
    const loadColor = load > 1 ? "var(--bad)" : load > 0.9 ? "var(--warn)" : "var(--ok)";
    const headroom = unk ? null : g.PowerCapacity - g.PowerConsumed;
    const maxOver = !unk && g.PowerMaxConsumed > g.PowerCapacity;
    const hasBatt = g.BatteryCapacity > 0;
    const flow = g.BatteryInput - g.BatteryOutput;
    $("wTiles").innerHTML = `
      <div class="tile click" data-jump="wUseCard" title="Show what's using the power"><div class="t-label">Consumption</div><div class="t-val">${mw(g.PowerConsumed)}</div>
        <div class="t-sub">${unk ? "capacity not reported" : `${bar(load, loadColor)}${pct(load * 100)} of capacity`}</div></div>
      <div class="tile click" data-jump="wGenCard" title="Show what's generating the power"><div class="t-label">Production</div><div class="t-val">${mw(g.PowerProduction)}</div><div class="t-sub">what generators put out now</div></div>
      <div class="tile click" data-jump="wGensCard" title="Show every generator, with fuel and status"><div class="t-label">Capacity</div><div class="t-val">${unk ? `<span class="muted">–</span>` : mw(g.PowerCapacity)}</div><div class="t-sub">${unk ? "FRM reports 0 here (e.g. a no-power-cost world)" : "if every fuelled generator ran flat out"}</div></div>
      <div class="tile click${maxOver ? " warn" : ""}" data-jump="wUseCard" title="Show max consumption by building type (lighter bars)"><div class="t-label">Max consumption</div><div class="t-val">${mw(g.PowerMaxConsumed)}</div>
        <div class="t-sub">${maxOver ? `<span class="warn-text">⚠ ${fmtNum(g.PowerMaxConsumed - g.PowerCapacity)} MW over capacity if everything runs at once</span>` : unk ? "if every machine ran at once" : "if every machine ran at once — fits"}</div></div>
      <div class="tile click${headroom < 0 ? " bad" : ""}" data-jump="wChartCard" title="Show power over time"><div class="t-label">Headroom</div><div class="t-val">${headroom == null ? `<span class="muted">–</span>` : mw(headroom)}</div>
        <div class="t-sub">${headroom == null ? "unknown without capacity" : headroom >= 0 ? "capacity − consumption" : hasBatt && g.BatteryPercent > 0 ? `<span class="bad-text">⚠ over capacity — batteries are covering it</span>` : `<span class="bad-text">⚠ over capacity</span>`}</div></div>
      <div class="tile click" data-jump="${hasBatt ? "wBattCard" : "wChartCard"}" title="Show battery charge over time"><div class="t-label">Batteries</div>${hasBatt ? `<div class="t-val">${pct(g.BatteryPercent)} <small>of ${fmtNum(g.BatteryCapacity)} MWh</small></div>
        <div class="t-sub">${bar(g.BatteryPercent / 100, "var(--s3)")}${flow < -0.05 ? `draining ${fmtNum(-flow, 1)} MW · empty in ${esc(g.BatteryTimeEmpty)}` : g.BatteryPercent >= 99.95 ? "full" : flow < 0.05 ? "idle" : flow > 0 ? `charging ${fmtNum(flow, 1)} MW · full in ${esc(g.BatteryTimeFull)}` : `draining ${fmtNum(-flow, 1)} MW · empty in ${esc(g.BatteryTimeEmpty)}`}</div>`
        : `<div class="t-val muted">none</div><div class="t-sub">no Power Storage on this grid</div>`}</div>`;
    const tot = k => groups.reduce((a, x) => a + x[k], 0);
    $("statsPower").innerHTML = `<span class="stat"><b>${fmtNum(tot("PowerConsumed"))}</b>MW used</span><span class="stat"><b>${fmtNum(tot("PowerCapacity"))}</b>MW capacity</span>` +
      (groups.length > 1 ? `<span class="stat"><b>${groups.length}</b>grids</span>` : "") +
      (groups.some(x => x.FuseTriggered) ? `<span class="stat" style="color:var(--bad)"><b>⚠</b>fuse tripped</span>` : "");
    $("wFuse").style.display = g.FuseTriggered ? "block" : "none";
    $("wFuse").textContent = `⚠ ${g.all ? groups.filter(x => x.FuseTriggered).map(gridName).join(", ") : gridName(g)}: the fuse has tripped — everything on it is off. Reset it at any power pole or generator (and fix the overload first: consumption ${fmtNum(g.PowerConsumed)} MW vs capacity ${fmtNum(g.PowerCapacity)} MW).`;
  }

  function renderGrids() {
    $("wGridGroup").style.display = groups.length > 1 ? "" : "none";   // one grid: nothing to choose
    const all = allGrids();
    setSeg($("wGrids"), segControl("grid", [{ v: "all", label: `All grids <span class="n">${mwPair(all)}</span>` },
      ...groups.map(g => ({ v: String(g.CircuitGroupID), label: `${g.FuseTriggered ? "⚠ " : ""}${esc(gridName(g))}`,
        title: "consumption / production" }))], o => o.v === String(grid().CircuitGroupID)));
  }

  // ---- grid layout: start at the circuit with the generators and follow the switches outward
  function renderLayout(g) {
    if (g.all) {   // each grid with its own layout, under its name
      const parts = groups.map(x => [x, layoutHtml(x)]).filter(([, h]) => h);
      $("wLayoutCard").style.display = parts.length ? "" : "none";
      $("wLayout").innerHTML = parts.map(([x, h]) => `<h3>${esc(gridName(x))}</h3>${h}`).join("");
      $("wLayoutHint").textContent = `${groups.length} grids · starting from the generators`;
      return;
    }
    const html = layoutHtml(g);
    $("wLayoutCard").style.display = html ? "" : "none";
    if (!html) return;
    $("wLayout").innerHTML = html;
    const circuits = g.AssociatedCircuits || [], sw = PowerNet.switches.filter(s => s.circuits.some(c => circuits.includes(c)));
    $("wLayoutHint").textContent = `${circuits.length} section${circuits.length === 1 ? "" : "s"} joined by ${sw.length} switch${sw.length === 1 ? "" : "es"} · starting from the generators`;
  }
  function layoutHtml(g) {
    const circuits = g.AssociatedCircuits || [];
    const sw = PowerNet.switches.filter(s => s.circuits.some(c => circuits.includes(c)));
    if (!(circuits.length > 1 || sw.length) && groups.length <= 1) return "";   // a single plain circuit: nothing to show
    const on = c => x => (x.pi || x.PowerInfo)?.CircuitID === c;
    const contents = c => {
      const n = {}; gens.filter(on(c)).forEach(x => n[x.type] = (n[x.type] || 0) + 1);
      usage.filter(u => on(c)(u) && !/Generator|Burner|Power Plant/.test(u.Name)).forEach(u => n[u.Name] = (n[u.Name] || 0) + 1);
      const poles = PowerNet.poles.filter(p => p.CircuitID === c).length;
      const items = Object.entries(n).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="with-icon">${icon(k, "icon sm")}${v} × ${esc(k)}</span>`);
      return (items.join("") || `<span class="muted">nothing but wires</span>`) + (poles ? `<span class="muted">${poles} pole${poles === 1 ? "" : "s"}</span>` : "");
    };
    const genMW = c => gens.filter(on(c)).reduce((a, x) => a + x.cap, 0);
    const seen = new Set();
    const branch = (c, depth) => {
      seen.add(c);
      let html = `<div class="lay-node" style="--d:${depth}"><div class="lay-items">${contents(c)}</div></div>`;
      for (const s of sw.filter(s => s.circuits.includes(c))) {
        const other = s.circuits.find(x => x !== c);
        if (other == null || seen.has(other)) continue;
        const name = s.SwitchTag || s.Name || "Power Switch";
        html += `<div class="lay-switch" style="--d:${depth + 1}"><span class="pill" style="color:${s.IsOn ? "var(--ok)" : "var(--bad)"};background:color-mix(in srgb, ${s.IsOn ? "var(--ok)" : "var(--bad)"} 14%, transparent)">${s.IsOn ? "on" : "off"}</span>
          <b>${esc(name)}</b>${s.Priority >= 0 ? ` <span class="muted">priority ${s.Priority} switch</span>` : ` <span class="muted">switch</span>`}</div>` + branch(other, depth + 1);
      }
      return html;
    };
    const order = [...circuits].sort((a, b) => genMW(b) - genMW(a));
    let html = "";
    for (const c of order) if (!seen.has(c)) html += branch(c, 0);
    return html;
  }

  function renderBreakdowns(g) {
    // generation by generator type: output now vs capacity (lighter track)
    const byType = new Map();
    for (const x of gens.filter(x => onGrid(x.pi, g))) {
      const t = byType.get(x.type) || { type: x.type, n: 0, on: 0, out: 0, cap: 0, fuels: new Map() };
      t.n++; if (x.status === "running") t.on++; t.out += x.out; t.cap += x.cap;
      if (x.burn) t.fuels.set(x.fuel.Name, (t.fuels.get(x.fuel.Name) || 0) + x.burn);
      byType.set(x.type, t);
    }
    hbars($("wGen"), [...byType.values()].sort((a, b) => b.cap - a.cap).map(t => ({
      label: `<span class="with-icon">${icon(t.type, "icon sm")}<span>${esc(t.type)}<br><span class="muted sub">${t.on} of ${t.n} running${[...t.fuels].map(([f, r]) => ` · ${fmtRate(r)} ${esc(f)}/min`).join("")}</span></span></span>`,
      value: t.out, cap: t.cap, text: `<b>${fmtNum(t.out)}</b> <span class="muted">/ ${fmtNum(t.cap)} MW</span>`,
      title: `${t.type}: ${fmtNum(t.out, 1)} MW now of ${fmtNum(t.cap, 1)} MW capacity`,
    })), { color: "var(--s1)", capColor: "var(--track)" });

    // consumption by building type (top 10, rest folded into Other)
    const byB = new Map();
    for (const u of usage) {
      if (!onGrid(u.PowerInfo, g) || !(u.PowerInfo.MaxPowerConsumed > 0)) continue;
      const b = byB.get(u.Name) || { name: u.Name, n: 0, cur: 0, max: 0 };
      b.n++; b.cur += u.PowerInfo.PowerConsumed || 0; b.max += u.PowerInfo.MaxPowerConsumed || 0; byB.set(u.Name, b);
    }
    let rows = [...byB.values()].sort((a, b) => b.cur - a.cur || b.max - a.max);
    if (rows.length > 11) {
      const rest = rows.slice(10);
      rows = rows.slice(0, 10).concat({ name: `Other (${rest.length} types)`, other: true, n: rest.reduce((a, r) => a + r.n, 0),
        cur: rest.reduce((a, r) => a + r.cur, 0), max: rest.reduce((a, r) => a + r.max, 0) });
    }
    hbars($("wUse"), rows.map(b => ({
      label: `<span class="with-icon">${b.other ? `<span class="icon sm"></span>` : icon(b.name, "icon sm")}<span>${esc(b.name)}<br><span class="muted sub">${b.n} building${b.n === 1 ? "" : "s"}</span></span></span>`,
      value: b.cur, cap: b.max, text: `<b>${fmtNum(b.cur, b.cur < 10 ? 1 : 0)}</b> <span class="muted">/ ${fmtNum(b.max, b.max < 10 ? 1 : 0)} MW</span>`,
      title: `${b.name}: ${fmtNum(b.cur, 1)} MW now, ${fmtNum(b.max, 1)} MW if all ran at once`,
    })), { color: "var(--s2)", capColor: "var(--track)" });
    const unpowered = usage.filter(u => u.PowerInfo && u.PowerInfo.CircuitID === -1 && /Build_(Constructor|Smelter|Assembler|Foundry|Manufacturer|Refinery|Packager|Blender|HadronCollider|Converter|QuantumEncoder|Miner|WaterPump|OilPump|FrackingExtractor)/.test(u.ClassName || u.ID)).length;
    $("wUnpowered").textContent = unpowered ? `⚠ ${unpowered} production building${unpowered === 1 ? " is" : "s are"} not connected to any grid.` : "";

    const q = ui.gq.trim().toLowerCase();
    genTable.render(gens.filter(x => onGrid(x.pi, g) && (!q || `${x.type} ${G_STATUS[x.status].label} ${x.fuel?.Name || ""}`.toLowerCase().includes(q))));
    $("wGenCount").textContent = `${gens.filter(x => onGrid(x.pi, g)).length} generators`;
    const pt = (u, extra) => u.location && { id: u.ID || u.id, x: u.location.x, y: u.location.y, ...extra };
    map.setPoints("gens", gens.filter(x => x.raw.location).map(x => pt(x.raw, { circuits: [x.pi?.CircuitID], color: G_STATUS[x.status].color,
      label: `${x.type} · ${G_STATUS[x.status].label} · ${fmtNum(x.out, 0)} MW` })));
    map.setPoints("use", usage.filter(u => u.PowerInfo?.MaxPowerConsumed > 0).map(u => pt(u, { circuits: [u.PowerInfo.CircuitID],
      label: `${u.Name} · ${fmtNum(u.PowerInfo.PowerConsumed, 1)} MW (max ${fmtNum(u.PowerInfo.MaxPowerConsumed, 1)})` })).filter(Boolean));
  }

  function renderCharts() {
    const g = grid(); if (!chart || !g || !hist) return;
    let h = hist.groups[String(g.CircuitGroupID)];
    if (g.all) {   // add the grids up point by point (a grid missing at a point counts as 0 there)
      const hs = Object.values(hist.groups), n = hist.t.length;
      if (hs.length) {
        h = {};
        for (const k of ["prod", "cons", "cap", "max"]) h[k] = Array.from({ length: n }, (_, i) => hs.some(x => x[k][i] != null) ? hs.reduce((a, x) => a + (x[k][i] || 0), 0) : null);
        h.batt = Array.from({ length: n }, (_, i) => { const w = hs.filter(x => x.batt[i] != null); return w.length ? w.reduce((a, x) => a + x.batt[i], 0) / w.length : null; });
      }
    }
    const s = (key, name, color, extra) => ({ key, name, color, values: h ? h[key] : [], ...extra });
    chart.update(h ? { t: hist.t, interval: hist.interval, series: [
      s("cap", "Capacity", "var(--s3)"), s("prod", "Production", "var(--s1)"),
      s("cons", "Consumption", "var(--s2)", { area: true }), s("max", "Max consumption", "var(--s4)", { dash: true }),
    ] } : null);
    $("wBattCard").style.display = g.BatteryCapacity > 0 ? "" : "none";
    if (g.BatteryCapacity > 0) battChart.update(h ? { t: hist.t, interval: hist.interval, yMax: 100, series: [s("batt", "Battery charge", "var(--s3)", { area: true })] } : null);
  }

  function render() {
    if (!loaded || !groups.length) {
      if (loaded) $("wTiles").innerHTML = `<p class="muted">No power grids in this world yet.</p>`;
      return;
    }
    const g = grid();
    renderGrids(); renderTiles(g); renderBreakdowns(g); renderLayout(g);
    if (!chart.data) renderCharts();
    setSeg($("wRange"), segControl("range", RANGES.map(([l, v]) => ({ v, label: l })), o => ui.range === o.v));
  }

  // ---- markup + events ---------------------------------------------------------------------------
  function init() {
    root.innerHTML = `
      <div class="toolbar"><div class="seg-group" id="wGridGroup"><span class="lbl">Grid</span><span id="wGrids"></span></div>
        <div class="seg-group right"><span class="lbl">History</span><span id="wRange"></span></div></div>
      <div class="banner bad" id="wFuse"></div>
      <div class="tiles compact" id="wTiles"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card w-chart" id="wChartCard"><div class="card-head"><h2>Power over time</h2><span class="hint">like the in-game power graph · hover for values</span></div><div id="wChart"></div></section>
          <section class="card w-batt" id="wBattCard"><div class="card-head"><h2>Battery charge</h2><span class="hint">% of total Power Storage</span></div><div id="wBatt"></div></section>
          <section class="card w-layout" id="wLayoutCard"><div class="card-head"><h2>Grid layout</h2><span class="hint" id="wLayoutHint"></span></div>
            <div class="card-body" id="wLayout"></div></section>
          <section class="card w-break"><div class="break-cols">
            <div id="wGenCard"><div class="card-head"><h2>Generation</h2><span class="hint">output now · lighter bar = capacity</span></div><div id="wGen" class="hbars"></div></div>
            <div id="wUseCard"><div class="card-head"><h2>Consumption</h2><span class="hint">by building type · lighter bar = max</span></div><div id="wUse" class="hbars"></div>
              <p class="warn-text small" id="wUnpowered"></p></div></div></section>
        </div>
        <div class="pcol">
          <section class="card w-map"><div id="wMap"></div></section>
          <section class="card w-gens" id="wGensCard"><div class="card-head"><h2>Generators</h2><span class="hint" id="wGenCount"></span>
            <input class="f-input search sm" id="wGenSearch" placeholder="Filter: type, status, fuel…" value="${esc(ui.gq)}"></div>
            <div class="table-wrap dtw tall" id="wGens"></div></section>
        </div>
      </div>`;
    chart = new LineChart($("wChart"), { height: 260, unit: "MW", fill: true });
    battChart = new LineChart($("wBatt"), { height: 120, unit: "%", fmt: v => fmtNum(v, 1), fill: true });
    genTable = new DataTable($("wGens"), [
      { key: "type", label: "Generator", val: r => r.type, cell: r => `<span class="with-icon">${icon(r.type)}<span>${esc(r.type)}<br><span class="muted sub">${esc(shortId(r.id))}</span></span></span>` },
      { key: "status", label: "Status", val: r => Object.keys(G_STATUS).indexOf(r.status), cell: r => pill(r.status) },
      { key: "out", label: "Output", num: true, title: "MW now / capacity", val: r => r.out, cell: r => `${bar(r.cap ? r.out / r.cap : 0, "var(--s1)")}${fmtNum(r.out, 1)} <span class="muted">/ ${fmtNum(r.cap, 0)}</span>` },
      { key: "clock", label: "Clock", num: true, val: r => r.clock, cell: r => `${pct(r.clock)}${r.shards ? `<br><span class="muted sub">◆${r.shards}</span>` : ""}` },
      { key: "fuel", label: "Fuel", val: r => r.fuel ? r.fuel.Amount : -1,
        cell: r => r.fuel ? `<span class="with-icon">${icon(r.fuel.Name, "icon sm")}<span>${fmtRate(r.fuel.Amount)} ${esc(r.fuel.Name)}${r.burn ? `<br><span class="muted sub">burning ${fmtRate(r.burn)}/min</span>` : ""}</span></span>` : `<span class="muted">–</span>` },
      { key: "sup", label: "Water", num: true, title: "Supplemental resource tank (coal and nuclear need water)", val: r => r.sup ? r.sup.PercentFull : -1,
        cell: r => r.sup ? `${bar(r.sup.PercentFull / 100, "var(--s1)")}${pct(r.sup.PercentFull)}<br><span class="muted sub">${fmtRate(r.sup.CurrentConsumed)} m³/min</span>` : `<span class="muted">–</span>` },
    ], { sortKey: "status", storeKey: "pw.genSort", rowAttrs: r => `data-gid="${esc(r.id)}" class="${r.id === selGen ? "sel" : ""}"` });
    const hl = id => { for (const tr of $("wGens").querySelectorAll("tr[data-gid]")) tr.classList.toggle("hl", tr.dataset.gid === id); };
    map = new MapView($("wMap"), {
      // the selected grid only: its generators and consumers, and its part of the power network
      storeKey: "pw.map2", layerMenu: true, players: true, powerNet: () => true, layers: [
        // points and lines not on the selected grid fade (All grids: nothing fades), see fade below
        { key: "gens", group: "Power", label: "Generators", color: "var(--ok)", size: 5, shape: "diamond" },
        { key: "use", group: "Power", label: "Consumers", color: "#8c94a1", size: 2.5, on: false },
      ],
      fade: p => p.circuits ? !grid().all && !inGrid(p.circuits) : false,   // other grids fade
      fitTo: () => grid().all ? [] : map.all(true).filter(p => p.circuits && inGrid(p.circuits)).map(p => p.ip),
      tooltip: p => `<div class="row"><span>${esc(p.label)}</span></div>`, hint: "click a generator row to find it",
      onHover: p => { hl(p && p.id); if (p) scrollRowIntoView($("wGens").querySelector(`tr[data-gid="${CSS.escape(p.id)}"]`)); },
    });
    $("wGens").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-gid]"); if (!tr) return;
      selGen = tr.dataset.gid; map.locate(selGen);
      for (const t of $("wGens").querySelectorAll("tr.sel")) t.classList.remove("sel"); tr.classList.add("sel");
    });
    PowerNet.listeners.add(() => { if (loaded && groups.length) renderLayout(grid()); });
    $("wGens").addEventListener("mousemove", e => { const tr = e.target.closest("tr[data-gid]"); map.highlight(tr ? tr.dataset.gid : null); });
    $("wGens").addEventListener("mouseleave", () => map.highlight(null));

    root.addEventListener("click", e => {
      const j = e.target.closest("[data-jump]");
      if (j) { const t = $(j.dataset.jump); t.scrollIntoView({ behavior: "smooth", block: "start" }); t.classList.remove("flash"); void t.offsetWidth; t.classList.add("flash"); return; }
      const sb = e.target.closest("[data-g]");
      if (sb && sb.dataset.g === "grid") { ui.grid = sb.dataset.v; saveUi(); render(); renderCharts(); map.draw(); map.fit(); return; }
      if (sb && sb.dataset.g === "range") { ui.range = +sb.dataset.v; saveUi(); render(); pollHistory(); }
    });
    $("wGenSearch").addEventListener("input", e => { ui.gq = e.target.value; saveUi(); render(); });
  }

  return {
    show() {
      if (!chart) init();
      poll(); pollDetail(); pollHistory();
      timer = timer || setInterval(poll, POLL_MS);
      detailTimer = detailTimer || setInterval(pollDetail, DETAIL_MS);
      histTimer = histTimer || setInterval(pollHistory, 5000);
    },
    hide() { [timer, detailTimer, histTimer, netTimer].forEach(clearInterval); timer = detailTimer = histTimer = netTimer = null; },
  };
})();
