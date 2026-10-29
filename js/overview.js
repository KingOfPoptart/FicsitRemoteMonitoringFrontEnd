// Overview (home) tab: how the whole world is doing at a glance — what needs attention, power, production,
// vehicles and progression in one screen each linking to its tab, and a map of the whole factory.
"use strict";

const Overview = (() => {
  let d = {}, prod = null, veh = [], timers = [], map, chart, sinks = null;
  const root = $("tab-overview");
  // vehicles, machines and sinks come from the shared map sources (one fetch for the cards and every map)
  VehSrc.listeners.add(() => { veh = VehSrc.list; if (activeTab === "overview") render(); });
  FactorySrc.listeners.add(() => { prod = FactorySrc.prod; sinks = FactorySrc.sinks; if (activeTab === "overview") render(); });

  async function load(eps) {
    const res = await Promise.allSettled(eps.map(e => getJSON(e)));
    eps.forEach((e, i) => { if (res[i].status === "fulfilled") d[e] = res[i].value; });
    if (res.some(r => r.status === "fulfilled")) setConn(true); else setConn(false, res[0].reason?.message || "error");
  }
  async function fast() {
    await load(["getPower", "getSessionInfo", "getSpaceElevator", "getHUBTerminal", "getResourceSink", "getTradingPost"]);
    render();
  }
  // machines and items: the copy server.py's history recorder takes every 15 s does (these replies are the biggest FRM has)
  const extractors = () => Production.pollExtractors();   // for the machine popups' extractor history
  // ---- Logistics card: belts and pipes, tiers, unconnected ends (data from the shared /logistics fetch)
  function renderLogistics() {
    const nets = Logistics.networks;
    if (!nets.length || !$("ovLogi")) return;
    const km = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${fmtNum(m)} m`;
    const sum = (kind, k) => nets.filter(n => n.kind === kind).reduce((a, n) => a + n[k], 0);
    const tiers = [...[1, 2, 3, 4, 5, 6].map(t => ["belt", t]), ...[1, 2].map(t => ["pipe", t])]
      .map(([k, t]) => [k, t, (k === "belt" ? Logistics.belts : Logistics.pipes).filter(b => b.t === t).length]).filter(x => x[2]);
    const maxT = Math.max(1, ...tiers.map(x => x[2]));
    const open = nets.filter(n => n.open).sort((a, b) => b.open - a.open);
    $("ovLogi").innerHTML = `<div class="big">${km(sum("belt", "len"))} <small>of belts · ${km(sum("pipe", "len"))} of pipes</small></div>
      <div class="t-sub">${fmtNum(Logistics.belts.length)} belts in ${nets.filter(n => n.kind === "belt").length} networks · ${fmtNum(Logistics.pipes.length)} pipes in ${nets.filter(n => n.kind === "pipe").length}</div>
      <h3>By tier</h3>${tiers.map(([k, t, c]) => `<div class="part"><span class="with-icon"><i class="sw-line" style="background:${(k === "belt" ? BELT_COLOR : PIPE_COLOR)[t]}"></i>Mk.${t} ${k}s</span>${bar(c / maxT, (k === "belt" ? BELT_COLOR : PIPE_COLOR)[t])}<span class="muted">${fmtNum(c)}</span></div>`).join("")}
      ${(() => { const hl = Logistics.headlift; if (!hl) return "";
        const bad = [...hl.runs.filter(r => r.sev !== "ok").map(r => [r.sev, `${esc(r.fluid || "Pipe")} · ${fmtNum(r.over, 1)} m above ${esc(r.src?.name || "its source")}`]),
                     ...hl.pumps.filter(p => p.sev !== "ok").map(p => [p.sev, `${esc(p.name)} · pushing ${fmtNum(p.hl, 1)} of ${fmtNum(p.design)} m`])].sort((a, b) => (a[0] === "bad" ? 0 : 1) - (b[0] === "bad" ? 0 : 1));
        return bad.length ? `<h3>Head lift</h3>${bad.slice(0, 4).map(([s, t]) => `<div class="kvrow"><span>${t}</span><b class="${s === "bad" ? "bad-text" : "warn-text"}">${s === "bad" ? "too high" : "near limit"}</b></div>`).join("")}` : ""; })()}
      ${open.length ? `<h3>Unconnected ends</h3>${open.slice(0, 4).map(n => `<div class="kvrow"><span>${n.kind === "belt" ? "Belts" : "Pipes"} · ${esc(Object.keys(n.touches).slice(0, 2).join(", ") || "nothing connected")}</span><b class="warn-text">${n.open}</b></div>`).join("")}` : ""}`;
  }
  Logistics.listeners.add(() => render());

  async function slow() { await load(["getSchematics"]); render(); }
  async function powerHist() {
    try {
      const h = await (await fetch("/hist/power?mins=60", { cache: "no-store" })).json();
      // the biggest grid; if the live grid list hasn't arrived (or a request failed), the biggest one in the history
      const g = d.getPower && [...d.getPower].sort((a, b) => b.PowerCapacity - a.PowerCapacity)[0];
      const lastCap = k => { const c = h.groups[k].cap; for (let i = c.length - 1; i >= 0; i--) if (c[i] != null) return c[i]; return 0; };
      const key = g ? String(g.CircuitGroupID) : Object.keys(h.groups).sort((a, b) => lastCap(b) - lastCap(a))[0];
      const s = key && h.groups[key];
      chart.update(s ? { t: h.t, interval: h.interval, series: [
        // the same four lines as the Power tab (and the in-game power graph)
        { key: "cap", name: "Capacity", color: "var(--s3)", values: s.cap },
        { key: "prod", name: "Production", color: "var(--s1)", values: s.prod },
        { key: "cons", name: "Consumption", color: "var(--s2)", values: s.cons, area: true },
        { key: "max", name: "Max consumption", color: "var(--s4)", values: s.max, dash: true },
      ] } : null);
    } catch {}
  }

  // ---- what needs attention, worst first -----------------------------------------------------
  function attention() {
    const out = [], add = (level, text, tab) => out.push({ level, text, tab });
    if (stale) {   // the game server isn't answering: everything below is from the last state it reported
      const t = new Date(stale.since), today = t.toDateString() === new Date().toDateString();
      add("bad", `Game server is offline (since ${today ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : t.toLocaleString()}) — showing the last state it reported`, null);
    }
    for (const g of d.getPower || []) {
      const name = (d.getPower.length > 1 ? `Grid ${g.CircuitGroupID}: ` : "");
      if (g.FuseTriggered) add("bad", `${name}fuse tripped — the grid is off`, "power");
      else if (!g.PowerCapacity && g.PowerProduction > 0) continue;   // capacity not reported (no-power-cost world): no overload alarms
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
    const hl = Logistics.headlift;
    if (hl) {   // pipes above their head lift: "bad" only when the live readings back it up (fluid stops below them)
      const runs = hl.runs.filter(r => r.sev !== "ok"), pumps = hl.pumps.filter(p => p.sev !== "ok");
      const sure = runs.filter(r => r.sev === "bad" && r.live === "starved"), fluids = [...new Set(runs.map(r => r.fluid).filter(Boolean))];
      // red when a run is past where flow stops, unless nothing has reached it yet (can't tell)
      if (runs.length) add(runs.some(r => r.sev === "bad" && r.live !== "empty") ? "bad" : "warn", `${runs.length} pipe run${runs.length > 1 ? "s go" : " goes"} higher than ${runs.length > 1 ? "their" : "its"} pump, extractor or buffer can push${fluids.length ? ` (${fluids.slice(0, 3).join(", ")})` : ""}${sure.length ? ` — ${sure.length} already stay${sure.length > 1 ? "" : "s"} empty past that point` : ""}`, "pipes");
      if (pumps.length) add(pumps.some(p => p.sev === "bad") ? "bad" : "warn", `${pumps.length} pump${pumps.length > 1 ? "s are" : " is"} working past ${pumps.length > 1 ? "their" : "its"} head lift — flow drops${pumps.some(p => p.sev === "bad") ? " or stops" : ""}`, "pipes");
    }
    for (const kind of ["belt", "pipe"]) {   // unconnected ends, on the Belts and Pipes tabs
      const nets = Logistics.networks.filter(n => n.kind === kind && n.open), ends = nets.reduce((a, n) => a + n.open, 0);
      if (ends) add("info", `${ends} ${kind} end${ends === 1 ? " isn't" : "s aren't"} connected to anything (${nets.length} network${nets.length > 1 ? "s" : ""})`, kind + "s");
    }
    // each stuck vehicle by name with its problem, e.g. Train "Train" (2 locos+1 car): Station unreachable
    for (const v of veh.filter(v => v.status === "error"))
      add("bad", `${v.type} ${v.name && v.name !== v.type ? `"${v.name.trim()}"` : shortId(v.id)}${v.consist ? ` (${v.consist})` : ""}: ${vehicleProblem(v) || "autopilot error"}`, "vehicles");
    const se = Progression.seState(d.getSpaceElevator?.[0]);
    if (se?.ready) add("ok", `Space Elevator phase ${se.n} is ready to send`, "progression");
    const hub = d.getHUBTerminal?.[0];
    const cost = hub?.HasActiveMilestone ? hub.ActiveMilestone.Cost || [] : [];
    if (cost.length && cost.every(c => c.RemainingCost === 0)) add("ok", `HUB milestone "${hub.ActiveMilestone.Name}" is paid — ready to unlock`, "progression");
    else if (hub && !hub.HasActiveMilestone) add("info", "No milestone selected in the HUB terminal", "progression");
    const sink = d.getResourceSink?.[0];
    const dark = (sinks || []).filter(s => !s.on).length;
    if (dark) add("warn", `${dark} AWESOME Sink${dark > 1 ? "s have" : " has"} no power`, "sink");
    if (sink?.NumCoupon >= 10) add("info", `${sink.NumCoupon} FICSIT Coupons to spend in the AWESOME Shop`, "progression");
    const order = { bad: 0, warn: 1, ok: 2, info: 3 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  // ---- render ------------------------------------------------------------------------------------
  function render() {
    if (!$("ovAttn")) return;
    const s = d.getSessionInfo, players = Players.list;   // the map's shared player poll
    const online = players.filter(p => p.Online);
    $("ovSession").innerHTML = s ? `<b>${esc(s.SessionName)}</b><span class="muted"> · day ${s.PassedDays} · ${String(s.Hours).padStart(2, "0")}:${String(s.Minutes).padStart(2, "0")} ${s.IsDay ? "☀" : "☾"} · ${esc(s.TotalPlayDurationText)} played</span>
      <span class="muted"> · ${online.length ? `${online.length} online: ${online.map(p => esc(p.Name)).join(", ")}` : "nobody online"}</span>` : "";

    const items = attention();
    const ICON = { bad: "⛔", warn: "⚠", ok: "✓", info: "ℹ" };
    // no tab: the "server offline" item, which flashes the connection light in the header instead of opening a tab
    const html = items.length ? items.map(a => a.tab ? `<a class="attn ${a.level}" href="#${a.tab}"><span class="ai">${ICON[a.level]}</span><span>${esc(a.text)}</span><span class="go">${a.tab} →</span></a>`
        : `<a class="attn ${a.level}" href="#" data-flash-dot title="Show the connection light"><span class="ai">${ICON[a.level]}</span><span>${esc(a.text)}</span><span class="go">status ↗</span></a>`).join("")
      : `<p class="muted">All good — nothing needs attention.</p>`;
    if ($("ovAttn").dataset.html !== html) { $("ovAttn").innerHTML = html; $("ovAttn").dataset.html = html; }   // only when it changes: rebuilding it swallowed clicks

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
      ["Max use", `<span class="${maxOver ? "warn-text" : ""}" title="Max consumption: if every machine ran at once">${fmtNum(tot("PowerMaxConsumed"))} MW</span>`],
      ["Batteries", battPct == null ? "none" : pct(battPct)],
      ["Generators", gens.length ? `<span title="running / built">${gensOn} / ${gens.length}</span>` : "–"],
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
      ${errs.length ? `<h3>Stuck</h3>${errs.map(v => `<div class="kvrow"><span>${esc(v.type)} ${v.name && v.name.trim() !== v.type ? `"${esc(v.name.trim())}"` : esc(shortId(v.id))}</span><b class="bad-text">${esc(vehicleProblem(v) || "error")}</b></div>`).join("")}` : ""}`;

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

    // ---- Sink: points per minute, the next coupon, what earns the most
    const rs = d.getResourceSink?.[0];
    if (rs && $("ovSink")) {
      const avg = Sink.avg(rs), cost = Sink.cost(rs), perHour = avg && cost ? avg * 60 / cost : null;
      const items = sinks ? Sink.byItem(sinks).sort((a, b) => b.ptsMin - a.ptsMin) : [];
      const tot = items.reduce((a, i) => a + i.ptsMin, 0);
      $("ovSink").innerHTML = `<div class="big">${Sink.k(avg)} <small>points/min</small></div>
        <div class="t-sub">10-minute average · ${Sink.k(Sink.now(rs))} in the last minute</div>
        <div class="t-sub">${bar(rs.Percent, SINK_COLOR)}next coupon in ${Sink.dur(Sink.minsToNext(rs))}</div>
        <div class="t-sub">${fmtNum(rs.NumCoupon)} to print${perHour ? ` · about ${fmtNum(perHour, perHour < 10 ? 1 : 0)} coupons an hour` : ""}</div>
        ${items.length ? `<h3>Most points <span class="muted">what the feeding machines could send</span></h3>${items.slice(0, 5).map(i =>
          `<div class="part"><span class="with-icon">${icon(i.item, "icon sm")}<span>${esc(i.item)}</span></span>${bar(tot ? i.ptsMin / tot : 0, SINK_COLOR)}<span class="muted">${i.split ? "≤ " : ""}${Sink.k(i.ptsMin)}/min</span></div>`).join("")}` : ""}`;
    }

    renderLogistics();
    $("statsOv").innerHTML = (gs.length ? `<span class="stat"><b>${fmtNum(tot("PowerConsumed"))}</b>/ ${fmtNum(tot("PowerCapacity"))} MW</span>` : "") +
      (prod ? `<span class="stat"><b>${prod.machines.filter(m => m.status === "running" || m.status === "partial").length}</b>machines working</span>` : "") +
      `<span class="stat"><b>${veh.length}</b>vehicles</span>`;
  }

  function init() {
    root.innerHTML = `
      <div class="mt-left ov-left">
        <div class="ov-session" id="ovSession"></div>
        <div class="ov-stack">
          <section class="card ov-attn"><div class="card-head"><h2>Needs attention</h2></div><div id="ovAttn" class="attn-list" onclick="if (event.target.closest('[data-flash-dot]')) { event.preventDefault(); flashDot('bad'); }"></div></section>
            <a class="card link ov-card ov-power" href="#power"><div class="card-head"><h2>Power</h2><span class="hint">→</span></div>
              <div class="ov-power-side"><div id="ovPower"></div><div class="figs" id="ovPowerFigs"></div></div><div id="ovChart"></div></a>
          <div class="ov-row">
            <a class="card link ov-card ov-prod" href="#production"><div class="card-head"><h2>Production</h2><span class="hint">→</span></div><div class="ov-body" id="ovProd"><p class="muted">Loading…</p></div></a>
            <a class="card link ov-card ov-prog" href="#progression"><div class="card-head"><h2>Progression</h2><span class="hint">→</span></div><div class="ov-body" id="ovProg"></div></a>
          </div>
          <div class="ov-row">
            <a class="card link ov-card ov-veh" href="#vehicles"><div class="card-head"><h2>Vehicles</h2><span class="hint">→</span></div><div class="ov-body" id="ovVeh"></div></a>
            <a class="card link ov-card ov-logi" href="#belts"><div class="card-head"><h2>Belts &amp; pipes</h2><span class="hint">→</span></div><div class="ov-body" id="ovLogi"><p class="muted">Working out belts and pipes…</p></div></a>
            <a class="card link ov-card ov-sink" href="#sink"><div class="card-head"><h2>AWESOME Sink</h2><span class="hint">→</span></div><div class="ov-body" id="ovSink"><p class="muted">Loading…</p></div></a>
          </div>
        </div>
      </div>
      <section class="card map-panel ov-world"><div id="ovMap"></div></section>`;
    chart = new LineChart($("ovChart"), { height: 140, unit: "MW", fill: true });
    map = new MapView($("ovMap"), {
      // the whole world: every kind of thing is in the Layers menu; on to start with: the factory, transport, the power
      // network, belts, pipes, storage and hypertubes (resource nodes and collectibles are there, off)
      storeKey: "ov.map2", layerMenu: true, layers: [], drawsNetwork: true,
      world: { on: l => ["Factory", "Transport", "Stations", "Power network", "Belts", "Pipes", "Storage", "Hypertubes"].includes(l.group) },
      onClick: p => { if (p.tab) location.hash = p.tab; },
      draw: (c, now, mv) => drawNetwork(mv, k => mv.isOn(k)),   // roads, tracks, drone routes, stations (shared with Vehicles)
      extraTip: (mx, my) => { const st = stationAt(mx, my, map); return st ? stationPopHtml(st, veh) : null; },
    });
  }

  return {
    show() {
      if (!map) init();
      fast().then(powerHist); extractors(); slow(); Logistics.start(); VehSrc.need(); FactorySrc.need(); Players.need();
      if (!timers.length) timers = [every(fast, 3000), every(extractors, 15000), every(slow, 60000), every(powerHist, 15000)];
    },
    hide() { timers.forEach(stopPoll); timers = []; },
  };
})();
