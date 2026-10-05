// Progression tab: Space Elevator phase, milestones per tier, the HUB's active milestone, MAM research,
// AWESOME Sink, alternate recipes, collectibles and resource nodes — plus a map of what's left to find.
"use strict";

// Space Elevator phases (wiki, 1.0+): parts per phase, and what finishing it unlocks
const SE_PHASES = [
  { n: 1, name: "Distribution Platform", parts: ["Smart Plating"], unlocks: "Tiers 3 & 4" },
  { n: 2, name: "Construction Dock", parts: ["Smart Plating", "Versatile Framework", "Automated Wiring"], unlocks: "Tiers 5 & 6" },
  { n: 3, name: "Main Body", parts: ["Versatile Framework", "Modular Engine", "Adaptive Control Unit"], unlocks: "Tiers 7 & 8" },
  { n: 4, name: "Propulsion", parts: ["Assembly Director System", "Magnetic Field Generator", "Thermal Propulsion Rocket", "Nuclear Pasta"], unlocks: "Tier 9" },
  { n: 5, name: "Assembly", parts: ["Nuclear Pasta", "Biochemical Sculptor", "AI Expansion Server", "Ballistic Warp Drive"], unlocks: "Project Assembly launch" },
];
const TIER_PHASE = { 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 3, 9: 4 };   // phase that must be done first
// totals in the world (wiki, 1.0+); FRM lists the ones still out there
const COLLECTIBLES = [
  { name: "Somersloop", total: 106, color: "#e66767", note: "doubles a machine's output; MAM research; Alien Power Augmenter" },
  { name: "Mercer Sphere", total: 298, color: "#9085e9", note: "MAM research; Dimensional Depot uploaders" },
  { name: "Blue Power Slug", total: 596, color: "#3987e5", note: "1 power shard each" },
  { name: "Yellow Power Slug", total: 389, color: "#c98500", note: "2 power shards each" },
  { name: "Purple Power Slug", total: 257, color: "#d55181", note: "5 power shards each" },
];
const COL_LAYER = name => name === "Somersloop" ? "sloop" : name === "Mercer Sphere" ? "sphere" : "slug";
const fmtDur = mins => !isFinite(mins) || mins < 0 ? "–" : mins < 1 ? "<1 min" : mins < 60 ? `${Math.round(mins)} min` : mins < 48 * 60 ? `${(mins / 60).toFixed(1)} h` : `${(mins / 1440).toFixed(1)} days`;

// shared by the Overview tab too
function seState(se) {
  if (!se) return null;
  if (se.FullyUpgraded) return { done: true, phase: SE_PHASES[4], n: 5 };
  const names = (se.CurrentPhase || []).map(p => p.Name).sort().join("|");
  const phase = SE_PHASES.find(p => [...p.parts].sort().join("|") === names) || null;
  const parts = (se.CurrentPhase || []).map(p => ({ name: p.Name, total: p.TotalCost, left: p.RemainingCost, done: p.TotalCost - p.RemainingCost }));
  const frac = parts.reduce((a, p) => a + p.done, 0) / Math.max(1, parts.reduce((a, p) => a + p.total, 0));
  return { phase, n: phase ? phase.n : null, parts, frac, ready: se.UpgradeReady };
}
function milestoneTiers(schematics) {
  const tiers = {};
  for (const s of schematics) {
    const isHub = s.Type === "Tutorial" && /HUB Upgrade/i.test(s.Name || "");
    if (s.Type !== "Milestone" && !isHub) continue;
    const t = isHub ? 0 : s.TechTier;
    (tiers[t] = tiers[t] || { tier: t, list: [] }).list.push(s);
  }
  for (const t of Object.values(tiers)) {
    t.done = t.list.filter(s => s.Purchased).length;
    t.locked = t.list.every(s => s.Locked || s.LockedPhase) && !t.done;
  }
  return Object.values(tiers).sort((a, b) => a.tier - b.tier);
}

const Progression = (() => {
  let data = {}, timers = [], map, framed = false;
  const root = $("tab-progression");
  const ui = (() => { try { return { node: "", ...JSON.parse(localStorage.getItem("pg.ui") || "{}") }; } catch { return { node: "" }; } })();

  async function load(eps) {
    const res = await Promise.allSettled(eps.map(e => getJSON(e)));
    eps.forEach((e, i) => { if (res[i].status === "fulfilled") data[e] = res[i].value; });
    if (res.some(r => r.status === "fulfilled")) setConn(true); else setConn(false, res[0].reason?.message || "error");
    render();
  }
  const fast = () => load(["getSpaceElevator", "getHUBTerminal", "getResourceSink", "getProdStats", "getWorldInv", "getCloudInv"]);
  const slow = () => load(["getSchematics", "getResearchTrees", "getTradingPost", "getSessionInfo"]);
  const world = () => load(["getArtifacts", "getPowerSlug", "getResourceNode"]);

  const rateOf = name => (data.getProdStats || []).find(p => p.Name === name)?.CurrentProd || 0;
  const stockOf = name => ((data.getWorldInv || []).find(p => p.Name === name)?.Amount || 0) + ((data.getCloudInv || []).find(p => p.Name === name)?.Amount || 0);
  // one row per required part: delivered / total, what the factory makes per minute, what's in storage, time to finish
  const costRows = parts => `<div class="cost">${parts.map(p => {
    const rate = rateOf(p.name), stock = stockOf(p.name), need = Math.max(0, p.left - stock);
    return `<div class="cost-row"><span class="with-icon">${icon(p.name)}<span>${esc(p.name)}<br><span class="muted sub">${fmtNum(p.done)} / ${fmtNum(p.total)} delivered</span></span></span>
      ${bar(p.done / Math.max(1, p.total), p.left ? "var(--s1)" : "var(--ok)")}
      <span class="cost-meta">${p.left ? `<b>${fmtNum(p.left)}</b> to go<br><span class="muted sub">${stock ? `${fmtNum(stock)} in storage · ` : ""}${rate ? `making ${fmtRate(rate)}/min · ${need ? fmtDur(need / rate) : "enough stored"}` : need ? "not being made" : "enough stored"}</span>` : `<span style="color:var(--ok)">✓ done</span>`}</span></div>`;
  }).join("")}</div>`;

  function renderElevator() {
    const st = seState(data.getSpaceElevator?.[0]);
    if (!st) return `<p class="muted">No Space Elevator built yet.</p>`;
    const steps = SE_PHASES.map(p => {
      const cls = st.done || (st.n && p.n < st.n) ? "done" : p.n === st.n ? "cur" : "";
      return `<div class="step ${cls}"><b>${p.n}</b><span>${esc(p.name)}</span><span class="muted sub">→ ${esc(p.unlocks)}</span></div>`;
    }).join("");
    if (st.done) return `<div class="steps">${steps}</div><p>Project Assembly is complete. 🚀</p>`;
    return `<div class="steps">${steps}</div>
      <p class="lead">Phase ${st.n ?? "?"}${st.phase ? ` · ${esc(st.phase.name)}` : ""} — ${pct(st.frac * 100)} delivered${st.phase ? ` · unlocks ${esc(st.phase.unlocks)}` : ""}
      ${st.ready ? ` <span class="pill" style="color:var(--ok);background:#5fcf8022">ready to send — pull the lever</span>` : ""}</p>${costRows(st.parts)}`;
  }

  function renderHub() {
    const h = data.getHUBTerminal?.[0], lvl = data.getTradingPost?.[0]?.HUBLevel;
    if (!h) return `<p class="muted">No HUB terminal.</p>`;
    if (!h.HasActiveMilestone) return `<p class="muted">No milestone selected in the HUB terminal${lvl != null ? ` · HUB level ${lvl}` : ""}.</p>`;
    const m = h.ActiveMilestone;
    const parts = (m.Cost || []).map(c => ({ name: c.Name, total: c.TotalCost ?? c.Amount, left: c.RemainingCost ?? c.Amount, done: (c.TotalCost ?? c.Amount) - (c.RemainingCost ?? c.Amount) }));
    const unlocks = (m.Recipes || []).map(r => r.Name);
    return `<p class="lead">Tier ${m.TechTier} · <b>${esc(m.Name)}</b>${unlocks.length ? ` <span class="muted">— unlocks ${unlocks.map(esc).join(", ")}</span>` : ""}</p>${costRows(parts)}`;
  }

  function renderTiers() {
    const tiers = milestoneTiers(data.getSchematics || []);
    const st = seState(data.getSpaceElevator?.[0]);
    const phaseDone = st ? (st.done ? 5 : (st.n || 1) - 1) : 0;
    return `<div class="tiers">${tiers.map(t => {
      const gate = TIER_PHASE[t.tier] || 0, locked = gate > phaseDone && !t.done;
      return `<div class="tier${locked ? " locked" : ""}">
        <div class="tier-head"><b>Tier ${t.tier}</b>${bar(t.done / t.list.length, t.done === t.list.length ? "var(--ok)" : "var(--s1)")}<span class="muted">${t.done}/${t.list.length}</span>
          ${locked ? `<span class="muted sub">needs elevator phase ${gate}</span>` : ""}</div>
        <div class="ms">${t.list.map(s => `<span class="m${s.Purchased ? " got" : ""}" title="${s.Purchased ? "Unlocked" : locked ? "Locked" : "Available"}">${s.Purchased ? "✓ " : ""}${esc(s.Name)}</span>`).join("")}</div></div>`;
    }).join("")}</div>`;
  }

  function renderOther() {
    const sch = data.getSchematics || [];
    const count = type => { const l = sch.filter(s => s.Type === type && s.Name); return [l.filter(s => s.Purchased).length, l.length]; };
    const [alt, altN] = count("Alternate"), [shop, shopN] = count("Resource Sink"), [mam, mamN] = count("M.A.M.");
    const sink = data.getResourceSink?.[0];
    const trees = (data.getResearchTrees || []).filter(t => t.Nodes.length);
    return `
      <div class="kv">
        <div><span class="muted">Alternate recipes</span><b>${alt} <small class="muted">of ${altN}</small></b><span class="muted sub">from hard drives (MAM)</span></div>
        <div><span class="muted">AWESOME Shop</span><b>${shop} <small class="muted">of ${shopN}</small></b><span class="muted sub">items bought</span></div>
        <div><span class="muted">MAM research</span><b>${mam} <small class="muted">of ${mamN}</small></b><span class="muted sub">nodes researched</span></div>
        ${sink ? `<div><span class="muted">FICSIT Coupons</span><b>${fmtNum(sink.NumCoupon)}</b><span class="muted sub">to spend · ${pct(sink.Percent * 100)} to the next</span></div>
        <div><span class="muted">Sink points</span><b>${fmtNum(sink.TotalPoints / 1e6, 1)}M</b><span class="muted sub">${fmtNum(sink.PointsToCoupon)} for the next coupon</span></div>` : ""}
      </div>
      <h3>MAM research trees</h3>
      <div class="hbars">${trees.map(t => { const done = t.Nodes.filter(n => n.State === "Purchased").length, busy = t.Nodes.filter(n => /Research/i.test(n.State)).length;
        return `<div class="hb"><div class="hb-label">${esc(t.Name)}${busy ? ` <span class="pill" style="color:var(--info);background:#5fa8ef22">researching</span>` : ""}</div>
          <div class="hb-track"><i class="cap" style="width:100%;background:var(--track)"></i><i style="width:${done / t.Nodes.length * 100}%;background:${done === t.Nodes.length ? "var(--ok)" : "var(--s1)"}"></i></div>
          <div class="hb-val"><b>${done}</b> <span class="muted">/ ${t.Nodes.length}</span></div></div>`; }).join("")}</div>`;
  }

  function renderWorld() {
    const left = name => [...(data.getArtifacts || []), ...(data.getPowerSlug || [])].filter(a => a.Name === name).length;
    const loaded = data.getArtifacts && data.getPowerSlug;
    const nodes = data.getResourceNode || [];
    const byRes = new Map();
    for (const n of nodes) {
      const r = byRes.get(n.Name) || { name: n.Name, n: 0, tapped: 0, pure: 0, pureT: 0 };
      r.n++; if (n.Exploited) r.tapped++; if (n.Purity === "Pure") { r.pure++; if (n.Exploited) r.pureT++; }
      byRes.set(n.Name, r);
    }
    const tapped = nodes.filter(n => n.Exploited).length;
    return `
      <h3>Collectibles found</h3>
      <div class="hbars">${COLLECTIBLES.map(c => { const found = loaded ? c.total - left(c.name) : 0;
        return `<div class="hb${ui.node === c.name ? " on" : ""}" data-node="${esc(c.name)}" title="${esc(c.note)} · click to find the ones still out there"><div class="hb-label"><span class="with-icon">${icon(c.name, "icon sm")}<span>${esc(c.name)}<br><span class="muted sub">${esc(c.note)}</span></span></span></div>
          <div class="hb-track"><i class="cap" style="width:100%;background:var(--track)"></i><i style="width:${found / c.total * 100}%;background:var(--s1)"></i></div>
          <div class="hb-val">${loaded ? `<b>${found}</b> <span class="muted">/ ${c.total}</span>` : "…"}</div></div>`; }).join("")}</div>
      <h3>Resource nodes tapped · ${tapped} of ${nodes.length} <span class="muted sub">(incl. wells and geysers)</span></h3>
      <div class="hbars">${[...byRes.values()].sort((a, b) => b.tapped - a.tapped || a.name.localeCompare(b.name)).map(r =>
        `<div class="hb${ui.node === r.name ? " on" : ""}" data-node="${esc(r.name)}" title="Click to show only ${esc(r.name)} on the map"><div class="hb-label"><span class="with-icon">${icon(r.name, "icon sm")}<span>${esc(r.name)}<br><span class="muted sub">${r.pureT}/${r.pure} pure tapped</span></span></span></div>
          <div class="hb-track"><i class="cap" style="width:100%;background:var(--track)"></i><i style="width:${r.tapped / r.n * 100}%;background:var(--s3)"></i></div>
          <div class="hb-val"><b>${r.tapped}</b> <span class="muted">/ ${r.n}</span></div></div>`).join("")}</div>`;
  }

  function renderMap() {
    if (!map) return;
    const pt = (a, extra) => ({ id: a.ID, x: a.location.x, y: a.location.y, ...extra });
    const col = name => COLLECTIBLES.find(c => c.name === name)?.color;
    map.setPoints("sloop", (data.getArtifacts || []).filter(a => a.Name === "Somersloop").map(a => pt(a, { label: "Somersloop" })));
    map.setPoints("sphere", (data.getArtifacts || []).filter(a => a.Name === "Mercer Sphere").map(a => pt(a, { label: "Mercer Sphere" })));
    map.setPoints("slug", (data.getPowerSlug || []).map(a => pt(a, { label: a.Name, color: col(a.Name) })));
    const pickCol = COLLECTIBLES.find(c => c.name === ui.node);   // a collectible picked (vs a resource)
    const nodes = (data.getResourceNode || []).filter(n => !ui.node || pickCol || n.Name === ui.node);
    const nl = n => `${n.Name} · ${n.Purity}${n.NodeType !== "Node" ? " · " + n.NodeType : ""}${n.Exploited ? " · tapped" : ""}`;
    map.setPoints("free", nodes.filter(n => !n.Exploited).map(n => pt(n, { label: nl(n), color: n.Purity === "Pure" ? "#f2f2f2" : n.Purity === "Normal" ? "#aab1bd" : "#6b7380" })));
    map.setPoints("tapped", nodes.filter(n => n.Exploited).map(n => pt(n, { label: nl(n) })));
    // a resource picked from the list: its nodes drawn big with a ring (white = untapped, green = tapped), the rest fades
    // the picked thing is drawn big with a ring (resources: white = untapped, green = tapped; collectibles: their colour)
    const BASE = { free: 3, tapped: 3.5, sloop: 4.5, sphere: 4, slug: 3 };
    for (const l of map.layers) if (l.key in BASE) l.size = BASE[l.key] * (ui.node && (pickCol ? l.key === COL_LAYER(pickCol.name) : l.key === "free" || l.key === "tapped") ? 1.8 : 1);
    map.setEmphasis(!ui.node ? null : pickCol
      ? new Map([...(data.getArtifacts || []), ...(data.getPowerSlug || [])].filter(a => a.Name === pickCol.name).map(a => [a.ID, pickCol.color]))
      : new Map(nodes.map(n => [n.ID, n.Exploited ? "#5fcf80" : "#ffffff"])));
    // frame the map once the collectibles and nodes have loaded (players arrive first and would otherwise set the zoom)
    if (!framed && data.getArtifacts && data.getResourceNode) { framed = true; ui.node ? map.fitEmphasis() : map.fit(); }
    $("pgNodeFilter").innerHTML = ui.node ? `Showing: <b>${esc(ui.node)}</b> <button class="b" data-clear-node>Show all</button>` : "Click a collectible or resource to find it";
  }

  function render() {
    if (!$("pgElevator")) return;
    $("pgElevator").innerHTML = renderElevator();
    $("pgHub").innerHTML = renderHub();
    $("pgTiers").innerHTML = data.getSchematics ? renderTiers() : `<p class="muted">Loading…</p>`;
    $("pgOther").innerHTML = renderOther();
    $("pgWorld").innerHTML = renderWorld();
    renderMap();
    const st = seState(data.getSpaceElevator?.[0]), tiers = milestoneTiers(data.getSchematics || []);
    const top = tiers.filter(t => t.done).pop();
    $("statsProg").innerHTML = (top ? `<span class="stat"><b>Tier ${top.tier}</b>reached</span>` : "") +
      (st ? `<span class="stat"><b>${st.done ? "Done" : "Phase " + st.n}</b>space elevator</span>` : "") +
      (data.getResourceSink ? `<span class="stat"><b>${data.getResourceSink[0].NumCoupon}</b>coupons</span>` : "");
  }

  function init() {
    // three columns: elevator + HUB + research | milestones + exploration | the map, full height (one screen on desktop)
    root.innerHTML = `
      <div class="pgrid">
        <div class="pcol">
          <section class="card g-elev"><div class="card-head"><h2>Space Elevator</h2><span class="hint">parts delivered, what the factory makes, time to finish</span></div><div class="card-body" id="pgElevator"></div></section>
          <section class="card g-hub"><div class="card-head"><h2>HUB milestone</h2><span class="hint">selected in the HUB terminal</span></div><div class="card-body" id="pgHub"></div></section>
          <section class="card g-other"><div class="card-head"><h2>Research &amp; unlocks</h2></div><div class="card-body" id="pgOther"></div></section>
        </div>
        <div class="pcol">
          <section class="card g-tiers"><div class="card-head"><h2>Milestones</h2><span class="hint">tiers open as the Space Elevator advances</span></div><div class="card-body" id="pgTiers"></div></section>
          <section class="card g-world"><div class="card-head"><h2>Exploration</h2><span class="hint">click a collectible or resource to find it on the map</span></div><div class="card-body" id="pgWorld"></div></section>
        </div>
        <div class="pcol">
          <section class="card g-map"><div class="card-head"><h2>Exploration map</h2><span class="hint" id="pgNodeFilter"></span></div><div id="pgMap"></div></section>
        </div>
      </div>`;
    map = new MapView($("pgMap"), {
      storeKey: "pg.map", layerMenu: true, players: true, layers: [
        { key: "sloop", group: "Collectibles", label: "Somersloops", color: "#e66767", size: 4.5, shape: "diamond" },
        { key: "sphere", group: "Collectibles", label: "Mercer Spheres", color: "#9085e9", size: 4, shape: "diamond" },
        { key: "slug", group: "Collectibles", label: "Power slugs", color: "#3987e5", size: 3, on: false },
        { key: "free", group: "Resource nodes", label: "Untapped nodes", color: "#aab1bd", size: 3, shape: "square", on: false },
        { key: "tapped", group: "Resource nodes", label: "Tapped nodes", color: "#199e70", size: 3.5, shape: "square" },
      ],
      tooltip: p => `<div class="row"><span>${esc(p.label)}</span></div>`,
    });
    root.addEventListener("click", e => {
      const n = e.target.closest("[data-node]");
      if (n) {
        ui.node = ui.node === n.dataset.node ? "" : n.dataset.node;
        // make sure what was picked is visible: its collectible layer, or both node layers
        if (ui.node) { const col = COLLECTIBLES.find(c => c.name === ui.node); map.setLayers(col ? { [COL_LAYER(col.name)]: true } : { free: true, tapped: true }); }
      }
      else if (e.target.closest("[data-clear-node]")) ui.node = "";
      else return;
      try { localStorage.setItem("pg.ui", JSON.stringify(ui)); } catch {}
      render(); ui.node ? map.fitEmphasis() : map.fit();   // zoom to the picked resource's nodes
    });
  }

  return {
    seState, milestoneTiers,
    show() {
      if (!map) init();
      fast(); slow(); world();
      if (!timers.length) timers = [setInterval(fast, 10000), setInterval(slow, 60000), setInterval(world, 300000)];
    },
    hide() { timers.forEach(clearInterval); timers = []; },
  };
})();
