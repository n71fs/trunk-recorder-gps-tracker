import test from 'node:test';
import assert from 'node:assert/strict';
import { CallSearch } from '../backfill.js';
import { PositionStore, unitKey } from '../positions.js';
import { observations, clusters, radioColor, GAP_MS } from '../view.js';
import { fixId, BrowserHistory } from '../history.js';
const fix = (time, unit = 1, system = 'city') => ({ system, unit, time, lat: 38, lon: -77 });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('backfill follows pages with a stable date range and reports progress', async () => {
  const sent = [], pages = [];
  const search = new CallSearch({ send: (m) => sent.push(m), onPage: (m) => pages.push(m) });
  const done = search.start({ from: 1000, to: 5000 });
  assert.equal(sent[0].from, 1000); assert.equal(sent[0].to, 5000);
  search.receive({ type: 'callsResult', id: sent[0].id, entries: [{ record: {} }], next: 'next' });
  await tick();
  assert.equal(sent[1].cursor, 'next'); assert.equal(sent[1].from, 1000);
  search.receive({ type: 'callsResult', id: sent[1].id, entries: [] });
  await done;
  assert.equal(search.state.calls, 1); assert.equal(search.state.pages, 2);
  assert.equal(pages.length, 2); assert.equal(search.state.running, false);
});
test('cancelled searches ignore late replies, and a new search is isolated', async () => {
  const sent = [], pages = [];
  const search = new CallSearch({ send: (m) => sent.push(m), onPage: (m) => pages.push(m) });
  const first = search.start(); search.cancel(); await first;
  const second = search.start();
  assert.equal(search.receive({ type: 'callsResult', id: sent[0].id, entries: [1] }), false);
  assert.equal(pages.length, 0);
  search.receive({ type: 'callsResult', id: sent[1].id, entries: [] }); await second;
  assert.equal(pages.length, 1);
});
test('backfill errors, timeout and repeated cursors stop instead of looping', async () => {
  let request;
  const search = new CallSearch({ send: (m) => { request = m; }, timeoutMs: 10 });
  let done = search.start(); search.receive({ type: 'callsResult', id: request.id, error: 'Store unavailable' }); await done;
  assert.match(search.state.message, /Store unavailable/);
  await search.start(); assert.match(search.state.message, /did not answer/);
  done = search.start(); search.receive({ type: 'callsResult', id: request.id, entries: [], next: 'same' }); await tick();
  search.receive({ type: 'callsResult', id: request.id, entries: [], next: 'same' }); await done;
  assert.match(search.state.message, /repeated/);
});
test('playback shows only actual observations before the playhead and honors date range', () => {
  const store = new PositionStore();
  store.add(fix(1000)); store.add(fix(2000)); store.add(fix(3000)); store.add(fix(2500, 2));
  let view = observations(store, { from: 1500, to: 3000, at: 2400 });
  assert.equal(view.latest.length, 1); assert.equal(view.latest[0].time, 2000);
  assert.deepEqual(view.trails.get(unitKey(fix(1000))).map((p) => p.time), [2000]);
  view = observations(store, { from: 1500, to: 3000, at: 900 }); assert.equal(view.latest.length, 0);
  assert.equal(GAP_MS, 300000);
});
test('clustering keeps close markers together and colors are stable across systems', () => {
  const points = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 200, y: 100 }];
  const groups = clusters(points, (p) => [p.x, p.y]);
  assert.deepEqual(groups.map((g) => g.points.length), [2, 1]);
  assert.equal(radioColor(fix(1)), radioColor(fix(999)));
  const settings = { [unitKey(fix(1))]: { color: '#008b8b' } };
  assert.equal(radioColor(fix(1), settings), '#008b8b');
  assert.notEqual(fixId(fix(1)), fixId(fix(1, 1, 'other')));
});
test('total memory and retention are bounded without losing latest positions', () => {
  const store = new PositionStore({ maxTotal: 3, maxPoints: 100 });
  for (const t of [1000, 2000, 3000, 4000]) store.add(fix(t));
  assert.equal(store.total, 3); assert.equal(store.latest()[0].time, 4000);
  store.prune(3500); assert.equal(store.total, 1);
  store.clear(); assert.equal(store.total, 0); assert.equal(store.units.size, 0);
});
test('normal calls without GPS do not count as rejected coordinates', () => {
  const store = new PositionStore();
  store.ingest({ type: 'history', entries: [{ record: { short_name: 'city', srcList: [{ src: 1, time: 1 }] } }] });
  assert.equal(store.rejected, 0);
  store.ingest({ type: 'history', entries: [{ record: { short_name: 'city', srcList: [{ src: 1, time: 1, lat: 1000, lon: 5 }] } }] });
  assert.equal(store.rejected, 1);
});
test('unavailable browser persistence reports a recoverable storage error', async () => {
  await assert.rejects(new BrowserHistory('test', null).open(), /session only/);
});
