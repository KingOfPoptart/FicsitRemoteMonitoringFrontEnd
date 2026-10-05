"""Vehicle tracker - serves the page and proxies Ficsit Remote Monitoring (FRM) so the browser has no CORS issues.

  python server.py [--port 8090] [--host 127.0.0.1] [--frm http://localhost:8080]

/api/<endpoint>  ->  <FRM URL>/<endpoint>

By default it only listens on this machine (127.0.0.1). Use --host 0.0.0.0 to reach it from other
devices on your network. The FRM URL can also be set with the FRM_URL environment variable.
Run tools/fetch_assets.py once first to get the map image and vehicle pictures.
"""
import argparse
import http.server
import os
import pathlib
import re
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).parent
ALLOWED = {"getFactoryCart", "getVehicles", "getTruckStation", "getVehiclePaths", "getTrains", "getTrainStation",
           "getTrainRails", "getDrone", "getDroneStation"}
FRM = os.environ.get("FRM_URL", "http://localhost:8080").rstrip("/")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.proxy(self.path[5:].split("?")[0])
        path = self.path.split("?")[0]
        if path in ("/", "/index.html", "/items.json", "/map.avif") or re.fullmatch(r"/img/[a-z0-9-]+\.png", path):
            return super().do_GET()
        self.send_error(404)

    def proxy(self, endpoint):
        if endpoint not in ALLOWED:
            return self.send_error(404)
        try:
            with urllib.request.urlopen(f"{FRM}/{endpoint}", timeout=10) as r:
                body, status = r.read(), 200
        except (urllib.error.URLError, OSError) as e:
            body, status = (b'{"error":"FRM not reachable - is the game/server up and its web server started (/frm http start)?","detail":"'
                            + str(e).replace('"', "'").encode() + b'"}'), 502
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if self.path.startswith(("/map.avif", "/img/")):
            self.send_header("Cache-Control", "max-age=86400")
        elif not self.path.startswith("/api/"):   # page + items.json: always revalidate so edits show up on refresh
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):  # polling would flood the console
            super().log_message(fmt, *args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--host", default="127.0.0.1", help="interface to listen on (0.0.0.0 = all, for LAN access)")
    ap.add_argument("--frm", help="FRM base URL (default: $FRM_URL or http://localhost:8080)")
    args = ap.parse_args()
    if args.frm:
        FRM = args.frm.rstrip("/")
    if not (ROOT / "map.avif").exists():
        print("note: map.avif missing - run `python tools/fetch_assets.py --game-dir <Satisfactory install>` for the map background")
    print(f"Vehicle tracker on http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}  (FRM: {FRM})")
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
