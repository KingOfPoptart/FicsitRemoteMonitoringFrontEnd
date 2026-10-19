// Sink tab: FICSIT Coupon income. Points per minute (the in-game graph, plus server.py's own history), progress to
// the next coupon, and what each AWESOME Sink is fed: server.py's /sinks follows the belts back from every sink to
// the machines, storage and stations they start at. Belts don't report their flow, so a machine's output is what it
// could send — when a splitter on the way sends some of it elsewhere (overflow), the sink only gets part of it.
"use strict";

// shared with the Overview card
const Sink = {
  // pts/min: 136,000 → "136k"
  k: v => v == null || isNaN(v) ? "–" : v >= 1e6 ? `${fmtNum(v / 1e6, 2)}M` : v >= 1e4 ? `${fmtNum(v / 1000, 0)}k` : fmtNum(v),
  // what the game's own sink graph shows: the last 10 one-minute readings, newest last
  graph: s => s?.GraphPoints || [],
  avg: s => { const g = Sink.graph(s); return g.length ? g.reduce((a, v) => a + v, 0) / g.length : null; },
  now: s => Sink.graph(s).at(-1) ?? null,
  // points this coupon costs in all (FRM gives what's left and how far along it is)
  cost: s => s && s.Percent < 1 ? s.PointsToCoupon / (1 - s.Percent) : null,
  minsToNext: s => { const a = Sink.avg(s); return a > 0 ? s.PointsToCoupon / a : null; },
  dur: m => m == null ? "–" : m < 1 ? "under a minute" : m < 90 ? `${Math.round(m)} min` : `${fmtNum(m / 60, 1)} h`,
  // each source once (a machine can feed two sinks): [{item, pts, rate, ptsMin, sinks:Set, srcs:Set, split}]
  byItem(sinks) {
    const items = new Map(), seen = new Set();
    for (const s of sinks) for (const f of s.feeds) {
      const it = items.get(f.item) || { item: f.item, pts: f.pts, rate: 0, max: 0, ptsMin: 0, sinks: new Set(), srcs: new Set(), split: false, recipes: new Set() };
      items.set(f.item, it);
      it.sinks.add(s.id); it.recipes.add(f.recipe); it.split ||= f.split;
      const key = f.src + "|" + f.item; if (seen.has(key)) continue;
      seen.add(key); it.srcs.add(f.src); it.rate += f.rate; it.max += f.max; it.ptsMin += f.rate * f.pts;
    }
    return [...items.values()];
  },
  feedPts: s => s.feeds.reduce((a, f) => a + f.rate * f.pts, 0),
  // a sink's popup (Sink tab and Overview maps): what feeds it, points, belts in, power
  tip(s, name) {
    const items = Sink.byItem([s]).sort((a, b) => b.ptsMin - a.ptsMin);
    return Pop.head("AWESOME Sink", { id: shortId(s.id), sub: name ? esc(name) : "", status: s.on ? "Powered" : "No power", color: s.on ? SINK_COLOR : "var(--bad)" }) +
      Pop.sec("Intake") + Pop.row("Could take in", s.feeds.length ? `${s.feeds.some(f => f.split) ? "≤ " : ""}${Sink.k(Sink.feedPts(s))}${Pop.unit("points/min")}` : "–") +
      Pop.row("Belts in", fmtNum(s.inputs)) + (s.loose ? Pop.row("From nothing", `<span class="warn-text">${s.loose} belt${s.loose > 1 ? "s" : ""}</span>`) : "") +
      (items.length ? Pop.sec("Fed by") + items.slice(0, 8).map(i => Pop.item(i.item, `${fmtRate(i.rate)}${Pop.unit(`/min · ${Sink.k(i.ptsMin)} pts`)}`)).join("") : "") +
      (s.other.length ? Pop.sec("Also from") + s.other.slice(0, 4).map(o => Pop.row(esc(o.name), o.holds.map(h => `${fmtNum(h.n)} ${esc(h.item)}`).join(", ") || "empty")).join("") : "") +
      (!s.inputs ? Pop.note("no belts go into it") : "");
  },
  async sinks() { const r = await fetch("/sinks", { cache: "no-store" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
};

// indigo: nothing else on the maps uses it (orange is the HUB and Space Elevator)
const SINK_COLOR = "#818cf8";

const SinkTab = (() => {
  const root = $("tab-sink");
  const RANGES = [["10m", 10], ["1h", 60], ["6h", 360], ["24h", 1440]];
  const ui = (() => { try { return { range: 60, ...JSON.parse(localStorage.getItem("sk.ui") || "{}") }; } catch { return { range: 60 }; } })();
  const saveUi = () => { try { localStorage.setItem("sk.ui", JSON.stringify(ui)); } catch {} };
  const FEED_COLOR = "#e5e7eb";
  let inited = false, framed = false, timers = [], chart, map, itemTable, sinkTable;
  let res = null, dna = null, hist = null, data = null, rows = [], sel = null;   // sel = selected sink id

  const itemCell = name => `<span class="with-icon">${icon(name, "icon sm")}${esc(name)}</span>`;
  const upTo = (v, split) => split ? `<span title="Some of it is split off to somewhere else on the way, so the sink gets less than this">≤ ${Sink.k(v)}</span>` : Sink.k(v);

  // one row per sink, named after what feeds it most (like the Power tab's grids); same names numbered
  function sinkRows() {
    const list = (data?.sinks || []).map(s => {
      const items = Sink.byItem([s]).sort((a, b) => b.ptsMin - a.ptsMin);
      const top = items.filter(i => i.ptsMin > 0);
      const base = top.length ? top[0].item + (top.length > 1 ? ` +${top.length - 1}` : "")
        : s.other.length ? s.other.map(o => o.name)[0] : s.inputs ? "Nothing traced" : "No belts in";
      return { ...s, items, ptsMin: Sink.feedPts(s), split: s.feeds.some(f => f.split), base };
    });
    const count = {}; list.forEach(r => count[r.base] = (count[r.base] || 0) + 1);
    const n = {};
    [...list].sort((a, b) => b.ptsMin - a.ptsMin || a.id.localeCompare(b.id))
      .forEach(r => r.name = count[r.base] > 1 ? `${r.base} (${n[r.base] = (n[r.base] || 0) + 1})` : r.base);
    return list;
  }

  async function poll() {
    const [a, b] = await Promise.allSettled([getJSON("getResourceSink"), getJSON("getExplorationSink")]);
    if (a.status === "fulfilled") { res = a.value[0]; setConn(true); } else setConn(false, a.reason?.message || "error");
    if (b.status === "fulfilled") dna = b.value[0];
    render();
  }
  async function pollSinks() { try { data = await Sink.sinks(); rows = sinkRows(); } catch {} render(); placeSinks(); }
  async function pollHistory() {
    try {
      const range = ui.range, h = await (await fetch(`/hist/sink?mins=${range}`, { cache: "no-store" })).json();
      if (range === ui.range) { hist = h; renderChart(); }
    } catch {}
  }

  function renderChart() {
    if (!chart) return;
    const vals = hist?.points || [], have = vals.filter(v => v != null).length;
    if (have >= 3) {
      const hasDna = (hist.dna || []).some(v => v > 0);
      chart.update({ t: hist.t, interval: hist.interval, series: [
        { key: "pts", name: "Standard points", color: SINK_COLOR, values: vals, area: true },
        ...(hasDna ? [{ key: "dna", name: "DNA points", color: "#c39cf7", values: hist.dna }] : []),
      ] });
      $("skChartHint").textContent = "points per minute, averaged over each minute · hover for values";
    } else {   // nothing recorded yet: the game's own graph (one reading a minute)
      const g = Sink.graph(res), now = Math.round(Date.now() / 1000);
      chart.update(g.length ? { t: g.map((_, i) => now - (g.length - 1 - i) * 60), interval: 60,
        series: [{ key: "pts", name: "Standard points", color: SINK_COLOR, values: g, area: true }] } : null);
      $("skChartHint").textContent = "the in-game graph (last 10 minutes) until the server has recorded some history";
    }
  }

  function render() {
    if (!inited) return;
    setSeg($("skRange"), segControl("range", RANGES.map(([l, v]) => ({ v, label: l })), o => ui.range === o.v));
    const s = res;
    if (s) {
      const avg = Sink.avg(s), now = Sink.now(s), cost = Sink.cost(s), next = Sink.minsToNext(s);
      const perHour = avg && cost ? avg * 60 / cost : null;
      const on = rows.filter(r => r.on).length, idle = rows.filter(r => !r.feeds.length && !r.other.length).length;
      const dnaAvg = Sink.avg(dna);
      $("skTiles").innerHTML = `
        <div class="tile" title="The newest reading on the in-game sink graph"><div class="t-label">Points now</div><div class="t-val">${Sink.k(now)} <small>/min</small></div><div class="t-sub">the last minute, like the in-game graph</div></div>
        <div class="tile" title="Average of the 10 readings on the in-game graph"><div class="t-label">10-minute average</div><div class="t-val">${Sink.k(avg)} <small>/min</small></div>
          <div class="t-sub">${perHour ? `about ${fmtNum(perHour, perHour < 10 ? 1 : 0)} coupon${perHour >= 0.95 && perHour < 1.05 ? "" : "s"} an hour` : "nothing sunk lately"}</div></div>
        <div class="tile"><div class="t-label">Next coupon</div><div class="t-val">${Sink.dur(next)}</div>
          <div class="t-sub">${bar(s.Percent, SINK_COLOR)}${fmtNum(s.PointsToCoupon)} points to go${cost ? ` of ${Sink.k(cost)}` : ""}</div></div>
        <div class="tile"><div class="t-label">Coupons to print</div><div class="t-val">${fmtNum(s.NumCoupon)}</div><div class="t-sub">print them at any AWESOME Sink</div></div>
        <div class="tile click${sel ? "" : " on"}" data-act="all" title="Show every sink"><div class="t-label">AWESOME Sinks</div><div class="t-val">${rows.length || "–"}</div>
          <div class="t-sub">${rows.length ? `${on} powered${idle ? ` · <span class="warn-text">${idle} with nothing coming in</span>` : ""}` : "tracing belts…"}</div></div>
        <div class="tile"><div class="t-label">Points so far</div><div class="t-val">${Sink.k(s.TotalPoints)}</div>
          <div class="t-sub">DNA: ${dnaAvg ? `${Sink.k(dnaAvg)}/min · ` : ""}${fmtNum(dna?.PointsToCoupon)} to the next coupon</div></div>`;
      $("statsSink").innerHTML = `<span class="stat"><b>${Sink.k(avg)}</b>points/min</span><span class="stat"><b>${Sink.dur(next)}</b>to the next coupon</span>` +
        (s.NumCoupon ? `<span class="stat" style="color:var(--ok)"><b>${fmtNum(s.NumCoupon)}</b>to print</span>` : "");
    }
    if (!data) return;
    const selRow = sel && rows.find(r => r.id === sel);
    const items = selRow ? selRow.items : Sink.byItem(rows);
    const tot = items.reduce((a, i) => a + i.ptsMin, 0);
    items.forEach(i => i.share = tot ? i.ptsMin / tot : 0);
    itemTable.render(items);
    $("skItemHint").innerHTML = !data.traced ? `<span class="warn-text">this FRM build doesn't say what belts connect to</span>`
      : selRow ? `fed to <b>${esc(selRow.name)}</b> · <a href="#" data-act="all">show every sink</a>` : `${items.length} items into ${rows.length} sinks`;
    $("skItemClear").disabled = !itemTable.hasFilters();
    sinkTable.render(rows);
    $("skSinkCount").textContent = `${sinkTable.filtered.length} of ${rows.length}`;
    $("skSinkClear").disabled = !sinkTable.hasFilters();
    const avg = Sink.avg(s);
    $("skNote").innerHTML = tot && avg != null ? `The machines feeding the sinks make up to <b>${Sink.k(tot)}</b> points/min${selRow ? " for this sink" : ""}; ${selRow ? "all sinks together" : "the sinks"} actually take in <b>${Sink.k(avg)}</b>/min (10-minute average). ` +
      `The difference goes elsewhere at splitters (marked ≤) — a sink on an overflow only gets what the rest of the factory doesn't use.` : "";
  }

  function placeSinks() {
    if (!map || !data) return;
    map.setPoints("sinks", rows.map(r => ({ id: r.id, x: r.x, y: r.y, color: r.on ? SINK_COLOR : "var(--bad)", tip: () => sinkTip(r) })));
    const seen = new Map();
    for (const r of rows) for (const f of r.feeds) {
      const p = seen.get(f.src) || { id: f.src, x: f.x, y: f.y, items: new Map(), sinks: new Set() };
      p.items.set(f.item, f); p.sinks.add(r.id); seen.set(f.src, p);
    }
    map.setPoints("feeds", [...seen.values()].map(p => ({ ...p, label: [...p.items.values()].map(f => `${f.building} · ${f.recipe}`)[0],
      tip: () => { const f0 = [...p.items.values()][0], m = Production.machine?.(p.id);
        return m ? Production.machinePop(m) + Pop.sec("Feeds") + [...p.sinks].map(id => Pop.note(esc(rows.find(r => r.id === id)?.name || ""), "")).join("")
          : Pop.head(f0.building, { id: shortId(p.id), sub: esc(f0.recipe) }) + Pop.sec("Sends to the sinks") +
            [...p.items.values()].map(f => Pop.item(f.item, `${fmtRate(f.rate)}${Pop.unit(`/min · ${Sink.k(f.rate * f.pts)} pts`)}`)).join("") +
            Pop.sec("Feeds") + [...p.sinks].map(id => Pop.note(esc(rows.find(r => r.id === id)?.name || ""), "")).join(""); } })));
    if (!framed) { framed = true; map.autoFit(); }   // once: after that the view is the user's
    emphasize();
  }
  function sinkTip(r) { return Sink.tip(r, r.name); }
  // the selected sink and the machines feeding it stand out on the map
  function emphasize() {
    if (!map) return;
    const r = sel && rows.find(x => x.id === sel);
    if (!r) { map.setEmphasis(null); return; }
    const em = new Map([[r.id, "#ffffff"]]);
    for (const f of r.feeds) em.set(f.src, SINK_COLOR);
    map.setEmphasis(em);
  }
  function pick(id) {
    sel = sel === id ? null : id;
    render(); emphasize();
    if (sel) map.fitEmphasis(); else map.fit();
  }

  function init() {
    root.innerHTML = `
      <div class="toolbar"><div class="seg-group right"><span class="lbl">History</span><span id="skRange"></span></div></div>
      <div class="tiles compact" id="skTiles"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card sk-chart"><div class="card-head"><h2>Points per minute</h2><span class="hint" id="skChartHint"></span></div><div id="skChart"></div></section>
          <section class="card sk-items"><div class="card-head"><h2>What's being sunk</h2><span class="hint" id="skItemHint"></span>
              <button class="b" id="skItemClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="skItems"></div><p class="muted small sk-note" id="skNote"></p></section>
        </div>
        <div class="pcol">
          <section class="card sk-map"><div id="skMap"></div></section>
          <section class="card sk-sinks"><div class="card-head"><h2>Sinks</h2><span class="hint" id="skSinkCount"></span>
              <button class="b" id="skSinkClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="skSinks"></div></section>
        </div>
      </div>`;
    chart = new LineChart($("skChart"), { height: 200, unit: "pts/min", fmt: v => Sink.k(v), empty: "No readings yet." });
    itemTable = new DataTable($("skItems"), [
      { key: "item", label: "Item", minW: 170, val: r => r.item, filter: { value: r => r.item, noun: "items", label: v => icon(v, "icon sm") + esc(v) }, cell: r => itemCell(r.item) },
      { key: "rate", label: "Made", num: true, minW: 74, title: "What the machines feeding the sinks make per minute now (some may go elsewhere at splitters)", val: r => r.rate,
        cell: r => `${fmtRate(r.rate)}<span class="muted sub">/min</span>` },
      { key: "pts", label: "Points", num: true, minW: 66, title: "Sink points for one of this item", val: r => r.pts, cell: r => fmtNum(r.pts) },
      { key: "ptsMin", label: "Pts/min", num: true, minW: 82, title: "Made per minute × points. ≤ = a splitter on the way sends some of it elsewhere", val: r => r.ptsMin, cell: r => upTo(r.ptsMin, r.split) },
      { key: "share", label: "Share", num: true, minW: 110, title: "Its part of the points the feeding machines could send", val: r => r.share,
        cell: r => `<span class="nowrap">${bar(r.share, SINK_COLOR)} ${pct(r.share * 100)}</span>` },
      { key: "srcs", label: "Machines", num: true, minW: 74, title: "Machines making it, and the recipes they use", val: r => r.srcs.size,
        cell: r => `${r.srcs.size}<br><span class="muted sub">${esc([...r.recipes].join(", "))}</span>` },
      { key: "sinks", label: "Sinks", num: true, minW: 56, val: r => r.sinks.size, cell: r => r.sinks.size },
    ], { sortKey: "ptsMin", dir: -1, storeKey: "sk.items", empty: "Nothing traced into the sinks.", onFilter: render,
         rowAttrs: r => `data-item="${esc(r.item)}"` });
    sinkTable = new DataTable($("skSinks"), [
      { key: "name", label: "Sink", minW: 170, val: r => r.name, filter: { text: r => r.name },
        cell: r => `<span class="with-icon">${r.items[0] ? icon(r.items[0].item, "icon sm") : ""}${esc(r.name)}</span>` },
      { key: "ptsMin", label: "Pts/min", num: true, minW: 82, title: "Up to: what the machines feeding it make × points", val: r => r.ptsMin,
        cell: r => r.ptsMin ? upTo(r.ptsMin, r.split) : `<span class="muted">–</span>` },
      { key: "feeds", label: "Fed by", minW: 200, val: r => r.items.map(i => i.item).join(", "),
        filter: { value: r => r.items.map(i => i.item), noun: "items", label: v => icon(v, "icon sm") + esc(v) },
        cell: r => [r.items.length ? r.items.slice(0, 3).map(i => `${esc(i.item)} <span class="muted">${fmtRate(i.rate)}/min</span>`).join("<br>") + (r.items.length > 3 ? `<br><span class="muted">+${r.items.length - 3} more</span>` : "") : "",
                    r.other.length ? `<span class="muted">${r.other.length > 1 ? `${r.other.length} × ` : ""}${esc(r.other[0].name)}${r.other.length > 1 ? " …" : ""}</span>` : "",
                    !r.inputs ? `<span class="warn-text">no belts in</span>` : r.loose ? `<span class="warn-text">${r.loose} belt${r.loose > 1 ? "s" : ""} from nothing</span>` : ""].filter(Boolean).join("<br>") },
      { key: "inputs", label: "Belts", num: true, minW: 56, title: "Belts going into it", val: r => r.inputs, cell: r => r.inputs },
      { key: "on", label: "Power", minW: 70, val: r => r.on ? 1 : 0,
        filter: { value: r => r.on ? "Powered" : "No Power", noun: "", all: () => [{ value: "Powered" }, { value: "No Power" }], ord: true },
        cell: r => r.on ? `<span style="color:var(--ok)">Powered</span>` : `<span class="bad-text">No Power</span>` },
    ], { sortKey: "ptsMin", dir: -1, storeKey: "sk.sinks", empty: "No AWESOME Sinks.", onFilter: render,
         rowAttrs: r => `data-sink="${esc(r.id)}" class="${r.id === sel ? "sel" : ""}"` });
    map = new MapView($("skMap"), {
      storeKey: "sk.map", layerMenu: true, world: { on: l => l.group === "Belts" || l.group === "Pipes" },
      // only the belts that end at a sink (their whole network, back to the machines)
      logistics: b => b.n && !!Logistics.byId?.get(b.n)?.touches?.["AWESOME Sink"], layers: [
        { key: "sinks", group: "Sinks", label: "AWESOME Sinks", color: SINK_COLOR, size: 6.5, shape: "drain" },
        { key: "feeds", group: "Sinks", label: "Machines feeding them", color: FEED_COLOR, size: 3.2 },
      ],
      hint: "click a sink to see what feeds it · scroll to zoom",
      onClick: p => { if (p.layer === "sinks") pick(p.id); else { const s = [...(p.sinks || [])][0]; if (s) pick(s); } },
      onHover: p => { for (const tr of $("skSinks").querySelectorAll("tr[data-sink]")) tr.classList.toggle("hl", !!p && (tr.dataset.sink === p.id || p.sinks?.has(tr.dataset.sink))); },
    });
    $("skSinks").addEventListener("click", e => { const tr = e.target.closest("tr[data-sink]"); if (tr) pick(tr.dataset.sink); });
    $("skSinks").addEventListener("mousemove", e => { const tr = e.target.closest("tr[data-sink]"); map.highlight(tr ? tr.dataset.sink : null); });
    $("skSinks").addEventListener("mouseleave", () => map.highlight(null));
    $("skItemClear").addEventListener("click", () => itemTable.clearFilters());
    $("skSinkClear").addEventListener("click", () => sinkTable.clearFilters());
    root.addEventListener("click", e => {
      if (e.target.closest("[data-act=all]")) { e.preventDefault(); if (sel) pick(sel); return; }
      const sb = e.target.closest("[data-g=range]");
      if (sb) { ui.range = +sb.dataset.v; saveUi(); render(); pollHistory(); }
    });
    inited = true;
  }

  return {
    show() {
      if (!inited) init();
      render(); poll(); pollSinks(); pollHistory(); Logistics.start();
      if (!timers.length) timers = [every(poll, 5000), every(pollSinks, 60000), every(pollHistory, 15000)];
    },
    hide() { timers.forEach(stopPoll); timers = []; },
  };
})();
