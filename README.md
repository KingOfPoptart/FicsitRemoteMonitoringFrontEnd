# Ficsit Remote Monitoring – Vehicle Tracker

A live web dashboard for every vehicle in a Satisfactory world: factory carts, tractors, trucks, fluid trucks, explorers, Cyber Wagons, trains and drones. It reads data from the [Ficsit Remote Monitoring](https://github.com/porisius/FicsitRemoteMonitoring) (FRM) mod's web API.

![Vehicle tracker](https://i.imgur.com/Gj9MMO4.png)

## Features
- **Table of all vehicles**: type, status (moving, docking, stopped, driven, error), speed, next stop, route, cargo, fill level, nearest station, autopilot and driver.
  - Sortable, resizable columns.
  - A filter under every column. Station and cargo filters are searchable multi-selects.
- **Live map** with smoothly moving vehicle markers.
  - Toggleable layers for vehicle paths, factory cart paths, train tracks, drone routes and stations.
  - Hover a vehicle to highlight its stops. Hover a station to see what's in it.
  - Click a row to follow a vehicle.
- **Desktop layout** puts the map beside the table. On phones it goes below.

## Requirements
- Satisfactory 1.2 with the **Ficsit Remote Monitoring** mod, with its web server started (`/frm http start` in game chat, or its autostart setting turned on).
- Python 3.9+ (standard library only; [Pillow](https://pypi.org/project/pillow/) is optional, for resizing pictures).
- For route, next-stop, live-position and speed data, FRM needs the vehicle fixes from [porisius/FicsitRemoteMonitoring#310](https://github.com/porisius/FicsitRemoteMonitoring/pull/310). With an FRM build that lacks them, the tracker still runs, but vehicles show no routes and stay frozen whenever no player is nearby.

## Setup
```sh
# one time: map image (from your FRM install) and vehicle pictures (from the Satisfactory wiki)
python tools/fetch_assets.py --game-dir "<path to Satisfactory or SatisfactoryDedicatedServer>"

# run it
python server.py
```
Then open http://localhost:8090.

Options:
- `--frm http://<host>:8080`, or set `FRM_URL`, if FRM runs on another machine.
- `--host 0.0.0.0` to open the tracker from other devices on your network.
- `--port` to use a port other than 8090.

`items.json` (every item in the game, used by the cargo filter) is included. To regenerate it after a game update, run `python tools/generate_items.py --game-dir "<Satisfactory install>"`.

## Notes
- The map image and vehicle pictures aren't included because they're Coffee Stain's game art. `fetch_assets.py` gets them on your own machine.
- `server.py` serves the page and passes API calls through to FRM, so the browser never has to deal with cross-origin (CORS) restrictions.
