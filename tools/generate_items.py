"""Regenerate items.json (every item in the game, solid or fluid) from the game's own data file.

  python tools/generate_items.py --game-dir "<Satisfactory install folder>"

Reads <game>/CommunityResources/Docs/en-US.json, which ships with the game.
"""
import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ITEM_CLASSES = ("FGItemDescriptor", "FGResourceDescriptor", "FGItemDescriptorBiomass", "FGItemDescriptorNuclearFuel",
                "FGEquipmentDescriptor", "FGConsumableDescriptor", "FGPowerShardDescriptor", "FGItemDescriptorPowerBoosterFuel")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", required=True, help="Satisfactory install folder (contains CommunityResources)")
    args = ap.parse_args()
    raw = (pathlib.Path(args.game_dir) / "CommunityResources" / "Docs" / "en-US.json").read_bytes()
    docs = json.loads(raw.decode("utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"))
    items = {}
    for group in docs:
        native = group.get("NativeClass", "").split(".")[-1].rstrip("'")
        if native not in ITEM_CLASSES and not native.startswith(("FGAmmoType", "FGEquipment")):
            continue
        for c in group.get("Classes", []):
            name, form = (c.get("mDisplayName") or "").strip(), c.get("mForm", "")
            if name and form != "RF_INVALID":
                items.setdefault(name, {"name": name, "kind": "fluid" if form in ("RF_LIQUID", "RF_GAS") else "solid",
                                        "class": c["ClassName"]})
    out = sorted(items.values(), key=lambda i: i["name"].lower())
    (ROOT / "items.json").write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"items.json: {len(out)} items ({sum(i['kind'] == 'fluid' for i in out)} fluids)")
