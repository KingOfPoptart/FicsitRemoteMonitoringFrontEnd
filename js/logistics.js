// Logistics tab: every conveyor belt and pipe, grouped into networks (worked out by server.py from geometry),
// with what each network feeds and connects to, its length, tiers and bottleneck, beside a map.
"use strict";

const LogisticsTab = (() => {
  const root = $("tab-logistics");
  const ui = (() => { const d = { kind: "all", feeds: "all", open: false, q: "", conn: [], tier: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem("lg.ui") || "{}") }; } catch { return d; } })();
  const saveUi = () => { try { localStorage.setItem("lg.ui", JSON.stringify(ui)); } catch {} };
  let table, map, picked = null, inited = false, connPick, tierPick;

  const net = id => Logistics.networks.find(n => n.id === id);
  const feeds = n => n.p && n.w ? "both" : n.p ? "production" : n.w ? "power" : "other";
  const FEEDS = { production: ["Production", "var(--s1)"], power: ["Power", "var(--s4)"], both: ["Both", "var(--s3)", "Feeds production machines and generators"], other: ["Other", "var(--muted)"] };
  const tierKeys = n => Object.keys(n.tiers).map(t => `${n.kind}:${t}`);   // e.g. "belt:3", "pipe:1"
  const passes = (n, except) => (ui.kind === "all" || n.kind === ui.kind)
    && (ui.feeds === "all" || (ui.feeds === "production" ? n.p : ui.feeds === "power" ? n.w : !n.p && !n.w))
    && (!ui.open || n.open > 0)
    && (!ui.q || Object.keys(n.touches).some(k => k.toLowerCase().includes(ui.q.toLowerCase())))
    && (except === "conn" || !ui.conn.length || ui.conn.some(c => c in n.touches))
    && (except === "tier" || !ui.tier.length || tierKeys(n).some(t => ui.tier.includes(t)));
  const km = m => m >= 1000 ? `${fmtNum(m / 1000, 1)} km` : `${fmtNum(m)} m`;
  const capText = n => n.cap ? `${fmtNum(n.cap)}${n.kind === "pipe" ? " m³" : ""}/min` : "–";
  const tierText = n => Object.entries(n.tiers).sort().map(([t, c]) => `Mk.${t}${Object.keys(n.tiers).length > 1 ? ` ×${c}` : ""}`).join(" · ");

  // select a network (row click or map click) or clear the selection (same one again, or id null).
  // fromMap: the network is already in view where it was clicked, so the map doesn't move.
  function pick(id, fromMap = false) {
    picked = id && picked !== id ? id : null;
    render();
    const n = picked && net(picked);
    if (fromMap) { if (n) $("lgNets").querySelector(`tr[data-net="${CSS.escape(n.id)}"]`)?.scrollIntoView({ block: "nearest" }); return; }
    if (n) map.fitBox([worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])], 60, true); else map.fit();
  }

  function render() {
    if (!inited || !Logistics.networks.length) return;
    const nets = Logistics.networks, c = Logistics.counts || {};
    const len = kind => nets.filter(n => n.kind === kind).reduce((a, n) => a + n.len, 0);
    const open = nets.reduce((a, n) => a + n.open, 0);
    const segs = (kind, t) => (kind === "belt" ? Logistics.belts : Logistics.pipes).filter(b => !t || b.t === t).length;
    $("lgTiles").innerHTML = `
      <div class="tile"><div class="t-label">Conveyor belts</div><div class="t-val">${fmtNum(segs("belt"))}</div><div class="t-sub">${km(len("belt"))} in ${nets.filter(n => n.kind === "belt").length} networks</div></div>
      <div class="tile"><div class="t-label">Pipes</div><div class="t-val">${fmtNum(segs("pipe"))}</div><div class="t-sub">${km(len("pipe"))} in ${nets.filter(n => n.kind === "pipe").length} networks</div></div>
      <div class="tile"><div class="t-label">Splitters · mergers</div><div class="t-val">${fmtNum(c.splitters || 0)} <small>· ${fmtNum(c.mergers || 0)}</small></div><div class="t-sub">on the belts</div></div>
      <div class="tile"><div class="t-label">Junctions · pumps · valves</div><div class="t-val">${fmtNum(c.junctions || 0)} <small>· ${fmtNum(c.pumps || 0)} · ${fmtNum(c.valves || 0)}</small></div><div class="t-sub">on the pipes</div></div>
      <div class="tile click${ui.open ? " on" : ""}" data-open title="Show only networks with an end that isn't connected to anything"><div class="t-label">Unconnected ends</div><div class="t-val">${fmtNum(open)}</div>
        <div class="t-sub">in ${nets.filter(n => n.open).length} networks · click to list them</div></div>`;
    $("lgKind").innerHTML = segControl("kind", [{ v: "all", label: "All", n: nets.length }, { v: "belt", label: "Belts", n: nets.filter(n => n.kind === "belt").length },
      { v: "pipe", label: "Pipes", n: nets.filter(n => n.kind === "pipe").length }], o => ui.kind === o.v);
    $("lgFeeds").innerHTML = segControl("feeds", [{ v: "all", label: "All" }, { v: "production", label: "Production", dot: "var(--s1)" },
      { v: "power", label: "Power", dot: "var(--s4)" }, { v: "other", label: "Other" }], o => ui.feeds === o.v);
    // length by tier
    const rows = [...[1, 2, 3, 4, 5, 6].map(t => ["belt", t]), ...[1, 2].map(t => ["pipe", t])].filter(([k, t]) => segs(k, t))
      .map(([k, t]) => { const list = (k === "belt" ? Logistics.belts : Logistics.pipes).filter(b => b.t === t);
        return { label: `<span class="with-icon"><i class="sw-line" style="background:${(k === "belt" ? BELT_COLOR : PIPE_COLOR)[t]}"></i>Mk.${t} ${k}s</span>`, value: list.length,
                 text: `<b>${fmtNum(list.length)}</b>`, color: (k === "belt" ? BELT_COLOR : PIPE_COLOR)[t] }; });
    hbars($("lgTiers"), rows);
    const shown = nets.filter(n => passes(n));
    connPick.refresh(); tierPick.refresh();
    $("lgClear").disabled = !(ui.conn.length || ui.tier.length || ui.open || ui.q || ui.kind !== "all" || ui.feeds !== "all");
    table.render(shown);
    $("lgCount").textContent = `${shown.length} of ${nets.length}`;
    $("statsLogi").innerHTML = `<span class="stat"><b>${km(len("belt"))}</b>of belts</span><span class="stat"><b>${km(len("pipe"))}</b>of pipes</span>` +
      (open ? `<span class="stat" style="color:var(--warn)"><b>${open}</b>unconnected ends</span>` : "");
    map.renderButtons(); map.draw();
  }

  function init() {
    root.innerHTML = `
      <div class="toolbar">
        <input class="f-input search" id="lgSearch" placeholder="Networks connected to… (e.g. Smelter)" value="${esc(ui.q)}">
        <div class="seg-group"><span class="lbl">Show</span><span id="lgKind"></span></div>
        <div class="seg-group"><span class="lbl">Feeding</span><span id="lgFeeds"></span></div>
      </div>
      <div class="tiles compact" id="lgTiles"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card lg-tiers"><div class="card-head"><h2>By tier</h2><span class="hint">segments</span></div><div class="card-body hbars" id="lgTiers"></div></section>
          <section class="card lg-nets"><div class="card-head"><h2>Networks</h2><span class="hint" id="lgCount"></span>
            <button class="f-multi pick" id="lgConnSel" title="Networks connected to these buildings"></button>
            <button class="f-multi pick" id="lgTierSel" title="Networks with these belt / pipe tiers"></button>
            <button class="b" id="lgClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="lgNets"></div></section>
        </div>
        <div class="pcol">
          <section class="card lg-map"><div id="lgMap"></div></section>
        </div>
      </div>`;
    table = new DataTable($("lgNets"), [
      { key: "kind", label: "Kind", minW: 92, val: r => r.kind, cell: r => `<span class="with-icon"><i class="sw-line" style="background:${(r.kind === "belt" ? BELT_COLOR : PIPE_COLOR)[Math.max(...Object.keys(r.tiers).map(Number))]}"></i>${r.kind === "belt" ? "Belts" : "Pipes"}</span>` },
      { key: "feeds", label: "Feeds", minW: 96, val: r => feeds(r), cell: r => { const [l, c, t] = FEEDS[feeds(r)]; return `<span class="pill" style="color:${c};background:color-mix(in srgb, ${c} 14%, transparent)"${t ? ` title="${t}"` : ""}>${l}</span>`; } },
      { key: "touches", label: "Connects", minW: 160, title: "Buildings at the ends of this network", val: r => Object.keys(r.touches)[0] || "",
        cell: r => { const e = Object.entries(r.touches); return e.length ? e.slice(0, 3).map(([k, n]) => `${n} × ${esc(k)}`).join("<br>") + (e.length > 3 ? `<br><span class="muted sub">+${e.length - 3} more</span>` : "") : `<span class="muted">nothing found</span>`; } },
      { key: "len", label: "Length", num: true, minW: 74, val: r => r.len, cell: r => km(r.len) },
      { key: "segs", label: "Pieces", num: true, minW: 66, title: "Belt or pipe segments", val: r => r.segs, cell: r => fmtNum(r.segs) },
      { key: "tiers", label: "Tiers", minW: 90, val: r => Math.min(...Object.keys(r.tiers).map(Number)), cell: r => esc(tierText(r)) },
      { key: "cap", label: "Bottleneck", num: true, minW: 96, title: "Most this network can carry: its slowest tier", val: r => r.cap || 0, cell: r => capText(r) },
      { key: "open", label: "Open ends", num: true, minW: 80, title: "Ends not connected to anything", val: r => r.open, cell: r => r.open ? `<span class="warn-text">${r.open}</span>` : `<span class="muted">0</span>` },
    ], { sortKey: "len", dir: -1, storeKey: "lg.sort", rowAttrs: r => `data-net="${esc(r.id)}" class="${r.id === picked ? "sel" : ""}"` });
    map = new MapView($("lgMap"), {
      storeKey: "lg.map", layerMenu: true, players: true, layers: [],
      logistics: b => { const n = net(b.n); return !n || passes(n); },   // the map follows the filters
      highlight: () => picked, hint: "hover a belt or pipe to see its network · click it (or a row) to select it",
      onNetClick: id => pick(id, true),   // click a belt/pipe = select its network; click it again or empty map = clear
      onNetHover: id => {   // map hover -> the network's row lights up and scrolls into view
        for (const tr of $("lgNets").querySelectorAll("tr.hl")) tr.classList.remove("hl");
        const tr = id && $("lgNets").querySelector(`tr[data-net="${CSS.escape(id)}"]`);
        if (tr) { tr.classList.add("hl"); tr.scrollIntoView({ block: "nearest" }); }
      },
      // Fit frames the networks the table shows
      fitTo: () => Logistics.networks.filter(n => passes(n)).flatMap(n => [worldToImg(n.box[0], n.box[1]), worldToImg(n.box[2], n.box[3])]),
    });
    // dropdown filters: every option, counted against the other filters; ones with no networks are greyed out
    connPick = new MultiSelect($("lgConnSel"), { noun: "buildings", search: "Search buildings…",
      options: () => { const names = new Map();
        for (const n of Logistics.networks) for (const k of Object.keys(n.touches)) names.set(k, (names.get(k) || 0) + (passes(n, "conn") ? 1 : 0));
        return [...names].map(([k, c]) => ({ value: k, label: icon(k, "icon sm") + esc(k), n: c || "", empty: !c })); },
      selected: () => ui.conn, onChange: v => { ui.conn = v; saveUi(); render(); map.fit(); } });
    tierPick = new MultiSelect($("lgTierSel"), { noun: "tiers", search: "Search tiers…",
      options: () => [...[1, 2, 3, 4, 5, 6].map(t => `belt:${t}`), ...[1, 2].map(t => `pipe:${t}`)].map(k => {
        const [kind, t] = k.split(":"), c = Logistics.networks.filter(n => passes(n, "tier") && tierKeys(n).includes(k)).length;
        return { value: k, label: `<i class="sw-line" style="background:${(kind === "belt" ? BELT_COLOR : PIPE_COLOR)[t]}"></i> Mk.${t} ${kind}s`, n: c || "", empty: !c,
                 group: kind === "belt" ? "Belts" : "Pipes" }; }),
      selected: () => ui.tier, onChange: v => { ui.tier = v; saveUi(); render(); map.fit(); } });
    root.addEventListener("click", e => {
      if (e.target.closest("#lgClear")) {
        Object.assign(ui, { kind: "all", feeds: "all", open: false, q: "", conn: [], tier: [] }); $("lgSearch").value = "";
        saveUi(); render(); map.fit(); return;
      }
      const s = e.target.closest("[data-g]");
      if (s && (s.dataset.g === "kind" || s.dataset.g === "feeds")) { ui[s.dataset.g] = s.dataset.v; saveUi(); render(); map.fit(); return; }
      if (e.target.closest("[data-open]")) { ui.open = !ui.open; saveUi(); render(); map.fit(); return; }
      const tr = e.target.closest("tr[data-net]"); if (tr) pick(tr.dataset.net);
    });
    $("lgSearch").addEventListener("input", e => { ui.q = e.target.value; saveUi(); render(); });
    Logistics.listeners.add(render);
    inited = true;
  }

  return {
    show() { if (!inited) init(); Logistics.start(); render(); setConn(true); },
    hide() {},
  };
})();
