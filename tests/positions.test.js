import test from "node:test";
import assert from "node:assert/strict";
import { PositionStore, normalize, unitKey } from "../positions.js";
import { PositionMap, project, unproject } from "../map.js";

const fix = (p = {}) => ({ system: "metro", unit: 12, lat: 38.9, lon: -77, time: 1700000000000, ...p });
test("coordinates are strict numbers, including valid zero coordinates", () => {
  assert.ok(normalize(fix({ lat: 0, lon: 0 })));
  for (const bad of [{ lat: null }, { lon: "-77" }, { lat: NaN }, { lon: Infinity }, { lat: 91 }, { lon: -181 }, { unit: 0 }, { system: "" }, { time: NaN }, { time: 1e20 }]) {
    assert.equal(normalize(fix(bad)), null);
  }
});
test("recorded calls accept unrecognized future protocols and isolate unit IDs per system", () => {
  const s = new PositionStore();
  s.ingest({ type: "history", entries: ["metro", "county"].map((system) => ({ record: {
    short_name: system, system_type: "future-radio", talkgroup: 3,
    srcList: [{ src: 12, time: 1700000000, lat: 0, lon: 12 }, { src: 13, time: 1700000000 }],
  } })) });
  assert.equal(s.latest().length, 2);
  assert.equal(s.latest()[0].protocol, "future-radio");
  assert.equal(s.latest()[0].time, 1700000000000);
  assert.equal(s.latest()[0].lat, 0);
});
test("live logs use system short names, correct engine time, and strict GPS matching", () => {
  const s = new PositionStore();
  s.ingest({ type: "log", lines: [
    { kind: "position", text: "Unit 12 at 38.90000, -77.00000 (TG 3)", system: "metro", timeS: 90 },
    { kind: "location", text: "Location registration 12", system: "metro", timeS: 91 },
  ] }, { rec: { status: { nowS: 100 }, config: { systems: [{ shortName: "metro", type: "future-radio" }] } }, receivedAt: 1700000010000 });
  assert.equal(s.latest().length, 1);
  assert.equal(s.latest()[0].time, 1700000000000);
  assert.equal(s.latest()[0].estimatedTime, true);
  assert.equal(s.latest()[0].protocol, "future-radio");
});
test("late history never moves a radio backward; copies are deduplicated and trails bounded", () => {
  const s = new PositionStore({ maxUnits: 2, maxPoints: 2 });
  s.add(fix({ time: 3000 })); s.add(fix({ time: 1000 })); s.add(fix({ time: 2000 }));
  assert.equal(s.add(fix({ time: 3000 })), false);
  assert.equal(s.latest()[0].time, 3000);
  assert.deepEqual(s.trail(unitKey(fix())).map((p) => p.time), [2000, 3000]);
  s.add(fix({ unit: 13, time: 4000 })); s.add(fix({ unit: 14, time: 5000 }));
  assert.deepEqual(s.latest().map((p) => p.unit), [14, 13]);
});
test("additional message adapters work without changing the model, including when another adapter fails", () => {
  const s = new PositionStore({ adapters: [
    { read() { throw new Error("broken extension"); } },
    { read(m) { return m.type === "new-gps" ? [fix({ protocol: m.protocol })] : []; } },
  ] });
  s.ingest({ type: "new-gps", protocol: "new-decoder" });
  assert.equal(s.latest()[0].protocol, "new-decoder");
  assert.equal(s.adapterErrors, 1);
});
test("GeoJSON exports only selected units, preserves provenance, and uses longitude first", () => {
  const s = new PositionStore(); s.add(fix()); s.add(fix({ system: "county" }));
  const data = JSON.parse(JSON.stringify(s.geoJSON([unitKey(fix())])));
  assert.equal(data.features.length, 1);
  assert.deepEqual(data.features[0].geometry.coordinates, [-77, 38.9]);
  assert.equal(data.features[0].properties.system, "metro");
  assert.equal(data.features[0].properties.time, "2023-11-14T22:13:20.000Z");
});
test("map projection round trips and clamps polar coordinates to finite map positions", () => {
  for (const [lon, lat] of [[0, 0], [-77.03, 38.9], [179.99, -40], [-179.99, 80]]) {
    const [a, b] = unproject(...project(lon, lat));
    assert.ok(Math.abs(a - lon) < 1e-8); assert.ok(Math.abs(b - lat) < 1e-8);
  }
  assert.ok(project(0, 90).every(Number.isFinite));
});
test("map fits radios across the date line without zooming out to the whole globe", () => {
  const view = { width: 900, height: 410, draw() {} };
  PositionMap.prototype.fit.call(view, [fix({ lon: 179.99 }), fix({ lon: -179.99 })]);
  assert.ok(view.center[0] < .001 || view.center[0] > .999);
  assert.ok(view.zoom >= 12);
});
