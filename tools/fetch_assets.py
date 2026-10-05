"""Fetch the assets the tracker needs but that aren't checked in (game art isn't ours to redistribute):

  - map.avif   the in-game map image, copied from your FRM install (FRM ships it in www/map/)
  - img/*.png  vehicle pictures, downloaded from the Satisfactory wiki (satisfactory.wiki.gg)

  python tools/fetch_assets.py --game-dir "<Satisfactory or SatisfactoryDedicatedServer install folder>"

Pillow (pip install pillow) is optional; with it the pictures are shrunk to 96 px.
"""
import argparse
import io
import json
import pathlib
import shutil
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "FicsitRemoteMonitoringFrontEnd/1.0 (asset fetch)"}
WIKI_API = "https://satisfactory.wiki.gg/api.php"
# tracker image name -> wiki file name
VEHICLE_IMAGES = {
    "factory-cart": "Factory Cart.png", "golden-factory-cart": "Golden Factory Cart.png", "tractor": "Tractor.png",
    "truck": "Truck.png", "fluid-truck": "Fluid Truck.png", "explorer": "Explorer.png",
    "cyber-wagon": "Cyber Wagon.png", "train": "Electric Locomotive.png", "drone": "Drone.png",
}


def copy_map(game_dir):
    candidates = list(pathlib.Path(game_dir).glob("FactoryGame/Mods/**/FicsitRemoteMonitoring/www/map/map.avif"))
    if not candidates:
        print(f"map.avif: not found under {game_dir} (is FicsitRemoteMonitoring installed there?)")
        return
    shutil.copy2(candidates[0], ROOT / "map.avif")
    print(f"map.avif: copied from {candidates[0]}")


def fetch_images():
    (ROOT / "img").mkdir(exist_ok=True)
    titles = "|".join("File:" + f for f in VEHICLE_IMAGES.values())
    q = urllib.parse.urlencode({"action": "query", "titles": titles, "prop": "imageinfo", "iiprop": "url", "format": "json"})
    pages = json.load(urllib.request.urlopen(urllib.request.Request(f"{WIKI_API}?{q}", headers=UA), timeout=30))["query"]["pages"]
    urls = {p["title"].removeprefix("File:"): p["imageinfo"][0]["url"] for p in pages.values() if p.get("imageinfo")}
    try:
        from PIL import Image
    except ImportError:
        Image = None
    for name, wiki_file in VEHICLE_IMAGES.items():
        url = urls.get(wiki_file)
        if not url:
            print(f"img/{name}.png: not found on the wiki ({wiki_file})")
            continue
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
        out = ROOT / "img" / f"{name}.png"
        if Image:
            im = Image.open(io.BytesIO(data)).convert("RGBA")
            im.thumbnail((96, 96), Image.LANCZOS)
            im.save(out, optimize=True)
        else:
            out.write_bytes(data)
        print(f"img/{name}.png: downloaded")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Fetch the tracker's map image and vehicle pictures")
    ap.add_argument("--game-dir", help="Satisfactory (or dedicated server) install folder with FRM installed")
    ap.add_argument("--skip-images", action="store_true")
    args = ap.parse_args()
    if args.game_dir:
        copy_map(args.game_dir)
    else:
        print("map.avif: skipped (pass --game-dir to copy it from your FRM install)")
    if not args.skip_images:
        fetch_images()
    sys.exit(0)
