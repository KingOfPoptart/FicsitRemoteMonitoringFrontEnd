"""FICSIT monitor - serves the page, proxies Ficsit Remote Monitoring (FRM) so the browser has no CORS issues,
and records power/production history so the charts have data from before the page was opened.

  python server.py [--port 8090] [--host 127.0.0.1] [--frm http://localhost:8080] [--no-history]

/api/<endpoint>  ->  <FRM URL>/<endpoint>   (responses cached 1 s, big ones 4 s, so several open pages don't multiply FRM load)
/hist/power?mins=60       power history per grid (sampled every 5 s, kept 24 h)
/hist/production?mins=60  produced/consumed per item and generation per generator type (sampled every 15 s, kept 24 h)
/hist/sink?mins=60        AWESOME Sink points per minute (from the running total, sampled every 15 s, kept 24 h)
/sinks                    each AWESOME Sink and the machines whose belts lead into it (worked out at most once a minute)
/hypertubes               tube networks, entrances (power) and the open ends rides shoot out of (at most every 30 s)
/logistics                every belt, conveyor lift and pipe (tier, production / power) and their networks (worked out
                          every 60 s while a page shows them, every 5 min for a page in the background, else not at all)

By default it only listens on this machine (127.0.0.1). Use --host 0.0.0.0 to reach it from other
devices on your network. The FRM URL can also be set with the FRM_URL environment variable.
History is saved to history.json next to this file, so it survives a restart.
Run tools/fetch_assets.py once first to get the map image, vehicle pictures and icons.
"""
import argparse
import http.server
import json
import math
import os
import pathlib
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).parent
ALLOWED = {"getFactoryCart", "getVehicles", "getTruckStation", "getVehiclePaths", "getTrains", "getTrainStation",
           "getTrainRails", "getDrone", "getDroneStation",
           "getFactory", "getExtractor", "getGenerators", "getPower", "getPowerUsage", "getSwitches", "getSessionInfo",
           "getBelts", "getLifts", "getSplitterMerger", "getStorageInv", "getFluidBuffer", "getCrateInv", "getPipes", "getPipeJunctions", "getPump",
           "getCables", "getPowerPoles",
           "getProdStats", "getSpaceElevator", "getHUBTerminal", "getTradingPost", "getSchematics", "getResearchTrees",
           "getResourceSink", "getPlayer", "getWorldInv", "getCloudInv", "getArtifacts", "getPowerSlug", "getResourceNode",
           "getRecipes", "getResourceSinkBuilding", "getExplorationSink", "getSinkList",
           "getHypertube", "getHyperEntrance", "getHyperJunctions"}
# Never forwarded to FRM (comma-separated in $FRM_BLOCK): for an endpoint that crashes the game on a mismatched mod build.
BLOCKED = set(filter(None, os.environ.get("FRM_BLOCK", "").split(",")))
FRM = os.environ.get("FRM_URL", "http://localhost:8080").rstrip("/")
CACHE_S = 1.0
# Big replies are kept a little longer, so tabs, other pages and the recorder fetching them at different moments share
# one request. 4 s, not 5: tabs poll these every 5 s and should still get a fresh copy each time.
SLOW_CACHE_S = dict.fromkeys(("getFactory", "getExtractor", "getGenerators", "getPowerUsage", "getCables", "getPowerPoles",
                              "getStorageInv", "getVehiclePaths", "getBelts", "getPipes", "getResourceNode", "getHypertube"), 4.0)
HISTORY_FILE = ROOT / "history.json"
KEEP_S = 24 * 3600
POWER_EVERY_S, PROD_EVERY_S, SAVE_EVERY_S = 5, 15, 60


# ---- FRM access with a short cache ------------------------------------------------------------
_cache, _cache_lock = {}, threading.Lock()
_ep_locks = {ep: threading.Lock() for ep in ALLOWED}


def frm(endpoint, max_age=None):
    """(status, body bytes) for an FRM endpoint; concurrent callers share one request."""
    if endpoint in BLOCKED:
        return 503, b'{"error":"endpoint blocked (FRM_BLOCK)"}'
    if max_age is None:
        max_age = SLOW_CACHE_S.get(endpoint, CACHE_S)
    with _ep_locks[endpoint]:
        with _cache_lock:
            hit = _cache.get(endpoint)
        if hit and time.monotonic() - hit[0] < max_age:
            return hit[1], hit[2]
        try:
            with urllib.request.urlopen(f"{FRM}/{endpoint}", timeout=15) as r:
                body, status = r.read(), 200
        except urllib.error.HTTPError as e:   # e.g. FRM's 503 while a session loads
            body, status = e.read() or b'{"error":"FRM error"}', e.code
        except (urllib.error.URLError, OSError) as e:
            body, status = (b'{"error":"FRM not reachable - is the game/server up and its web server started (/frm http start)?","detail":"'
                            + str(e).replace('"', "'").encode() + b'"}'), 502
        if status == 200:   # don't cache errors: once FRM is back, the next call should reach it
            with _cache_lock:
                _cache[endpoint] = (time.monotonic(), status, body)
        return status, body


def frm_json(endpoint, max_age=None):
    status, body = frm(endpoint, max_age)
    if status != 200:
        raise OSError(f"{endpoint}: HTTP {status}")
    return json.loads(body)


# ---- history ---------------------------------------------------------------------------------
def load_items():
    try:
        return {i["name"]: i for i in json.loads((ROOT / "items.json").read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return {}


ITEMS = load_items()
# spent fuel rods: waste per rod burned (wiki)
WASTE = {"Uranium Fuel Rod": ("Uranium Waste", 50), "Plutonium Fuel Rod": ("Plutonium Waste", 10)}


def production_totals(factories, extractors, generators):
    """{item: [produced/min, consumed/min]} over every machine, including what generators burn."""
    tot = {}

    def add(name, i, v):
        if v:
            tot.setdefault(name, [0.0, 0.0])[i] += v
    for m in factories + extractors:
        for p in m.get("production") or []:
            add(p["Name"], 0, p.get("CurrentProd", 0))
        for c in m.get("ingredients") or []:
            add(c["Name"], 1, c.get("CurrentConsumed", 0))
    for g in generators:
        for name, rate in generator_burn(g):
            add(name, 1 if rate > 0 else 0, abs(rate))
    return tot


def generator_burn(g):
    """[(item, per min)] a generator uses right now; negative = produced (nuclear waste)."""
    mw = g.get("RegulatedDemandProd") or 0
    out = []
    fuel = next((f for f in g.get("FuelInventory") or [] if f.get("Amount", 0) > 0
                 and ITEMS.get(f["Name"], {}).get("energy")), None)
    if mw > 0 and fuel:
        rate = mw * 60 / ITEMS[fuel["Name"]]["energy"]
        out.append((fuel["Name"], rate))
        if fuel["Name"] in WASTE:
            waste, per_rod = WASTE[fuel["Name"]]
            out.append((waste, -rate * per_rod))
    sup = g.get("Supplement") or {}
    if sup.get("CurrentConsumed") and sup.get("Name") not in (None, "", "N/A"):
        out.append((sup["Name"], sup["CurrentConsumed"]))
    return out


class History:
    """Rolling 24 h history, columnar so it serialises small. One instance, guarded by a lock."""

    def __init__(self):
        self.lock = threading.Lock()
        self.session = None
        self.power = []   # [t, {groupId: [prod, cons, cap, maxCons, batteryPct, battIn, battOut, fuse, battCapMWh]}]
        self.prod = []    # [t, {item: [p, c]}, {genType: MW}]
        self.sink = []    # [t, total standard points, total DNA points]

    def load(self):
        try:
            d = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            self.session, self.power, self.prod = d.get("session"), d.get("power", []), d.get("prod", [])
            self.sink = d.get("sink", [])
            self.trim()
        except (OSError, ValueError):
            pass

    def save(self):
        with self.lock:
            data = json.dumps({"session": self.session, "power": self.power, "prod": self.prod, "sink": self.sink}, separators=(",", ":"))
        tmp = HISTORY_FILE.with_suffix(".tmp")
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, HISTORY_FILE)

    def trim(self):
        cut = time.time() - KEEP_S
        self.power = [s for s in self.power if s[0] >= cut]
        self.prod = [s for s in self.prod if s[0] >= cut]
        self.sink = [s for s in self.sink if s[0] >= cut]

    def check_session(self, name):
        """A different save was loaded: its history doesn't belong on the same chart."""
        with self.lock:
            if name and name != self.session:
                self.session, self.power, self.prod, self.sink = name, [], [], []

    def add_power(self, groups):
        r = lambda v: round(v or 0, 2)
        with self.lock:
            last = self.power[-1][1] if self.power else {}
        # a grid that was producing a moment ago and now reads all zeros (no fuse) is a glitch - FRM sometimes
        # returns an empty reading while the server is busy; a real outage shows as a tripped fuse instead
        groups = [g for g in groups if not (str(g["CircuitGroupID"]) in last and last[str(g["CircuitGroupID"])][2] > 0
                  and not g.get("FuseTriggered") and not any(g.get(k) for k in ("PowerProduction", "PowerConsumed", "PowerCapacity")))]
        if not groups:
            return
        row = {str(g["CircuitGroupID"]): [r(g["PowerProduction"]), r(g["PowerConsumed"]), r(g["PowerCapacity"]),
                                          r(g["PowerMaxConsumed"]), r(g["BatteryPercent"]), r(g["BatteryInput"]),
                                          r(g["BatteryOutput"]), 1 if g.get("FuseTriggered") else 0,
                                          r(g.get("BatteryCapacity"))] for g in groups}   # MWh, so stored charge = % x this
        # one value reading 0 for a grid that's running (no fuse) is a glitch too: keep its previous value
        # (production, consumption, capacity, max consumption, battery %)
        for k, v in row.items():
            prev = last.get(k)
            if prev and not v[7]:
                for i in range(5):
                    if v[i] == 0 and prev[i] > 0:
                        v[i] = prev[i]
        with self.lock:
            self.power.append([round(time.time()), row])
            self.trim()

    def add_prod(self, totals, gen):
        with self.lock:
            self.prod.append([round(time.time()), {k: [round(p, 3), round(c, 3)] for k, (p, c) in totals.items()},
                              {k: round(v, 2) for k, v in gen.items()}])

    def add_sink(self, total, dna):
        with self.lock:
            self.sink.append([round(time.time()), total, dna])

    def sink_json(self, mins):
        """points/min over the minute before each sample (the sink takes items in bursts: a 15 s step is too jumpy)"""
        with self.lock:
            rows = list(self.sink)
        out, j = [], 0
        for i, (t, p, d) in enumerate(rows):
            while j < i - 1 and t - rows[j + 1][0] >= 60:
                j += 1
            t0, p0, d0 = rows[j]
            # a gap (server down) or the total going back (save reloaded): no reading
            ok = j < i and 50 <= t - t0 <= 180 and p >= p0 and d >= d0
            out.append([t, round((p - p0) / (t - t0) * 60) if ok else None, round((d - d0) / (t - t0) * 60) if ok else None])
        rows, step = self.window(out, mins)
        if step != 1:
            avg = lambda vs: round(sum(vs) / len(vs)) if vs else None
            rows = [[b[-1][0], avg([s[1] for s in b if s[1] is not None]), avg([s[2] for s in b if s[2] is not None])] for b in rows]
        return {"session": self.session, "interval": PROD_EVERY_S * step, "t": [r[0] for r in rows],
                "points": [r[1] for r in rows], "dna": [r[2] for r in rows]}

    @staticmethod
    def window(rows, mins, max_points=720):
        """Rows from the last `mins` minutes, averaged into at most max_points buckets."""
        cut = time.time() - mins * 60
        rows = [s for s in rows if s[0] >= cut]
        if len(rows) <= max_points:
            return rows, 1
        step = len(rows) / max_points
        return [rows[int(i * step):int((i + 1) * step)] for i in range(max_points)], step

    def power_json(self, mins):
        with self.lock:
            rows, step = self.window(self.power, mins)
        if step != 1:   # average each bucket; fuse = tripped at any point in it
            merged = []
            for b in rows:
                keys = set().union(*(s[1].keys() for s in b))
                row = {}
                for k in keys:
                    vals = [s[1][k] for s in b if k in s[1]]
                    caps = [v[8] for v in vals if len(v) > 8]   # older samples have no battery capacity
                    row[k] = ([round(sum(v[i] for v in vals) / len(vals), 2) for i in range(7)] + [max(v[7] for v in vals)]
                              + ([round(sum(caps) / len(caps), 2)] if caps else []))
                merged.append([b[-1][0], row])
            rows = merged
        groups = {}
        for i, (t, row) in enumerate(rows):
            for k, v in row.items():
                g = groups.setdefault(k, {f: [None] * len(rows) for f in
                                          ("prod", "cons", "cap", "max", "batt", "battIn", "battOut", "fuse", "battCap")})
                for f, x in zip(g, v):
                    g[f][i] = x
        return {"session": self.session, "interval": POWER_EVERY_S * step, "t": [r[0] for r in rows], "groups": groups}

    def prod_json(self, mins):
        with self.lock:
            rows, step = self.window(self.prod, mins)
        if step != 1:
            merged = []
            for b in rows:
                items, gen = {}, {}
                for s in b:
                    for k, (p, c) in s[1].items():
                        a = items.setdefault(k, [0, 0]); a[0] += p; a[1] += c
                    for k, v in s[2].items():
                        gen[k] = gen.get(k, 0) + v
                n = len(b)
                merged.append([b[-1][0], {k: [round(p / n, 3), round(c / n, 3)] for k, (p, c) in items.items()},
                               {k: round(v / n, 2) for k, v in gen.items()}])
            rows = merged
        items, gen = {}, {}
        for i, (_, it, gn) in enumerate(rows):
            for k, (p, c) in it.items():
                a = items.setdefault(k, {"p": [0] * len(rows), "c": [0] * len(rows)})
                a["p"][i], a["c"][i] = p, c
            for k, v in gn.items():
                gen.setdefault(k, [0] * len(rows))[i] = v
        return {"session": self.session, "interval": PROD_EVERY_S * step, "t": [r[0] for r in rows], "items": items, "gen": gen}


HIST = History()


# ---- logistics: conveyor belts and pipes --------------------------------------------------------
# FRM lists belts and pipes (curve, both ends, whether each end is connected) but not what they connect to, so
# networks are worked out from geometry: segments whose ends meet, segments touching the same joiner (splitter,
# merger, pipe junction, pump, valve) and, for belts, connected ends straight above each other (a conveyor lift,
# which FRM doesn't list) form one network. A network feeds "production" if any end sits at a machine or
# extractor and "power" if at a generator; other buildings it reaches are listed by name.
# Only while someone is looking: getBelts / getPipes are big and FRM answers them on the game thread (a short hitch
# on the server), so it's every minute for a page showing them, every 5 minutes for one in the background, else never.
LOGI = {"json": None, "t": -1e9, "tried": -1e9, "fg": -1e9, "bg": -1e9}   # monotonic: last result, last try, last asked (in view / background)
LOGI_EVERY_S, LOGI_BG_EVERY_S, LOGI_IDLE_S = 60, 300, 180
_logi_wake = threading.Event()


def logistics_due():
    now = time.monotonic()
    if now - LOGI["tried"] < 30:   # working on it, or FRM just failed: don't hammer it
        return False
    age = now - LOGI["t"]
    return ((now - LOGI["fg"] < LOGI_IDLE_S and age >= LOGI_EVERY_S - 5) or
            (now - LOGI["bg"] < LOGI_IDLE_S and age >= LOGI_BG_EVERY_S - 5))
PIPE_FLOW = {1: 300, 2: 600}   # m³/min per pipe tier (wiki)


def _box(b, pad):
    bb = b.get("BoundingBox") or {}
    mn, mx = bb.get("min"), bb.get("max")
    if not mn or mn == mx:   # no size reported: a box around its location
        l = b["location"]
        return (l["x"] - 600 - pad, l["y"] - 600 - pad, l["z"] - 200 - pad, l["x"] + 600 + pad, l["y"] + 600 + pad, l["z"] + 1200 + pad)
    return (mn["x"] - pad, mn["y"] - pad, mn["z"] - pad, mx["x"] + pad, mx["y"] + pad, mx["z"] + pad)


class _BoxGrid:
    """boxes bucketed on a 20 m grid so 'which boxes contain this point' is quick"""
    S = 2000

    def __init__(self, boxes):
        self.cells = {}
        for tag, b in boxes:
            for gx in range(int(b[0] // self.S), int(b[3] // self.S) + 1):
                for gy in range(int(b[1] // self.S), int(b[4] // self.S) + 1):
                    self.cells.setdefault((gx, gy), []).append((tag, b))

    def hits(self, p):
        for tag, b in self.cells.get((int(p["x"] // self.S), int(p["y"] // self.S)), ()):
            if b[0] <= p["x"] <= b[3] and b[1] <= p["y"] <= b[4] and b[2] <= p["z"] <= b[5]:
                yield tag


def _tier(name):
    name = name or ""
    return int(name.rsplit(".", 1)[-1]) if "Mk." in name and name.rsplit(".", 1)[-1].isdigit() else 1


def networks(kind, segs, joiners, buildings, storage=frozenset()):
    """segs: belts (conveyor lifts included: they're belt pieces that go up) or pipes; joiners: splitters/mergers or junctions/pumps/valves;
    buildings: [(category 'p'|'w'|'o', name, id, box)]; storage: IDs of storage buildings, listed per network
    as "st" so the page can link a network to its storage. Returns (segments, lifts, networks)."""
    parent = list(range(len(segs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        parent[find(a)] = find(b)

    touch = {}   # network root -> {(cat, name, id)}
    if segs and all("ConnectedTo0" in s for s in segs):
        # newer FRM says what each end is plugged into: follow that (exact; lifts, splitters, machines…)
        seg_at = {s.get("ID"): i for i, s in enumerate(segs)}
        joiner_ids = {x.get("ID") for x in joiners}
        by_id = {bid: (cat, name, bid) for cat, name, bid, _ in buildings}
        first, ends_to = {}, []
        for i, s in enumerate(segs):
            for k in ("ConnectedTo0", "ConnectedTo1"):
                to = s.get(k)
                if not to:
                    continue
                if to in seg_at:
                    union(i, seg_at[to])
                elif to in by_id:
                    ends_to.append((i, by_id[to]))
                elif to in joiner_ids or "Passthrough" in to or "Hole" in to:
                    # a splitter / merger / junction / pump / valve, or a floor or wall hole: the pieces on it are one network
                    if to in first:
                        union(first[to], i)
                    else:
                        first[to] = i
                # anything else (a building this page doesn't list) ends the line, like a machine does
        for i, tag in ends_to:
            touch.setdefault(find(i), set()).add(tag)
    else:   # older FRM: work it out from where the ends are
        ends = [(i, s[k], s.get(c)) for i, s in enumerate(segs) for k, c in (("location0", "Connected0"), ("location1", "Connected1"))]
        grid = {}   # ends at the same spot (within 20 cm)
        for i, q, _ in ends:
            grid.setdefault((round(q["x"] / 50), round(q["y"] / 50), round(q["z"] / 50)), []).append((i, q))
        for i, q, _ in ends:
            gx, gy, gz = round(q["x"] / 50), round(q["y"] / 50), round(q["z"] / 50)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for j, r in grid.get((gx + dx, gy + dy, gz + dz), ()):
                            if j != i and abs(q["x"] - r["x"]) < 20 and abs(q["y"] - r["y"]) < 20 and abs(q["z"] - r["z"]) < 20:
                                union(i, j)
        jgrid, first = _BoxGrid([(n, _box(x, 60)) for n, x in enumerate(joiners)]), {}
        for i, q, _ in ends:   # segments touching the same joiner
            for n in jgrid.hits(q):
                if n in first:
                    union(first[n], i)
                else:
                    first[n] = i
        # lifts: FRM reports their ends on the lift's centre line, so join each to the nearest belt end at that height
        lift_ends = [(i, q) for i, q, c in ends if c and _is_lift(segs[i])]
        belt_ends = [(i, q) for i, q, c in ends if c and not _is_lift(segs[i])]
        for i, q in lift_ends:
            near = [(math.hypot(q["x"] - r["x"], q["y"] - r["y"]), j) for j, r in belt_ends
                    if abs(q["z"] - r["z"]) < 50 and abs(q["x"] - r["x"]) < 450 and abs(q["y"] - r["y"]) < 450]
            if near:
                union(i, min(near)[1])
        bgrid = _BoxGrid([((cat, name, bid), box) for cat, name, bid, box in buildings])
        for i, q, _ in ends:
            for tag in bgrid.hits(q):
                touch.setdefault(find(i), set()).add(tag)
    # per-network summary
    nets = {}
    for i, s in enumerate(segs):
        r = find(i)
        n = nets.setdefault(r, {"id": f"{kind[0]}{r}", "kind": kind, "segs": 0, "lifts": 0, "len": 0.0, "tiers": {}, "open": 0,
                                "x0": 1e12, "y0": 1e12, "x1": -1e12, "y1": -1e12})
        t = _tier(s.get("Name"))
        if _is_lift(s):
            n["lifts"] += 1
        else:
            n["segs"] += 1
        n["len"] += (s.get("Length") or 0) / 100   # metres
        n["tiers"][t] = n["tiers"].get(t, 0) + 1
        n["open"] += (not s.get("Connected0")) + (not s.get("Connected1"))
        for q in (s["location0"], s["location1"]):
            n["x0"], n["y0"] = min(n["x0"], q["x"]), min(n["y0"], q["y"])
            n["x1"], n["y1"] = max(n["x1"], q["x"]), max(n["y1"], q["y"])
    out_nets = []
    for r, n in nets.items():
        t = touch.get(r, set())
        names = {}
        for cat, name, bid in t:
            names[name] = names.get(name, 0) + 1
        slowest = min(n["tiers"])
        n.update({"p": any(c == "p" for c, _, _ in t), "w": any(c == "w" for c, _, _ in t), "len": round(n["len"]),
                  "touches": dict(sorted(names.items(), key=lambda kv: -kv[1])),
                  "st": sorted(bid for _, _, bid in t if bid in storage),
                  "cap": (BELT_IPM.get(slowest) if kind == "belt" else PIPE_FLOW.get(slowest)),
                  "box": [round(n.pop("x0")), round(n.pop("y0")), round(n.pop("x1")), round(n.pop("y1"))]})
        out_nets.append(n)
    out, lifts = [], []
    for i, s in enumerate(segs):
        n = nets[find(i)]
        if _is_lift(s):   # drawn as a marker on the map, not a line
            at = s.get("location") or s["location0"]
            lifts.append({"id": s.get("ID"), "t": _tier(s.get("Name")), "x": round(at["x"]), "y": round(at["y"]),
                          "h": round(abs(s["location1"]["z"] - s["location0"]["z"]) / 100, 1),
                          "up": s["location1"]["z"] > s["location0"]["z"],   # items go from end 0 to end 1
                          "p": n["p"], "w": n["w"], "n": n["id"]})
            continue
        pts = s.get("SplineData") or [s["location0"], s["location1"]]
        out.append({"t": _tier(s.get("Name")), "pts": [[round(q["x"]), round(q["y"])] for q in pts],
                    "p": n["p"], "w": n["w"], "n": n["id"]})
    return out, lifts, out_nets


def _is_lift(s):
    return "Lift" in (s.get("ClassName") or s.get("Name") or "")


BELT_IPM = {1: 60, 2: 120, 3: 270, 4: 480, 5: 780, 6: 1200}   # items/min per belt tier (wiki)


def logistics_worker():
    while True:
        _logi_wake.wait(LOGI_EVERY_S)
        _logi_wake.clear()
        if not logistics_due():
            continue
        LOGI["tried"] = time.monotonic()
        try:
            fac, ext, gens = frm_json("getFactory", 30), frm_json("getExtractor", 30), frm_json("getGenerators", 30)
            seen = {m["ID"] for m in fac + ext + gens}
            # other buildings a network can reach (storage, stations, sinks…), not the belt/pipe parts themselves
            parts = ("Pipeline", "Pipe", "Junction", "Pump", "Valve", "Conveyor", "Splitter", "Merger", "Lift")
            try:
                buffers = frm_json("getFluidBuffer", 30)   # needs a newer FRM build
            except (OSError, ValueError):
                buffers = []
            store = frm_json("getStorageInv", 30) + buffers
            storage = frozenset(b["ID"] for b in store if b.get("ID"))
            other = [b for b in frm_json("getPowerUsage", 30) + store
                     if b.get("ID") not in seen and not any(w in (b.get("Name") or "") for w in parts)]
            buildings = ([("p", m["Name"], m["ID"], _box(m, 80)) for m in fac + ext] +
                         [("w", g["Name"], g["ID"], _box(g, 80)) for g in gens] +
                         [("o", b["Name"], b["ID"], _box(b, 80)) for b in other if b.get("location") and b.get("Name")])
            belts, lifts, bnets = networks("belt", frm_json("getBelts", 30) + frm_json("getLifts", 30), frm_json("getSplitterMerger", 30), buildings, storage)
            pump_like = [x for x in frm_json("getPump", 30)]
            pipes, _, pnets = networks("pipe", frm_json("getPipes", 30), frm_json("getPipeJunctions", 30) + pump_like, buildings, storage)
            counts = {"splitters": sum("Splitter" in (x.get("Name") or "") for x in frm_json("getSplitterMerger", 30)),
                      "mergers": sum("Merger" in (x.get("Name") or "") for x in frm_json("getSplitterMerger", 30)),
                      "junctions": len(frm_json("getPipeJunctions", 30)),
                      "pumps": sum("Pump" in (x.get("Name") or "") for x in pump_like),
                      "valves": sum("Valve" in (x.get("Name") or "") for x in pump_like)}
            LOGI["json"] = json.dumps({"belts": belts, "lifts": lifts, "pipes": pipes, "networks": bnets + pnets, "counts": counts},
                                      separators=(",", ":")).encode()
            LOGI["t"] = time.monotonic()
        except Exception:
            pass   # FRM down or loading: keep the last result


# ---- AWESOME Sinks: what feeds each one --------------------------------------------------------
# Newer FRM says what each belt end is plugged into, so from each sink the belts are followed back (through
# splitters, mergers, lifts and floor holes) to the machines, storage and stations they start at. Belts don't report
# their flow, so a machine's output is what it could send: anything split off on the way goes elsewhere too.
SINKS = {"json": None, "t": -1e9}
_sinks_lock = threading.Lock()
SINK_EVERY_S = 60
PASS_THROUGH = ("Splitter", "Merger", "Passthrough", "Hole")


def sink_feeds():
    sinks = frm_json("getResourceSinkBuilding", 30)
    belts = frm_json("getBelts", 30) + frm_json("getLifts", 30)
    base = lambda s: {"id": s["ID"], "x": round(s["location"]["x"]), "y": round(s["location"]["y"]),
                      "on": bool((s.get("PowerInfo") or {}).get("PowerConsumed"))}
    if belts and "ConnectedTo0" not in belts[0]:   # older FRM: no way to tell what a belt is plugged into
        return {"sinks": [{**base(s), "inputs": 0, "feeds": [], "other": [], "loose": 0} for s in sinks], "traced": False}
    fac = {m["ID"]: m for m in frm_json("getFactory", 30) + frm_json("getExtractor", 30)}
    points = {i["ClassName"]: i["Points"] for i in frm_json("getSinkList", 300)}
    named = {}   # storage / stations a belt can start at: name and what's in them
    for ep in ("getStorageInv", "getTruckStation", "getTrainStation"):
        try:
            for b in frm_json(ep, 30):
                inv = b.get("Inventory") or [i for p in b.get("CargoInventory") or [] for i in p.get("Inventory") or []]
                named[b.get("ID")] = (b.get("Name"), inv)
        except (OSError, ValueError):
            pass
    by_id = {b["ID"]: b for b in belts}
    into = {}   # building -> belts whose output end is plugged into it
    for b in belts:
        if b.get("ConnectedTo1"):
            into.setdefault(b["ConnectedTo1"], []).append(b["ID"])
    out = []
    for s in sinks:
        seen, sources, loose = set(), {}, 0
        stack = [(i, False) for i in into.get(s["ID"], [])]
        while stack:
            bid, via = stack.pop()
            if bid in seen:
                continue
            seen.add(bid)
            if bid in by_id:
                up = by_id[bid].get("ConnectedTo0")
                if up:
                    stack.append((up, via))
                else:
                    loose += 1
            elif any(w in bid for w in PASS_THROUGH):   # via = some of it is split off to somewhere else on the way
                stack += [(i, via or "Splitter" in bid) for i in into.get(bid, [])]
            else:
                sources[bid] = sources.get(bid, False) or via
        feeds, other = [], []
        for src, via in sources.items():
            m = fac.get(src)
            if m:
                for p in m.get("production") or []:
                    if ITEMS.get(p["Name"], {}).get("kind") == "fluid":   # a refinery's fluid output goes down a pipe, not this belt
                        continue
                    feeds.append({"src": src, "building": m.get("Name"), "recipe": m.get("Recipe"), "item": p["Name"],
                                  "rate": round(p.get("CurrentProd") or 0, 3), "max": round(p.get("MaxProd") or 0, 3),
                                  "pts": points.get(p.get("ClassName"), 0), "split": via,
                                  "x": round(m["location"]["x"]), "y": round(m["location"]["y"])})
            else:
                name, inv = named.get(src, (re.sub(r"^Build_|_C_\d+$", "", src).replace("_", " "), []))
                top = sorted((i for i in inv if i.get("Amount")), key=lambda i: -i["Amount"])[:3]
                other.append({"src": src, "name": name,
                              "holds": [{"item": i["Name"], "n": i["Amount"], "pts": points.get(i.get("ClassName"), 0)} for i in top]})
        out.append({**base(s), "inputs": len(into.get(s["ID"], [])), "feeds": feeds, "other": other, "loose": loose})
    return {"sinks": out, "traced": True}


def sinks_json():
    with _sinks_lock:
        if not SINKS["json"] or time.monotonic() - SINKS["t"] >= SINK_EVERY_S:
            SINKS["json"] = json.dumps(sink_feeds(), separators=(",", ":")).encode()
            SINKS["t"] = time.monotonic()
        return SINKS["json"]


# ---- hypertubes: networks, entrances, launch points --------------------------------------------
# FRM lists tubes (curve + both ends), entrances (with power) and junctions, but not what connects to what, so
# networks come from geometry like the belts: tube ends that meet, ends at the same entrance or junction, and ends
# a few metres apart with nothing else near (a wall / floor hole between them). A tube end touching nothing is where
# a ride shoots you out - the muzzle of a hypertube cannon - so those are listed with the angle they point at.
HYPER = {"json": None, "t": -1e9}
_hyper_lock = threading.Lock()
HYPER_EVERY_S = 30


def _d3(a, b):
    return math.sqrt((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2 + (a["z"] - b["z"]) ** 2)


def hyper_build():
    tubes = frm_json("getHypertube", 30)
    ents = frm_json("getHyperEntrance", 30)
    try:
        juncs = frm_json("getHyperJunctions", 30)
    except (OSError, ValueError):
        juncs = []
    T, E = len(tubes), len(ents)
    parent = list(range(T + E + len(juncs)))   # tubes, then entrances, then junctions

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        parent[find(a)] = find(b)
    ends = [(i, k, t[k]) for i, t in enumerate(tubes) for k in ("location0", "location1")]
    grid = {}
    for n, (i, k, q) in enumerate(ends):
        grid.setdefault((int(q["x"] // 500), int(q["y"] // 500)), []).append(n)

    def near(q, r):   # end indexes within r cm of q (r <= 500)
        gx, gy = int(q["x"] // 500), int(q["y"] // 500)
        return [n for dx in (-1, 0, 1) for dy in (-1, 0, 1) for n in grid.get((gx + dx, gy + dy), ()) if _d3(ends[n][2], q) <= r]
    used = [False] * len(ends)
    for n, (i, k, q) in enumerate(ends):   # ends that meet
        for m in near(q, 60):
            if m != n:
                union(i, ends[m][0]); used[n] = used[m] = True
    for e, x in enumerate(ents):   # the tube plugged into an entrance
        for m in near(x["location"], 300):
            union(T + e, ends[m][0]); used[m] = True
    for j, x in enumerate(juncs):
        spots = [x["location"]] + [x[k] for k in ("location0", "location1") if x.get(k)]
        for m in {m for s in spots for m in near(s, 200)}:
            union(T + E + j, ends[m][0]); used[m] = True
    # two loose ends a few metres apart: a floor or wall hole between them
    for n, (i, k, q) in enumerate(ends):
        if used[n]:
            continue
        cand = [(_d3(ends[m][2], q), m) for m in near(q, 500) if m != n and not used[m] and ends[m][0] != i]
        if cand:
            m = min(cand)[1]
            union(i, ends[m][0]); used[n] = used[m] = True
    nets, out_tubes = {}, []
    for i, t in enumerate(tubes):
        pts = list(t.get("SplineData") or [t["location0"], t["location1"]])
        # FRM samples the curve every 75 cm and can stop short of the far end: put both ends on
        a, b = (t["location0"], t["location1"]) if _d3(pts[0], t["location0"]) <= _d3(pts[0], t["location1"]) else (t["location1"], t["location0"])
        if _d3(pts[0], a) > 5:
            pts.insert(0, a)
        if _d3(pts[-1], b) > 5:
            pts.append(b)
        tubes[i]["SplineData"] = pts   # the open-end direction below uses the same points
        length = sum(_d3(pts[j - 1], pts[j]) for j in range(1, len(pts))) / 100
        r = find(i)
        n = nets.setdefault(r, {"id": f"h{r}", "tubes": 0, "len": 0.0, "ents": [], "juncs": 0, "exits": [],
                                "z0": 1e12, "z1": -1e12, "box": [1e12, 1e12, -1e12, -1e12]})
        n["tubes"] += 1
        n["len"] += length
        for q in pts:
            n["z0"], n["z1"] = min(n["z0"], q["z"]), max(n["z1"], q["z"])
            b = n["box"]
            b[0], b[1], b[2], b[3] = min(b[0], q["x"]), min(b[1], q["y"]), max(b[2], q["x"]), max(b[3], q["y"])
        out_tubes.append({"n": n["id"], "len": round(length, 1), "pts": [[round(q["x"]), round(q["y"]), round(q["z"])] for q in pts]})
    for n, (i, k, q) in enumerate(ends):   # open ends: which way a ride leaves (outwards along the tube's last bit)
        if used[n]:
            continue
        pts = tubes[i].get("SplineData") or [tubes[i]["location0"], tubes[i]["location1"]]
        if len(pts) < 2:
            continue
        a, b = (pts[1], pts[0]) if _d3(pts[0], q) <= _d3(pts[-1], q) else (pts[-2], pts[-1])
        dx, dy, dz = b["x"] - a["x"], b["y"] - a["y"], b["z"] - a["z"]
        nets[find(i)]["exits"].append({"x": round(q["x"]), "y": round(q["y"]), "z": round(q["z"]),
                                       "pitch": round(math.degrees(math.atan2(dz, math.hypot(dx, dy) or 1e-9)), 1),
                                       "heading": round((math.degrees(math.atan2(dy, dx)) + 90) % 360)})   # compass, like FRM
    out_ents = []
    for e, x in enumerate(ents):
        r = find(T + e)
        p = x.get("PowerInfo") or {}
        l = x["location"]
        out_ents.append({"id": x["ID"], "x": round(l["x"]), "y": round(l["y"]), "z": round(l["z"]),
                         "n": nets[r]["id"] if r in nets else None, "mw": p.get("PowerConsumed") or 0,
                         "max": p.get("MaxPowerConsumed") or 0, "fuse": bool(p.get("FuseTriggered")), "circuit": p.get("CircuitID")})
        if r in nets:
            nets[r]["ents"].append(x["ID"])
    for j in range(len(juncs)):
        r = find(T + E + j)
        if r in nets:
            nets[r]["juncs"] += 1
    for n in nets.values():
        n.update({"len": round(n["len"]), "z0": round(n["z0"] / 100, 1), "z1": round(n["z1"] / 100, 1), "box": [round(v) for v in n["box"]]})
    return {"tubes": out_tubes, "entrances": out_ents, "networks": list(nets.values()), "junctions": len(juncs)}


def hyper_data():
    with _hyper_lock:
        if not HYPER["json"] or time.monotonic() - HYPER["t"] >= HYPER_EVERY_S:
            HYPER["json"] = json.dumps(hyper_build(), separators=(",", ":")).encode()
            HYPER["t"] = time.monotonic()
        return HYPER["json"]


def recorder():
    last_prod = last_save = 0
    while True:
        t0 = time.monotonic()
        try:
            if "getSessionInfo" not in BLOCKED:
                HIST.check_session(frm_json("getSessionInfo", 30).get("SessionName"))
            HIST.add_power(frm_json("getPower"))
            if t0 - last_prod >= PROD_EVERY_S:
                last_prod = t0
                fac, ext, gens = frm_json("getFactory"), frm_json("getExtractor"), frm_json("getGenerators")
                gen = {}
                for g in gens:
                    gen[g["Name"]] = gen.get(g["Name"], 0) + (g.get("RegulatedDemandProd") or 0)
                HIST.add_prod(production_totals(fac, ext, gens), gen)
                try:
                    dna = frm_json("getExplorationSink")[0].get("TotalPoints", 0)
                except (OSError, ValueError, IndexError):
                    dna = 0
                HIST.add_sink(frm_json("getResourceSink")[0]["TotalPoints"], dna)
        except Exception:   # FRM down, a session loading, a cut-off or odd reply: just a gap in the chart
            pass
        if t0 - last_save >= SAVE_EVERY_S:
            last_save = t0
            try:
                HIST.save()
            except OSError:
                pass
        time.sleep(max(0.5, POWER_EVERY_S - (time.monotonic() - t0)))


# ---- HTTP ------------------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path.startswith("/api/"):
            return self.proxy(path[5:], query)
        if path == "/logistics":
            LOGI["bg" if "bg=1" in query else "fg"] = time.monotonic()
            if logistics_due():
                _logi_wake.set()
            if not LOGI["json"]:
                return self.send_body(503, b'{"error":"belts and pipes not ready yet"}')
            return self.send_body(200, LOGI["json"], {"X-Age": str(int(time.monotonic() - LOGI["t"]))})
        if path == "/sinks":
            try:
                return self.send_body(200, sinks_json())
            except Exception as e:   # FRM down or loading
                return self.send_body(502, json.dumps({"error": str(e)}).encode())
        if path == "/hypertubes":
            try:
                return self.send_body(200, hyper_data())
            except Exception as e:   # FRM down or loading
                return self.send_body(502, json.dumps({"error": str(e)}).encode())
        if path in ("/hist/power", "/hist/production", "/hist/sink"):
            try:
                mins = max(1, min(KEEP_S // 60, int(urllib.parse.parse_qs(query).get("mins", ["60"])[0])))
            except ValueError:
                mins = 60
            data = (HIST.power_json(mins) if path == "/hist/power" else HIST.prod_json(mins) if path == "/hist/production"
                    else HIST.sink_json(mins))
            return self.send_body(200, json.dumps(data, separators=(",", ":")).encode())
        if (path in ("/", "/index.html", "/items.json", "/map.avif") or re.fullmatch(r"/js/[a-z0-9-]+\.js", path)
                or re.fullmatch(r"/img/(icons/)?[a-z0-9-]+\.png", path)):
            return super().do_GET()
        self.send_error(404)

    def proxy(self, endpoint, query=""):
        if endpoint not in ALLOWED:
            return self.send_error(404)
        try:   # ?max_age=N: an older copy is fine (e.g. the Overview reusing what the history recorder fetched)
            max_age = min(60.0, float(urllib.parse.parse_qs(query)["max_age"][0]))
        except (KeyError, ValueError):
            max_age = None
        self.send_body(*frm(endpoint, max_age))

    def send_body(self, status, body, headers=None):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def end_headers(self):
        if getattr(self, "_status", 200) >= 400:   # never let the browser cache an error (e.g. an icon fetched later)
            self.send_header("Cache-Control", "no-store")
        elif self.path.startswith(("/map.avif", "/img/")):
            self.send_header("Cache-Control", "max-age=86400")
        elif not self.path.startswith(("/api/", "/hist/")):   # page, scripts, items.json: always revalidate so edits show up
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/api/", "/hist/", "/sinks", "/hypertubes")):  # polling would flood the console
            super().log_message(fmt, *args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--host", default="127.0.0.1", help="interface to listen on (0.0.0.0 = all, for LAN access)")
    ap.add_argument("--frm", help="FRM base URL (default: $FRM_URL or http://localhost:8080)")
    ap.add_argument("--no-history", action="store_true", help="don't record power/production history")
    args = ap.parse_args()
    if args.frm:
        FRM = args.frm.rstrip("/")
    if not (ROOT / "map.avif").exists():
        print("note: map.avif missing - run `python tools/fetch_assets.py --game-dir <Satisfactory install>` for the map background")
    if not args.no_history:
        HIST.load()
        threading.Thread(target=recorder, daemon=True).start()
    threading.Thread(target=logistics_worker, daemon=True).start()
    print(f"FICSIT monitor on http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}  (FRM: {FRM})")
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
