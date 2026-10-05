// Overview (home) tab: how the whole world is doing at a glance — what needs attention, power, production,
// vehicles and progression in one screen each linking to its tab, and a map of the whole factory.
"use strict";

const Overview = (() => {
  let d = {}, prod = null, veh = [], timers = [], map, chart;
  const root = $("tab-overview");
  const VEH_COLOR = { moving: "#5fcf80", docking: "#5fa8ef", stopped: "#c5cad3", driven: "#c39cf7", error: "#ef5f5f" };

  async function load(eps) {
    const res = await Promise.allSettled(eps.map(e => getJSON(e)));
    eps.forEach((e, i) => { if (res[i].status === "fulfilled") d[e] = res[i].value; });
    if (res.some(r => r.status === "fulfilled")) setConn(true); else setConn(false, res[0].reason?.message || "error");
  }
  async function fast() {
    await load(["getPower", "getSessionInfo", "getPlayer", "getSpaceElevator", "getHUBTerminal", "getResourceSink", "getTradingPost"]);
    try {
      const [w, t, dr] = await Promise.all([getJSON("getVehicles"), getJSON("getTrains").catch(() => []), getJSON("getDrone").catch(() => [])]);
      veh = w.map(fromWheeled).concat(t.map(fromTrain), dr.map(fromDrone));
    } catch {}
    render();
  }
  async function factory() { try { prod = await Production.snapshot(); } catch {} render(); }
  async function slow() { await load(["getSchematics"]); render(); }
  async function powerHist() {
    try {
      const h = await (await fetch("/hist/power?mins=60", { cache: "no-store" })).json();
      const g = d.getPower && [...d.getPower].sort((a, b) => b.PowerCapacity - a.PowerCapacity)[0];
      const s = g && h.groups[String(g.CircuitGroupID)];
      chart.update(s ? { t: h.t, interval: h.interval, series: [
        { key: "cap", name: "Capacity", color: "var(--s3)", values: s.cap },
        { key: "cons", name: "Consumption", color: "var(--s2)", values: s.cons, area: true },
      ] } : null);
    } catch {}
  }

  // ---- what needs attention, worst first -----------------------------------------------------
  function attention() {
    const out = [], add = (level, text, tab) => out.push({ level, text, tab });
    for (const g of d.getPower || []) {
      const name = (d.getPower.length > 1 ? `Grid ${g.CircuitGroupID}: ` : "");
      if (g.FuseTriggered) add("bad", `${name}fuse tripped — the grid is off`, "power");
      else if (g.PowerConsumed > g.PowerCapacity) add("bad", `${name}using ${fmtNum(g.PowerConsumed)} MW, more than the ${fmtNum(g.PowerCapacity)} MW capacity${g.BatteryCapacity ? ` — batteries at ${pct(g.BatteryPercent)}` : ""}`, "power");
      else if (g.PowerConsumed > g.PowerCapacity * 0.9) add("warn", `${name}power is ${pct(g.PowerConsumed / g.PowerCapacity * 100)} of capacity`, "power");
      if (g.PowerMaxConsumed > g.PowerCapacity) add("warn", `${name}max consumption ${fmtNum(g.PowerMaxConsumed)} MW is over capacity ${fmtNum(g.PowerCapacity)} MW — a fuse could trip if everything runs at once`, "power");
    }
    if (prod) {
      const gens = prod.gens || [];
      const noFuel = gens.filter(g => !(g.RegulatedDemandProd > 0) && !(g.DynamicProdCapacity > 0) && !/GeoThermal|AlienPower/i.test(g.ClassName)).length;
      if (noFuel) add("warn", `${noFuel} generator${noFuel > 1 ? "s" : ""} without enough fuel or water`, "power");
      const by = s => prod.machines.filter(m => m.status === s).length;
      if (by("nopower")) add("bad", `${by("nopower")} machines have no power`, "production");
      if (by("starved")) add("warn", `${by("starved")} machines are starved of input`, "production");
      const shorts = [...prod.items.values()].filter(Production.isShort).sort((a, b) => a.net - b.net);
      if (shorts.length) add("warn", `Used faster than made: ${shorts.slice(0, 4).map(i => `${i.name} (${fmtRate(i.net)}/min)`).join(", ")}${shorts.length > 4 ? ` +${shorts.length - 4} more` : ""}`, "production");
      if (by("full")) add("info", `${by("full")} machines are stopped with full output (backed up)`, "production");
    }
    // each stuck vehicle by name with its problem, e.g. Train "Train" (2 locos+1 car): Station unreachable
    for (const v of veh.filter(v => v.status === "error"))
      add("bad", `${v.type} ${v.name && v.name !== v.type ? `"${v.name.trim()}"` : shortId(v.id)}${v.consist ? ` (${v.consist})` : ""}: ${v.error || "autopilot error"}`, "vehicles");
    const se = Progression.seState(d.getSpaceElevator?.[0]);
    if (se?.ready) add("ok", `Space Elevator phase ${se.n} is ready to send`, "progression");
    const hub = d.getHUBTerminal?.[0];
    const cost = hub?.HasActiveMilestone ? hub.ActiveMilestone.Cost || [] : [];
    if (cost.length && cost.every(c => c.RemainingCost === 0)) add("ok", `HUB milestone "${hub.ActiveMilestone.Name}" is paid — ready to unlock`, "progression");
    else if (hub && !hub.HasActiveMilestone) add("info", "No milestone selected in the HUB terminal", "progression");
    const sink = d.getResourceSink?.[0];
    if (sink?.NumCoupon >= 10) add("info", `${sink.NumCoupon} FICSIT Coupons to spend in the AWESOME Shop`, "progression");
    const order = { bad: 0, warn: 1, ok: 2, info: 3 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  // ---- render ------------------------------------------------------------------------------------
  function render() {
    if (!$("ovAttn")) return;
    const s = d.getSessionInfo, players = d.getPlayer || [];
    const online = players.filter(p => p.Online);
    $("ovSession").innerHTML = s ? `<b>${esc(s.SessionName)}</b><span class="muted"> · day ${s.PassedDays} · ${String(s.Hours).padStart(2, "0")}:${String(s.Minutes).padStart(2, "0")} ${s.IsDay ? "☀" : "☾"} · ${esc(s.TotalPlayDurationText)} played</span>
      <span class="muted"> · ${online.length ? `${online.length} online: ${online.map(p => esc(p.Name)).join(", ")}` : "nobody online"}</span>` : "";

    const items = attention();
    const ICON = { bad: "⛔", warn: "⚠", ok: "✓", info: "ℹ" };
    $("ovAttn").innerHTML = items.length ? items.map(a => `<a class="attn ${a.level}" href="#${a.tab}"><span class="ai">${ICON[a.level]}</span><span>${esc(a.text)}</span><span class="go">${a.tab} →</span></a>`).join("")
      : `<p class="muted">All good — nothing needs attention.</p>`;

    // ---- Power: headline, chart (fills the card), key figures
    const gs = d.getPower || [], tot = k => gs.reduce((a, g) => a + g[k], 0);
    const load = tot("PowerCapacity") ? tot("PowerConsumed") / tot("PowerCapacity") : 0;
    const batt = gs.filter(g => g.BatteryCapacity > 0);
    const battPct = batt.length ? batt.reduce((a, g) => a + g.BatteryPercent * g.BatteryCapacity, 0) / batt.reduce((a, g) => a + g.BatteryCapacity, 0) : null;
    const gens = prod?.gens || [], gensOn = gens.filter(g => g.RegulatedDemandProd > 0).length;
    const maxOver = tot("PowerMaxConsumed") > tot("PowerCapacity");
    $("ovPower").innerHTML = gs.length ? `<div class="big">${fmtNum(tot("PowerConsumed"))} <small>/ ${fmtNum(tot("PowerCapacity"))} MW used</small></div>
      <div class="t-sub">${bar(load, load > 1 ? "var(--bad)" : load > 0.9 ? "var(--warn)" : "var(--ok)")}${pct(load * 100)} of capacity${gs.length > 1 ? ` · ${gs.length} grids` : ""}</div>` : `<p class="muted">No grids.</p>`;
    $("ovPowerFigs").innerHTML = gs.length ? [
      ["Production", `${fmtNum(tot("PowerProduction"))} MW`],
      ["Max consumption", `<span class="${maxOver ? "warn-text" : ""}">${fmtNum(tot("PowerMaxConsumed"))} MW</span>`],
      ["Batteries", battPct == null ? "none" : pct(battPct)],
      ["Generators", gens.length ? `${gensOn} / ${gens.length} running` : "–"],
    ].map(([k, v]) => `<div><span class="muted">${k}</span><b>${v}</b></div>`).join("") : "";

    // ---- Production: status mix, top products, shortfalls
    if (prod) {
      const ms = prod.machines, working = ms.filter(m => m.status === "running" || m.status === "partial").length;
      const cfg = ms.filter(m => m.status !== "norecipe" && m.status !== "paused");
      const avg = cfg.length ? cfg.reduce((a, m) => a + m.eff, 0) / cfg.length : 0;
      const S = Production.M_STATUS, cnt = {}; ms.forEach(m => cnt[m.status] = (cnt[m.status] || 0) + 1);
      const segs = Object.keys(S).filter(k => cnt[k]);
      const shorts = [...prod.items.values()].filter(Production.isShort).sort((a, b) => a.net - b.net);
      const top = [...prod.items.values()].sort((a, b) => b.prod - a.prod).slice(0, 10);
      $("ovProd").innerHTML = `<div class="big">${fmtNum(working)} <small>/ ${fmtNum(ms.length)} machines working · ${pct(avg)} avg productivity</small></div>
        <div class="stack" title="Machines by status">${segs.map(k => `<i style="flex:${cnt[k]};background:${S[k].color}" title="${cnt[k]} ${S[k].label.toLowerCase()}"></i>`).join("")}</div>
        <div class="stack-key">${segs.map(k => `<span><i style="background:${S[k].color}"></i>${cnt[k]} ${S[k].label.toLowerCase()}</span>`).join("")}</div>
        <h3>Top products <span class="muted">per minute</span></h3>
        <div class="two-col">${top.map(i => `<div class="kvrow"><span class="with-icon">${icon(i.name, "icon sm")}${esc(i.name)}</span><b>${fmtRate(i.prod)}${i.fluid ? ` <small class="muted">m³</small>` : ""}</b></div>`).join("")}</div>
        ${shorts.length ? `<h3>Used faster than made</h3><div class="two-col">${shorts.slice(0, 6).map(i => `<div class="kvrow"><span class="with-icon">${icon(i.name, "icon sm")}${esc(i.name)}</span><b class="bad-text">−${fmtRate(-i.net)}</b></div>`).join("")}</div>` : ""}`;
    }

    // ---- Vehicles: a row per type with its picture and status counts; stuck vehicles by name
    const vc = st => veh.filter(v => v.status === st).length;
    const types = Object.keys(TYPES).filter(t => veh.some(v => v.type === t));
    const errs = veh.filter(v => v.status === "error");
    $("ovVeh").innerHTML = `<div class="big">${veh.length} <small>vehicles</small></div>
      <div class="t-sub"><span style="color:var(--ok)">${vc("moving")} moving</span> · <span style="color:var(--info)">${vc("docking")} docking</span> · ${vc("stopped")} stopped${vc("error") ? ` · <span style="color:var(--bad)">${vc("error")} stuck</span>` : ""}</div>
      <div class="vtypes">${types.map(t => { const vs = veh.filter(v => v.type === t), c = st => vs.filter(v => v.status === st).length;
        return `<div class="vt"><span class="with-icon">${typeImg(t)}<b>${vs.length}</b> ${esc(t)}${vs.length === 1 ? "" : "s"}</span>
          <span class="vt-st">${["moving", "docking", "stopped", "driven", "error"].filter(st => c(st)).map(st => `<span class="pill s-${st}">${c(st)} ${STATUS_LABEL[st].toLowerCase()}</span>`).join("")}</span></div>`; }).join("")}</div>
      ${errs.length ? `<h3>Stuck</h3>${errs.map(v => `<div class="kvrow"><span>${esc(v.type)} ${v.name && v.name.trim() !== v.type ? `"${esc(v.name.trim())}"` : esc(shortId(v.id))}</span><b class="bad-text">${esc(v.error || "error")}</b></div>`).join("")}` : ""}`;

    // ---- Progression: tier, Space Elevator parts, HUB milestone parts, coupons
    const se = Progression.seState(d.getSpaceElevator?.[0]);
    const tiers = Progression.milestoneTiers(d.getSchematics || []);
    const topTier = tiers.filter(t => t.done).pop();
    const hub = d.getHUBTerminal?.[0], m = hub?.HasActiveMilestone ? hub.ActiveMilestone : null;
    const total = c => c.TotalCost ?? c.Amount ?? 0, left = c => c.RemainingCost ?? total(c);
    const allMs = tiers.reduce((a, t) => a + t.list.length, 0), gotMs = tiers.reduce((a, t) => a + t.done, 0);
    const partRow = (name, done, of) => `<div class="part"><span class="with-icon">${icon(name, "icon sm")}<span>${esc(name)}</span></span>${bar(done / Math.max(1, of), done >= of ? "var(--ok)" : "var(--s1)")}<span class="muted">${fmtNum(done)} / ${fmtNum(of)}</span></div>`;
    const sink = d.getResourceSink?.[0];
    $("ovProg").innerHTML = `<div class="big">${topTier ? `Tier ${topTier.tier}` : "–"} <small>${allMs ? `${gotMs} / ${allMs} milestones` : ""}${sink ? ` · ${fmtNum(sink.NumCoupon)} coupons` : ""}</small></div>
      ${se ? `<h3>Space Elevator · ${se.done ? "complete" : `phase ${se.n}${se.phase ? ` ${esc(se.phase.name)}` : ""} · ${pct(se.frac * 100)}`}</h3>
        ${se.done ? "" : se.parts.map(pt => partRow(pt.name, pt.done, pt.total)).join("")}` : ""}
      ${m ? `<h3>HUB · ${esc(m.Name)}</h3>${(m.Cost || []).map(c => partRow(c.Name, total(c) - left(c), total(c))).join("")}` : `<h3>HUB</h3><p class="muted">No milestone selected.</p>`}`;

    $("statsOv").innerHTML = (gs.length ? `<span class="stat"><b>${fmtNum(tot("PowerConsumed"))}</b>/ ${fmtNum(tot("PowerCapacity"))} MW</span>` : "") +
      (prod ? `<span class="stat"><b>${prod.machines.filter(m => m.status === "running" || m.status === "partial").length}</b>machines working</span>` : "") +
      `<span class="stat"><b>${veh.length}</b>vehicles</span>`;
    renderMap();
  }

  function renderMap() {
    if (!map) return;
    const pt = (o, extra) => o.location && { id: o.ID, x: o.location.x, y: o.location.y, ...extra };
    if (prod) {
      map.setPoints("machines", prod.machines.filter(m => m.loc).map(m => ({ id: m.id, x: m.loc.x, y: m.loc.y, color: Production.M_STATUS[m.status].color,
        label: `${m.building}${m.recipe ? " · " + m.recipe : ""} · ${Production.M_STATUS[m.status].label}`, tab: "production" })));
      map.setPoints("gens", (prod.gens || []).map(g => pt(g, { label: `${g.Name} · ${fmtNum(g.RegulatedDemandProd || 0)} MW`, color: g.RegulatedDemandProd > 0 ? "var(--s4)" : "var(--bad)", tab: "power" })).filter(Boolean));
    }
    map.setPoints("veh", veh.filter(v => v.loc).map(v => ({ id: v.id, x: v.loc.x, y: v.loc.y, rot: v.rot, color: VEH_COLOR[v.status], label: `${v.type} ${shortId(v.id)} · ${STATUS_LABEL[v.status]}${v.nextStop ? " → " + v.nextStop : ""}`, tab: "vehicles" })));
    map.setPoints("land", [...(d.getTradingPost || []), ...(d.getSpaceElevator || [])].map(o => pt(o, { label: o.Name })).filter(Boolean));
  }

  function init() {
    root.innerHTML = `
      <div class="ov-session" id="ovSession"></div>
      <div class="cols ov-cols">
        <div class="ov-left">
          <section class="card"><div class="card-head"><h2>Needs attention</h2></div><div id="ovAttn" class="attn-list"></div></section>
          <div class="ov-cards">
            <a class="card link ov-card" href="#power"><div class="card-head"><h2>Power</h2><span class="hint">→</span></div><div id="ovPower"></div><div id="ovChart"></div><div class="figs" id="ovPowerFigs"></div></a>
            <a class="card link ov-card" href="#production"><div class="card-head"><h2>Production</h2><span class="hint">→</span></div><div class="ov-body" id="ovProd"><p class="muted">Loading…</p></div></a>
            <a class="card link ov-card" href="#vehicles"><div class="card-head"><h2>Vehicles</h2><span class="hint">→</span></div><div class="ov-body" id="ovVeh"></div></a>
            <a class="card link ov-card" href="#progression"><div class="card-head"><h2>Progression</h2><span class="hint">→</span></div><div class="ov-body" id="ovProg"></div></a>
          </div>
        </div>
        <section class="card sticky ov-world"><div class="card-head"><h2>World</h2><span class="hint">click a marker to open it in its tab</span></div><div id="ovMap"></div></section>
      </div>`;
    chart = new LineChart($("ovChart"), { height: 140, unit: "MW", fill: true });
    map = new MapView($("ovMap"), {
      // dropdown sections: Factory, Transport, Stations, People (players are added by MapView)
      storeKey: "ov.map2", layerMenu: true, players: true, logistics: () => true, layers: [   // every belt   // new key: everything starts enabled
        // told apart by shape (and colour where status isn't the point): machines = small dots coloured by status,
        // generators = amber diamonds (red when out of fuel/water), vehicles = heading arrows, players = labelled dots on top
        { key: "machines", group: "Factory", label: "Machines", color: "var(--ok)", size: 2.6 },
        { key: "gens", group: "Factory", label: "Generators", color: "var(--s4)", size: 5, shape: "diamond" },
        { key: "land", group: "Factory", label: "HUB & Elevator", color: "#ffffff", size: 6, shape: "square" },
        { key: "veh", group: "Transport", label: "Vehicles", color: "#5fcf80", size: 5, shape: "arrow" },
        ...networkLayers(),
      ],
      tooltip: p => `<div class="row"><span>${esc(p.label)}</span></div>`,
      onClick: p => { if (p.tab) location.hash = p.tab; },
      draw: (c, now, mv) => drawNetwork(mv, k => mv.isOn(k)),   // roads, tracks, drone routes, stations (shared with Vehicles)
    });
  }

  return {
    show() {
      if (!map) init();
      fast().then(powerHist); factory(); slow();
      if (!timers.length) timers = [setInterval(fast, 3000), setInterval(factory, 10000), setInterval(slow, 60000), setInterval(powerHist, 15000)];
    },
    hide() { timers.forEach(clearInterval); timers = []; },
  };
})();
