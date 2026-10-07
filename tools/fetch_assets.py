"""Fetch the assets the tracker needs but that aren't checked in (game art isn't ours to redistribute):

  - map.avif   the in-game map image, copied from your FRM install (FRM ships it in www/map/)
  - img/*.png  vehicle pictures, downloaded from the Satisfactory wiki (satisfactory.wiki.gg)
  - img/icons/<name>.png  item and building icons for the Production and Power tabs (also from the wiki)

  python tools/fetch_assets.py --game-dir "<Satisfactory or SatisfactoryDedicatedServer install folder>"

Pillow (pip install pillow) is optional; with it the pictures are shrunk (vehicles 96 px, icons 64 px).
"""
import argparse
import io
import json
import pathlib
import re
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

# buildings shown with an icon on the Production and Power tabs (every item in items.json gets one too)
ICON_BUILDINGS = [
    "Smelter", "Foundry", "Constructor", "Assembler", "Manufacturer", "Refinery", "Packager", "Blender",
    "Particle Accelerator", "Converter", "Quantum Encoder", "Miner Mk.1", "Miner Mk.2", "Miner Mk.3", "Water Extractor",
    "Oil Extractor", "Resource Well Pressurizer", "Resource Well Extractor", "Biomass Burner", "Coal-Powered Generator",
    "Fuel-Powered Generator", "Geothermal Generator", "Nuclear Power Plant", "Alien Power Augmenter", "Power Storage",
    "AWESOME Sink", "AWESOME Shop", "Storage Container", "Industrial Storage Container", "Personal Storage Box",
    "Pipeline Pump Mk.1", "Pipeline Pump Mk.2", "Valve", "Pipeline Junction", "Pipeline T-Junction", "Fluid Buffer",
    "Industrial Fluid Buffer", "Truck Station", "Train Station", "Freight Platform", "Fluid Freight Platform",
    "Empty Platform", "Drone Port", "Dimensional Depot Uploader", "Space Elevator", "The HUB", "Radar Tower",
    "Hypertube Entrance", "Craft Bench", "Equipment Workshop", "Lookout Tower", "Blueprint Designer",
    "Power Switch", "Priority Power Switch",
    "Medical Storage Box", "Hazard Storage Box",
    "Geyser",   # resource node type (geothermal), listed with the ores on the Progression tab
]
icon_slug = lambda name: re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")   # same rule as the page's iconSlug()


def copy_map(game_dir):
    candidates = list(pathlib.Path(game_dir).glob("FactoryGame/Mods/**/FicsitRemoteMonitoring/www/map/map.avif"))
    if not candidates:
        print(f"map.avif: not found under {game_dir} (is FicsitRemoteMonitoring installed there?)")
        return
    shutil.copy2(candidates[0], ROOT / "map.avif")
    print(f"map.avif: copied from {candidates[0]}")


def wiki_urls(files):
    """wiki file name -> download URL (50 titles per API call)"""
    urls = {}
    for k in range(0, len(files), 50):
        titles = "|".join("File:" + f for f in files[k:k + 50])
        q = urllib.parse.urlencode({"action": "query", "titles": titles, "prop": "imageinfo", "iiprop": "url", "format": "json"})
        pages = json.load(urllib.request.urlopen(urllib.request.Request(f"{WIKI_API}?{q}", headers=UA), timeout=30))["query"]["pages"]
        urls.update({p["title"].removeprefix("File:"): p["imageinfo"][0]["url"] for p in pages.values() if p.get("imageinfo")})
    return urls


def download(wanted, size, label):
    """wanted: {output path: wiki file name}"""
    urls = wiki_urls(sorted(set(wanted.values())))
    try:
        from PIL import Image
    except ImportError:
        Image = None
    got, missing = 0, []
    for out, wiki_file in wanted.items():
        url = urls.get(wiki_file)
        if not url:
            missing.append(wiki_file)
            continue
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
        out.parent.mkdir(parents=True, exist_ok=True)
        if Image:
            im = Image.open(io.BytesIO(data)).convert("RGBA")
            im.thumbnail((size, size), Image.LANCZOS)
            im.save(out, optimize=True)
        else:
            out.write_bytes(data)
        got += 1
    print(f"{label}: {got} downloaded" + (f", not on the wiki: {', '.join(missing)}" if missing else ""))


def fetch_images():
    download({ROOT / "img" / f"{name}.png": f for name, f in VEHICLE_IMAGES.items()}, 96, "vehicle pictures")


def fetch_icons():
    items = [i["name"] for i in json.loads((ROOT / "items.json").read_text(encoding="utf-8"))]
    download({ROOT / "img" / "icons" / f"{icon_slug(n)}.png": f"{n}.png" for n in items + ICON_BUILDINGS}, 64, "item/building icons")


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
        fetch_icons()
    sys.exit(0)
