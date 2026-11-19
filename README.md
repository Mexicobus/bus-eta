# Bus ETA (prototype)
Static web app, no build step. Open `index.html` through any web server (needs http/https for GPS + Wake Lock).
Local test:  `cd bus-eta && python3 -m http.server 8765`  then http://localhost:8765/
- Setup screen: Add a stop box, today's trip (edit, stop time, reorder, remove, reverse, clear), Trips box (save/load/back up/restore), Preview and Start. (Old "regular stops" data is left in the browser but no longer used; saved trips replace it.)
- Drive screen: map + ordered stops with ETA. Demo mode (no key) uses Leaflet/OSM + a simulated bus.
- Live mode: Settings -> paste Google Maps API key (Maps JavaScript API + Routes API enabled; routing uses the Routes library, Route.computeRoutes). Stored only in this browser's localStorage.
Tests (Playwright, python): `tests/test_shots.py` (demo + screenshots), `tests/test_live_stub.py` (live path against a fake google.maps).
