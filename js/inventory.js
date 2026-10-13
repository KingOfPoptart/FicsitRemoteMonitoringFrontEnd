// Inventory tab: what every player is carrying (FRM getPlayer) beside what's in the Dimensional Depot (getCloudInv).
// The two are linked by item: each table shows the other's amount, and clicking an item marks it in both.
"use strict";

const InventoryTab = (() => {
  const root = $("tab-inventory");
  const ui = (() => { const d = { fill: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem("iv.ui") || "{}") }; } catch { return d; } })();
  const saveUi = () => { try { localStorage.setItem("iv.ui", JSON.stringify(ui)); } catch {} };
  if (!Array.isArray(ui.fill)) ui.fill = [];
  let pTable, dTable, timer = null, inited = false, loaded = false;
  let players = [], carried = [], depot = [];   // players; one row per player + item; one row per depot item
  let picked = null, pickedIn = null;           // the selected item, and the table it was clicked in

  const byName = (a, b) => a.localeCompare(b);
  const stacks = r => r.stack ? Math.ceil(r.amount / r.stack) : 0;
  const FILLS = ["Empty", "Partly Full", "At Limit"];
  const FILL_COLOR = { Empty: "var(--muted)", "Partly Full": "var(--s1)", "At Limit": "var(--warn)" };
  const fillOf = r => !r.amount ? "Empty" : r.limit && r.amount >= r.limit ? "At Limit" : "Partly Full";
  const frac = r => r.limit ? Math.min(1, r.amount / r.limit) : 0;
  const itemCell = r => `<span class="with-icon">${icon(r.name, "icon sm")}${esc(r.name)}</span>`;
  const other = n => n ? fmtNum(n) : `<span class="muted">–</span>`;
  const rowClass = (r, t) => r.name !== picked ? "" : pickedIn === t ? "sel" : "link";

  async function load() {
    const [p, c] = await Promise.allSettled([getJSON("getPlayer"), getJSON("getCloudInv")]);
    if (p.status === "fulfilled") players = p.value;
    if (c.status === "fulfilled") depot = c.value.map(i => ({ name: i.Name, amount: i.Amount, stack: i.MaxAmount, limit: i.Limit }));
    if (p.status === "fulfilled" || c.status === "fulfilled") { loaded = true; setConn(true); }
    else setConn(false, p.reason?.message || "error");
    // rows keep one order (online players first, then by name, then item) between refreshes, so equal values never swap places
    const inDepot = new Map(depot.map(i => [i.name, i.amount])), held = new Map();
    carried = [...players].sort((a, b) => !!b.Online - !!a.Online || byName(a.Name, b.Name)).flatMap(pl =>
      (pl.Inventory || []).map(i => ({ player: pl.Name, online: !!pl.Online, name: i.Name, amount: i.Amount, stack: i.MaxAmount, depot: inDepot.get(i.Name) || 0 }))
        .sort((a, b) => byName(a.name, b.name)));
    for (const r of carried) held.set(r.name, (held.get(r.name) || 0) + r.amount);
    depot.sort((a, b) => byName(a.name, b.name));
    for (const i of depot) i.carried = held.get(i.name) || 0;
    render();
  }

  function pick(name, from) {   // same item again clears the selection
    if (picked === name && pickedIn === from) picked = pickedIn = null; else { picked = name; pickedIn = from; }
    render();
    if (picked) (from === "p" ? $("ivDepot") : $("ivPlayers")).scrollTop = 0;   // it's pinned to the top of the other table
  }

  function render() {
    if (!inited) return;
    const online = players.filter(p => p.Online).length, items = new Set(carried.map(r => r.name)).size;
    const slots = carried.reduce((a, r) => a + stacks(r), 0);
    const atLimit = depot.filter(i => fillOf(i) === "At Limit").length, both = depot.filter(i => i.carried).length;
    const limitOn = ui.fill.length === 1 && ui.fill[0] === "At Limit";
    $("ivTiles").innerHTML = `
      <div class="tile"><div class="t-label">Players</div><div class="t-val">${fmtNum(players.length)}</div><div class="t-sub">${online ? `${online} online` : "nobody online"}</div></div>
      <div class="tile"><div class="t-label">Carried by players</div><div class="t-val">${fmtNum(items)} <small>items</small></div><div class="t-sub">${fmtNum(slots)} stacks · ${fmtNum(both)} also in the depot</div></div>
      <div class="tile"><div class="t-label">Dimensional Depot</div><div class="t-val">${fmtNum(depot.length)} <small>items</small></div><div class="t-sub">${fmtNum(depot.reduce((a, i) => a + i.amount, 0))} stored in total</div></div>
      <div class="tile click${limitOn ? " on" : ""}" data-fill="At Limit" title="Show only depot items that can't take any more uploads"><div class="t-label">At the limit</div><div class="t-val">${fmtNum(atLimit)}</div><div class="t-sub">click to list them</div></div>`;
    if (loaded) { pTable.render(carried); dTable.render(depot); }
    $("ivPClear").disabled = !pTable.hasFilters();
    $("ivPCount").textContent = `${pTable.filtered.length} of ${carried.length}`;
    $("ivDClear").disabled = !dTable.hasFilters();
    $("ivDCount").textContent = `${dTable.filtered.length} of ${depot.length}`;
    $("statsInv").innerHTML = !loaded ? "" : `<span class="stat"><b>${online}</b>online</span><span class="stat"><b>${fmtNum(items)}</b>items carried</span>` +
      `<span class="stat"><b>${fmtNum(depot.length)}</b>in the depot</span>` + (atLimit ? `<span class="stat" style="color:var(--warn)"><b>${atLimit}</b>at the limit</span>` : "");
  }

  function init() {
    root.innerHTML = `
      <div class="tiles compact" id="ivTiles"></div>
      <div class="pgrid">
        <div class="pcol">
          <section class="card iv-players"><div class="card-head"><h2>Player inventory</h2><span class="hint" id="ivPCount"></span>
            <button class="b" id="ivPClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="ivPlayers"></div></section>
        </div>
        <div class="pcol">
          <section class="card iv-depot"><div class="card-head"><h2>Dimensional Depot</h2><span class="hint" id="ivDCount"></span>
            <button class="b" id="ivDClear">Clear filters</button></div>
            <div class="table-wrap dtw tall" id="ivDepot"></div></section>
        </div>
      </div>`;
    const itemFilter = { value: r => r.name, noun: "items", label: v => icon(v, "icon sm") + esc(v) };
    pTable = new DataTable($("ivPlayers"), [
      { key: "player", label: "Player", minW: 120, val: r => (r.online ? "0" : "1") + r.player.toLowerCase(),   // whoever is online comes first
        filter: { value: r => r.player, noun: "players" },
        cell: r => `<span class="with-icon" title="${r.online ? "Online" : "Offline"}"><i class="sw" style="background:${r.online ? "var(--ok)" : "var(--muted)"}"></i>${esc(r.player)}</span>` },
      { key: "name", label: "Item", minW: 160, val: r => r.name, filter: itemFilter, cell: itemCell },
      { key: "amount", label: "Amount", num: true, minW: 76, val: r => r.amount, cell: r => fmtNum(r.amount) },
      { key: "stacks", label: "Stacks", num: true, minW: 66, title: "Inventory slots it takes: amount ÷ stack size, rounded up", val: stacks,
        cell: r => `${fmtNum(stacks(r))} <span class="muted sub">× ${fmtNum(r.stack)}</span>` },
      { key: "depot", label: "Depot", num: true, minW: 70, title: "How many of this item the Dimensional Depot holds", val: r => r.depot,
        filter: { value: r => r.depot ? "In The Depot" : "Not In The Depot", noun: "", all: () => [{ value: "In The Depot" }, { value: "Not In The Depot" }], ord: true },
        cell: r => other(r.depot) },
    ], { sortKey: "player", dir: 1, storeKey: "iv.p", empty: "Nobody is carrying anything.", onFilter: render,
         pin: r => pickedIn === "d" && r.name === picked ? 0 : 1,
         rowAttrs: r => `data-item="${esc(r.name)}" class="${rowClass(r, "p")}"` });
    dTable = new DataTable($("ivDepot"), [
      { key: "name", label: "Item", minW: 160, val: r => r.name, filter: itemFilter, cell: itemCell },
      { key: "amount", label: "Stored", num: true, minW: 76, val: r => r.amount, cell: r => fmtNum(r.amount) },
      { key: "limit", label: "Limit", num: true, minW: 70, title: "Most the depot keeps of this item; uploads stop there", val: r => r.limit || 0,
        cell: r => r.limit ? fmtNum(r.limit) : `<span class="muted">–</span>` },
      { key: "fill", label: "Fill", num: true, minW: 104, title: "Stored against the limit", val: frac,
        filter: { value: fillOf, noun: "", get: () => ui.fill, set: v => { ui.fill = v; saveUi(); },
                  all: () => FILLS.map(v => ({ value: v, label: `<i class="sw" style="background:${FILL_COLOR[v]}"></i> ${v}` })), ord: true },
        cell: r => r.limit ? `<span class="nowrap">${bar(frac(r), fillOf(r) === "At Limit" ? "var(--warn)" : "var(--s1)")} ${Math.round(frac(r) * 100)}%</span>` : `<span class="muted">–</span>` },
      { key: "stacks", label: "Stacks", num: true, minW: 66, title: "Stored ÷ stack size, rounded up", val: stacks,
        cell: r => `${fmtNum(stacks(r))} <span class="muted sub">× ${fmtNum(r.stack)}</span>` },
      { key: "carried", label: "Carried", num: true, minW: 76, title: "How many of this item players are carrying right now", val: r => r.carried,
        filter: { value: r => r.carried ? "Carried" : "Not Carried", noun: "", all: () => [{ value: "Carried" }, { value: "Not Carried" }], ord: true },
        cell: r => other(r.carried) },
    ], { sortKey: "name", dir: 1, storeKey: "iv.d", empty: "Nothing uploaded yet.", onFilter: render,
         pin: r => pickedIn === "p" && r.name === picked ? 0 : 1,
         rowAttrs: r => `data-item="${esc(r.name)}" class="${rowClass(r, "d")}"` });

    root.addEventListener("click", e => {
      if (e.target.closest("#ivPClear")) { pTable.clearFilters(); return; }
      if (e.target.closest("#ivDClear")) { dTable.clearFilters(); return; }
      const f = e.target.closest("[data-fill]"); if (f) { const want = f.dataset.fill; dTable.setFilter("fill", ui.fill.length === 1 && ui.fill[0] === want ? [] : [want]); return; }
      const tr = e.target.closest("tbody tr[data-item]"); if (tr) pick(tr.dataset.item, tr.closest("#ivPlayers") ? "p" : "d");
    });
    inited = true;
  }

  return {
    show() { if (!inited) init(); render(); load(); if (!timer) timer = every(load, 5000); },
    hide() { stopPoll(timer); timer = null; },
  };
})();
