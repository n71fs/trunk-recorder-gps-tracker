import { unitKey } from "./positions.js";
import { basemapMode, tileUrl } from "./basemaps.js";
import { clusters, GAP_MS } from "./view.js";

export function project(lon, lat) {
  const a = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + a / 2)) / Math.PI) / 2];
}
export function unproject(x, y) {
  return [((x * 360) % 360 + 360) % 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}
const wrap = (x) => x - Math.round(x);

export class PositionMap {
  constructor(canvas, onSelect, onBasemapStatus = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.center = [.5, .5];
    this.zoom = 2;
    this.points = [];
    this.tiles = new Map();
    this.onSelect = onSelect;
    this.onBasemapStatus = onBasemapStatus;
    this.basemap = "osm";
    new ResizeObserver(() => this.draw()).observe(canvas);
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => this.draw());
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.zoomBy(e.deltaY > 0 ? -1 : 1); }, { passive: false });
    canvas.addEventListener("keydown", (e) => {
      if (["+", "=", "-", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        this.onInteract?.();
        if (["+", "=", "-"].includes(e.key)) this.zoomBy(e.key === "-" ? -1 : 1);
        else {
          const step = 80 / this.scale;
          this.center[0] += e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          this.center[1] += e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          this.draw();
        }
      }
    });
    canvas.addEventListener("pointerdown", (e) => {
      this.drag = { x: e.clientX, y: e.clientY, center: [...this.center], moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.moved ||= Math.hypot(dx, dy) > 4;
      if (this.drag.moved) this.onInteract?.();
      this.center = [this.drag.center[0] - dx / this.scale, this.drag.center[1] - dy / this.scale];
      this.draw();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (this.drag && !this.drag.moved) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const near = (this.hitTargets || []).map((g) => ({ g, d: Math.hypot(g.x - x, g.y - y) })).sort((a, b) => a.d - b.d)[0];
        if (near?.d < 26) {
          if (near.g.points.length === 1) onSelect(unitKey(near.g.points[0]));
          else { this.onInteract?.(); const oldZoom = this.zoom; this.fit(near.g.points); this.zoom = Math.min(18, Math.max(this.zoom, oldZoom + 2)); this.draw(); }
        }
      }
      this.drag = null;
    });
    canvas.addEventListener("pointercancel", () => { this.drag = null; });
  }
  get scale() { return 256 * 2 ** this.zoom; }
  screen(p) {
    const [x, y] = project(p.lon, p.lat);
    return [this.width / 2 + wrap(x - this.center[0]) * this.scale, this.height / 2 + (y - this.center[1]) * this.scale];
  }
  projectPosition(p) { return project(p.lon, p.lat); }
  zoomBy(delta) { this.onInteract?.(); this.zoom = Math.min(18, Math.max(1, this.zoom + delta)); this.draw(); }
  focus(p) { this.center = project(p.lon, p.lat); this.zoom = Math.max(13, this.zoom); this.draw(); }
  fit(points = this.points) {
    if (!points.length) return;
    const coords = points.map((p) => project(p.lon, p.lat));
    const xs = coords.map((p) => p[0]).sort((a, b) => a - b);
    // Cut the largest empty arc, keeping radios near ±180° together.
    let gap = -1, start = xs[0];
    xs.forEach((x, i) => {
      const next = xs[(i + 1) % xs.length] + (i === xs.length - 1 ? 1 : 0);
      if (next - x > gap) { gap = next - x; start = next % 1; }
    });
    const unwrapped = xs.map((x) => x < start - 1e-10 ? x + 1 : x);
    const minX = Math.min(...unwrapped), maxX = Math.max(...unwrapped);
    const ys = coords.map((p) => p[1]), minY = Math.min(...ys), maxY = Math.max(...ys);
    this.center = [((minX + maxX) / 2) % 1, (minY + maxY) / 2];
    this.zoom = Math.max(1, Math.min(15, Math.floor(Math.log2(Math.min(
      Math.max(100, this.width - 120) / (256 * Math.max(maxX - minX, .00001)),
      Math.max(100, this.height - 120) / (256 * Math.max(maxY - minY, .00001)))))));
    this.draw();
  }
  update(points, store, selected, trails, basemap, options = {}) {
    Object.assign(this, { points, store, selected, trails, basemap: basemapMode(basemap), options });
    this.draw();
  }
  scheduleDraw() {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.draw(); });
  }
  retryFailedTiles() {
    for (const [key, img] of this.tiles) if (img.failed) this.tiles.delete(key);
    this.draw();
  }
  draw() {
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    if (!this.width || !this.height) return;
    this.center = [((this.center[0] % 1) + 1) % 1, Math.max(0, Math.min(1, this.center[1]))];
    const signature = JSON.stringify([this.center, this.zoom]);
    if (signature !== this.viewSignature) { this.viewSignature = signature; this.onViewChange?.({ center: [...this.center], zoom: this.zoom }); }
    const dpr = devicePixelRatio || 1;
    this.canvas.width = this.width * dpr; this.canvas.height = this.height * dpr;
    const c = this.ctx; c.scale(dpr, dpr);
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(name).trim();
    c.fillStyle = color("--map-bg"); c.fillRect(0, 0, this.width, this.height);
    const tiles = this.basemap !== "none" ? this.drawTiles() : { ready: 0, failed: 0, loading: 0 };
    this.onBasemapStatus({ mode: this.basemap, ...tiles });
    c.strokeStyle = color("--line"); c.lineWidth = 1;
    c.fillStyle = color("--muted"); c.font = "10px ui-monospace, monospace";
    // Grid stays geographically anchored while panning and zooming.
    const step = 2 ** Math.ceil(Math.log2(100 / this.scale));
    const left = this.center[0] - this.width / 2 / this.scale, top = this.center[1] - this.height / 2 / this.scale;
    // The coordinate grid fills in when imagery is absent.
    if (!tiles.ready) for (let x = Math.ceil(left / step) * step; x <= left + this.width / this.scale; x += step) {
      const px = (x - left) * this.scale;
      c.beginPath(); c.moveTo(px, 0); c.lineTo(px, this.height); c.stroke();
      c.fillText(`${unproject(x, .5)[0].toFixed(this.zoom > 10 ? 3 : 1)}°`, px + 5, 16);
    }
    if (!tiles.ready) for (let y = Math.ceil(top / step) * step; y <= top + this.height / this.scale; y += step) {
      if (y < 0 || y > 1) continue;
      const py = (y - top) * this.scale;
      c.beginPath(); c.moveTo(0, py); c.lineTo(this.width, py); c.stroke();
      c.fillText(`${unproject(.5, y)[1].toFixed(this.zoom > 10 ? 3 : 1)}°`, 8, py - 6);
    }
    if (this.trails) for (const p of this.points) {
      const trail = this.store?.trail(unitKey(p)) ?? [];
      c.strokeStyle = this.options?.color?.(p) || color("--trail"); c.lineWidth = unitKey(p) === this.selected ? 3 : 1.5;
      c.beginPath();
      let previous;
      for (const t of trail) {
        const [x, y] = this.screen(t);
        if (!previous || t.time - previous[2] > GAP_MS || Math.abs(x - previous[0]) > this.scale / 2) c.moveTo(x, y); else c.lineTo(x, y);
        previous = [x, y, t.time];
      }
      c.stroke();
    }
    const inView = this.points.filter((p) => { const [x, y] = this.screen(p); return x > -50 && y > -30 && x < this.width + 50 && y < this.height + 30; });
    const selected = inView.find((p) => unitKey(p) === this.selected);
    const others = inView.filter((p) => p !== selected);
    const groups = this.options?.cluster && this.zoom < 16 ? clusters(others, (p) => this.screen(p)) : others.map((p) => { const [x, y] = this.screen(p); return { x, y, points: [p] }; });
    if (selected) { const [x, y] = this.screen(selected); groups.push({ x, y, points: [selected] }); }
    this.hitTargets = groups;
    for (const group of groups) {
      const { x, y, points } = group, p = points[0], isSelected = unitKey(p) === this.selected;
      const markerColor = this.options?.color?.(p) || color("--accent");
      c.fillStyle = points.length > 1 ? color("--panel") : markerColor;
      c.strokeStyle = points.length > 1 ? color("--accent") : color("--panel"); c.lineWidth = isSelected ? 4 : 2;
      c.beginPath(); c.arc(x, y, points.length > 1 ? 18 : isSelected ? 9 : 6, 0, Math.PI * 2); c.fill(); c.stroke();
      if (points.length > 1) {
        c.fillStyle = color("--text"); c.font = '600 12px system-ui';
        const count = String(points.length); c.fillText(count, x - c.measureText(count).width / 2, y + 4);
        continue;
      }
      c.font = `${isSelected ? 600 : 400} 12px system-ui`;
      const duplicate = this.points.some((other) => other.unit === p.unit && other.system !== p.system);
      const primary = (this.options?.label ? this.options.label(p)?.trim() : p.name?.trim()) || String(p.unit);
      const label = duplicate ? `${primary} · ${p.system}` : primary, w = c.measureText(label).width;
      c.fillStyle = color("--panel"); c.fillRect(x + 12, y - 12, w + 12, 23);
      c.fillStyle = color("--text"); c.fillText(label, x + 18, y + 4);
    }
  }

  drawTiles() {
    const c = this.ctx, n = 2 ** this.zoom;
    const result = { ready: 0, failed: 0, loading: 0 };
    const left = this.center[0] * n - this.width / 512, top = this.center[1] * n - this.height / 512;
    for (let x = Math.floor(left); x < left + this.width / 256; x++) for (let y = Math.floor(top); y < top + this.height / 256; y++) {
      if (y < 0 || y >= n) continue;
      const key = tileUrl(this.basemap, this.zoom, x, y);
      if (!key) continue;
      if (!this.tiles.has(key)) {
        const img = new Image();
        this.tiles.set(key, img);
        // Normal browser caching honors HTTP cache headers. Never cache-bust,
        // send no-cache headers, or offer an area download mode.
        img.referrerPolicy = "strict-origin-when-cross-origin";
        img.onload = () => this.scheduleDraw();
        img.onerror = () => { img.failed = true; this.scheduleDraw(); };
        img.src = key;
        if (this.tiles.size > 256) this.tiles.delete(this.tiles.keys().next().value);
      }
      const img = this.tiles.get(key);
      if (img.complete && img.naturalWidth) {
        c.drawImage(img, (x - left) * 256, (y - top) * 256, 256, 256);
        result.ready++;
      } else if (img.failed) result.failed++;
      else result.loading++;
    }
    return result;
  }
}
