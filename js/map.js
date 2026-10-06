// The world map used by every tab: the in-game map image, pan/zoom, toggleable layers, hover tooltips,
// "locate" (fly to a point and pulse it) and the X/Y cursor readout. Point layers are drawn here; a tab can draw
// anything else (vehicle paths, rails, moving markers) through the draw() hook. Uses the page's WORLD/IMG/worldToImg/mapImg.
"use strict";


/**
 * new MapView(container, {
 *   layers: [{ key, label, color, on, shape: "dot"|"square"|"diamond"|"ring", size, swatch?: css for the button key,
 *              count?: () => n (for layers drawn by the tab instead of points) }],
 *   storeKey,                       localStorage key for which layers are on
 *   tooltip(point) -> html, onHover(point|null), onClick(point),
 *   draw(ctx, now, mapView)         extra drawing between the map image and the point layers
 *   animate                         repaint every frame (moving markers) while visible
 *   fitTo() -> [image points], fitLabel   what the Fit button frames (default: the visible point layers)
 *   onPan()                         the user dragged the map
 *   hint, dim                       hint text bottom-left; darkening over the map image (0-1)
 * })
 * setPoints(layerKey, [{ id, x, y, color?, label?, ... }]) — world coordinates (Unreal cm)
 */
// Players on any map: MapView({ players: true }) adds this layer, and one shared poll keeps every such map updated.
const PLAYER_COLOR = "#22d3ee";   // cyan: nothing else on the maps uses it
const playerLayer = () => ({ key: "players", group: "People", label: "Players", color: PLAYER_COLOR, size: 6, shape: "player", top: true });
const Players = {
  list: [], maps: new Set(), timer: null,
  attach(mv) {
    this.maps.add(mv); this.push(mv);
    if (!this.timer) { this.poll(); this.timer = setInterval(() => this.poll(), 5000); }
  },
  async poll() {
    try { this.list = await getJSON("getPlayer"); } catch { return; }
    for (const mv of this.maps) this.push(mv);
  },
  push(mv) {   // online: solid orange + name; offline: grey, dashed outline, "(offline)"
    mv.setPoints("players", this.list.filter(p => p.location).map(p => ({ id: p.ID, x: p.location.x, y: p.location.y,
      label: `${p.Name}${p.Online ? " · online" : " · offline"}`, name: p.Online ? p.Name : `${p.Name} (offline)`,
      offline: !p.Online, color: p.Online ? PLAYER_COLOR : "#8c94a1" })));
  },
};

// Belts and pipes on any map: MapView({ logistics: seg => bool }) adds a layer per belt tier (Mk.1-Mk.6) and pipe
// tier (Mk.1-Mk.2) and draws the segments the filter keeps (all, production lines, power lines). One shared fetch
// of /logistics (the server works out the networks). opts.highlight() -> network id draws that network on top.
const BELT_COLOR = { 1: "#4d6a85", 2: "#5d89b3", 3: "#6fa6dc", 4: "#8fc0f1", 5: "#b6d6f7", 6: "#dfecfb" };   // faster = brighter
const PIPE_COLOR = { 1: "#2dd4bf", 2: "#99f6e4" };   // teal, drawn as hollow tubes; belts are solid blue lines
const logisticsLayers = keep => [
  ...[1, 2, 3, 4, 5, 6].map(t => ({ key: "belt" + t, group: "Belts", label: `Mk.${t} belts`, swatch: `background:${BELT_COLOR[t]}`,
    count: () => Logistics.belts.filter(b => b.t === t && keep(b)).length })),
  ...[1, 2].map(t => ({ key: "pipe" + t, group: "Pipes", label: `Mk.${t} pipes`,
    swatch: `background:linear-gradient(${PIPE_COLOR[t]} 0 30%, #0d1013 30% 70%, ${PIPE_COLOR[t]} 70%);height:6px`,
    count: () => Logistics.pipes.filter(b => b.t === t && keep(b)).length })),
];
const Logistics = {
  belts: [], pipes: [], networks: [], counts: {}, maps: new Set(), listeners: new Set(), timer: null,
  attach(mv) { this.maps.add(mv); this.start(); },
  start() { if (!this.timer) { this.poll(); this.timer = setInterval(() => this.poll(), 60000); } },
  async poll() {
    try {
      const r = await fetch("/logistics", { cache: "no-store" }); if (!r.ok) throw 0;
      Object.assign(this, await r.json());
      this.byId = new Map(this.networks.map(n => [n.id, n]));
    } catch { if (!this.belts.length) setTimeout(() => this.poll(), 5000); return; }   // server still working it out
    for (const mv of this.maps) { mv.renderButtons(); mv.draw(); }
    for (const f of this.listeners) f();
  },
};
function drawLogistics(mv, keep, hi, hover) {
  const ctx = mv.ctx, v = mv.view, w = Math.max(1.3, Math.min(3, 1.4 * Math.sqrt(v.s / 0.3)));   // stays visible zoomed out
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const path = segs => { for (const b of segs) { const ip = b.ip || (b.ip = b.pts.map(([x, y]) => worldToImg(x, y)));
    ip.forEach((q, i) => { const s = mv.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); } };
  for (const [kind, list, colors, width] of [["pipe", Logistics.pipes, PIPE_COLOR, w * 2.2], ["belt", Logistics.belts, BELT_COLOR, w]]) {
    for (const t of Object.keys(colors)) {
      if (!mv.isOn(kind + t)) continue;
      const segs = list.filter(b => b.t === +t && keep(b));
      ctx.globalAlpha = hi ? 0.35 : 0.95; ctx.strokeStyle = colors[t]; ctx.lineWidth = width; ctx.beginPath(); path(segs); ctx.stroke();
      if (kind === "pipe") {   // hollow tube: a dark core down the middle
        ctx.globalAlpha = hi ? 0.35 : 0.85; ctx.strokeStyle = "#0d1013"; ctx.lineWidth = Math.max(0.8, width * 0.38); ctx.beginPath(); path(segs); ctx.stroke();
      }
    }
  }
  const outline = (id, color) => {   // a whole network: dark casing + coloured line on top
    const segs = [...Logistics.belts, ...Logistics.pipes].filter(b => b.n === id);
    ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(13,16,19,.9)"; ctx.lineWidth = w + 5; ctx.beginPath(); path(segs); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = w + 2; ctx.beginPath(); path(segs); ctx.stroke();
  };
  if (hi) outline(hi, "#fa9549");                        // picked
  if (hover && hover !== hi) outline(hover, "#ffffff");   // under the mouse
  ctx.globalAlpha = 1;
}

// tooltip for a belt / pipe: the piece itself, then its whole network
const netTooltip = (n, seg) => !n ? "" :
  `<div class="head"><b style="color:#fff">Mk.${seg ? seg.t : "?"} ${n.kind === "belt" ? "conveyor belt" : "pipeline"}</b>` +
  ` · ${n.kind === "belt" ? `${({ 1: 60, 2: 120, 3: 270, 4: 480, 5: 780, 6: 1200 })[seg?.t] || "?"} items/min` : `${({ 1: 300, 2: 600 })[seg?.t] || "?"} m³/min`}<br>` +
  `part of a ${n.kind} network · ${n.p && n.w ? "production + power" : n.p ? "production" : n.w ? "power" : "other"} · ${n.len >= 1000 ? (n.len / 1000).toFixed(1) + " km" : n.len + " m"}</div>` +
  (Object.entries(n.touches).slice(0, 5).map(([k, c]) => `<div class="row"><span>${esc(k)}</span><b>×${c}</b></div>`).join("") || `<div class="row muted"><span>connects to nothing found</span></div>`) +
  `<div class="row muted"><span>${n.segs} pieces · bottleneck ${n.cap ? n.cap + (n.kind === "pipe" ? " m³" : "") + "/min" : "–"}${n.open ? ` · ${n.open} open ends` : ""}</span></div>`;

// The power network on any map: MapView({ powerNet: circuits => bool }) adds power lines, poles, wall outlets,
// towers, switches and power storage, keeping the ones whose circuit(s) the filter accepts (all, or one grid).
// FRM gives poles/storage/buildings a circuit ID and switches two; lines have none, so each line takes the circuit
// of whatever its ends touch. One shared poll every 30 s.
const POWER_COLOR = "#f2d64e";
const powerLayers = keep => [
  { key: "wires", group: "Power network", label: "Power lines", swatch: `background:${POWER_COLOR};height:2px`, count: () => PowerNet.wires.filter(w => keep(w.circuits)).length },
  { key: "poles", group: "Power network", label: "Power poles", color: POWER_COLOR, size: 2.5 },
  { key: "outlets", group: "Power network", label: "Wall outlets", color: POWER_COLOR, size: 3, shape: "square" },
  { key: "towers", group: "Power network", label: "Power towers", color: "#ffe9a3", size: 6, shape: "triangle" },
  { key: "switches", group: "Power network", label: "Power switches", color: POWER_COLOR, size: 5, shape: "diamond" },
  { key: "pstorage", group: "Power network", label: "Power Storage", color: "#fff1a8", size: 4.5, shape: "square" },
];
const PowerNet = {
  wires: [], poles: [], switches: [], storage: [], things: [], groupOf: new Map(), maps: new Set(), listeners: new Set(), timer: null,
  attach(mv) { this.maps.add(mv); if (!this.timer) { this.poll(); this.timer = setInterval(() => this.poll(), 30000); } else this.push(mv); },
  async poll() {
    const [c, p, s, u, g, w] = await Promise.allSettled(["getCables", "getPowerPoles", "getSwitches", "getPowerUsage", "getGenerators", "getPower"].map(e => getJSON(e)));
    const ok = r => r.status === "fulfilled" ? r.value : null;
    const usage = ok(u) || [], gens = ok(g) || [], poles = ok(p) || [];   // getPowerPoles needs the newer FRM build
    this.groupOf = new Map((ok(w) || []).flatMap(gr => (gr.AssociatedCircuits || []).map(c => [c, gr.CircuitGroupID])));
    this.poles = poles.map(x => ({ ...x, kind: /Tower/i.test(x.ClassName) ? "towers" : /Wall/i.test(x.ClassName) ? "outlets" : "poles", circuits: [x.CircuitID] }));
    this.switches = (ok(s) || []).map(x => ({ ...x, circuits: [x.Primary, x.Secondary] }));
    this.storage = usage.filter(x => /PowerStorage/.test(x.ClassName || x.ID)).map(x => ({ ...x, circuits: [x.PowerInfo?.CircuitID] }));
    // everything with a circuit and a place: what a line's end can attach to
    this.things = [...this.poles, ...this.switches, ...usage.filter(x => x.location && x.PowerInfo?.CircuitID >= 0).map(x => ({ location: x.location, circuits: [x.PowerInfo.CircuitID] })),
                   ...gens.filter(x => x.location && x.PowerInfo?.CircuitID >= 0).map(x => ({ location: x.location, circuits: [x.PowerInfo.CircuitID] }))];
    const near = q => { let best = null, bd = 2500 ** 2;   // within 25 m
      for (const t of this.things) { const d = (t.location.x - q.x) ** 2 + (t.location.y - q.y) ** 2 + ((t.location.z - q.z) ** 2) / 4; if (d < bd) { bd = d; best = t; } }
      return best ? best.circuits : []; };
    this.wires = (ok(c) || []).map(x => ({ a: worldToImg(x.location0.x, x.location0.y), b: worldToImg(x.location1.x, x.location1.y),
      circuits: [...new Set([...near(x.location0), ...near(x.location1)])].filter(c => c >= 0) }));
    for (const mv of this.maps) this.push(mv);
    for (const f of this.listeners) f();
  },
  push(mv) {
    const keep = mv.opts.powerNet, pt = (o, extra) => o.location && { id: o.ID, x: o.location.x, y: o.location.y, ...extra };
    for (const k of ["poles", "outlets", "towers"])
      mv.setPoints(k, this.poles.filter(x => x.kind === k && keep(x.circuits)).map(x => pt(x, { circuits: x.circuits, label: `${x.Name} · ${x.Connections} of ${x.MaxConnections} wires` })).filter(Boolean));
    mv.setPoints("switches", this.switches.filter(x => keep(x.circuits)).map(x => pt(x, { circuits: x.circuits, color: x.IsOn ? POWER_COLOR : "#6b7380",
      label: `${x.SwitchTag || x.Name || "Power Switch"} · ${x.IsOn ? "on" : "off"}${x.Priority >= 0 ? ` · priority ${x.Priority}` : ""}` })).filter(Boolean));
    mv.setPoints("pstorage", this.storage.filter(x => keep(x.circuits)).map(x => pt(x, { circuits: x.circuits, label: "Power Storage" })).filter(Boolean));
    mv.draw();
  },
};
function drawPowerLines(mv, keep) {
  if (!mv.isOn("wires") || !PowerNet.wires.length) return;
  const ctx = mv.ctx; ctx.lineWidth = Math.max(0.7, Math.min(1.8, mv.view.s * 2));
  for (const faded of [true, false]) {   // lines off the highlighted grid first, faint; then the rest on top
    ctx.strokeStyle = faded ? "rgba(242,214,78,.12)" : "rgba(242,214,78,.7)"; ctx.beginPath();
    for (const w of PowerNet.wires) {
      if (!keep(w.circuits) || !!mv.opts.fade?.(w) !== faded) continue;
      const a = mv.toScreen(w.a), b = mv.toScreen(w.b); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
}

class MapView {
  constructor(el, opts) {
    this.opts = opts;
    this.layers = [...opts.layers, ...(opts.powerNet ? powerLayers(opts.powerNet) : []), ...(opts.logistics ? logisticsLayers(opts.logistics) : []),
                   ...(opts.players ? [playerLayer()] : [])];
    this.points = {}; this.hoverId = null; this.focus = null; this.fitted = false;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(opts.storeKey) || "{}"); } catch {}
    for (const l of this.layers) l.on = saved[l.key] ?? l.on ?? true;
    this.dragging = false; this.mouseWorld = null;
    el.classList.add("mapview");
    el.innerHTML = `<div class="mv-head"><div class="btns"></div><div class="btns right"><button class="b" data-act="fit">${esc(opts.fitLabel || "Fit")}</button><button class="b" data-act="world">Whole map</button></div></div>
      <div class="mv-box"><canvas></canvas><div class="mv-hint">${esc(opts.hint || "scroll to zoom · drag to pan")}</div></div>`;
    this.btns = el.querySelector(".mv-head .btns");
    this.canvas = el.querySelector("canvas"); this.ctx = this.canvas.getContext("2d");
    this.view = { s: 0.1, ox: 0, oy: 0 };
    el.querySelector(".mv-head").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.act === "fit") this.fit();
      else if (b.dataset.act === "world") this.fitWorld(true);
      else if (b.dataset.act === "layers") { this.menu.classList.contains("open") ? this.closeMenu() : this.openMenu(b); return; }
      else if (b.dataset.layer) this.setLayers({ [b.dataset.layer]: !this.isOn(b.dataset.layer) });
      this.draw();
    });
    // layerMenu: the layers are checkboxes in a dropdown instead of a row of toggle buttons (same .popover look as filters)
    if (opts.layerMenu) {
      this.menu = document.createElement("div"); this.menu.className = "popover mv-menu"; document.body.appendChild(this.menu);
      this.menu.addEventListener("change", e => { if (e.target.dataset.layer) this.setLayers({ [e.target.dataset.layer]: e.target.checked }); });
      this.menu.addEventListener("click", e => {
        const a = e.target.dataset.act;
        if (a === "all" || a === "none") this.setLayers(Object.fromEntries(this.layers.map(l => [l.key, a === "all"])));
        if (a === "done") this.closeMenu();
        const g = e.target.closest("[data-group]");
        if (g) { const ls = this.layers.filter(l => (l.group || "") === g.dataset.group), on = !ls.every(l => l.on);
                 this.setLayers(Object.fromEntries(ls.map(l => [l.key, on]))); }
      });
      document.addEventListener("mousedown", e => { if (!this.menu.contains(e.target) && !e.target.closest(".mv-layers")) this.closeMenu(); });
      addEventListener("resize", () => this.closeMenu());
    }
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    let drag = null;
    this.canvas.addEventListener("mousedown", e => { this.anim = null; drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false }; this.dragging = true; this.canvas.classList.add("dragging"); });
    addEventListener("mouseup", e => {
      if (drag && !drag.moved && e.target === this.canvas) {   // a click, not a pan
        if (this.hoverId) { const p = this.find(this.hoverId); if (p && opts.onClick) opts.onClick(p); }
        else if (opts.onNetClick) opts.onNetClick(this.hoverNet || null);   // a belt/pipe network, or empty map (null)
      }
      drag = null; this.dragging = false; this.canvas.classList.remove("dragging");
    });
    addEventListener("mousemove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { if (!drag.moved && opts.onPan) opts.onPan(); drag.moved = true; }
      this.view.ox = drag.ox + dx; this.view.oy = drag.oy + dy; this.draw();
    });
    this.canvas.addEventListener("wheel", e => {
      this.anim = null;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, v = this.view;
      const s = Math.min(8, Math.max(0.04, v.s * Math.exp(-e.deltaY * 0.0015)));
      v.ox = mx - (mx - v.ox) * (s / v.s); v.oy = my - (my - v.oy) * (s / v.s); v.s = s; this.draw();
    }, { passive: false });
    this.canvas.addEventListener("mousemove", e => {
      const r = this.canvas.getBoundingClientRect(), v = this.view;
      const ix = (e.clientX - r.left - v.ox) / v.s, iy = (e.clientY - r.top - v.oy) / v.s;
      this.mouseWorld = { x: WORLD.x0 + ix / IMG * (WORLD.x1 - WORLD.x0), y: WORLD.y0 + iy / IMG * (WORLD.y1 - WORLD.y0) };
      this.draw();
      if (drag) return;
      // what's under the cursor: a marker if the cursor is right on it (or it's nearer than a belt/pipe), else the line
      let p = this.nearest(e.clientX - r.left, e.clientY - r.top);
      const hit = opts.logistics ? this.nearestSegment(ix, iy) : null;
      if (p && hit && p._d > 6 && hit.d < p._d) p = null;
      const seg = !p && hit ? hit.seg : null, netId = seg ? seg.n : null;
      if ((p && p.id) !== this.hoverId) { this.hoverId = p ? p.id : null; opts.onHover && opts.onHover(p); this.draw(); }
      if (netId !== this.hoverNet) { this.hoverNet = netId; opts.onNetHover && opts.onNetHover(netId); this.draw(); }
      const tip = p ? (p.layer === "players" || !opts.tooltip ? p.label && `<div class="row"><span>${esc(p.label)}</span></div>` : opts.tooltip(p))
                    : seg && netTooltip(Logistics.byId?.get(netId), seg);
      if (tip) showPopAt(tip, e.clientX, e.clientY); else hideCargoPop();
      this.canvas.style.cursor = p || seg ? "pointer" : "";
    });
    this.canvas.addEventListener("mouseleave", () => {
      if (this.hoverNet) { this.hoverNet = null; opts.onNetHover && opts.onNetHover(null); }
      this.mouseWorld = null; this.draw(); if (this.hoverId) { this.hoverId = null; opts.onHover && opts.onHover(null); this.draw(); } hideCargoPop(); });
    mapImg.addEventListener("load", () => this.draw());
    this.renderButtons();
    if (opts.players) Players.attach(this);
    if (opts.logistics) Logistics.attach(this);
    if (opts.powerNet) PowerNet.attach(this);
    if (opts.animate) {   // continuous repaint, skipped while the map isn't on screen (hidden tab)
      const loop = () => { if (this.canvas.clientWidth) this.paint(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
  }
  isOn(key) { return !!this.layers.find(l => l.key === key)?.on; }
  setPoints(key, pts) {
    this.points[key] = pts.map(p => ({ ...p, layer: key, ip: worldToImg(p.x, p.y) }));
    this.renderButtons();
    if (!this.fitted && this.canvas.clientWidth && this.framePoints().length) this.fit();
    this.draw();
  }
  // the belt / pipe under the cursor (image coords), among the ones this map shows; null if none within ~7 px
  nearestSegment(ix, iy) {
    const tol = 7 / this.view.s, keep = this.opts.logistics;
    let best = null, bd = tol;
    for (const [kind, list] of [["belt", Logistics.belts], ["pipe", Logistics.pipes]]) for (const b of list) {
      if (!this.isOn(kind + b.t) || !keep(b)) continue;
      const ip = b.ip || (b.ip = b.pts.map(([x, y]) => worldToImg(x, y)));
      const bx = b.bx || (b.bx = ip.reduce((a, q) => [Math.min(a[0], q.x), Math.min(a[1], q.y), Math.max(a[2], q.x), Math.max(a[3], q.y)], [1e9, 1e9, -1e9, -1e9]));
      if (ix < bx[0] - tol || ix > bx[2] + tol || iy < bx[1] - tol || iy > bx[3] + tol) continue;
      for (let i = 1; i < ip.length; i++) {
        const a = ip[i - 1], c = ip[i], dx = c.x - a.x, dy = c.y - a.y, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((ix - a.x) * dx + (iy - a.y) * dy) / L)) : 0;
        const d = Math.hypot(ix - (a.x + t * dx), iy - (a.y + t * dy));
        if (d < bd) { bd = d; best = b; }
      }
    }
    return best && { seg: best, d: bd * this.view.s };   // distance in screen px
  }
  // what "Fit" frames: visible points, not counting top layers (players), who arrive first and are always in one spot
  framePoints() { return this.layers.filter(l => l.on && !l.top).flatMap(l => this.points[l.key] || []); }
  all(visibleOnly) { return this.layers.filter(l => !visibleOnly || l.on).flatMap(l => this.points[l.key] || []); }
  find(id) { return this.all(false).find(p => p.id === id); }
  // turn layers on/off ({ key: bool }), remember it, redraw
  setLayers(changes) {
    for (const l of this.layers) if (l.key in changes) l.on = changes[l.key];
    try { localStorage.setItem(this.opts.storeKey, JSON.stringify(Object.fromEntries(this.layers.map(x => [x.key, x.on])))); } catch {}
    this.renderButtons(); this.draw();
  }
  swatch(l) {
    if (l.swatchHtml) return l.swatchHtml;
    if (l.swatch) return `<i style="${l.swatch}"></i>`;
    const shape = { square: "", diamond: "transform:rotate(45deg) scale(.8);", ring: `background:none;border:2px solid ${l.color};border-radius:50%;`,
                    arrow: "clip-path:polygon(100% 50%,0 100%,25% 50%,0 0);width:11px;", dot: "border-radius:50%;",
                    player: "border-radius:50%;box-shadow:0 0 0 2px #fff;width:8px;height:8px;",
                    triangle: "clip-path:polygon(50% 0,100% 100%,0 100%);width:11px;height:11px;" }[l.shape || "dot"];
    return `<i style="background:${l.color};width:9px;height:9px;display:inline-block;${shape}"></i>`;
  }
  layerCount(l) { return l.count ? l.count() : (this.points[l.key] || []).length; }
  renderButtons() {
    if (this.opts.layerMenu) {
      const on = this.layers.filter(l => l.on).length;
      this.btns.innerHTML = `<button class="f-multi mv-layers${on < this.layers.length ? " f-active" : ""}" data-act="layers" title="Choose what the map shows">` +
        `<span>Layers <span class="n">${on === this.layers.length ? "all" : `${on} of ${this.layers.length}`}</span></span></button>`;
      if (this.menu.classList.contains("open")) this.renderMenu();
      return;
    }
    this.btns.innerHTML = this.layers.map(l => `<button class="b layer${l.on ? " on" : ""}" data-layer="${l.key}" title="${l.on ? "Hide" : "Show"} ${esc(l.label.toLowerCase())}">` +
      `${this.swatch(l)}${esc(l.label)} <span class="n">${this.layerCount(l)}</span></button>`).join("");
  }
  // layers with a group get a heading per group (in order of first appearance); clicking a heading toggles the group
  renderMenu() {
    const groups = [...new Set(this.layers.map(l => l.group || ""))];
    const row = l => `<label class="${this.layerCount(l) ? "" : "empty"}"><input type="checkbox" data-layer="${l.key}"${l.on ? " checked" : ""}>` +
      `<span class="mv-sw">${this.swatch(l)}</span>${esc(l.label)}<span class="n">${this.layerCount(l)}</span></label>`;
    this.menu.innerHTML = `<div class="pop-list">${groups.map(g => {
      const ls = this.layers.filter(l => (l.group || "") === g);
      return (g && groups.length > 1 ? `<div class="pop-group" data-group="${esc(g)}" title="Show / hide all ${esc(g.toLowerCase())}">${esc(g)}</div>` : "") + ls.map(row).join("");
    }).join("")}</div>
      <div class="pop-foot"><button data-act="all">All</button><button data-act="none">None</button><button data-act="done">Done</button></div>`;
  }
  openMenu(btn) {
    this.renderMenu(); this.menu.classList.add("open");
    const r = btn.getBoundingClientRect();
    this.menu.style.left = Math.max(8, Math.min(r.left, innerWidth - this.menu.offsetWidth - 8)) + "px";
    placePopover(this.menu, btn);
  }
  closeMenu() { this.menu?.classList.remove("open"); }
  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (!r.width) return;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.anim = null;
    // size changed (window resize, panel expanded/restored): keep showing the same area, scaled to the new size
    const last = this.lastSize, v = this.view;
    if (this.fitted && last && last.w && (last.w !== r.width || last.h !== r.height)) {
      const cx = (last.w / 2 - v.ox) / v.s, cy = (last.h / 2 - v.oy) / v.s;
      v.s *= Math.min(r.width / last.w, r.height / last.h);
      v.ox = r.width / 2 - cx * v.s; v.oy = r.height / 2 - cy * v.s;
    }
    this.lastSize = { w: r.width, h: r.height };
    if (!this.fitted) this.fit();
    this.draw();
  }
  fitBox(pts, pad = 40, animate = false) {
    const r = this.canvas.getBoundingClientRect(); if (!r.width || !pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const w = Math.max(x1 - x0, 40), h = Math.max(y1 - y0, 40);
    const s = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h, 3);
    this.goTo({ s, ox: r.width / 2 - (x0 + x1) / 2 * s, oy: r.height / 2 - (y0 + y1) / 2 * s }, animate);
  }
  // move the view to t = { s, ox, oy }; animate: glide there (~0.35 s, zoom eased in log scale so it feels even).
  // Any drag, scroll or resize cancels a glide in progress. The view object is updated in place (others hold it).
  goTo(t, animate) {
    const v = this.view, r = this.canvas.getBoundingClientRect();
    if (!animate || !r.width) { this.anim = null; Object.assign(v, t); this.draw(); return; }
    const W = r.width / 2, H = r.height / 2, from = { ...v }, t0 = performance.now(), D = 350;
    const c0 = { x: (W - from.ox) / from.s, y: (H - from.oy) / from.s }, c1 = { x: (W - t.ox) / t.s, y: (H - t.oy) / t.s };
    const anim = this.anim = {};
    const step = now => {
      if (this.anim !== anim) return;
      const k = 1 - (1 - Math.min(1, (now - t0) / D)) ** 3;
      const s = Math.exp(Math.log(from.s) + (Math.log(t.s) - Math.log(from.s)) * k);
      const cx = c0.x + (c1.x - c0.x) * k, cy = c0.y + (c1.y - c0.y) * k;
      v.s = s; v.ox = W - cx * s; v.oy = H - cy * s;
      this.paint();
      if (k < 1) requestAnimationFrame(step); else this.anim = null;
    };
    requestAnimationFrame(step);
  }
  // frame the tab's chosen points (or the visible point layers); whole map until there's something to frame
  fit() {
    let pts = this.opts.fitTo ? this.opts.fitTo() : null;
    if (!pts || !pts.length) pts = this.framePoints().map(p => p.ip);
    const glide = this.fitted;   // the very first framing is instant; later ones (Fit, filters) glide
    if (pts.length && this.canvas.clientWidth) { this.fitBox(pts, this.opts.fitTo ? 60 : 40, glide); this.fitted = true; } else this.fitWorld(glide);
    this.draw();
  }
  fitWorld(animate = false) { this.fitBox([{ x: 0, y: 0 }, { x: IMG, y: IMG }], 6, animate); }
  // fly to a point and pulse it for a few seconds (turns its layer on if needed)
  locate(id) {
    const p = this.find(id); if (!p) return;
    const l = this.layers.find(x => x.key === p.layer); if (!l.on) { l.on = true; this.renderButtons(); }
    const r = this.canvas.getBoundingClientRect(), s = Math.max(1, this.view.s);
    this.goTo({ s, ox: r.width / 2 - p.ip.x * s, oy: r.height / 2 - p.ip.y * s }, true);
    this.focus = { id, until: performance.now() + 4000 };
    const tick = () => { this.draw(); if (this.focus && performance.now() < this.focus.until) requestAnimationFrame(tick); else { this.focus = null; this.draw(); } };
    requestAnimationFrame(tick);
    this.canvas.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  highlight(id) { if (id !== this.hoverId) { this.hoverId = id; this.draw(); } }
  // emphasis: Map id -> ring colour; those points stand out and everything else fades (null clears it)
  setEmphasis(m) { this.emphasis = m && m.size ? m : null; this.draw(); }
  fitEmphasis() {
    const pts = this.all(true).filter(p => this.emphasis?.has(p.id)).map(p => p.ip);
    if (pts.length) this.fitBox(pts, 50, true);
  }
  toScreen(ip) { return { x: ip.x * this.view.s + this.view.ox, y: ip.y * this.view.s + this.view.oy }; }
  radius(l) { return (l.size || 4) * Math.max(0.55, Math.min(1.4, Math.sqrt(this.view.s / 0.5))); }
  nearest(mx, my) {
    let best = null, bd = 12;
    for (const l of this.layers) if (l.on) for (const p of this.points[l.key] || []) {
      const s = this.toScreen(p.ip), d = Math.hypot(s.x - mx, s.y - my);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) best._d = bd;
    return best;
  }
  draw() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => { this.pending = null; this.paint(); });
  }
  paint() {
    const ctx = this.ctx, r = this.canvas.getBoundingClientRect(), v = this.view;
    if (!r.width) return;
    ctx.clearRect(0, 0, r.width, r.height);
    if (mapImg.complete && mapImg.naturalWidth) {
      ctx.imageSmoothingEnabled = v.s < 1;
      // only the part of the map image that's on screen: drawing all 8192 px scaled up fails (blank) when zoomed in
      const sx = Math.max(0, -v.ox / v.s), sy = Math.max(0, -v.oy / v.s);
      const sw = Math.min(IMG - sx, r.width / v.s - Math.max(0, v.ox / v.s)), sh = Math.min(IMG - sy, r.height / v.s - Math.max(0, v.oy / v.s));
      if (sw > 0 && sh > 0) ctx.drawImage(mapImg, sx, sy, sw, sh, v.ox + sx * v.s, v.oy + sy * v.s, sw * v.s, sh * v.s);
      ctx.fillStyle = `rgba(10,12,16,${this.opts.dim ?? 0.45})`; ctx.fillRect(0, 0, r.width, r.height);
    }
    if (this.opts.powerNet) { ctx.save(); drawPowerLines(this, this.opts.powerNet); ctx.restore(); }
    if (this.opts.logistics) { ctx.save(); drawLogistics(this, this.opts.logistics, this.opts.highlight?.(), this.hoverNet); ctx.restore(); }   // under everything else
    if (this.opts.draw) { ctx.save(); this.opts.draw(ctx, performance.now(), this); ctx.restore(); }
    const marked = [], emph = [], top = [];
    for (const l of this.layers) {
      if (!l.on) continue;
      if (l.top) { for (const p of this.points[l.key] || []) top.push([p, this.toScreen(p.ip), l, Math.max(l.size, this.radius(l))]); continue; }   // never shrink below its size
      const rad = this.radius(l);
      for (const p of this.points[l.key] || []) {
        const s = this.toScreen(p.ip);
        if (s.x < -10 || s.y < -10 || s.x > r.width + 10 || s.y > r.height + 10) continue;
        if (p.id === this.hoverId || (this.focus && p.id === this.focus.id)) { marked.push([p, s, l, rad]); continue; }
        if (this.emphasis?.has(p.id)) { emph.push([p, s, l, rad]); continue; }
        this.mark(p, s, l, rad, this.opts.fade?.(p) ? 0.18 : this.emphasis ? 0.25 : this.hoverId || this.focus ? 0.6 : 1);
      }
    }
    for (const [p, s, l, rad] of emph) {   // emphasised points: full colour with a coloured ring, above the faded rest
      ctx.strokeStyle = cssColor(this.emphasis.get(p.id)); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, rad + 4, 0, Math.PI * 2); ctx.stroke();
      this.mark(p, s, l, rad, 1);
    }
    for (const [p, s, l, rad] of marked) {   // highlighted on top, with a ring + label
      const now = performance.now();
      if (this.focus && p.id === this.focus.id) {
        const t = (now % 1200) / 1200;
        ctx.strokeStyle = `rgba(250,149,73,${1 - t})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(s.x, s.y, 10 + t * 24, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.strokeStyle = "#fa9549"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, rad + 6, 0, Math.PI * 2); ctx.stroke();
      this.mark(p, s, l, rad + 1.5, 1);
      if (p.label) {
        ctx.font = "600 12px Segoe UI, sans-serif"; ctx.textBaseline = "middle";
        const w = ctx.measureText(p.label).width;
        ctx.fillStyle = "rgba(13,16,19,.92)"; ctx.fillRect(s.x + rad + 10, s.y - 10, w + 12, 20);
        ctx.strokeStyle = "#fa9549"; ctx.lineWidth = 1; ctx.strokeRect(s.x + rad + 10.5, s.y - 9.5, w + 11, 19);
        ctx.fillStyle = "#fff"; ctx.fillText(p.label, s.x + rad + 16, s.y);
      }
    }
    const placed = [];   // name labels already drawn this frame (they stack instead of overlapping)
    for (const [p, s, l, rad] of top) {   // e.g. players: above everything, full strength, name always shown
      if (s.x < -60 || s.y < -20 || s.x > r.width + 20 || s.y > r.height + 20) continue;
      this.mark(p, s, l, rad, 1);
      if (!p.name) continue;
      ctx.font = "600 12px Segoe UI, sans-serif"; ctx.textBaseline = "middle";
      const w = ctx.measureText(p.name).width, x = s.x + rad + 6;
      let y = s.y;
      const hits = b => placed.some(o => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
      while (hits({ x: x - 3, y: y - 9, w: w + 8, h: 18 })) y += 19;
      placed.push({ x: x - 3, y: y - 9, w: w + 8, h: 18 });
      if (y !== s.y) {   // moved: a thin leader line back to the marker
        ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(s.x + rad, s.y); ctx.lineTo(x - 3, y); ctx.stroke();
      }
      ctx.fillStyle = "rgba(13,16,19,.85)"; ctx.fillRect(x - 3, y - 9, w + 8, 18);
      ctx.fillStyle = p.offline ? "#aab1bd" : "#fff"; ctx.fillText(p.name, x + 1, y);
    }
    this.drawCoords(r);
  }
  // world X/Y under the cursor, bottom-right (in metres, like the game's map)
  drawCoords(r) {
    if (!this.mouseWorld) return;
    const ctx = this.ctx, fmt = n => Math.round(n / 100).toLocaleString();
    const text = `X ${fmt(this.mouseWorld.x)} m   Y ${fmt(this.mouseWorld.y)} m`;
    ctx.font = "600 13px Consolas, 'Segoe UI', monospace"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width, bx = r.width - w - 26, by = r.height - 36;
    ctx.fillStyle = "rgba(13,16,19,.85)"; ctx.fillRect(bx, by, w + 16, 26);
    ctx.strokeStyle = "rgba(250,149,73,.6)"; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, w + 15, 25);
    ctx.fillStyle = "#fff"; ctx.fillText(text, bx + 8, by + 13);
  }
  mark(p, s, l, rad, alpha) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = cssColor(p.color || l.color); ctx.strokeStyle = "#0d1013"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (l.shape === "square") ctx.rect(s.x - rad, s.y - rad, rad * 2, rad * 2);
    else if (l.shape === "diamond") { ctx.moveTo(s.x, s.y - rad * 1.3); ctx.lineTo(s.x + rad * 1.3, s.y); ctx.lineTo(s.x, s.y + rad * 1.3); ctx.lineTo(s.x - rad * 1.3, s.y); ctx.closePath(); }
    else if (l.shape === "arrow") {
      const a = (p.rot || 0) * Math.PI / 180, r = rad * 1.25, pt = (x, y) => [s.x + x * Math.cos(a) - y * Math.sin(a), s.y + x * Math.sin(a) + y * Math.cos(a)];
      ctx.moveTo(...pt(r * 1.4, 0)); ctx.lineTo(...pt(-r, r * 0.85)); ctx.lineTo(...pt(-r * 0.5, 0)); ctx.lineTo(...pt(-r, -r * 0.85)); ctx.closePath();
    }
    else if (l.shape === "triangle") {   // a tower (Space Elevator)
      ctx.moveTo(s.x, s.y - rad * 1.5); ctx.lineTo(s.x + rad * 1.15, s.y + rad * 0.9); ctx.lineTo(s.x - rad * 1.15, s.y + rad * 0.9); ctx.closePath();
    }
    else if (l.shape === "player") {
      ctx.arc(s.x, s.y, rad, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; if (p.offline) ctx.setLineDash([3, 2.5]);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.lineWidth = 1; ctx.strokeStyle = "#0d1013"; ctx.beginPath(); ctx.arc(s.x, s.y, rad + 2, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1; return;
    }
    else if (l.shape === "ring") { ctx.arc(s.x, s.y, rad, 0, Math.PI * 2); ctx.globalAlpha = alpha; ctx.lineWidth = 2; ctx.strokeStyle = cssColor(p.color || l.color); ctx.stroke(); ctx.globalAlpha = 1; return; }
    else ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
