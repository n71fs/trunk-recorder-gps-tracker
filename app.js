import { PositionStore, unitKey, recordedPositions, livePositions } from "./positions.js";
import { additionalAdapters } from "./adapters.js";
import { PositionMap } from "./map.js";
import { BASEMAPS, readBasemapPreference, saveBasemapPreference } from "./basemaps.js";

const $ = (id) => document.getElementById(id);
const store = new PositionStore({ adapters: [recordedPositions, livePositions, ...additionalAdapters] });
const demo = new URLSearchParams(location.search).has("demo");
let rec, selected, visible = [], nextCursor, pending, requestId = 10000, scheduled = false;
let error = "", fitted = false;
let storage;
try { storage = window.localStorage; } catch { /* Preferences are optional. */ }
$("basemap").value = readBasemapPreference(storage);
function basemapStatus({ mode, ready, failed, loading }) {
  const source = BASEMAPS[mode];
  $("attribution").hidden = mode !== "osm";
  $("retry-tiles").hidden = !failed;
  $("map-label").textContent = mode === "none" ? "Offline coordinate map · north ↑" :
    ready ? `${source.name} · north ↑` : loading ? `${source.name} · loading tiles…` :
      failed ? `${source.name} unavailable · coordinate grid shown` : `${source.name} · waiting for positions`;
}
const map = new PositionMap($("map"), select, basemapStatus);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const label = (p) => ({ p25: "P25", p25_phase2: "P25 Phase 2", dmr: "DMR", nxdn: "NXDN", nxdn48: "NXDN48", nxdn96: "NXDN96", unknown: "Unknown", conventional: "Conventional" }[p] || p);
const name = (p) => rec?.unitName(p.system, p.unit) || p.name || `Unit ${p.unit}`;
function age(time) {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
function queueDraw() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; draw(); });
}
function select(key) {
  selected = key;
  const p = store.trail(key).at(-1);
  if (p) map.focus(p);
  draw();
}
function options(id, values, all) {
  const el = $(id), previous = el.value;
  const sorted = [...new Set(values)].sort();
  const signature = JSON.stringify(sorted);
  if (el.dataset.values === signature) return;
  el.dataset.values = signature;
  el.innerHTML = `<option value="">${all}</option>` + sorted.map((s) => `<option value="${esc(s)}">${esc(id === "protocol" ? label(s) : s)}</option>`).join("");
  if (sorted.includes(previous)) el.value = previous;
}
function draw() {
  const all = store.latest(), now = Date.now();
  options("system", all.map((p) => p.system), "All systems");
  options("protocol", all.map((p) => p.protocol), "All protocols");
  const search = $("search").value.trim().toLowerCase(), maxAge = Number($("age").value);
  visible = all.filter((p) => (!$("system").value || p.system === $("system").value) &&
    (!$("protocol").value || p.protocol === $("protocol").value) &&
    (!maxAge || now - p.time <= maxAge) &&
    `${p.unit} ${name(p)} ${p.talkgroup ?? ""}`.toLowerCase().includes(search));
  if (!visible.some((p) => unitKey(p) === selected)) selected = visible[0] ? unitKey(visible[0]) : null;
  $("count").textContent = all.length;
  $("recent").textContent = all.filter((p) => now - p.time <= 300000).length;
  $("protocol-count").textContent = new Set(all.map((p) => p.protocol)).size;
  $("last").textContent = all[0] ? age(all[0].time) : "—";
  $("last-detail").textContent = all[0] ? `${all[0].system} · unit ${all[0].unit}` : "Waiting for a GPS fix";
  $("shown").textContent = `${visible.length} / ${all.length}`;
  $("connection").textContent = demo ? "Demo data" : rec?.connected ? "Connected" : "Reconnecting…";
  $("connection").classList.toggle("ok", !demo && !!rec?.connected);
  $("notice").textContent = demo ? "Demo mode · fictional positions. Open without ?demo to connect to your recorder." :
    error || (!rec?.connected ? "Recorder disconnected. Retained positions are shown; reconnecting automatically." :
      rec.phase.phase !== "running" ? "Recorder is idle. Recent recorded positions are shown; start recording in the main interface for live fixes." :
        "Receiving position logs and recorded calls. A position older than 5 minutes may no longer reflect the radio’s location.");
  $("radios").innerHTML = visible.map((p, i) => `<tr class="${unitKey(p) === selected ? "selected" : ""}">
    <td><button data-index="${i}" aria-pressed="${unitKey(p) === selected}">${esc(name(p))}</button><small>Unit ${p.unit}</small></td>
    <td>${esc(p.system)}<small>${esc(label(p.protocol))}</small></td>
    <td class="mono">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</td><td>${esc(p.talkgroup ?? "—")}</td>
    <td title="${esc(new Date(p.time).toLocaleString())}">${esc(age(p.time))}${now - p.time > 300000 ? " · stale" : ""}</td><td>${esc(p.origin)}</td></tr>`).join("");
  $("list-empty").hidden = visible.length > 0;
  $("list-empty").textContent = all.length ? "No radios match these filters. Try another system or time range." :
    "No GPS positions received. Keep the recorder running on a system that sends GPS.";
  $("map-empty").hidden = visible.length > 0;
  $("map-empty").querySelector("h2").textContent = all.length ? "No matching radios" : "No positions yet";
  $("map-empty").querySelector("p").textContent = all.length ? "Change the filters to show positions on the map." : "GPS fixes from live logs and recorded calls will appear here.";
  $("fit").disabled = !visible.length;
  $("export").disabled = !visible.length;
  $("older").disabled = demo || !rec?.connected || !rec.capabilities.includes("calls") || !nextCursor || !!pending;
  $("older").textContent = pending ? "Loading calls…" : "Load older calls";
  const p = visible.find((v) => unitKey(v) === selected);
  $("details").innerHTML = p ? `<h3>${esc(name(p))}</h3><p class="system">${esc(p.system)} · unit ${p.unit}</p><dl>
    <div><dt>Latitude / longitude</dt><dd class="coordinates">${p.lat.toFixed(5)}<br>${p.lon.toFixed(5)}</dd></div>
    <div><dt>Last position</dt><dd>${esc(age(p.time))}${now - p.time > 300000 ? " · stale" : ""}</dd></div>
    <div><dt>Protocol</dt><dd>${esc(label(p.protocol))}</dd></div><div><dt>Talkgroup</dt><dd>${esc(p.talkgroup ?? "—")}</dd></div>
    <div><dt>Observations</dt><dd>${store.trail(selected).length} retained</dd></div><div><dt>Source</dt><dd>${esc(p.origin)}</dd></div></dl>
    <p class="detail-note">${esc(new Date(p.time).toLocaleString())}${p.estimatedTime ? " · approximate observation time" : ""}</p>
    <button id="center">Center on radio</button>` : '<p class="muted">Select a radio to see its coordinates and recent trail.</p>';
  if ($("center")) $("center").onclick = () => map.focus(p);
  if (!fitted && visible.length) { map.fit(visible); fitted = true; }
  map.update(visible, store, selected, $("trails").checked, $("basemap").value);
  $("diagnostics").textContent = store.adapterErrors ? `${store.adapterErrors} adapter errors · check adapters.js` :
    $("basemap").value === "osm" ? "Listen access · map tiles from OpenStreetMap" : "Listen access · offline map source";
}
$("filters").onsubmit = (e) => e.preventDefault();
$("filters").oninput = queueDraw;
$("radios").onclick = (e) => {
  const button = e.target.closest("button[data-index]");
  if (button) select(unitKey(visible[Number(button.dataset.index)]));
};
$("fit").onclick = () => map.fit();
$("zoom-in").onclick = () => map.zoomBy(1);
$("zoom-out").onclick = () => map.zoomBy(-1);
$("trails").onchange = queueDraw;
$("basemap").onchange = () => { saveBasemapPreference(storage, $("basemap").value); queueDraw(); };
$("retry-tiles").onclick = () => map.retryFailedTiles();
$("export").onclick = () => {
  const data = store.geoJSON(visible.map(unitKey));
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/geo+json" }));
  const a = document.createElement("a"); a.href = url; a.download = "radio-positions.geojson"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function clearPending() { if (pending) clearTimeout(pending.timer); pending = null; }
$("older").onclick = () => {
  const id = ++requestId;
  error = "";
  pending = { id, timer: setTimeout(() => { clearPending(); error = "Older calls did not arrive. Reconnect or try loading again."; queueDraw(); }, 15000) };
  // Use the wire command: in the shipped client, the calls state shadows its calls() method.
  rec.send({ type: "callsQuery", id, cursor: nextCursor, limit: 500 });
  queueDraw();
};
draw();
if (demo) {
  const { seedDemo } = await import("./demo.js");
  seedDemo(store);
  draw();
} else {
  try {
    const { TrunkClient } = await import("/api/client.js");
    rec = new TrunkClient();
    rec.on("message", (m) => {
      if (m.type === "callsResult" && m.id !== pending?.id) return;
      store.ingest(m, { rec, receivedAt: Date.now() });
      if (m.type === "history" || m.type === "callsResult") {
        if (m.error) error = m.error;
        else nextCursor = m.next;
        if (m.type === "callsResult") clearPending();
      }
      if (m.type === "hello") error = "";
      if (["hello", "state", "config", "status", "unitAlias", "unitNames", "unitNameEdited", "history", "concluded", "log", "callsResult"].includes(m.type)) queueDraw();
    });
    rec.on("connection", (connected) => {
      if (connected) rec.subscribe(["log"]);
      else clearPending();
      queueDraw();
    });
    window.addEventListener("pagehide", () => rec.close());
  } catch {
    error = "Recorder API unavailable. Serve this folder using Interfaces → Add a folder… or trunk-pro --ui. Add ?demo for a fictional preview.";
    draw();
  }
}
setInterval(queueDraw, 10000);
