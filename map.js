import { unitKey } from "./positions.js";

export function project(lon, lat) {
  const a = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + a / 2)) / Math.PI) / 2];
}
export function unproject(x, y) {
  return [((x * 360) % 360 + 360) % 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}
const wrap = (x) => x - Math.round(x);

export class PositionMap {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.center = [.5, .5];
    this.zoom = 2;
    this.points = [];
    this.tiles = new Map();
    this.onSelect = onSelect;
    new ResizeObserver(() => this.draw()).observe(canvas);
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => this.draw());
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.zoomBy(e.deltaY > 0 ? -1 : 1); }, { passive: false });
    canvas.addEventListener("keydown", (e) => {
      if (["+", "=", "-", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
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
      this.center = [this.drag.center[0] - dx / this.scale, this.drag.center[1] - dy / this.scale];
      this.draw();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (this.drag && !this.drag.moved) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const near = this.points.map((p) => ({ p, d: Math.hypot(...this.screen(p).map((v, i) => v - [x, y][i])) })).sort((a, b) => a.d - b.d)[0];
        if (near?.d < 24) onSelect(unitKey(near.p));
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
  zoomBy(delta) { this.zoom = Math.min(18, Math.max(1, this.zoom + delta)); this.draw(); }
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
  update(points, store, selected, trails, localTiles) {
    Object.assign(this, { points, store, selected, trails, localTiles });
    this.draw();
  }
  draw() {
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    if (!this.width || !this.height) return;
    this.center = [((this.center[0] % 1) + 1) % 1, Math.max(0, Math.min(1, this.center[1]))];
    const dpr = devicePixelRatio || 1;
    this.canvas.width = this.width * dpr; this.canvas.height = this.height * dpr;
    const c = this.ctx; c.scale(dpr, dpr);
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(name).trim();
    c.fillStyle = color("--map-bg"); c.fillRect(0, 0, this.width, this.height);
    if (this.localTiles) this.drawTiles();
    c.strokeStyle = color("--line"); c.lineWidth = 1;
    c.fillStyle = color("--muted"); c.font = "10px ui-monospace, monospace";
    // Grid stays geographically anchored while panning and zooming.
    const step = 2 ** Math.ceil(Math.log2(100 / this.scale));
    const left = this.center[0] - this.width / 2 / this.scale, top = this.center[1] - this.height / 2 / this.scale;
    for (let x = Math.ceil(left / step) * step; x <= left + this.width / this.scale; x += step) {
      const px = (x - left) * this.scale;
      c.beginPath(); c.moveTo(px, 0); c.lineTo(px, this.height); c.stroke();
      c.fillText(`${unproject(x, .5)[0].toFixed(this.zoom > 10 ? 3 : 1)}°`, px + 5, 16);
    }
    for (let y = Math.ceil(top / step) * step; y <= top + this.height / this.scale; y += step) {
      if (y < 0 || y > 1) continue;
      const py = (y - top) * this.scale;
      c.beginPath(); c.moveTo(0, py); c.lineTo(this.width, py); c.stroke();
      c.fillText(`${unproject(.5, y)[1].toFixed(this.zoom > 10 ? 3 : 1)}°`, 8, py - 6);
    }
    if (this.trails) for (const p of this.points) {
      const trail = this.store?.trail(unitKey(p)) ?? [];
      c.strokeStyle = color(unitKey(p) === this.selected ? "--accent" : "--trail"); c.lineWidth = 2;
      c.beginPath();
      let previous;
      for (const t of trail) {
        const [x, y] = this.screen(t);
        if (!previous || Math.abs(x - previous[0]) > this.scale / 2) c.moveTo(x, y); else c.lineTo(x, y);
        previous = [x, y];
      }
      c.stroke();
    }
    for (const p of [...this.points].sort((a, b) => Number(unitKey(a) === this.selected) - Number(unitKey(b) === this.selected))) {
      const [x, y] = this.screen(p);
      if (x < -50 || y < -30 || x > this.width + 50 || y > this.height + 30) continue;
      const selected = unitKey(p) === this.selected;
      c.fillStyle = color(selected ? "--accent" : "--text");
      c.strokeStyle = color("--map-bg"); c.lineWidth = 3;
      c.beginPath(); c.arc(x, y, selected ? 8 : 5, 0, Math.PI * 2); c.fill(); c.stroke();
      c.font = `${selected ? 600 : 400} 12px system-ui`;
      const duplicate = this.points.some((other) => other.unit === p.unit && other.system !== p.system);
      const label = duplicate ? `${p.system} · ${p.unit}` : `${p.unit}`, w = c.measureText(label).width;
      c.fillStyle = color("--panel"); c.fillRect(x + 11, y - 12, w + 12, 23);
      c.fillStyle = color(selected ? "--accent" : "--text"); c.fillText(label, x + 17, y + 4);
    }
  }
  drawTiles() {
    const c = this.ctx, n = 2 ** this.zoom;
    const left = this.center[0] * n - this.width / 512, top = this.center[1] * n - this.height / 512;
    for (let x = Math.floor(left); x < left + this.width / 256; x++) for (let y = Math.floor(top); y < top + this.height / 256; y++) {
      if (y < 0 || y >= n) continue;
      const key = `${this.zoom}/${((x % n) + n) % n}/${y}`;
      if (!this.tiles.has(key)) {
        const img = new Image();
        this.tiles.set(key, img);
        img.onload = () => { if (this.localTiles) this.draw(); };
        img.src = `./tiles/${key}.png`;
        if (this.tiles.size > 256) this.tiles.delete(this.tiles.keys().next().value);
      }
      const img = this.tiles.get(key);
      if (img.complete && img.naturalWidth) c.drawImage(img, (x - left) * 256, (y - top) * 256, 256, 256);
    }
  }
}
