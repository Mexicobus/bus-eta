'use strict';
/* Bus ETA — single-page, no build step.
   Screens: setup (pick stops) and drive (map + ETAs).
   Live mode = Google Maps JS API + Directions service. Demo mode = Leaflet/OSM + simulated bus. */

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode / full */ } }
};
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const M_PER_MI = 1609.344;
const MAX_STOP_MIN = 480;

/* Per-stop time: a stop may carry its own `dwellMin`; without one it follows the Settings standard. */
function hasOwnDwell(s) { return s && s.dwellMin != null && s.dwellMin !== '' && isFinite(+s.dwellMin); }
function stopDwellMin(s, standard) { return hasOwnDwell(s) ? Math.max(0, +s.dwellMin) : Math.max(0, +standard || 0); }
function fmtMin(m) { return Math.round(m) + ' min'; }
/* ETAs for the remaining stops from Google leg data: each stop's own dwell is added to every stop AFTER it.
   legT = driving seconds per leg (already scaled), legD = meters per leg. */
function buildLiveEtas(rem, legT, legD, now, standard) {
  const etas = {}; let cumT = 0, cumD = 0, waited = 0;
  rem.forEach((s, i) => {
    if (legT[i] == null) return;
    cumT += legT[i]; cumD += legD[i];
    etas[s.id] = { eta: now + (cumT + waited) * 1000, dur: cumT + waited, dist: cumD };
    waited += stopDwellMin(s, standard) * 60;   // this stop's wait delays the NEXT stops only
  });
  return etas;
}

function haversineMi(a, b) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function fmtClock(ts, refNow) {
  const d = new Date(ts), n = new Date(refNow);
  let t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() !== n.toDateString()) t = d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
  return t;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return '< 1 min';
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), mm = m % 60;
  if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  return h + 'h ' + String(mm).padStart(2, '0') + 'm';
}
function fmtMi(meters) {
  const mi = meters / M_PER_MI;
  return (mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()) + ' mi';
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + ' sec ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
}

/* ------------------------------------------------------------------ state */
const SAMPLE_STOPS = [
  { name: 'Phoenix, AZ', lat: 33.4484, lng: -112.0740 },
  { name: 'Albuquerque, NM', lat: 35.0844, lng: -106.6504 },
  { name: 'Oklahoma City, OK', lat: 35.4676, lng: -97.5164 },
  { name: 'St. Louis, MO', lat: 38.6270, lng: -90.1994 },
  { name: 'Columbus, OH', lat: 39.9612, lng: -82.9988 },
  { name: 'Ephrata, PA', lat: 40.1798, lng: -76.1783 }
];
const state = {
  settings: Object.assign({ apiKey: '', dwellMin: 10, speedPct: 100, forceDemo: false, demoSpeed: 300 }, LS.get('busEta.settings', {})),
  regular: LS.get('busEta.regular', null),
  trip: LS.get('busEta.trip', { stops: [], started: false, results: null }),
  manage: false,
  sessionDemo: false   // set if Google rejects the key during this session
};
if (!state.regular) {
  state.regular = SAMPLE_STOPS.map(s => ({ id: uid(), name: s.name, query: s.name, lat: s.lat, lng: s.lng }));
  LS.set('busEta.regular', state.regular);
}
const saveSettings = () => LS.set('busEta.settings', state.settings);
const saveRegular = () => LS.set('busEta.regular', state.regular);
const saveTrip = () => LS.set('busEta.trip', state.trip);
const isDemo = () => !state.settings.apiKey || state.settings.forceDemo || state.sessionDemo;
const remainingStops = () => state.trip.stops.filter(s => !s.dropped);

/* ------------------------------------------------------------------ screens */
function show(name) {
  $('#setup').classList.toggle('hidden', name !== 'setup');
  $('#drive').classList.toggle('hidden', name !== 'drive');
}

/* ================================================================== SETUP */
function renderSetup() {
  const chip = $('#setupMode');
  chip.textContent = isDemo() ? 'DEMO MODE (no Google key)' : 'LIVE — Google key set';
  chip.className = 'chip ' + (isDemo() ? 'demo' : 'live');
  $('#btnDemoTrip').classList.toggle('hidden', !isDemo());

  const stops = state.trip.stops;
  const active = stops.filter(s => !s.dropped).length;
  $('#tripCount').textContent = stops.length ? `(${stops.length})` : '';
  $('#tripList').innerHTML = stops.length ? stops.map((s, i) => `
    <li data-id="${s.id}" class="${s.dropped ? 'dropped' : ''}">
      <span class="num">${i + 1}</span>
      <span class="nm">${esc(s.name)}${s.dropped ? '<small>already dropped off</small>' : `<button class="dwellchip ${hasOwnDwell(s) ? 'custom' : ''}" data-act="dwell" aria-label="Change stop time for ${esc(s.name)}">⏱ Stop time: ${fmtMin(stopDwellMin(s, state.settings.dwellMin))}${hasOwnDwell(s) ? '' : ' <small>(standard)</small>'}</button>`}</span>
      <button class="btn" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn" data-act="down" aria-label="Move down" ${i === stops.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="btn danger" data-act="rm" aria-label="Remove">✕</button>
    </li>`).join('') : '<li class="empty" style="display:block">No stops yet.<br>Tap a regular stop or type a new one.</li>';

  const inTrip = new Set(stops.map(s => s.name.toLowerCase()));
  $('#regList').innerHTML = state.regular.length ? state.regular.map(r => {
    const inT = inTrip.has(r.name.toLowerCase());
    return `<div class="reg-wrap" data-id="${r.id}">
      <button class="btn reg ${inT ? 'in' : ''}" data-act="addreg">${inT ? '✓ ' : '＋ '}${esc(r.name)}</button>
      ${state.manage ? '<button class="btn reg-del danger" data-act="delreg" aria-label="Delete">✕</button>' : ''}
    </div>`;
  }).join('') : '<div class="empty" style="width:100%">No saved stops yet.</div>';
  $('#btnManage').textContent = state.manage ? 'Done' : 'Edit list';

  const b = $('#btnStart');
  b.disabled = active === 0;
  b.textContent = active ? `▶ START DRIVING  (${active} stop${active > 1 ? 's' : ''})` : '▶ ADD STOPS TO START';
}
function setMsg(text, kind) { const m = $('#addMsg'); m.textContent = text || ''; m.className = 'msg ' + (kind || ''); }

function addToTrip(stop) {
  state.trip.stops.push({ id: uid(), name: stop.name, query: stop.query || stop.name, lat: stop.lat ?? null, lng: stop.lng ?? null, dropped: false });
  state.trip.results = null;
  saveTrip(); renderSetup();
}
async function geocodeDemo(q) {   // demo mode only: OSM Nominatim, light use
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('lookup failed');
  const j = await r.json();
  if (!j.length) return null;
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
}
async function onAddSubmit(e) {
  e.preventDefault();
  const q = $('#newStop').value.trim();
  if (!q) { setMsg('Type a city or address first.', 'err'); return; }
  const save = $('#saveReg').checked;
  const entry = { name: q, query: q, lat: null, lng: null };
  if (isDemo()) {
    setMsg('Looking up place…');
    try {
      const g = await geocodeDemo(q);
      if (!g) { setMsg("Couldn't find that place. Try “City, ST”.", 'err'); return; }
      entry.lat = g.lat; entry.lng = g.lng;
    } catch (err) { setMsg("Demo mode needs internet to look up new places.", 'err'); return; }
  }
  addToTrip(entry);
  if (save && !state.regular.some(r => r.name.toLowerCase() === q.toLowerCase())) {
    state.regular.push({ id: uid(), ...entry }); saveRegular(); renderSetup();
  }
  $('#newStop').value = ''; $('#saveReg').checked = false;
  setMsg(`Added “${q}”${save ? ' and saved as regular' : ''}.`, 'ok');
}
function bindSetup() {
  $('#addForm').addEventListener('submit', onAddSubmit);
  $('#tripList').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('li').dataset.id, st = state.trip.stops, i = st.findIndex(s => s.id === id);
    if (b.dataset.act === 'dwell') { openDwell(id); return; }
    if (b.dataset.act === 'rm') st.splice(i, 1);
    if (b.dataset.act === 'up' && i > 0) [st[i - 1], st[i]] = [st[i], st[i - 1]];
    if (b.dataset.act === 'down' && i < st.length - 1) [st[i + 1], st[i]] = [st[i], st[i + 1]];
    state.trip.results = null; saveTrip(); renderSetup();
  });
  $('#regList').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const r = state.regular.find(x => x.id === b.closest('.reg-wrap').dataset.id); if (!r) return;
    if (b.dataset.act === 'addreg') { addToTrip(r); setMsg(`Added “${r.name}”.`, 'ok'); }
    if (b.dataset.act === 'delreg') { state.regular = state.regular.filter(x => x !== r); saveRegular(); renderSetup(); }
  });
  $('#btnManage').addEventListener('click', () => { state.manage = !state.manage; renderSetup(); });
  $('#btnClearTrip').addEventListener('click', () => { state.trip = { stops: [], started: false, results: null }; saveTrip(); renderSetup(); });
  $('#btnDemoTrip').addEventListener('click', () => {
    state.trip = { stops: SAMPLE_STOPS.map(s => ({ id: uid(), name: s.name, query: s.name, lat: s.lat, lng: s.lng, dropped: false })), started: false, results: null };
    saveTrip(); renderSetup();
  });
  $('#btnStart').addEventListener('click', startDrive);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnSetCancel').addEventListener('click', () => $('#settings').classList.add('hidden'));
  $('#btnSetSave').addEventListener('click', saveSettingsForm);
  $('#btnSetClearKey').addEventListener('click', () => { $('#setKey').value = ''; });
  $('#setShowKey').addEventListener('change', e => { $('#setKey').type = e.target.checked ? 'text' : 'password'; });
}
function openSettings() {
  const s = state.settings;
  $('#setKey').value = s.apiKey; $('#setDwell').value = s.dwellMin; $('#setPct').value = s.speedPct;
  $('#setForceDemo').checked = s.forceDemo;
  $('#settings').classList.remove('hidden');
}
function saveSettingsForm() {
  const s = state.settings, oldKey = s.apiKey;
  s.apiKey = $('#setKey').value.trim();
  s.dwellMin = Math.max(0, Math.min(120, parseInt($('#setDwell').value, 10) || 0));
  s.speedPct = Math.max(50, Math.min(200, parseInt($('#setPct').value, 10) || 100));
  s.forceDemo = $('#setForceDemo').checked;
  if (s.apiKey !== oldKey) state.sessionDemo = false;
  saveSettings();
  $('#settings').classList.add('hidden');
  renderSetup();
  if (!$('#drive').classList.contains('hidden')) startDrive();   // re-init drive with the new mode
}

/* ---------------- per-stop time editor (used on both screens) ---------------- */
let dwellEditId = null;
function openDwell(id) {
  const s = state.trip.stops.find(x => x.id === id); if (!s) return;
  dwellEditId = id;
  $('#dwellTitle').textContent = 'Stop time at ' + s.name.split(',')[0];
  $('#dwellInput').value = stopDwellMin(s, state.settings.dwellMin);
  $('#dwellStd').textContent = 'Use standard (' + fmtMin(state.settings.dwellMin) + ')';
  $('#dwellStd').disabled = !hasOwnDwell(s);
  $('#dwellEdit').classList.remove('hidden');
}
function closeDwell() { dwellEditId = null; $('#dwellEdit').classList.add('hidden'); }
function applyDwellChange() {
  state.trip.results = D.mode === 'live' ? D.results : null;
  saveTrip();
  renderSetup();
  if (!$('#drive').classList.contains('hidden')) {
    D.sig = null;
    if (D.demo) demoTick();
    else {
      const b = D.liveBase, rem = remainingStops();
      if (b && b.ids.join() === rem.map(s => s.id).join() && D.results) {   // re-add waits to the last Google answer right away
        D.results.etas = buildLiveEtas(rem, b.legT, b.legD, b.now, state.settings.dwellMin);
        state.trip.results = D.results; saveTrip();
      }
      renderList(true);
    }
  }
}
function setStopDwell(id, minutes) {   // minutes = null -> back to standard
  const s = state.trip.stops.find(x => x.id === id); if (!s) return;
  if (minutes == null) delete s.dwellMin;
  else s.dwellMin = Math.max(0, Math.min(MAX_STOP_MIN, Math.round(minutes)));
  applyDwellChange();
}
function bindDwell() {
  $('#dwellEdit').addEventListener('click', e => {
    if (e.target === $('#dwellEdit')) { closeDwell(); return; }
    const q = e.target.closest('[data-min]');
    if (q) $('#dwellInput').value = q.dataset.min;
  });
  $('#dwellSave').addEventListener('click', () => {
    const v = parseInt($('#dwellInput').value, 10);
    if (isNaN(v)) { $('#dwellInput').focus(); return; }
    const id = dwellEditId; closeDwell(); setStopDwell(id, v);
  });
  $('#dwellStd').addEventListener('click', () => { const id = dwellEditId; closeDwell(); setStopDwell(id, null); });
  $('#dwellCancel').addEventListener('click', closeDwell);
}

/* ================================================================== MAP ADAPTERS */
class LeafletMap {
  constructor(el) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true, zoomSnap: 0.25 }).setView([36.5, -105], 5);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(this.map);
    this.markers = []; this.line = null; this.bus = null;
  }
  setRoute(path) {
    if (this.line) this.line.setLatLngs(path);
    else this.line = L.polyline(path, { color: '#4aa3ff', weight: 6, opacity: 0.95 }).addTo(this.map);
  }
  setStops(stops, nextId) {
    this.markers.forEach(m => m.remove()); this.markers = [];
    stops.forEach((s, i) => {
      if (s.lat == null) return;
      const cls = s.dropped ? 'done' : (s.id === nextId ? 'next' : '');
      const sz = s.id === nextId ? 42 : 34;
      this.markers.push(L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: `<div class="pin ${cls}">${i + 1}</div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] }),
        zIndexOffset: s.id === nextId ? 1000 : 0, keyboard: false
      }).addTo(this.map));
    });
  }
  setBus(p) {
    if (!p) return;
    if (!this.bus) this.bus = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="busdot"></div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 2000, keyboard: false }).addTo(this.map);
    else this.bus.setLatLng([p.lat, p.lng]);
  }
  fit(points) {
    const pts = points.filter(Boolean).map(p => [p.lat, p.lng]);
    if (!pts.length) return;
    if (pts.length === 1) { this.map.setView(pts[0], 9); return; }
    this.map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 11, animate: false });
  }
  resize() { this.map.invalidateSize(); }
  destroy() { this.map.remove(); }
}

const GOOGLE_DARK = [
  { elementType: 'geometry', stylers: [{ color: '#1d2733' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#b8c4d2' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0b0f14' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#33414f' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4b5d70' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b141d' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] }
];
class GoogleMap {
  constructor(el) {
    this.map = new google.maps.Map(el, { center: { lat: 38, lng: -98 }, zoom: 5, styles: GOOGLE_DARK, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false });
    this.markers = []; this.line = null; this.bus = null;
  }
  setRoute(path) {
    const p = path.map(a => ({ lat: a[0], lng: a[1] }));
    if (this.line) this.line.setPath(p);
    else this.line = new google.maps.Polyline({ map: this.map, path: p, strokeColor: '#4aa3ff', strokeWeight: 6, strokeOpacity: 0.95 });
  }
  setStops(stops, nextId) {
    this.markers.forEach(m => m.setMap(null)); this.markers = [];
    stops.forEach((s, i) => {
      if (s.lat == null) return;
      const next = s.id === nextId;
      this.markers.push(new google.maps.Marker({
        map: this.map, position: { lat: s.lat, lng: s.lng }, zIndex: next ? 100 : 10,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: next ? 20 : 16, fillColor: s.dropped ? '#566' : (next ? '#ffd400' : '#e8eef5'), fillOpacity: 1, strokeColor: '#06101a', strokeWeight: 3 },
        label: { text: String(i + 1), color: '#06101a', fontWeight: '800', fontSize: next ? '20px' : '16px' }
      }));
    });
  }
  setBus(p) {
    if (!p) return;
    const pos = { lat: p.lat, lng: p.lng };
    if (!this.bus) this.bus = new google.maps.Marker({ map: this.map, position: pos, zIndex: 999, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 11, fillColor: '#4aa3ff', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 4 } });
    else this.bus.setPosition(pos);
  }
  fit(points) {
    const pts = points.filter(Boolean);
    if (!pts.length) return;
    const b = new google.maps.LatLngBounds();
    pts.forEach(p => b.extend({ lat: p.lat, lng: p.lng }));
    this.map.fitBounds(b, 60);
    google.maps.event.addListenerOnce(this.map, 'idle', () => { if (this.map.getZoom() > 11) this.map.setZoom(11); });
  }
  resize() { google.maps.event.trigger(this.map, 'resize'); }
  destroy() { this.markers.forEach(m => m.setMap(null)); $('#map').innerHTML = ''; }
}

let googlePromise = null, googleKeyLoaded = null;
function loadGoogle(key) {
  if (googlePromise && googleKeyLoaded === key) return googlePromise;
  googleKeyLoaded = key;
  googlePromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) return resolve();
    const t = setTimeout(() => { reject(new Error('timeout')); }, 20000);
    window.__gmReady = () => { clearTimeout(t); resolve(); };
    window.gm_authFailure = () => { state.sessionDemo = true; D.authFailed = true; onGoogleAuthFailure(); };
    const sc = document.createElement('script');
    sc.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly&callback=__gmReady';
    sc.async = true;
    sc.onerror = () => { clearTimeout(t); reject(new Error('load')); };
    document.head.appendChild(sc);
  });
  googlePromise.catch(() => { googlePromise = null; });
  return googlePromise;
}

/* ================================================================== DRIVE */
const D = {
  mode: null, map: null, timers: [], watchId: null, pos: null, posAt: 0,
  svc: null, inflight: false, lastCompute: 0, lastComputePos: null,
  results: null,      // { updatedAt, source, etas:{id:{eta,dur,dist,arrived}}, path:[[lat,lng]] }
  err: null, fitMode: 'next', sig: '', wake: null, demo: null, authFailed: false, retryAt: 0, token: 0
};
const nowMs = () => (D.mode === 'demo' && D.demo) ? D.demo.simNow : Date.now();

async function startDrive() {
  stopDrive();
  const mySession = ++D.token;
  state.trip.started = true; saveTrip();
  show('drive');
  D.mode = isDemo() ? 'demo' : 'live';
  D.err = null; D.authFailed = false; D.sig = ''; D.pos = null; D.results = null;
  $('#demoStrip').classList.toggle('hidden', D.mode !== 'demo');
  $('#demoMark').classList.toggle('hidden', D.mode !== 'demo');
  $('#errBanner').classList.add('hidden');
  $('#mapMsg').classList.add('hidden');
  const mc = $('#modeChip');
  mc.textContent = D.mode === 'demo' ? 'DEMO DATA' : '● LIVE'; mc.className = 'chip ' + (D.mode === 'demo' ? 'demo' : 'live');

  acquireWake();
  D.timers.push(setInterval(uiTick, 1000));

  if (D.mode === 'demo') {
    D.map = new LeafletMap($('#map'));
    initDemo();
    D.timers.push(setInterval(demoTick, 1000));
    demoTick();
  } else {
    // restore last saved live results so the list isn't empty if we start offline
    const r = state.trip.results;
    if (r && r.source === 'live') { D.results = r; }
    renderList(true);
    await initLive(mySession);
  }
  setTimeout(() => D.map && D.map.resize(), 100);
  uiTick();
}
function stopDrive() {
  D.timers.forEach(clearInterval); D.timers = [];
  if (D.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(D.watchId);
  D.watchId = null; D.inflight = false;
  if (D.map) { try { D.map.destroy(); } catch (e) { } D.map = null; }
  D.svc = null; D.demo = null; D.token++;
}
function showMapMsg(t) { const m = $('#mapMsg'); if (!t) { m.classList.add('hidden'); return; } m.textContent = t; m.classList.remove('hidden'); }
function showErr(t) { D.err = t; const b = $('#errBanner'); b.textContent = t || ''; b.classList.toggle('hidden', !t); }

/* ---------------- live mode ---------------- */
async function initLive(session) {
  showMapMsg('Loading Google Maps…');
  try {
    await loadGoogle(state.settings.apiKey);
  } catch (e) {
    if (session !== D.token) return;
    if (D.authFailed) return;
    showMapMsg('Can\'t load Google Maps (no signal?). Showing last saved ETAs. Retrying…');
    showErr('No connection to Google Maps — retrying');
    D.timers.push(setTimeout(() => { if (session === D.token && D.mode === 'live') initLive(session); }, 15000));
    return;
  }
  if (session !== D.token || D.mode !== 'live') return;
  showMapMsg(null); showErr(null);
  D.map = new GoogleMap($('#map'));
  D.svc = new google.maps.DirectionsService();
  if (D.results && D.results.path) D.map.setRoute(D.results.path);
  refreshMap(true);
  startGps();
  D.timers.push(setInterval(() => maybeRefresh(false), 5000));
}
function onGoogleAuthFailure() {
  showErr('Google rejected the API key — switched to DEMO data. Check the key in ⚙ Settings (setup screen).');
  if (state.trip.started && !$('#drive').classList.contains('hidden')) startDrive();
  setTimeout(() => showErr('Google rejected the API key — showing DEMO data. Check the key in Settings.'), 300);
}
function startGps() {
  if (!navigator.geolocation) { showErr('This device has no location (GPS) access.'); return; }
  D.watchId = navigator.geolocation.watchPosition(p => {
    D.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    D.posAt = Date.now();
    if (D.err && D.err.startsWith('Location')) showErr(null);
    D.map && D.map.setBus(D.pos);
    if (!D.lastComputePos) maybeRefresh(true);
    else if (haversineMi(D.pos, D.lastComputePos) * M_PER_MI > 1500) maybeRefresh(false, true);
    refreshMap(false);
  }, err => {
    showErr('Location problem: ' + (err.code === 1 ? 'permission denied — allow Location for this site in Safari settings.' : err.message));
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function maybeRefresh(force, moved) {
  if (D.mode !== 'live' || !D.svc || D.inflight) return;
  const since = Date.now() - D.lastCompute;
  if (force || since >= 60000 || (moved && since >= 20000)) computeLive();
}
function computeLive() {
  const rem = remainingStops();
  if (!rem.length || !D.pos) return;
  if (!navigator.onLine) { return; }
  D.inflight = true; D.lastCompute = Date.now(); D.lastComputePos = { ...D.pos };
  const loc = s => s.lat != null ? new google.maps.LatLng(s.lat, s.lng) : (s.query || s.name);
  const req = {
    origin: new google.maps.LatLng(D.pos.lat, D.pos.lng),
    destination: loc(rem[rem.length - 1]),
    waypoints: rem.slice(0, -1).map(s => ({ location: loc(s), stopover: true })),
    optimizeWaypoints: false,
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
    unitSystem: google.maps.UnitSystem.IMPERIAL
  };
  const session = D.token;
  new Promise((res, rej) => D.svc.route(req, (r, st) => st === 'OK' ? res(r) : rej(st)))
    .then(res => {
      if (session !== D.token) return;
      const legs = res.routes[0].legs, now = Date.now();
      const f = state.settings.speedPct / 100;
      const legT = legs.map(l => ((l.duration_in_traffic || l.duration).value) * f), legD = legs.map(l => l.distance.value);
      D.liveBase = { ids: rem.map(s => s.id), legT, legD, now };
      const etas = buildLiveEtas(rem, legT, legD, now, state.settings.dwellMin);
      legs.forEach((leg, i) => {
        const s = rem[i]; if (!s) return;
        s.lat = leg.end_location.lat(); s.lng = leg.end_location.lng();
        const rg = state.regular.find(r => r.name.toLowerCase() === s.name.toLowerCase());
        if (rg && rg.lat == null) { rg.lat = s.lat; rg.lng = s.lng; }
      });
      const path = res.routes[0].overview_path.map(p => [p.lat(), p.lng()]);
      D.results = { updatedAt: now, source: 'live', etas, path };
      state.trip.results = D.results; saveTrip(); saveRegular();
      showErr(null);
      D.map && D.map.setRoute(path);
      refreshMap(D.fitMode === 'all' || !D.fitted); D.fitted = true;
      renderList(false);
    })
    .catch(st => {
      if (session !== D.token) return;
      const msgs = {
        REQUEST_DENIED: 'Google denied the request — enable the Directions API for this key.',
        OVER_QUERY_LIMIT: 'Google usage limit hit — will retry.',
        ZERO_RESULTS: 'Google found no driving route to one of the stops.',
        NOT_FOUND: 'Google could not find one of the stop addresses.',
        MAX_WAYPOINTS_EXCEEDED: 'Too many stops for one route.',
        UNKNOWN_ERROR: 'Google had a temporary error — will retry.'
      };
      showErr((msgs[st] || 'Route update failed (' + st + ')') + ' Showing last ETAs.');
    })
    .finally(() => { D.inflight = false; });
}

/* ---------------- demo mode ---------------- */
// Rough highway corridor SD -> Ephrata (I-8, I-10, I-40, I-44, I-70, I-76)
const CORRIDOR = [
  [32.7157, -117.1611], [32.7353, -116.0], [32.6927, -114.6277], [32.9, -113.5], [33.4484, -112.0740],
  [34.4, -112.0], [35.1983, -111.6513], [35.2, -110.5], [35.5280, -108.7426], [35.0844, -106.6504],
  [34.9378, -104.6847], [35.2220, -101.8313], [35.4676, -97.5164], [36.1540, -95.9928], [37.0842, -94.5133],
  [37.2090, -93.2923], [37.9485, -91.7715], [38.6270, -90.1994], [39.0, -88.0], [39.7684, -86.1581],
  [39.9612, -82.9988], [40.0640, -80.7209], [40.0, -78.2400], [40.2737, -76.8844], [40.1798, -76.1783]
];
const DEMO_ORIGIN = { lat: 32.7157, lng: -117.1611, name: 'San Diego, CA' };
function nearestCorridor(p) {
  let bi = 0, bd = 1e9;
  CORRIDOR.forEach((c, i) => { const d = haversineMi(p, { lat: c[0], lng: c[1] }); if (d < bd) { bd = d; bi = i; } });
  return { i: bi, d: bd };
}
function buildDemoPath(origin, stops) {
  const path = [[origin.lat, origin.lng]], stopIdx = [];
  let prev = origin;
  stops.forEach(s => {
    const a = nearestCorridor(prev), b = nearestCorridor(s);
    if (a.d < 80 && b.d < 80 && a.i !== b.i) {
      if (a.i < b.i) for (let k = a.i; k <= b.i; k++) path.push(CORRIDOR[k]);
      else for (let k = a.i; k >= b.i; k--) path.push(CORRIDOR[k]);
    }
    path.push([s.lat, s.lng]); stopIdx.push(path.length - 1); prev = s;
  });
  const cum = [0];
  for (let k = 1; k < path.length; k++)
    cum.push(cum[k - 1] + 1.1 * haversineMi({ lat: path[k - 1][0], lng: path[k - 1][1] }, { lat: path[k][0], lng: path[k][1] }));
  return { path, cum, stopS: stopIdx.map(i => cum[i]), total: cum[cum.length - 1] };
}
function posAtMiles(dm, d) {
  const { path, cum } = dm;
  d = Math.max(0, Math.min(d, dm.total));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo], t = seg > 0 ? (d - cum[lo]) / seg : 0;
  return { lat: path[lo][0] + (path[hi][0] - path[lo][0]) * t, lng: path[lo][1] + (path[hi][1] - path[lo][1]) * t };
}
function initDemo() {
  const stops = state.trip.stops.filter(s => s.lat != null);
  const built = buildDemoPath(DEMO_ORIGIN, stops);
  const stopS = {}; stops.forEach((s, i) => stopS[s.id] = built.stopS[i]);
  D.demo = Object.assign(built, {
    stops, stopSById: stopS, d: 0, simNow: Date.now(), lastReal: Date.now(), dwellLeft: 0, dwellId: null,
    visited: new Set(), speed: state.settings.demoSpeed || 300
  });
  // stops dropped before this session count as visited
  stops.forEach(s => { if (s.dropped) D.demo.visited.add(s.id); });
  // start the bus past any already-dropped stops so resumed trips make sense
  let startD = 0; stops.forEach(s => { if (s.dropped) startD = Math.max(startD, stopS[s.id]); });
  D.demo.d = startD;
  D.map.setRoute(built.path);
  $$('#demoStrip [data-speed]').forEach(b => b.classList.toggle('sel', +b.dataset.speed === D.demo.speed));
  D.fitted = false;
}
function demoAdvance(simDt) {
  const dm = D.demo, mph = 62;
  let guard = 0;
  while (simDt > 0 && guard++ < 60) {
    if (dm.dwellLeft > 0) { const u = Math.min(dm.dwellLeft, simDt); dm.dwellLeft -= u; simDt -= u; if (dm.dwellLeft <= 0) dm.dwellId = null; continue; }
    const nextStop = dm.stops.find(s => !dm.visited.has(s.id));
    const target = nextStop ? dm.stopSById[nextStop.id] : dm.total;
    const need = (target - dm.d) / mph * 3600;
    if (need > simDt) { dm.d += mph * simDt / 3600; simDt = 0; }
    else {
      dm.d = target; simDt -= Math.max(need, 0);
      if (!nextStop) break;
      dm.visited.add(nextStop.id);
      const live = state.trip.stops.find(s => s.id === nextStop.id);
      const dw = live ? stopDwellMin(live, state.settings.dwellMin) * 60 : 0;
      if (live && !live.dropped && dw > 0) { dm.dwellLeft = dw; dm.dwellId = nextStop.id; }
    }
  }
}
function demoTick() {
  const dm = D.demo; if (!dm) return;
  const real = Date.now(), dt = Math.min(5, (real - dm.lastReal) / 1000); dm.lastReal = real;
  const simDt = dt * dm.speed;
  dm.simNow += simDt * 1000;
  demoAdvance(simDt);
  D.pos = posAtMiles(dm, dm.d); D.posAt = real;
  D.map.setBus(D.pos);
  // ETAs
  const etas = {}, f = state.settings.speedPct / 100;
  let j = 0, waited = 0;   // waited = own dwell of earlier stops still ahead of the bus
  state.trip.stops.forEach(s => {
    if (s.dropped || s.lat == null) return;
    if (dm.visited.has(s.id)) { etas[s.id] = { eta: dm.simNow, dur: 0, dist: 0, arrived: true }; return; }
    const miles = Math.max(0, dm.stopSById[s.id] - dm.d);
    const tf = 1.03 + 0.07 * Math.sin(dm.simNow / 3.6e6 / 2.3 + j);
    const dur = (miles / 62 * 3600 * tf + dm.dwellLeft + waited) * f;
    etas[s.id] = { eta: dm.simNow + dur * 1000, dur, dist: miles * M_PER_MI };
    waited += stopDwellMin(s, state.settings.dwellMin) * 60;
    j++;
  });
  D.results = { updatedAt: real, source: 'demo', etas, path: dm.path };
  renderList(false);
  refreshMap(!D.fitted); D.fitted = true;
}

/* ---------------- shared drive UI ---------------- */
function nextStop() { return remainingStops()[0] || null; }
function refreshMap(refit) {
  if (!D.map) return;
  const stops = state.trip.stops, nx = nextStop();
  const key = stops.map(s => s.id + s.dropped + s.lat).join('|') + (nx ? nx.id : '');
  if (key !== D.mapKey) { D.map.setStops(stops, nx && nx.id); D.mapKey = key; refit = true; }
  if (D.pos) D.map.setBus(D.pos);
  if (refit) fitMap();
}
function fitMap() {
  if (!D.map) return;
  const stops = remainingStops();
  if (D.fitMode === 'all') D.map.fit([D.pos, DEMO_ORIGIN.lat && D.mode === 'demo' ? DEMO_ORIGIN : null, ...stops]);
  else D.map.fit([D.pos, stops[0]]);
}
function renderList(forceStructure) {
  const list = $('#stopList'), stops = state.trip.stops, nx = nextStop();
  const sig = stops.map(s => s.id + (s.dropped ? 'd' : '') + (hasOwnDwell(s) ? '=' + s.dwellMin : '')).join(',') + '#' + state.settings.dwellMin + '|' + (nx ? nx.id : '');
  if (forceStructure || sig !== D.sig) {
    D.sig = sig;
    list.innerHTML = stops.map((s, i) => s.dropped ? '' : `
      <div class="stop ${nx && nx.id === s.id ? 'next' : ''}" data-id="${s.id}">
        <div class="num">${i + 1}</div>
        <div class="main">
          <div class="top"><div class="name">${esc(s.name)}</div><button class="dwellchip ${hasOwnDwell(s) ? 'custom' : ''}" data-act="dwell" aria-label="Change stop time for ${esc(s.name)}">⏱ Stop time: ${fmtMin(stopDwellMin(s, state.settings.dwellMin))}</button><span class="tag">NEXT</span></div>
          <div class="row2">
            <div class="eta" data-f="eta">--</div>
            <div class="side"><span data-f="rem">—</span><span data-f="dist"></span></div>
          </div>
        </div>
        <button class="btn drop" data-act="drop" aria-label="Dropped off at ${esc(s.name)}">✓ DROPPED<br>OFF</button>
      </div>`).join('');
    const done = stops.map((s, i) => [s, i]).filter(([s]) => s.dropped);
    const box = $('#doneBox');
    box.classList.toggle('hidden', !done.length);
    box.innerHTML = done.length ? '<span>Dropped off:</span>' + done.map(([s, i]) => `<button class="btn ghost" data-act="undo" data-id="${s.id}" aria-label="Undo drop-off at ${esc(s.name)}">✓ ${esc(s.name.split(',')[0])} ↶</button>`).join('') : '';
    if (!remainingStops().length && stops.length) list.innerHTML = '<div class="alldone">✓ All stops complete</div>';
    D.mapKey = null; refreshMap(false);
  }
  const res = D.results, now = nowMs();
  stops.forEach(s => {
    if (s.dropped) return;
    const el = list.querySelector(`.stop[data-id="${s.id}"]`); if (!el) return;
    const e = res && res.etas[s.id];
    const set = (f, t) => { const n = el.querySelector(`[data-f="${f}"]`); if (n && n.textContent !== t) n.textContent = t; };
    if (!e) { set('eta', '--:--'); set('rem', 'Calculating…'); set('dist', ''); return; }
    const here = s.lat != null && D.pos && haversineMi(D.pos, s) < 0.3;
    const passed = !here && e.arrived;
    el.classList.toggle('here', !!here); el.classList.toggle('passed', !!passed);
    set('eta', here ? 'HERE' : passed ? 'PASSED' : fmtClock(e.eta, now));
    set('rem', here ? 'At stop' : passed ? 'Tap Dropped Off' : fmtDur((e.eta - now) / 1000) + ' left');
    set('dist', here || passed ? '' : fmtMi(e.dist));
  });
  // summary
  const rem = remainingStops();
  const last = rem[rem.length - 1], le = last && res && res.etas[last.id];
  $('#summary').innerHTML = rem.length
    ? `<span><b>${rem.length}</b> stop${rem.length > 1 ? 's' : ''} left</span><span>Final: <b>${le ? esc(last.name.split(',')[0]) + ' ' + fmtClock(le.eta, now) : '—'}</b></span>`
    : '<span>Trip finished</span>';
}
function uiTick() {
  const now = nowMs();
  $('#clock').textContent = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const u = $('#updChip'), r = D.results, offline = !navigator.onLine && D.mode === 'live';
  if (D.mode === 'demo') { u.textContent = 'Simulated clock'; u.className = 'chip'; }
  else if (!r) { u.textContent = D.pos ? 'Calculating…' : 'Waiting for GPS…'; u.className = 'chip warn'; }
  else {
    const age = Date.now() - r.updatedAt;
    u.textContent = (offline ? 'NO SIGNAL · ' : '') + 'Updated ' + fmtAgo(age);
    u.className = 'chip ' + (offline || age > 300000 ? 'bad' : age > 120000 ? 'warn' : 'ok');
  }
  const g = $('#gpsChip');
  if (D.mode === 'live' && D.pos && Date.now() - D.posAt > 120000) { g.textContent = 'GPS lost'; g.className = 'chip bad'; }
  else g.classList.add('hidden');
  if (D.mode === 'live' && D.pos && Date.now() - D.posAt > 120000) g.classList.remove('hidden');
  renderList(false);
}
function bindDrive() {
  $('#stopList').addEventListener('click', e => {
    const dw = e.target.closest('[data-act="dwell"]');
    if (dw) { openDwell(dw.closest('.stop').dataset.id); return; }
    const b = e.target.closest('[data-act="drop"]'); if (!b) return;
    setDropped(b.closest('.stop').dataset.id, true);
  });
  $('#doneBox').addEventListener('click', e => {
    const b = e.target.closest('[data-act="undo"]'); if (!b) return;
    setDropped(b.dataset.id, false);
  });
  $('#btnEdit').addEventListener('click', () => { stopDrive(); releaseWake(); state.trip.started = false; saveTrip(); show('setup'); renderSetup(); });
  $('#btnRefresh').addEventListener('click', () => { if (D.mode === 'live') { D.lastCompute = 0; maybeRefresh(true); } else demoTick(); });
  $('#btnFit').addEventListener('click', () => {
    D.fitMode = D.fitMode === 'next' ? 'all' : 'next';
    $('#btnFit').textContent = D.fitMode === 'next' ? 'Map: next stop' : 'Map: whole route';
    fitMap();
  });
  $('#awakeChip').addEventListener('click', acquireWake);
  $$('#demoStrip [data-speed]').forEach(b => b.addEventListener('click', () => {
    state.settings.demoSpeed = +b.dataset.speed; saveSettings();
    if (D.demo) D.demo.speed = +b.dataset.speed;
    $$('#demoStrip [data-speed]').forEach(x => x.classList.toggle('sel', x === b));
  }));
  $('#btnSkip').addEventListener('click', () => {
    if (!D.demo) return; const dm = D.demo;
    const nxt = dm.stops.find(s => !dm.visited.has(s.id));
    if (!nxt) return;
    dm.d = Math.max(dm.d, dm.stopSById[nxt.id] - 3); dm.dwellLeft = 0; demoTick();
  });
  $('#btnDemoReset').addEventListener('click', () => { state.trip.stops.forEach(s => s.dropped = false); saveTrip(); startDrive(); });
  window.addEventListener('online', () => { if (D.mode === 'live') { D.lastCompute = 0; maybeRefresh(true); uiTick(); } });
  window.addEventListener('offline', uiTick);
  window.addEventListener('resize', () => D.map && D.map.resize());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('#drive').classList.contains('hidden')) { acquireWake(); if (D.mode === 'live') maybeRefresh(false); } });
}
function setDropped(id, v) {
  const s = state.trip.stops.find(x => x.id === id); if (!s) return;
  s.dropped = v; saveTrip();
  if (D.demo) {
    if (v && D.demo.dwellId === id) { D.demo.dwellLeft = 0; D.demo.dwellId = null; }
    if (v) D.demo.visited.add(id); else if (D.demo.stopSById[id] > D.demo.d) D.demo.visited.delete(id);
    demoTick();
  } else {
    renderList(true); refreshMap(true);
    D.lastCompute = 0; maybeRefresh(true);
  }
  uiTick();
}

/* ---------------- wake lock ---------------- */
async function acquireWake() {
  const chip = $('#awakeChip');
  const set = (ok, t) => { chip.textContent = t; chip.className = 'chip chipbtn ' + (ok ? 'ok' : 'warn'); };
  try {
    if (!('wakeLock' in navigator)) throw new Error('unsupported');
    if (D.wake && !D.wake.released) { set(true, '☀ Screen stays on'); return; }
    D.wake = await navigator.wakeLock.request('screen');
    D.wake.addEventListener('release', () => set(false, '⚠ Screen may sleep (tap)'));
    set(true, '☀ Screen stays on');
  } catch (e) {
    set(false, '⚠ Screen may sleep (tap)');
  }
}
function releaseWake() { try { D.wake && D.wake.release(); } catch (e) { } D.wake = null; }

/* ================================================================== BOOT */
function boot() {
  bindSetup(); bindDrive(); bindDwell();
  renderSetup();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
  const q = new URLSearchParams(location.search);
  if (state.trip.started && remainingStops().length && !q.has('setup')) startDrive();
  else show('setup');
  window.__busEta = { state, D };   // for debugging/tests
}
boot();
