# Bus ETA (prototype)
Static web app, no build step. Open `index.html` through any web server (needs http/https for GPS + Wake Lock).
Local test:  `cd bus-eta && python3 -m http.server 8765`  then http://localhost:8765/
- Setup screen: Add a stop box, today's trip (edit, stop time, reorder, remove, reverse, clear), Trips box (save/load/back up/restore), Preview and Start. (Old "regular stops" data is left in the browser but no longer used; saved trips replace it.)
- Drive screen: map + ordered stops with ETA. Demo mode (no key) uses Leaflet/OSM + a simulated bus.
- Live mode: Settings -> paste Google Maps API key (Maps JavaScript API + Routes API enabled; routing uses the Routes library, Route.computeRoutes). Stored only in this browser's localStorage.
Tests (Playwright, python): `tests/test_shots.py` (demo + screenshots), `tests/test_live_stub.py` (live path against a fake google.maps).

## Bus screen, next-stop banner, auto drop-off
- **📺 Bus screen** (driving screen): hides all controls and shows the map plus a big stop list for the bus TV. Leave it with the faint ✕ in the top-right corner, by pressing and holding anywhere for a second, or Esc.
- **Next-stop banner**: when the next stop is about 10 minutes away (from the ETA already counting down, no extra Google request) a banner shows once per stop for ~2 minutes. No sound.
- **Auto drop-off**: bus within ~0.25 mile of the next stop and not moving for 3 minutes (Settings: on/off, minutes) marks it dropped off, with an Undo button for 25 seconds.
