# Ficsit Remote Monitoring – FICSIT Monitor

A live web dashboard for a Satisfactory world: how the factory is doing at a glance, every vehicle, every production machine, the power grid and your progression. It reads data from the [Ficsit Remote Monitoring](https://github.com/porisius/FicsitRemoteMonitoring) (FRM) mod's web API.

![Overview](docs/screenshots/overview.png)

## Tabs

### Overview (home)
- **Needs attention**: an overloaded grid or tripped fuse, max consumption over capacity, generators out of fuel or water, starved machines, items used faster than they're made, stuck vehicles (derailed, station unreachable, …), milestones ready to unlock, coupons to spend. Each links to the tab that explains it.
- **Summary cards** for power (with a chart), production (status mix, top products, shortfalls), vehicles (per type, stuck ones by name) and progression (Space Elevator and HUB parts).
- **World map** of machines, generators, vehicles, players, the HUB and Space Elevator, roads, rail, drone routes and stations.

### Vehicles
![Vehicles](docs/screenshots/vehicles.png)
- **Table of every vehicle**: factory carts, tractors, trucks, fluid trucks, explorers, Cyber Wagons, trains and drones, with status (moving, docking, stopped, driven, error), speed, next stop, route, cargo, fill level, nearest station, autopilot and driver. A filter under every column; station and cargo filters are searchable multi-selects.
- **Live map** with smoothly moving markers. Hover a vehicle to highlight its stops; hover a station to see what's in it; click a row to follow a vehicle.

### Production
![Production](docs/screenshots/production.png)
- **Items**: producing, consuming and net per minute for every item (generators' fuel and water included), capacity and how much of it is in use. Click an item to see its history and highlight the machines that make (blue) and use (orange) it, in the table and on the map.
- **Machines**: status (running, partial, starved, output full, paused, no power), productivity, input and output, clock speed, power shards, Somersloops and power draw. Filter by status and building type; click a row to find the machine on the map.
- The summary tiles are shortcuts: click "5 starved" to see those five.

### Power
![Power](docs/screenshots/power.png)
- Per grid, the in-game power graph's numbers (capacity, production, consumption, max consumption) plus headroom, batteries and fuse state, with history charts.
- Generation by generator type, consumption by building type, and every generator with its fuel, water and status, beside a map.

### Progression
![Progression](docs/screenshots/progression.png)
- Space Elevator phase with each part's delivered amount, how many are in storage, how fast the factory makes them and time to finish; the HUB's active milestone; milestones per tier; MAM research; alternate recipes, AWESOME Shop and coupons.
- Collectibles found (Somersloops, Mercer Spheres, power slugs) and resource nodes tapped. Click one to find the ones still out there on the map.

### Everywhere
- Every map has a **Layers** dropdown, X/Y coordinates under the cursor, and shows players (online and offline).
- Every panel has a **full-screen** button (Esc to close). Table columns can be resized (double-click an edge to fit) and sorted.
- On a desktop browser each tab fits one screen; on phones the panels stack.
- `server.py` records power and production history (every 5 s / 15 s, 24 hours kept, saved to `history.json`), so charts have data from before the page was opened.

## Requirements
- Satisfactory 1.2 with the **Ficsit Remote Monitoring** mod, with its web server started (`/frm http start` in game chat, or its autostart setting turned on).
- Python 3.9+ (standard library only; [Pillow](https://pypi.org/project/pillow/) is optional, for resizing pictures).
- For route, next-stop, live-position and speed data, FRM needs the vehicle fixes from [porisius/FicsitRemoteMonitoring#310](https://github.com/porisius/FicsitRemoteMonitoring/pull/310). With an FRM build that lacks them, the dashboard still runs, but vehicles show no routes and stay frozen whenever no player is nearby.

## Setup
```sh
# one time: map image (from your FRM install), vehicle pictures and item/building icons (from the Satisfactory wiki)
python tools/fetch_assets.py --game-dir "<path to Satisfactory or SatisfactoryDedicatedServer>"

# run it
python server.py
```
Then open http://localhost:8090.

Options:
- `--frm http://<host>:8080`, or set `FRM_URL`, if FRM runs on another machine.
- `--host 0.0.0.0` to open the dashboard from other devices on your network.
- `--port` to use a port other than 8090.
- `--no-history` to not record power/production history.

`items.json` (every item in the game, with fuel energy values) is included. To regenerate it after a game update, run `python tools/generate_items.py --game-dir "<Satisfactory install>"`.

## Notes
- The map image, vehicle pictures and icons aren't included because they're Coffee Stain's game art. `fetch_assets.py` gets them on your own machine.
- `server.py` serves the page and passes API calls through to FRM (with a short cache, so several open pages don't multiply the load on the game), so the browser never has to deal with cross-origin (CORS) restrictions.
- Code: `index.html` (page, Vehicles tab), `js/charts.js` (charts, tables, dropdowns), `js/map.js` (the shared map), and one file per other tab.
