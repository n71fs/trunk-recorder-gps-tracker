import test from "node:test";
import assert from "node:assert/strict";
import { BASEMAPS, basemapMode, tileUrl, readBasemapPreference, saveBasemapPreference } from "../basemaps.js";
import { PositionMap } from "../map.js";

test("OSM is the default, with official HTTPS URL and attribution", () => {
  assert.equal(basemapMode(null), "osm");
  assert.equal(basemapMode("__proto__"), "osm");
  assert.equal(basemapMode("none"), "none");
  assert.equal(tileUrl("osm", 3, 2, 4), "https://tile.openstreetmap.org/3/2/4.png");
  assert.equal(BASEMAPS.osm.copyright, "https://www.openstreetmap.org/copyright");
});
test("tile addressing wraps longitude, clips latitude and never requests tiles for the offline grid", () => {
  assert.equal(tileUrl("osm", 3, -1, 0), "https://tile.openstreetmap.org/3/7/0.png");
  assert.equal(tileUrl("local", 3, 8, 1), "./tiles/3/0/1.png");
  assert.equal(tileUrl("none", 3, 0, 1), null);
  for (const coords of [[3, 0, -1], [3, 0, 8], [19, 0, 1], [3, 1.5, 1]]) {
    assert.equal(tileUrl("osm", ...coords), null);
  }
});
test("basemap preference survives reload and blocked storage remains optional", () => {
  let value;
  const storage = { getItem: () => value, setItem: (_, v) => { value = v; } };
  assert.equal(readBasemapPreference(storage), "osm");
  saveBasemapPreference(storage, "none");
  assert.equal(readBasemapPreference(storage), "none");
  assert.equal(readBasemapPreference(undefined), "osm");
  assert.doesNotThrow(() => saveBasemapPreference(undefined, "local"));
});
test("tile drawing reuses cache and isolates sources; failed tiles retry only on request", () => {
  const previousImage = globalThis.Image;
  const created = [];
  globalThis.Image = class {
    constructor() { this.complete = false; this.naturalWidth = 0; created.push(this); }
  };
  try {
    const view = { zoom: 3, width: 300, height: 250, center: [.5, .5],
      basemap: "osm", tiles: new Map(), ctx: { drawImage() {} }, scheduleDraw() {}, draw() {} };
    let result = PositionMap.prototype.drawTiles.call(view);
    const count = created.length;
    assert.ok(count > 0 && count <= 4);
    assert.equal(result.loading, count);
    assert.ok(created.every((img) => img.referrerPolicy === "strict-origin-when-cross-origin"));
    PositionMap.prototype.drawTiles.call(view);
    assert.equal(created.length, count);
    created.forEach((img) => img.onerror());
    result = PositionMap.prototype.drawTiles.call(view);
    assert.equal(result.failed, count);
    assert.equal(created.length, count);
    PositionMap.prototype.retryFailedTiles.call(view);
    PositionMap.prototype.drawTiles.call(view);
    assert.equal(created.length, count * 2);
    view.basemap = "local";
    PositionMap.prototype.drawTiles.call(view);
    assert.ok(created.at(-1).src.startsWith("./tiles/"));
  } finally { globalThis.Image = previousImage; }
});
