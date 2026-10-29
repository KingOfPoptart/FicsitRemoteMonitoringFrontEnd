// ---- resizable panels (desktop) -------------------------------------------------------------------------------
// Drag the gap between two panels to trade space between them; double-click a gap to put that group back.
//  - stacked panels (a column):        the gap trades height
//  - side-by-side panels / top tiles:  the gap trades width (tile height follows their content)
//  - the map:                          drag its left edge; one width for every tab, so the map stays put when you change tabs
// Sizes are remembered per browser (localStorage "ft.rs" and "ft.mapw"). Phones / touch: no handles, normal layout.

const Resize = (() => {
  // [name, selector inside the tab, direction, gap px]. A selector can match several containers (numbered in order).
  const GROUPS = [
    ["col", ".pgrid > .pcol", "v", 12],
    ["cols", "#tab-progression .pgrid, #tab-inventory .pgrid", "h", 12],
    ["row", ".w-row, .lg-row, .ov-row", "h", 12],
    ["stack", ".ov-stack", "v", 12],
    ["tiles", ".tiles.compact", "h", 8],
  ];
  const MIN = { v: 60, h: 90 }, MIN_TILE = 70;
  const KEY = "ft.rs", MAPKEY = "ft.mapw";
  let store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {} };
  const desktop = matchMedia("(min-width: 1200px) and (hover: hover) and (pointer: fine)");

  const parts = c => [...c.children].filter(el => !el.classList.contains("rs-h"));
  // how small a panel can go: stacked panels down to their title bar (a row of cards: its tallest title bar),
  // side-by-side ones to a narrow column; a collapsed panel (Production's item details strip) doesn't change
  function minOf(c, p, size) {
    if (p.classList.contains("none")) return size;
    if (c.dataset.rsDir === "h") return c.matches(".tiles") ? MIN_TILE : MIN.h;
    const cards = p.matches(".card") ? [p] : [...p.querySelectorAll(":scope > .card")], top = p.getBoundingClientRect().top;
    const mins = cards.map(card => {
      const h = card.querySelector(":scope > .card-head"); if (!h) return MIN.v;
      const cs = getComputedStyle(card), px = k => parseFloat(cs[k]) || 0;
      return card.getBoundingClientRect().top - top + px("borderTopWidth") + px("paddingTop") + h.offsetHeight + px("paddingBottom") + px("borderBottomWidth");
    });
    return mins.length ? Math.max(...mins) : MIN.v;
  }
  // panels squeezed to their title bar: hide what's under the title (so it doesn't show cut in half)
  function markMin(c, sizes, mins) {
    if (c.dataset.rsDir !== "v") return;
    parts(c).forEach((p, k) => p.classList.toggle("rs-min", sizes[k] <= mins[k] + 2 && !p.classList.contains("none")));
  }
  const axis = c => c.dataset.rsDir === "v" ? "height" : "width";
  function setSize(p, ax, size) {
    const cs = getComputedStyle(p), px = k => parseFloat(cs[k]) || 0;
    const pb = ax === "height" ? px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth")
                               : px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth");
    p.style.flex = `${Math.max(0.01, size - pb).toFixed(2)} 1 0px`;
  }

  // (re)build the handles between a container's panels and apply its remembered sizes. Runs again whenever the
  // container's children change (the tile rows are re-rendered on every refresh).
  function sync(c) {
    c._rsObs?.disconnect();
    for (const h of c.querySelectorAll(":scope > .rs-h")) h.remove();
    const ps = parts(c);
    ps.forEach((p, i) => {
      if (!i) return;
      const h = document.createElement("div");
      h.className = "rs-h"; h.title = "Drag to resize · double-click to reset";
      p.before(h);
    });
    const saved = store[c.dataset.rs];
    if (saved && saved.length === ps.length) {
      // null = a panel that was collapsed when the sizes were saved (Production's item details): give it a fair share
      const known = saved.filter(v => v != null), share = known.length ? known.reduce((a, b) => a + b, 0) / known.length * 0.75 : 1;
      ps.forEach((p, i) => setSize(p, axis(c), saved[i] ?? share));
      requestAnimationFrame(() => { const ax = axis(c), ss = ps.map(p => p.getBoundingClientRect()[ax]); if (ss[0]) markMin(c, ss, ps.map((p, k) => minOf(c, p, ss[k]))); });
    } else ps.forEach(p => p.classList.remove("rs-min"));
    c._rsObs?.observe(c, { childList: true });
  }

  function setup(c, key, dir, gap) {
    if (c.dataset.rs) return;
    c.dataset.rs = key; c.dataset.rsDir = dir; c.style.setProperty("--rs-gap", gap + "px");
    c._rsObs = new MutationObserver(() => sync(c));
    sync(c);
  }

  // find every group on the open tabs (tabs build their panels on first show)
  function scan() {
    for (const main of document.querySelectorAll("main.tab")) {
      const tab = main.id.replace(/^tab-/, "");
      for (const [name, sel, dir, gap] of GROUPS)
        [...main.querySelectorAll(sel)].forEach((c, i) => setup(c, `${tab}.${name}.${i}`, dir, gap));
      const left = main.querySelector(":scope.maptab > .mt-left");
      if (left && !left.querySelector(":scope > .rs-map")) {
        const h = document.createElement("div");
        h.className = "rs-map"; h.title = "Drag to make the map wider or narrower (same on every tab) · double-click to reset";
        left.append(h);
      }
    }
  }

  // ---- map width: one value for every tab --------------------------------------------------------------------
  function applyMapW() {
    let f = null;
    try { f = parseFloat(localStorage.getItem(MAPKEY)); } catch {}
    // a share of the window, so it follows window resizes; never so wide the panels on the left get unusable
    if (f > 0) document.documentElement.style.setProperty("--mapw", `clamp(360px, ${(f * 100).toFixed(2)}vw, calc(100vw - 500px))`);
    else document.documentElement.style.removeProperty("--mapw");
  }
  applyMapW();

  // ---- dragging -------------------------------------------------------------------------------------------------
  let drag = null;
  document.addEventListener("mousedown", e => {
    if (e.button !== 0 || !desktop.matches) return;
    const h = e.target instanceof Element && e.target.closest(".rs-h, .rs-map"); if (!h) return;
    e.preventDefault();
    if (h.classList.contains("rs-map")) {
      const panel = h.closest("main").querySelector(":scope > .map-panel");
      drag = { map: true, h, x: e.clientX, w: panel.getBoundingClientRect().width };
    } else {
      const c = h.parentElement, ps = parts(c), i = ps.indexOf(h.nextElementSibling) - 1, ax = axis(c);
      const sizes = ps.map(p => p.getBoundingClientRect()[ax]);
      drag = { c, ps, i, sizes, mins: ps.map((p, k) => minOf(c, p, sizes[k])), v: ax === "height", at: ax === "height" ? e.clientY : e.clientX, h };
    }
    h.classList.add("drag");
    document.body.classList.add("rs-dragging", drag.map || !drag.v ? "rs-col" : "rs-row");
  });
  addEventListener("mousemove", e => {
    if (!drag) return;
    if (drag.map) {
      drag.moved = true;
      const w = Math.max(360, Math.min(innerWidth - 500, drag.w - (e.clientX - drag.x)));
      document.documentElement.style.setProperty("--mapw", w + "px");
      return;
    }
    const { ps, i, sizes, mins } = drag, d = (drag.v ? e.clientY : e.clientX) - drag.at;
    drag.moved = drag.moved || d !== 0;   // a plain click changes nothing
    if (!drag.moved) return;
    // Worked out fresh from the sizes at the start of the drag, so moving back undoes it exactly. Pulling a gap
    // down (or right) squeezes the panel after it to its title bar, then the next one, and so on; pulling back
    // opens them again in reverse (the last one squeezed opens first). Pulling up / left works the same way upwards.
    const next = sizes.slice(), down = d > 0, order = down ? ps.map((_, k) => i + 1 + k).filter(k => k < ps.length)
                                                           : ps.map((_, k) => i - k).filter(k => k >= 0);
    let left = Math.abs(d);
    for (const k of order) { const t = Math.min(left, Math.max(0, next[k] - mins[k])); next[k] -= t; left -= t; if (!left) break; }
    next[down ? i : i + 1] += Math.abs(d) - left;
    ps.forEach((p, k) => setSize(p, drag.v ? "height" : "width", next[k]));
    markMin(drag.c, next, mins); drag.last = next;
  });
  addEventListener("mouseup", () => {
    if (!drag) return;
    if (!drag.moved) ;   // a click (or half of a double-click): nothing to save
    else if (drag.map) {
      const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mapw"));
      try { localStorage.setItem(MAPKEY, String(w / innerWidth)); } catch {}
      applyMapW();
    } else {
      store[drag.c.dataset.rs] = drag.ps.map((p, k) => p.classList.contains("none") ? null : Math.round(drag.last[k]));
      save();
      sync(drag.c);   // so a collapsed panel already has its share for when it opens
    }
    drag.h.classList.remove("drag");
    document.body.classList.remove("rs-dragging", "rs-col", "rs-row");
    drag = null;
  });
  // double-click a gap: that group goes back to the default layout
  document.addEventListener("dblclick", e => {
    const h = e.target instanceof Element && e.target.closest(".rs-h, .rs-map"); if (!h) return;
    if (h.classList.contains("rs-map")) { try { localStorage.removeItem(MAPKEY); } catch {} applyMapW(); return; }
    const c = h.parentElement;
    delete store[c.dataset.rs]; save();
    for (const p of parts(c)) { p.style.flex = ""; p.classList.remove("rs-min"); }
  });

  // the header's "Reset layout" button: every tab's panels and the map back to their default sizes
  function reset() {
    store = {}; save();
    try { localStorage.removeItem(MAPKEY); } catch {}
    applyMapW();
    for (const c of document.querySelectorAll("[data-rs]")) for (const p of parts(c)) { p.style.flex = ""; p.classList.remove("rs-min"); }
  }
  document.getElementById("resetLayout")?.addEventListener("click", reset);

  return { scan, reset };
})();
