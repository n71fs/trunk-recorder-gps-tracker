import { PositionStore, unitKey, recordedPositions, livePositions } from './positions.js';
import { additionalAdapters } from './adapters.js';
import { PositionMap } from './map.js';
import { BASEMAPS, readBasemapPreference, saveBasemapPreference } from './basemaps.js';
import { BrowserHistory, fixId } from './history.js';
import { CallSearch } from './backfill.js';
import { observations, radioColor, GAP_MS, readSettings, writeSettings } from './view.js';

const $ = (id) => document.getElementById(id);
const demo = new URLSearchParams(location.search).has('demo');
const DAY = 86400000;
let storage;
try { storage = window.localStorage; } catch { /* Preferences are optional. */ }
const prefs = readSettings(storage);
const radioPrefs = prefs.radios && typeof prefs.radios === 'object' ? prefs.radios : {};
let rec, database, storageFailure = '', storageStats = { count: 0, bytes: 0 }, storageReady = false;
let selected = prefs.selected, visible = [], recentCursor, scheduled = false, error = '', editKey;
let playhead = null, playing = false, timelineStart = 0, timelineEnd = 0, restoring = false;
let viewTrails = new Map(), tileStatus = { mode: 'osm', ready: 0, failed: 0, loading: 0 };
let backfillGenerationStarted = false, flushTimer, maintenanceRunning = false;
const writeBuffer = new Map();
const metrics = { restored: 0, live: 0, recorded: 0, lastLiveAt: null, lastMessageAt: null, positionLogs: 0, unreadableLogs: 0 };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (p) => ({ p25: 'P25', p25_phase2: 'P25 Phase 2', dmr: 'DMR', nxdn: 'NXDN', nxdn48: 'NXDN48', nxdn96: 'NXDN96', unknown: 'Unknown', conventional: 'Conventional' }[p] || p);
const name = (p) => radioPrefs[unitKey(p)]?.name || rec?.unitName(p.system, p.unit) || p.name || `Unit ${p.unit}`;
const retentionDays = () => Number($('retention').value) || 7;
const cutoff = () => Date.now() - retentionDays() * DAY;
const store = new PositionStore({ maxPoints: 2000, maxTotal: 100000, adapters: [recordedPositions, livePositions, ...additionalAdapters], onAdd(p) {
  if (restoring) { metrics.restored++; return; }
  if (p.origin === 'live') { metrics.live++; metrics.lastLiveAt = Date.now(); }
  else if (p.origin === 'recorded') metrics.recorded++;
  if (database && !storageFailure && p.time >= cutoff()) {
    writeBuffer.set(fixId(p), p);
    if (!flushTimer) flushTimer = setTimeout(flush, 500);
  }
} });
function savePreferences() { prefs.radios = radioPrefs; prefs.selected = selected; writeSettings(storage, prefs); }
for (const id of ['search', 'system', 'protocol', 'age', 'range-from', 'range-to']) {
  if (typeof prefs.filters?.[id] === 'string' && !['system', 'protocol'].includes(id)) $(id).value = prefs.filters[id];
}
$('favorites-only').checked = !!prefs.favoritesOnly;
$('auto-backfill').checked = prefs.autoBackfill !== false;
$('retention').value = [1, 7, 30, 90].includes(prefs.retention) ? String(prefs.retention) : '7';
$('trails').checked = prefs.trails !== false;
$('cluster').checked = prefs.cluster !== false;
$('follow').checked = !!prefs.follow;
$('basemap').value = readBasemapPreference(storage);
for (const id of ['filter-panel', 'radio-panel', 'history-panel', 'diagnostic-panel']) {
  $(id).open = typeof prefs.panels?.[id] === 'boolean' ? prefs.panels[id] : id === 'history-panel' || (innerWidth > 640 && id !== 'diagnostic-panel');
  $(id).addEventListener('toggle', () => { prefs.panels = { ...prefs.panels, [id]: $(id).open }; savePreferences(); });
}
function basemapStatus(status) {
  const changed = JSON.stringify(tileStatus) !== JSON.stringify(status);
  tileStatus = status;
  const { mode, ready, failed, loading } = status, source = BASEMAPS[mode];
  $('attribution').hidden = mode !== 'osm'; $('retry-tiles').hidden = !failed;
  $('map-label').textContent = mode === 'none' ? 'Offline coordinate map · north ↑' :
    ready ? `${source.name} · north ↑` : loading ? `${source.name} · loading tiles…` :
      failed ? `${source.name} unavailable · coordinate grid shown` : `${source.name} · north ↑`;
  if (changed && $('diagnostic-panel').open) queueDraw();
}
const map = new PositionMap($('map'), select, basemapStatus);
let fitted = false, viewTimer;
if (Array.isArray(prefs.view?.center) && prefs.view.center.length === 2 && prefs.view.center.every(Number.isFinite) && Number.isFinite(prefs.view.zoom)) {
  map.center = prefs.view.center; map.zoom = Math.max(1, Math.min(18, Math.round(prefs.view.zoom))); fitted = true;
}
map.onViewChange = (view) => { clearTimeout(viewTimer); viewTimer = setTimeout(() => { prefs.view = view; savePreferences(); }, 200); };
map.onInteract = () => { $('follow').checked = false; prefs.follow = false; savePreferences(); };
const search = new CallSearch({
  send(m) { if (!rec?.connected) throw new Error('Recorder disconnected. Reconnect before searching.'); rec.send(m); },
  onPage(m, kind) { store.ingest(m, { rec, receivedAt: Date.now() }); if (kind === 'older') recentCursor = m.next; queueDraw(); },
  onChange() { queueDraw(); },
});
function age(time, reference = Date.now()) {
  const seconds = Math.max(0, Math.floor((reference - time) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
function queueDraw() { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; draw(); }); } }
function select(key) {
  selected = key; const p = visible.find((v) => unitKey(v) === key) || store.trail(key).at(-1);
  if (p) map.focus(p);
  $('radio-panel').open = true; savePreferences(); draw();
}
function options(id, values, all) {
  const el = $(id), previous = el.value || prefs.filters?.[id] || '';
  const sorted = [...new Set([...values, ...(previous ? [previous] : [])])].sort(), signature = JSON.stringify(sorted);
  if (el.dataset.values === signature) return;
  el.dataset.values = signature;
  el.innerHTML = `<option value="">${all}</option>` + sorted.map((s) => `<option value="${esc(s)}">${esc(id === 'protocol' ? label(s) : s)}</option>`).join('');
  if (sorted.includes(previous)) el.value = previous;
}
function range() {
  const from = $('range-from').value ? new Date($('range-from').value).getTime() : 0;
  const to = $('range-to').value ? new Date($('range-to').value).getTime() : Date.now();
  return { from, to, valid: Number.isFinite(from) && Number.isFinite(to) && from <= to };
}
function sourceText(p) { return `${p.cached ? 'Saved · ' : ''}${p.origin}`; }
function matches(p, reference) {
  return (!$('system').value || p.system === $('system').value) && (!$('protocol').value || p.protocol === $('protocol').value) &&
    (!$('age').value || Number($('age').value) === 0 || reference - p.time <= Number($('age').value)) &&
    (!$('favorites-only').checked || radioPrefs[unitKey(p)]?.favorite) &&
    `${p.unit} ${name(p)} ${p.talkgroup ?? ''}`.toLowerCase().includes($('search').value.trim().toLowerCase());
}
function draw() {
  const all = store.latest(), now = Date.now(), r = range(), reference = playhead ?? now;
  options('system', all.map((p) => p.system), 'All systems'); options('protocol', all.map((p) => p.protocol), 'All protocols');
  const base = observations(store, { from: r.from, to: r.to });
  const eligible = base.latest.filter((p) => matches(p, now));
  const times = eligible.flatMap((p) => base.trails.get(unitKey(p)).map((v) => v.time));
  timelineStart = times.length ? times.reduce((a, b) => Math.min(a, b)) : 0;
  timelineEnd = times.length ? times.reduce((a, b) => Math.max(a, b)) : 0;
  const view = observations(store, { from: r.from, to: r.to, at: playhead ?? Infinity });
  visible = r.valid ? view.latest.filter((p) => matches(p, reference)) : [];
  viewTrails = view.trails;
  if (!eligible.some((p) => unitKey(p) === selected)) selected = visible[0] ? unitKey(visible[0]) : null;
  $('count').textContent = all.length; $('recent').textContent = all.filter((p) => now - p.time <= GAP_MS).length;
  $('protocol-count').textContent = new Set(all.map((p) => p.protocol)).size;
  $('last').textContent = all[0] ? age(all[0].time) : '—'; $('last-detail').textContent = all[0] ? `${all[0].system} · unit ${all[0].unit}` : 'Waiting for a GPS fix';
  $('shown').textContent = `${visible.length} / ${all.length}`;
  $('connection').textContent = demo ? 'Demo data' : rec?.connected ? 'Connected' : 'Reconnecting…';
  $('connection').classList.toggle('ok', !demo && !!rec?.connected);
  $('notice').textContent = !r.valid ? 'The From time must be before the To time.' : demo ? 'Demo mode · fictional positions and a separate demo history store.' :
    error || (!rec?.connected ? 'Recorder disconnected. Saved positions remain available; reconnecting automatically.' :
      rec.phase.phase !== 'running' ? 'Recorder is idle. Saved and recorded positions remain available.' :
        playhead != null ? 'History playback · markers show the last observation at or before the selected time.' : 'Receiving decoded GPS positions. Stale locations may no longer reflect the radio’s location.');
  $('radios').innerHTML = visible.map((p, i) => `<tr class="${unitKey(p) === selected ? 'selected' : ''}"><td><button data-index="${i}" aria-pressed="${unitKey(p) === selected}"><span class="radio-dot" style="background:${radioColor(p, radioPrefs)}"></span>${esc(name(p))}</button><small>Unit ${p.unit} <button data-favorite="${i}" aria-label="${radioPrefs[unitKey(p)]?.favorite ? 'Remove favorite' : 'Add favorite'} ${p.unit}" aria-pressed="${!!radioPrefs[unitKey(p)]?.favorite}">${radioPrefs[unitKey(p)]?.favorite ? '★' : '☆'}</button></small></td>
    <td>${esc(p.system)}<small>${esc(label(p.protocol))}</small></td><td class="mono">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</td><td>${esc(p.talkgroup ?? '—')}</td>
    <td title="${esc(new Date(p.time).toLocaleString())}">${esc(age(p.time, reference))}${reference - p.time > GAP_MS ? ' · stale' : ''}</td><td>${esc(sourceText(p))}</td></tr>`).join('');
  $('list-empty').hidden = !!visible.length;
  $('list-empty').textContent = all.length ? 'No radios match this time and filter selection.' : 'No GPS positions received. Check GPS and connection diagnostics below.';
  $('map-empty').hidden = !!visible.length;
  $('map-empty').querySelector('h2').textContent = all.length ? 'No matching observations' : 'No positions yet';
  $('map-empty').querySelector('p').textContent = all.length ? 'Change the time, playback position or filters.' : 'The map is ready. GPS fixes appear when the recorder decodes them.';
  $('fit').disabled = $('export').disabled = !visible.length;
  $('older').disabled = demo || !rec?.connected || !rec.capabilities.includes('calls') || !recentCursor || search.state.running;
  $('older').textContent = search.state.running && search.state.kind === 'older' ? 'Loading calls…' : 'Load older calls';
  $('search-history').disabled = demo || !rec?.connected || !rec.capabilities.includes('calls') || search.state.running || !r.valid;
  $('cancel-backfill').disabled = !search.state.running;
  $('backfill-status').textContent = demo ? 'Demo mode: no recorder searches' : !rec?.connected ? 'Waiting for the recorder' : !rec.capabilities.includes('calls') ? 'Recorder call store unavailable; recent greeting history still loads' : `${search.state.message} · ${search.state.pages} pages · ${search.state.calls} calls checked`;
  const p = visible.find((v) => unitKey(v) === selected), trail = p ? viewTrails.get(selected) : [];
  const gap = trail?.length > 1 ? trail.at(-1).time - trail.at(-2).time : 0;
  $('details').innerHTML = p ? `<h3>${esc(name(p))}</h3><p class="system">${esc(p.system)} · unit ${p.unit}</p><dl><div><dt>Latitude / longitude</dt><dd class="coordinates">${p.lat.toFixed(5)}<br>${p.lon.toFixed(5)}</dd></div>
    <div><dt>Last observation</dt><dd>${esc(age(p.time, reference))}${reference - p.time > GAP_MS ? ' · stale' : ''}</dd></div><div><dt>Protocol</dt><dd>${esc(label(p.protocol))}</dd></div><div><dt>Talkgroup</dt><dd>${esc(p.talkgroup ?? '—')}</dd></div><div><dt>Observations in view</dt><dd>${trail.length}</dd></div><div><dt>Source</dt><dd>${esc(sourceText(p))}</dd></div></dl>
    <p class="detail-note">${esc(new Date(p.time).toLocaleString())}${p.estimatedTime ? ' · approximate observation time' : ''}${gap > GAP_MS ? ` · ${Math.round(gap / 60000)} minute observation gap` : ''}</p><button id="center">Center on radio</button>` : `<p class="muted">${selected ? 'The selected radio has no observation at this playback time.' : 'Select a radio to see its coordinates and recent trail.'}</p>`;
  if ($('center')) $('center').onclick = () => map.focus(p);
  $('radio-settings').hidden = !p;
  if (p && editKey !== selected) { $('friendly-name').value = radioPrefs[selected]?.name || ''; $('radio-color').value = radioPrefs[selected]?.color || ''; editKey = selected; }
  if (p) { $('favorite').textContent = radioPrefs[selected]?.favorite ? 'Remove favorite' : 'Add favorite'; $('favorite').setAttribute('aria-pressed', !!radioPrefs[selected]?.favorite); }
  if (!p) editKey = null;
  $('timeline').min = timelineStart; $('timeline').max = Math.max(timelineStart + 1, timelineEnd); $('timeline').step = 1;
  $('timeline').value = playhead ?? timelineEnd; $('timeline').disabled = $('play').disabled = timelineEnd <= timelineStart;
  $('play').textContent = playing ? 'Pause playback' : 'Play history';
  $('playback-time').textContent = playhead == null ? 'Live · latest observations' : `Replay · ${new Date(playhead).toLocaleString()}`;
  if (!fitted && visible.length) { map.fit(visible); fitted = true; }
  if ($('follow').checked && p) map.center = map.projectPosition(p);
  map.update(visible, { trail: (key) => viewTrails.get(key) || [] }, selected, $('trails').checked, $('basemap').value, { cluster: $('cluster').checked, color: (p) => radioColor(p, radioPrefs) });
  $('storage-status').textContent = !storageReady ? 'Opening saved positions…' : storageFailure ? `Session only: ${storageFailure}` : `${storageStats.count.toLocaleString()} saved positions · about ${(storageStats.bytes / 1024).toFixed(1)} KiB of position data · ${retentionDays()} day retention`;
  $('clear-history').disabled = !storageReady;
  $('export-all').disabled = !store.total && !storageStats.count;
  $('diagnostics').textContent = $('basemap').value === 'osm' ? 'Browser history · map tiles from OpenStreetMap' : 'Browser history · offline map source';
  const diagnostics = [ ['Recorder', rec?.connected ? `Connected · ${rec.version || 'unknown version'}` : demo ? 'Demo' : 'Disconnected'], ['Recorder phase', rec?.phase?.phase || '—'], ['Last recorder message', metrics.lastMessageAt ? age(metrics.lastMessageAt) : 'None'], ['Last live GPS received', metrics.lastLiveAt ? age(metrics.lastLiveAt) : 'None this visit'], ['Live fixes this visit', metrics.live], ['Recorded fixes this visit', metrics.recorded], ['Restored browser fixes', metrics.restored], ['Invalid fixes rejected', store.rejected], ['Unreadable position logs', metrics.unreadableLogs], ['Adapter errors', store.adapterErrors], ['Map tiles', `${tileStatus.ready} ready · ${tileStatus.failed} failed · ${tileStatus.loading} loading`], ['Display memory', `${store.total.toLocaleString()} observations`] ];
  $('diagnostic-content').innerHTML = diagnostics.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
  $('gps-explanation').textContent = !rec?.connected && !demo ? 'No recorder connection. Saved browser positions remain available. Serve this folder from TR Pro to reconnect.' :
    !metrics.live && !metrics.recorded && !all.length ? 'No decoded coordinates received. Check that the radio transmits GPS and the recorder supports its format. This interface cannot distinguish unsupported GPS traffic from no GPS traffic.' :
      'Live, recorded and restored fixes are counted separately. Missing call-source coordinates are normal and are not counted as invalid fixes. Saved history does not prove a radio is still at that location.';
}
async function refreshStats() { if (database) storageStats = await database.stats(); queueDraw(); }
async function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  if (!database || storageFailure || !writeBuffer.size) return;
  const values = [...writeBuffer.values()]; writeBuffer.clear();
  try { await database.save(values, cutoff()); await refreshStats(); }
  catch (e) { storageFailure = e.message || 'Saving failed. Check browser storage permissions or quota.'; queueDraw(); }
}
async function maintenance() {
  if (!database || maintenanceRunning) return;
  maintenanceRunning = true;
  try { await flush(); await database.prune(cutoff()); store.prune(cutoff()); await refreshStats(); }
  catch (e) { storageFailure = e.message; queueDraw(); }
  finally { maintenanceRunning = false; }
}
function filterPreferences() {
  prefs.filters = Object.fromEntries(['search', 'system', 'protocol', 'age', 'range-from', 'range-to'].map((id) => [id, $(id).value]));
  prefs.favoritesOnly = $('favorites-only').checked; playing = false; savePreferences(); queueDraw();
}
$('filters').onsubmit = (e) => e.preventDefault(); $('filters').oninput = filterPreferences;
$('reset-filters').onclick = () => { for (const id of ['search', 'system', 'protocol', 'range-from', 'range-to']) $(id).value = ''; $('age').value = '0'; $('favorites-only').checked = false; playhead = null; filterPreferences(); };
function favorite(key) { radioPrefs[key] = { ...radioPrefs[key], favorite: !radioPrefs[key]?.favorite }; savePreferences(); queueDraw(); }
$('radios').onclick = (e) => { const star = e.target.closest('button[data-favorite]'), button = e.target.closest('button[data-index]'); if (star) favorite(unitKey(visible[Number(star.dataset.favorite)])); else if (button) select(unitKey(visible[Number(button.dataset.index)])); };
$('radio-settings').onsubmit = (e) => e.preventDefault();
$('friendly-name').onchange = () => { if (selected) { radioPrefs[selected] = { ...radioPrefs[selected], name: $('friendly-name').value.trim() }; savePreferences(); queueDraw(); } };
$('radio-color').onchange = () => { if (selected) { radioPrefs[selected] = { ...radioPrefs[selected], color: $('radio-color').value }; savePreferences(); queueDraw(); } };
$('favorite').onclick = () => { if (selected) favorite(selected); };
$('fit').onclick = () => { $('follow').checked = false; prefs.follow = false; savePreferences(); map.fit(); };
$('zoom-in').onclick = () => map.zoomBy(1); $('zoom-out').onclick = () => map.zoomBy(-1);
for (const id of ['trails', 'cluster', 'follow']) $(id).onchange = () => { prefs[id] = $(id).checked; savePreferences(); queueDraw(); };
$('basemap').onchange = () => { saveBasemapPreference(storage, $('basemap').value); queueDraw(); };
$('retry-tiles').onclick = () => map.retryFailedTiles();
function download(data, filename) { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function geoJSON(fixes) { return { type: 'FeatureCollection', features: fixes.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { ...p, lat: undefined, lon: undefined, time: new Date(p.time).toISOString() } })) }; }
$('export').onclick = () => download(geoJSON(visible.flatMap((p) => viewTrails.get(unitKey(p)) || [])), 'radio-positions.geojson');
$('export-all').onclick = async () => { try { await flush(); const saved = database ? await database.load() : []; const fixes = new Map(saved.map((p) => [fixId(p), p])); for (const points of store.units.values()) for (const p of points) fixes.set(fixId(p), p); download(geoJSON([...fixes.values()]), 'radio-position-history.geojson'); } catch (e) { error = `History export failed: ${e.message}`; queueDraw(); } };
$('clear-history').onclick = async () => {
  if (!confirm('Delete all position history in this browser? Recorder files and radio preferences are unchanged. New fixes may arrive, and automatic backfill can restore recorder positions on reconnect.')) return;
  search.cancel(); writeBuffer.clear(); store.clear(); selected = null; playhead = null; playing = false;
  try { if (database) await database.clear(); storageStats = { count: 0, bytes: 0 }; storageFailure = database ? '' : storageFailure; }
  catch (e) { storageFailure = e.message; }
  queueDraw();
};
$('retention').onchange = () => { prefs.retention = retentionDays(); savePreferences(); maintenance(); };
$('auto-backfill').onchange = () => { prefs.autoBackfill = $('auto-backfill').checked; savePreferences(); if (!prefs.autoBackfill) search.cancel(); };
function searchRange() { const r = range(); if (!r.valid) return; search.start({ from: r.from || Date.now() - DAY, to: r.to + 1 }); }
$('search-history').onclick = searchRange; $('cancel-backfill').onclick = () => search.cancel();
$('older').onclick = () => search.start({ cursor: recentCursor, maxPages: 1, kind: 'older' });
$('timeline').oninput = () => { playing = false; playhead = Number($('timeline').value); queueDraw(); };
$('play').onclick = () => { if (playing) playing = false; else { if (playhead == null || playhead >= timelineEnd) playhead = timelineStart; playing = true; } queueDraw(); };
$('live').onclick = () => { playing = false; playhead = null; queueDraw(); };
let lastTick = performance.now();
setInterval(() => { const now = performance.now(), elapsed = Math.min(1000, now - lastTick); lastTick = now; if (playing && playhead != null) { playhead = Math.min(timelineEnd, playhead + elapsed * Number($('speed').value)); if (playhead >= timelineEnd) playing = false; queueDraw(); } }, 250);
document.addEventListener('visibilitychange', () => { if (document.hidden) { playing = false; flush(); } });
window.addEventListener('pagehide', () => { flush(); rec?.close(); });
setInterval(queueDraw, 10000); setInterval(maintenance, 60000);
draw();
try {
  database = await new BrowserHistory(demo ? 'radio-positions-demo-v1' : 'radio-positions-v1').open();
  await database.prune(cutoff()); const saved = await database.load(); restoring = true;
  for (const p of saved) store.add(p);
  restoring = false; await refreshStats();
} catch (e) { restoring = false; storageFailure = e.message; }
storageReady = true; draw();
if (demo) { const { seedDemo } = await import('./demo.js'); seedDemo(store); draw(); }
else {
  try {
    const { TrunkClient } = await import('/api/client.js'); rec = new TrunkClient();
    rec.on('message', (m) => {
      metrics.lastMessageAt = Date.now();
      if (m.type === 'callsResult') { search.receive(m); return; }
      if (m.type === 'log') for (const line of m.lines || []) if (line.kind === 'position') { metrics.positionLogs++; if (!/^Unit (\d+) at (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?) \(TG (\d+)\)$/.test(line.text || '')) metrics.unreadableLogs++; }
      store.ingest(m, { rec, receivedAt: Date.now() });
      if (m.type === 'history') recentCursor = m.next;
      if (m.type === 'hello') { error = ''; if ($('auto-backfill').checked && rec.capabilities.includes('calls') && !backfillGenerationStarted) { backfillGenerationStarted = true; searchRange(); } }
      queueDraw();
    });
    rec.on('connection', (connected) => { if (connected) rec.subscribe(['log']); else { search.cancel('Recorder disconnected; search stopped'); backfillGenerationStarted = false; } queueDraw(); });
  } catch { error = 'Recorder API unavailable. Serve this folder using Interfaces → Add a folder… or trunk-pro --ui. Add ?demo for a fictional preview.'; draw(); }
}
