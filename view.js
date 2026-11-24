import { unitKey } from './positions.js';
export const GAP_MS = 5 * 60 * 1000;
export const COLORS = ['#1689df', '#8055df', '#008b8b', '#b3479e', '#4774b9', '#9864b6'];
export function radioColor(p, settings = {}) {
  const custom = settings[unitKey(p)]?.color;
  if (/^#[\da-f]{6}$/i.test(custom || '')) return custom;
  let hash = 0;
  for (const c of unitKey(p)) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return COLORS[(hash >>> 0) % COLORS.length];
}
export function observations(store, { from = 0, to = Infinity, at = Infinity } = {}) {
  const trails = new Map(), latest = [];
  for (const [key, points] of store.units) {
    const trail = points.filter((p) => p.time >= from && p.time <= to && p.time <= at);
    if (trail.length) { trails.set(key, trail); latest.push(trail.at(-1)); }
  }
  latest.sort((a, b) => b.time - a.time);
  return { trails, latest };
}
export function clusters(points, screen, radius = 36) {
  const groups = [];
  for (const p of points) {
    const [x, y] = screen(p);
    const group = groups.find((g) => Math.hypot(g.x - x, g.y - y) < radius);
    if (group) {
      group.points.push(p); const n = group.points.length;
      group.x += (x - group.x) / n; group.y += (y - group.y) / n;
    } else groups.push({ x, y, points: [p] });
  }
  return groups;
}
export function readSettings(storage) {
  try { const p = JSON.parse(storage.getItem('radio-positions-settings') || '{}'); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; }
  catch { return {}; }
}
export function writeSettings(storage, value) {
  try { storage.setItem('radio-positions-settings', JSON.stringify(value)); } catch { /* Page still works without preferences. */ }
}
