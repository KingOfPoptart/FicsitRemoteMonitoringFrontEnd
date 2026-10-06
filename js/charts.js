// Small SVG charts shared by the Production and Power tabs: a time-series line chart with a crosshair
// tooltip, and horizontal bar rows. No library; colours come from the CSS custom properties.
"use strict";

const cssColor = (() => {   // canvas and SVG attributes need real colours: resolve "var(--x)" once
  const cache = new Map();
  return c => {
    if (!c || !c.startsWith("var(")) return c;
    if (!cache.has(c)) cache.set(c, getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)).trim() || "#888");
    return cache.get(c);
  };
})();

// Column widths for a fixed-layout table: when they add up to less than the panel, the spare room is shared out
// over the columns here (in proportion to their widths), except the one being dragged. Leaving it to the browser
// spreads it over every column, including the dragged one, which makes that column jump when a drag starts.
function settleWidths(ws, avail, dragIndex = -1) {
  const out = [...ws], spare = avail - out.reduce((a, b) => a + b, 0);
  if (spare <= 0 || !out.length) return out;
  const idx = out.map((_, i) => i).filter(i => i !== dragIndex);
  const base = idx.reduce((a, i) => a + out[i], 0) || 1;
  let given = 0;
  idx.forEach((i, n) => { const add = n === idx.length - 1 ? spare - given : Math.floor(spare * out[i] / base); out[i] += add; given += add; });
  return out;
}

// Segmented control (one choice per group, like radio buttons). opts = [{ v, label, n?, dot?, title? }];
// each button carries data-g=group and data-v=value for the tab's click handler.
const segControl = (group, opts, isOn) => `<div class="seg" role="radiogroup">${opts.map(o =>
  `<button role="radio" aria-checked="${isOn(o)}" class="${isOn(o) ? "on" : ""}" data-g="${group}" data-v="${esc(o.v)}"${o.title ? ` title="${esc(o.title)}"` : ""}>` +
  `${o.dot ? `<i class="sw" style="background:${o.dot}"></i>` : ""}${o.label}${o.n != null ? ` <span class="n">${typeof o.n === "number" ? fmtNum(o.n) : o.n}</span>` : ""}</button>`).join("")}</div>`;

// Bring a table row into view inside its scrolling box, centred. (scrollIntoView "nearest" can leave the row
// hidden under the table's sticky header when it scrolls up.) Only scrolls if the row isn't already clearly visible.
function scrollRowIntoView(tr) {
  const box = tr && tr.closest(".table-wrap"); if (!box) return;
  const head = box.querySelector("thead")?.offsetHeight || 0;
  const top = tr.offsetTop, bottom = top + tr.offsetHeight;
  if (top >= box.scrollTop + head && bottom <= box.scrollTop + box.clientHeight) return;
  box.scrollTop = Math.max(0, top - head - (box.clientHeight - head - tr.offsetHeight) / 2);
}

// Put a segmented control into el. If it already holds the same buttons, they're updated in place (text,
// highlight) instead of replaced, so a click that lands while the page refreshes isn't lost.
function setSeg(el, html) {
  const t = document.createElement("template"); t.innerHTML = html.trim();
  const fresh = t.content.querySelectorAll("button"), old = el.querySelectorAll("button");
  const key = list => [...list].map(b => b.dataset.g + ":" + b.dataset.v).join("|");
  if (!old.length || key(old) !== key(fresh)) { el.innerHTML = html; return; }
  fresh.forEach((b, i) => {
    const o = old[i];
    if (o.className !== b.className) o.className = b.className;
    o.setAttribute("aria-checked", b.getAttribute("aria-checked"));
    if (o.title !== b.title) o.title = b.title;
    if (o.innerHTML !== b.innerHTML) o.innerHTML = b.innerHTML;
  });
}

// Place a dropdown panel under its button, or above it when there isn't room below; the list scrolls if neither fits.
function placePopover(pop, btn) {
  const r = btn.getBoundingClientRect(), list = pop.querySelector(".pop-list");
  if (list) list.style.maxHeight = "";
  const below = innerHeight - r.bottom - 12, above = r.top - 12;
  let h = pop.offsetHeight;
  const up = h > below && above > below;
  const room = up ? above : below;
  if (h > room && list) { list.style.maxHeight = Math.max(80, list.clientHeight - (h - room)) + "px"; h = pop.offsetHeight; }
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (up ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
}

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

// clean axis ticks: 0, 1,000, 2,000 … (≈4-6 of them)
function niceTicks(max, count = 5) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
}
const fmtNum = (v, digits = 0) => v == null || isNaN(v) ? "–" : v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
// adaptive precision for rates: 1,234 · 56.7 · 0.25
const fmtRate = v => v == null || isNaN(v) ? "–" : Math.abs(v) >= 100 ? fmtNum(v, 0) : Math.abs(v) >= 10 ? fmtNum(v, 1) : fmtNum(v, 2);
const fmtTime = (t, withDate) => new Date(t * 1000).toLocaleTimeString([], withDate ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/**
 * Line chart over time. One instance per container; call .update(data) with new data.
 * data = { t: [unix s], interval: s, series: [{ key, name, color, values: [..], dash?, area? }], unit, yMax? }
 * Gaps: null values, or a time jump > 3 intervals, break the line.
 */
class LineChart {
  // fill: take the height of the panel it sits in (one-screen layouts) instead of a fixed height
  constructor(el, { height = 230, unit = "", fmt = fmtRate, empty = "No history yet — the server records it while it runs.", fill = false } = {}) {
    this.el = el; this.height = height; this.unit = unit; this.fmt = fmt; this.emptyText = empty; this.fill = fill;
    el.classList.add("lc"); if (fill) el.classList.add("lc-fill");
    this.legend = document.createElement("div"); this.legend.className = "lc-legend"; el.appendChild(this.legend);
    this.box = document.createElement("div"); this.box.className = "lc-box"; el.appendChild(this.box);
    this.svg = svgEl("svg", { height, role: "img" }, this.box);
    this.tip = document.createElement("div"); this.tip.className = "lc-tip"; this.box.appendChild(this.tip);
    this.data = null; this.hoverI = null;
    new ResizeObserver(() => this.render()).observe(this.box);
    this.svg.addEventListener("pointermove", e => this.hover(e));
    this.svg.addEventListener("pointerleave", () => { this.hoverI = null; this.tip.style.display = "none"; this.drawCursor(); });
  }
  update(data) { this.data = data; this.render(); }
  render() {
    const svg = this.svg, d = this.data, W = this.box.clientWidth;
    if (!W) return;
    if (this.fill && this.box.clientHeight > 40) this.height = this.box.clientHeight;
    svg.setAttribute("height", this.height);
    svg.setAttribute("width", W); svg.setAttribute("viewBox", `0 0 ${W} ${this.height}`);
    svg.replaceChildren();
    this.legend.replaceChildren(...(d ? d.series : []).map(s => {
      const span = document.createElement("span"), key = document.createElement("i");
      key.style.background = s.color; if (s.dash) key.className = "dash";
      span.append(key, document.createTextNode(s.name)); return span;
    }));
    const n = d ? d.t.length : 0;
    if (n < 2) {
      svgEl("text", { x: W / 2, y: this.height / 2, "text-anchor": "middle", class: "lc-empty" }, svg).textContent = this.emptyText;
      return;
    }
    let max = d.yMax || 0;
    for (const s of d.series) for (const v of s.values) if (v > max) max = v;
    // about one gridline per 30 px of plot height, so short charts don't stack their labels
    const nTicks = Math.max(1, Math.min(5, Math.floor((this.height - 34) / 30)));
    const ticks = niceTicks(d.yMax && max <= d.yMax ? d.yMax : max * 1.05, nTicks), yTop = ticks[ticks.length - 1];
    // left margin fits the widest tick label
    const pad = { l: 12 + Math.max(...ticks.map(v => this.fmtTick(v).length)) * 7, r: 14, t: 10, b: 24 };
    const t0 = d.t[0], t1 = d.t[n - 1], span = Math.max(1, t1 - t0);
    const x = t => pad.l + (t - t0) / span * (W - pad.l - pad.r);
    const y = v => this.height - pad.b - v / yTop * (this.height - pad.t - pad.b);
    Object.assign(this, { x, y, pad, W });
    const grid = svgEl("g", { class: "lc-grid" }, svg);
    for (const v of ticks) {
      svgEl("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v === 0 ? "base" : "" }, grid);
      svgEl("text", { x: pad.l - 6, y: y(v) + 4, "text-anchor": "end" }, grid).textContent = this.fmtTick(v);
    }
    // ~5 time labels on round minutes
    const withDate = span > 20 * 3600;
    const stepS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].find(s => span / s <= 6) || 21600;
    for (let t = Math.ceil(t0 / stepS) * stepS; t <= t1; t += stepS)
      svgEl("text", { x: x(t), y: this.height - 6, "text-anchor": "middle" }, grid).textContent = fmtTime(t, withDate && t % 86400 === 0);
    const gapS = (d.interval || 5) * 3.5;
    for (const s of d.series) {
      let path = "", area = "", seg = [];
      const flush = () => {
        if (seg.length > 1 && s.area) area += `M${seg[0][0]},${y(0)}` + seg.map(p => `L${p[0]},${p[1]}`).join("") + `L${seg[seg.length - 1][0]},${y(0)}Z`;
        seg = [];
      };
      s.values.forEach((v, i) => {
        if (v == null || (i && d.t[i] - d.t[i - 1] > gapS)) flush();
        if (v == null) return;
        const p = [x(d.t[i]).toFixed(1), y(v).toFixed(1)];
        path += (seg.length ? "L" : "M") + p[0] + "," + p[1]; seg.push(p);
      });
      flush();
      if (area) svgEl("path", { d: area, fill: cssColor(s.color), "fill-opacity": 0.1, stroke: "none" }, svg);
      svgEl("path", { d: path, fill: "none", stroke: cssColor(s.color), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
                      ...(s.dash ? { "stroke-dasharray": "5 4" } : {}) }, svg);
    }
    this.cursor = svgEl("g", {}, svg);
    this.drawCursor();
  }
  fmtTick(v) { return v >= 10000 ? fmtNum(v / 1000, 1) + "k" : fmtNum(v, v < 10 ? 2 : 0); }
  hover(e) {
    const d = this.data; if (!d || d.t.length < 2 || !this.x) return;
    const r = this.svg.getBoundingClientRect(), mx = e.clientX - r.left;
    let best = 0, bd = Infinity;
    d.t.forEach((t, i) => { const dd = Math.abs(this.x(t) - mx); if (dd < bd) { bd = dd; best = i; } });
    this.hoverI = best; this.drawCursor();
    // values lead, names follow; line keys
    this.tip.replaceChildren();
    const head = document.createElement("div"); head.className = "lc-tip-head";
    head.textContent = new Date(d.t[best] * 1000).toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
    this.tip.appendChild(head);
    for (const s of d.series) {
      const row = document.createElement("div"), key = document.createElement("i"), b = document.createElement("b"), name = document.createElement("span");
      key.style.background = s.color; b.textContent = s.values[best] == null ? "–" : this.fmt(s.values[best]) + (this.unit ? " " + this.unit : "");
      name.textContent = s.name; row.append(key, b, name); this.tip.appendChild(row);
    }
    this.tip.style.display = "block";
    const tw = this.tip.offsetWidth, px = this.x(d.t[best]);
    this.tip.style.left = (px + 14 + tw > this.W ? px - tw - 14 : px + 14) + "px";
  }
  drawCursor() {
    if (!this.cursor) return;
    this.cursor.replaceChildren();
    const d = this.data, i = this.hoverI;
    if (i == null || !d) return;
    const px = this.x(d.t[i]);
    svgEl("line", { x1: px, x2: px, y1: this.pad.t, y2: this.height - this.pad.b, class: "lc-cross" }, this.cursor);
    for (const s of d.series) if (s.values[i] != null)
      svgEl("circle", { cx: px, cy: this.y(s.values[i]), r: 4, fill: cssColor(s.color), class: "lc-dot" }, this.cursor);
  }
}

/**
 * Horizontal bar rows (HTML): label | track with fill (+ optional lighter "cap" segment) | value text.
 * rows = [{ label (html), value, cap?, text, title?, key? }]; scale = max of value/cap across rows.
 */
function hbars(el, rows, { color = "var(--s1)", capColor = "var(--s1-dim)" } = {}) {
  const max = Math.max(1e-9, ...rows.map(r => Math.max(r.value, r.cap || 0)));
  el.innerHTML = rows.map(r => `<div class="hb"${r.title ? ` title="${esc(r.title)}"` : ""}${r.key ? ` data-key="${esc(r.key)}"` : ""}>
      <div class="hb-label">${r.label}</div>
      <div class="hb-track">${r.cap ? `<i class="cap" style="width:${r.cap / max * 100}%;background:${capColor}"></i>` : ""}<i style="width:${r.value / max * 100}%;background:${r.color || color}"></i></div>
      <div class="hb-val">${r.text}</div></div>`).join("") || `<div class="muted">Nothing here.</div>`;
}

// ---- shared small helpers for the new tabs ----------------------------------------------------
const iconSlug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const icon = (name, cls = "icon") => name ? `<img class="${cls}" src="/img/icons/${iconSlug(name)}.png?v=2" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : "";
const pct = v => v == null || isNaN(v) ? "–" : `${Math.round(v)}%`;
const bar = (frac, color) => `<span class="fill"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%;background:${color || "var(--accent)"}"></i></span>`;

// sortable table with resizable columns — same header classes as the Vehicles table (sort-row, .rz handles).
// cols = [{ key, label, title?, num?, val(row) -> sort value, cell(row) -> html, cls?, minW? (narrowest when fitting the panel),
//           filter? }] — a filter row under the headers, like the Vehicles table:
//   filter: { text: row => string, placeholder? }                         search box (all words must match)
//   filter: { value: row => string | string[], all?: () => [{ value, label?, group? }], noun? }   multi-select dropdown;
//           `all` lists every possible value (ones no row has are greyed out), otherwise the values present are listed
// Options are counted against the other columns' filters. onFilter() is called after a filter changes.
// Widths: measured from the content on first render, then fixed; drag a header edge to resize, double-click it
// to fit the content. Sort and widths are remembered under storeKey.
class DataTable {
  constructor(el, cols, { sortKey, dir = 1, rowAttrs = () => "", empty = "Nothing to show.", storeKey, pin = () => 0, onFilter } = {}) {
    Object.assign(this, { el, cols, rowAttrs, empty, storeKey, pin, onFilter });
    const load = k => { try { return k && JSON.parse(localStorage.getItem(k)); } catch { return null; } };
    const saved = load(storeKey);
    this.sort = saved && cols.some(c => c.key === saved.key) ? saved : { key: sortKey || cols[0].key, dir };
    this.widths = load(storeKey && storeKey + ".w") || {};
    this.auto = {}; this.measured = false; this.justResized = false;
    el.innerHTML = `<table class="dt"><colgroup></colgroup><thead><tr class="sort-row"></tr></thead><tbody></tbody></table>`;
    this.table = el.querySelector("table"); this.colgroup = el.querySelector("colgroup");
    this.head = el.querySelector("thead tr"); this.body = el.querySelector("tbody");
    this.f = load(storeKey && storeKey + ".f") || {};   // column filters: key -> text or [values]
    if (cols.some(c => c.filter)) this.buildFilters();
    this.head.addEventListener("click", e => {
      const th = e.target.closest("th[data-key]"); if (!th || this.justResized || e.target.closest(".rz")) return;
      const k = th.dataset.key;
      this.sort = { key: k, dir: this.sort.key === k ? -this.sort.dir : (this.cols.find(c => c.key === k).num ? -1 : 1) };
      try { storeKey && localStorage.setItem(storeKey, JSON.stringify(this.sort)); } catch {}
      this.render(this.rows);
    });
    this.head.addEventListener("mousedown", e => {
      const h = e.target.closest(".rz"); if (!h) return;
      e.preventDefault(); e.stopPropagation();
      const key = h.dataset.rz, startX = e.clientX, startW = h.parentElement.getBoundingClientRect().width;
      this.dragKey = key; h.classList.add("dragging"); document.body.classList.add("resizing");
      const move = ev => { this.widths[key] = Math.max(48, Math.round(startW + ev.clientX - startX)); this.applyWidths(); };
      const up = () => {
        removeEventListener("mousemove", move); removeEventListener("mouseup", up);
        document.body.classList.remove("resizing"); this.dragKey = null; this.applyWidths(); this.saveWidths();
        this.justResized = true; setTimeout(() => this.justResized = false, 0);   // swallow the click that follows
      };
      addEventListener("mousemove", move); addEventListener("mouseup", up);
    });
    this.head.addEventListener("dblclick", e => { const h = e.target.closest(".rz"); if (h) this.fitColumn(h.dataset.rz); });
    new ResizeObserver(() => { if (this.measured && this.el.clientWidth) this.applyWidths(); }).observe(el);
  }
  // the filter row is built once (not on every refresh), so typing and clicking in it is never interrupted
  buildFilters() {
    const tr = document.createElement("tr"); tr.className = "filter-row"; this.head.after(tr); this.filterRow = tr;
    this.pickers = [];
    for (const c of this.cols) {
      const th = document.createElement("th"); tr.appendChild(th);
      if (!c.filter) continue;
      if (c.filter.text) {
        const inp = document.createElement("input"); inp.className = "f-input"; inp.placeholder = c.filter.placeholder || "search";
        inp.value = this.f[c.key] || ""; th.appendChild(inp);
        inp.addEventListener("input", () => { this.f[c.key] = inp.value; this.filtersChanged(); });
        c._input = inp;
      } else {
        const btn = document.createElement("button"); btn.className = "f-multi"; th.appendChild(btn);
        const vals = r => { const v = c.filter.value(r); return Array.isArray(v) ? v : [v]; };
        this.pickers.push(new MultiSelect(btn, { noun: c.filter.noun || "values", search: "Search…",
          options: () => {
            const rows = (this.rows || []).filter(r => this.passes(r, c.key)), n = new Map();
            for (const r of rows) for (const v of vals(r)) if (v != null && v !== "") n.set(v, (n.get(v) || 0) + 1);
            const all = c.filter.all ? c.filter.all() : [...n.keys()].map(value => ({ value }));
            return all.map(o => ({ value: o.value, label: o.label || esc(o.value), group: o.group, n: n.get(o.value) || "", empty: !n.get(o.value) }));
          },
          selected: () => this.f[c.key] || [], onChange: v => { this.f[c.key] = v; this.filtersChanged(); } }));
      }
    }
  }
  filtersChanged() {
    try { this.storeKey && localStorage.setItem(this.storeKey + ".f", JSON.stringify(this.f)); } catch {}
    this.render(this.rows); this.onFilter && this.onFilter();
  }
  // does a row pass every column filter (except `skip`, used to count a dropdown's own options)?
  passes(r, skip) {
    for (const c of this.cols) {
      if (!c.filter || c.key === skip) continue;
      const f = this.f[c.key];
      if (c.filter.text) {
        if (f && !f.toLowerCase().split(/\s+/).filter(Boolean).every(w => String(c.filter.text(r)).toLowerCase().includes(w))) return false;
      } else if (f && f.length) {
        const v = c.filter.value(r), vs = Array.isArray(v) ? v : [v];
        if (!vs.some(x => f.includes(x))) return false;
      }
    }
    return true;
  }
  get filtered() { return (this.rows || []).filter(r => this.passes(r)); }
  hasFilters() { return Object.values(this.f).some(v => Array.isArray(v) ? v.length : v); }
  clearFilters() {
    this.f = {};
    for (const c of this.cols) if (c._input) c._input.value = "";
    this.filtersChanged();
  }
  saveWidths() { try { this.storeKey && localStorage.setItem(this.storeKey + ".w", JSON.stringify(this.widths)); } catch {} }
  // natural (unwrapped) header+content widths, measured once there are rows and the table is visible
  measure() {
    const t = this.table;
    t.classList.remove("fixed"); t.style.width = "auto"; this.colgroup.innerHTML = "";
    [...this.head.children].forEach(th => { this.auto[th.dataset.key] = Math.min(360, Math.max(56, Math.ceil(th.getBoundingClientRect().width))); });
    // too wide for the panel: shrink the columns the user hasn't sized, wide ones most, none below ~its header
    const keys = this.cols.map(c => c.key).filter(k => !this.widths[k]);
    const total = () => this.cols.reduce((a, c) => a + (this.widths[c.key] || this.auto[c.key]), 0);
    const min = k => Math.min(this.auto[k], this.cols.find(c => c.key === k).minW || (k === this.cols[0].key ? 130 : 80));
    for (let pass = 0, over = total() - (this.el.clientWidth - 2); over > 1 && pass < 4; pass++, over = total() - (this.el.clientWidth - 2)) {
      const room = keys.map(k => this.auto[k] - min(k)), sum = room.reduce((a, b) => a + b, 0);
      if (sum <= 0) break;
      keys.forEach((k, i) => { this.auto[k] -= Math.ceil(Math.min(room[i], over * room[i] / sum)); });
    }
    this.measured = true;
  }
  applyWidths() {
    const ws = settleWidths(this.cols.map(c => this.widths[c.key] || this.auto[c.key] || 100), this.el.clientWidth - 2,
                            this.cols.findIndex(c => c.key === this.dragKey));
    this.colgroup.innerHTML = ws.map(w => `<col style="width:${w}px">`).join("");
    this.table.style.width = ws.reduce((a, b) => a + b, 0) + "px";
    this.table.classList.add("fixed");
  }
  fitColumn(key) {   // double-click a header edge: size to the widest cell
    const i = this.cols.findIndex(c => c.key === key); if (i < 0) return;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;display:inline-block;font:14px 'Segoe UI',system-ui,sans-serif";
    document.body.appendChild(probe);
    probe.innerHTML = this.head.children[i].innerHTML; let w = probe.offsetWidth + 30;
    for (const tr of this.body.children) if (tr.children[i]) { probe.innerHTML = tr.children[i].innerHTML; w = Math.max(w, probe.offsetWidth + 22); }
    probe.remove();
    this.widths[key] = Math.max(48, Math.ceil(w)); this.applyWidths(); this.saveWidths();
  }
  render(rows) {
    this.rows = rows;
    this.head.innerHTML = this.cols.map(c => `<th data-key="${c.key}" class="${c.num ? "num" : ""}${this.sort.key === c.key ? " sorted" : ""}" title="${esc(c.title ? `${c.label}: ${c.title}` : c.label)}">${c.label}${this.sort.key === c.key ? `<span class="arrow">${this.sort.dir > 0 ? "▲" : "▼"}</span>` : ""}<span class="rz" data-rz="${c.key}" title="Drag to resize · double-click to fit"></span></th>`).join("");
    const col = this.cols.find(c => c.key === this.sort.key) || this.cols[0];
    const sorted = rows.filter(r => this.passes(r)).sort((a, b) => {
      const va = col.val(a), vb = col.val(b);
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return this.pin(a) - this.pin(b) || r * this.sort.dir || String(a.id ?? "").localeCompare(String(b.id ?? ""), undefined, { numeric: true });
    });
    this.body.innerHTML = sorted.map(r => `<tr ${this.rowAttrs(r)}>${this.cols.map(c => `<td class="${c.num ? "num" : ""} ${c.cls || ""}">${c.cell(r)}</td>`).join("")}</tr>`).join("")
      || `<tr><td colspan="${this.cols.length}" class="muted">${this.empty}</td></tr>`;
    if (!this.measured && rows.length && this.el.clientWidth) this.measure();
    if (this.measured) this.applyWidths();
    if (this.pickers) for (const p of this.pickers) p.refresh();
  }
}

/**
 * Searchable multi-select dropdown, same look as the Vehicles table's filters (.f-multi button + .popover).
 * options() -> [{ value, label (html), n?, empty? (greyed out), group? }]; selected() -> array; onChange(array)
 */
class MultiSelect {
  constructor(btn, { noun, search = "Search…", options, selected, onChange }) {
    Object.assign(this, { btn, noun, search, options, selected, onChange, q: "" });
    this.pop = document.createElement("div"); this.pop.className = "popover"; document.body.appendChild(this.pop);
    btn.addEventListener("click", e => { e.stopPropagation(); this.pop.classList.contains("open") ? this.close() : this.open(); });
    document.addEventListener("mousedown", e => { if (!this.pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) this.close(); });
    addEventListener("resize", () => this.close());
    this.pop.addEventListener("input", e => { if (e.target.classList.contains("pop-search")) { this.q = e.target.value; this.renderList(); } });
    this.pop.addEventListener("change", e => {
      const v = e.target.value, cur = new Set(this.selected());
      e.target.checked ? cur.add(v) : cur.delete(v);
      this.onChange([...cur]); this.refresh();
    });
    this.pop.addEventListener("click", e => {
      if (e.target.dataset.act === "clear") { this.onChange([]); this.refresh(); this.renderList(); }
      if (e.target.dataset.act === "done") this.close();
    });
    this.refresh();
  }
  refresh() {
    const n = this.selected().length;
    this.btn.innerHTML = `<span>${n ? `${n} ${n === 1 ? this.noun.replace(/s$/, "") : this.noun}` : `All ${this.noun}`}</span>`;
    this.btn.classList.toggle("f-active", n > 0);
    if (this.pop.classList.contains("open")) this.renderList();
  }
  open() {
    this.q = "";
    this.pop.innerHTML = `<input class="f-input pop-search" placeholder="${esc(this.search)}"><div class="pop-list"></div>
      <div class="pop-foot"><button data-act="clear">Clear</button><button data-act="done">Done</button></div>`;
    this.pop.classList.add("open");
    this.renderList();
    placePopover(this.pop, this.btn);   // after the list is filled in, so its real height is known
    this.pop.querySelector(".pop-search").focus({ preventScroll: true });
  }
  close() { this.pop.classList.remove("open"); }
  renderList() {
    const sel = new Set(this.selected()), q = this.q.trim().toLowerCase();
    // existing ones first, greyed-out ones after; selected always shown
    const opts = this.options().filter(o => !q || o.value.toLowerCase().includes(q) || sel.has(o.value))
      .sort((a, b) => (a.empty - b.empty) || String(a.group || "").localeCompare(String(b.group || "")) || a.value.localeCompare(b.value));
    let html = "", lastGroup = null, greyed = false;
    for (const o of opts) {
      if (o.empty && !greyed) { greyed = true; html += `<div class="pop-group">Not in your factory</div>`; lastGroup = null; }
      else if (!o.empty && o.group && o.group !== lastGroup) { html += `<div class="pop-group">${esc(o.group)}</div>`; lastGroup = o.group; }
      html += `<label class="${o.empty ? "empty" : ""}"><input type="checkbox" value="${esc(o.value)}"${sel.has(o.value) ? " checked" : ""}>${o.label}<span class="n">${o.n ?? ""}</span></label>`;
    }
    html = html || `<div class="muted" style="padding:6px 8px">No matches</div>`;
    // while it's open the page keeps refreshing: update the existing rows in place when the same options are listed,
    // so a click that lands mid-refresh isn't lost (and the list doesn't scroll back)
    const list = this.pop.querySelector(".pop-list"), t = document.createElement("template"); t.innerHTML = html;
    const key = el => [...el.children].map(c => c.tagName + (c.querySelector("input")?.value || c.textContent)).join("|");
    if (list.children.length && key(list) === key(t.content)) {
      [...t.content.children].forEach((c, i) => {
        const o = list.children[i];
        if (o.className !== c.className) o.className = c.className;
        const n = o.querySelector(".n"), cn = c.querySelector(".n"); if (n && cn && n.textContent !== cn.textContent) n.textContent = cn.textContent;
        const inp = o.querySelector("input"), ci = c.querySelector("input"); if (inp && ci) inp.checked = ci.checked;
      });
    } else list.innerHTML = html;
  }
}
