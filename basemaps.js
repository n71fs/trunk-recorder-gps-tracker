// Only request tiles inside the current viewport. Never prefetch areas.
export const BASEMAPS = {
  osm: {
    name: "OpenStreetMap",
    template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    copyright: "https://www.openstreetmap.org/copyright",
  },
  local: { name: "Local tiles", template: "./tiles/{z}/{x}/{y}.png" },
  none: { name: "Offline grid" },
};
export const basemapMode = (mode) => Object.hasOwn(BASEMAPS, mode) ? mode : "osm";
export function tileUrl(mode, z, x, y) {
  const template = BASEMAPS[mode]?.template;
  if (!template || ![z, x, y].every(Number.isInteger) || z < 0 || z > 18 || y < 0 || y >= 2 ** z) return null;
  const wrappedX = ((x % 2 ** z) + 2 ** z) % 2 ** z;
  return template.replace("{z}", z).replace("{x}", wrappedX).replace("{y}", y);
}
export function readBasemapPreference(storage) {
  try { return basemapMode(storage.getItem("radio-positions-basemap")); } catch { return "osm"; }
}
export function saveBasemapPreference(storage, mode) {
  try { storage.setItem("radio-positions-basemap", basemapMode(mode)); } catch { /* Optional convenience. */ }
}
