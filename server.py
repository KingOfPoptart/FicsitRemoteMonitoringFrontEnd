"""FICSIT monitor - serves the page, proxies Ficsit Remote Monitoring (FRM) so the browser has no CORS issues,
and records power/production history so the charts have data from before the page was opened.

  python server.py [--port 8090] [--host 127.0.0.1] [--frm http://localhost:8080] [--no-history]

/api/<endpoint>  ->  <FRM URL>/<endpoint>   (responses cached ~1 s, so several open pages don't multiply FRM load)
/hist/power?mins=60       power history per grid (sampled every 5 s, kept 24 h)
/hist/production?mins=60  produced/consumed per item and generation per generator type (sampled every 15 s, kept 24 h)

By default it only listens on this machine (127.0.0.1). Use --host 0.0.0.0 to reach it from other
devices on your network. The FRM URL can also be set with the FRM_URL environment variable.
History is saved to history.json next to this file, so it survives a restart.
Run tools/fetch_assets.py once first to get the map image, vehicle pictures and icons.
"""
import argparse
import http.server
import json
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
           "getProdStats", "getSpaceElevator", "getHUBTerminal", "getTradingPost", "getSchematics", "getResearchTrees",
           "getResourceSink", "getPlayer", "getWorldInv", "getCloudInv", "getArtifacts", "getPowerSlug", "getResourceNode"}
FRM = os.environ.get("FRM_URL", "http://localhost:8080").rstrip("/")
CACHE_S = 1.0
HISTORY_FILE = ROOT / "history.json"
KEEP_S = 24 * 3600
POWER_EVERY_S, PROD_EVERY_S, SAVE_EVERY_S = 5, 15, 60


# ---- FRM access with a short cache ------------------------------------------------------------
_cache, _cache_lock = {}, threading.Lock()
_ep_locks = {ep: threading.Lock() for ep in ALLOWED}


def frm(endpoint, max_age=CACHE_S):
    """(status, body bytes) for an FRM endpoint; concurrent callers share one request."""
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


def frm_json(endpoint, max_age=CACHE_S):
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
        self.power = []   # [t, {groupId: [prod, cons, cap, maxCons, batteryPct, battIn, battOut, fuse]}]
        self.prod = []    # [t, {item: [p, c]}, {genType: MW}]

    def load(self):
        try:
            d = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            self.session, self.power, self.prod = d.get("session"), d.get("power", []), d.get("prod", [])
            self.trim()
        except (OSError, ValueError):
            pass

    def save(self):
        with self.lock:
            data = json.dumps({"session": self.session, "power": self.power, "prod": self.prod}, separators=(",", ":"))
        tmp = HISTORY_FILE.with_suffix(".tmp")
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, HISTORY_FILE)

    def trim(self):
        cut = time.time() - KEEP_S
        self.power = [s for s in self.power if s[0] >= cut]
        self.prod = [s for s in self.prod if s[0] >= cut]

    def check_session(self, name):
        """A different save was loaded: its history doesn't belong on the same chart."""
        with self.lock:
            if name and name != self.session:
                self.session, self.power, self.prod = name, [], []

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
                                          r(g["BatteryOutput"]), 1 if g.get("FuseTriggered") else 0] for g in groups}
        with self.lock:
            self.power.append([round(time.time()), row])
            self.trim()

    def add_prod(self, totals, gen):
        with self.lock:
            self.prod.append([round(time.time()), {k: [round(p, 3), round(c, 3)] for k, (p, c) in totals.items()},
                              {k: round(v, 2) for k, v in gen.items()}])

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
                    row[k] = [round(sum(v[i] for v in vals) / len(vals), 2) for i in range(7)] + [max(v[7] for v in vals)]
                merged.append([b[-1][0], row])
            rows = merged
        groups = {}
        for i, (t, row) in enumerate(rows):
            for k, v in row.items():
                g = groups.setdefault(k, {f: [None] * len(rows) for f in
                                          ("prod", "cons", "cap", "max", "batt", "battIn", "battOut", "fuse")})
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


def recorder():
    last_prod = last_save = 0
    while True:
        t0 = time.monotonic()
        try:
            HIST.check_session(frm_json("getSessionInfo", 30).get("SessionName"))
            HIST.add_power(frm_json("getPower"))
            if t0 - last_prod >= PROD_EVERY_S:
                last_prod = t0
                fac, ext, gens = frm_json("getFactory", 3), frm_json("getExtractor", 3), frm_json("getGenerators", 3)
                gen = {}
                for g in gens:
                    gen[g["Name"]] = gen.get(g["Name"], 0) + (g.get("RegulatedDemandProd") or 0)
                HIST.add_prod(production_totals(fac, ext, gens), gen)
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
            return self.proxy(path[5:])
        if path in ("/hist/power", "/hist/production"):
            try:
                mins = max(1, min(KEEP_S // 60, int(urllib.parse.parse_qs(query).get("mins", ["60"])[0])))
            except ValueError:
                mins = 60
            data = HIST.power_json(mins) if path == "/hist/power" else HIST.prod_json(mins)
            return self.send_body(200, json.dumps(data, separators=(",", ":")).encode())
        if (path in ("/", "/index.html", "/items.json", "/map.avif") or re.fullmatch(r"/js/[a-z0-9-]+\.js", path)
                or re.fullmatch(r"/img/(icons/)?[a-z0-9-]+\.png", path)):
            return super().do_GET()
        self.send_error(404)

    def proxy(self, endpoint):
        if endpoint not in ALLOWED:
            return self.send_error(404)
        self.send_body(*frm(endpoint))

    def send_body(self, status, body):
        self.send_response(status)
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
        if not self.path.startswith(("/api/", "/hist/")):  # polling would flood the console
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
    print(f"FICSIT monitor on http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}  (FRM: {FRM})")
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
