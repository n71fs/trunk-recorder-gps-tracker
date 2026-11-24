const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.GPS_PREVIEW_URL || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE === 'bundled' ? undefined : (process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium'), headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const now = Date.now(); let socket, hold = false, held, noHistory = false, failTiles = false, supportsCalls = true;
    const entry = (unit, lat, time = now - 60000) => ({ path: `test-${unit}-${time}`, record: { short_name: 'city', system_type: 'dmr', talkgroup: 20, srcList: [{ src: unit, lat, lon: -77, time: time / 1000, tag: `Radio ${unit}` }] } });
    await page.route('https://tile.openstreetmap.org/**', (r) => failTiles ? r.abort() : r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#cbded0"/></svg>' }));
    await page.route('**/api/client.js', (r) => r.fulfill({ path: path.resolve(__dirname, 'fixtures/trunk-client.js'), contentType: 'text/javascript' }));
    await page.routeWebSocket('**/api/ws', (ws) => {
      socket = ws;
      ws.onMessage((text) => {
        const m = JSON.parse(text);
        if (m.type !== 'callsQuery') return;
        requests.push(m);
        if (hold) { held = m; return; }
        ws.send(JSON.stringify({ type: 'callsResult', id: m.id, entries: noHistory ? [] : m.cursor ? [entry(1, 38.005, now - 1800000)] : [entry(1, 38, now - 3600000)], ...(!m.cursor && !noHistory ? { next: 'range-2' } : {}) }));
      });
      for (const m of [
        { type: 'state', phase: 'running', error: null, ended: false },
        { type: 'config', version: 1, config: { systems: [{ shortName: 'city', type: 'dmr' }], conventional: [] } },
        { type: 'history', entries: noHistory ? [] : [entry(1, 38.01), entry(2, 38.015, now - 90000)] },
        { type: 'status', status: { nowS: 100 }, sources: [], calls: [] },
        { type: 'hello', version: 'v0.3.9-gps.1', capabilities: supportsCalls ? ['calls'] : [] },
      ]) ws.send(JSON.stringify(m));
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#backfill-status').textContent.includes('Search complete'));
    assert.equal(requests.length, 2); assert.ok(requests[0].from > now - 86500000); assert.equal(requests[1].from, requests[0].from);
    assert.equal(await page.locator('#count').textContent(), '2');
    await page.waitForFunction(() => document.querySelector('#storage-status').textContent.includes('4 saved positions'));
    await page.locator('#friendly-name').fill('Vehicle <1>'); await page.locator('#friendly-name').press('Tab');
    await page.locator('#radio-color').selectOption('#008b8b'); await page.locator('#favorite').click();
    await page.locator('#filter-panel').evaluate((e) => e.open = true);
    await page.locator('#favorites-only').check();
    await page.waitForFunction(() => document.querySelector('#shown').textContent === '1 / 2');
    assert.match(await page.locator('#details').textContent(), /Vehicle <1>/);
    assert.equal(await page.locator('#details img').count(), 0);
    await page.locator('#favorites-only').uncheck();
    const min = await page.locator('#timeline').getAttribute('min');
    await page.locator('#timeline').evaluate((e, value) => { e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); }, min);
    await page.waitForFunction(() => document.querySelector('#details').textContent.includes('38.00000'));
    assert.match(await page.locator('#playback-time').textContent(), /Replay/);
    await page.locator('#play').click();
    await page.waitForFunction((v) => Number(document.querySelector('#timeline').value) > Number(v), min);
    await page.locator('#live').click();
    await page.waitForFunction(() => document.querySelector('#details').textContent.includes('38.01000'));
    await page.locator('#range-from').fill('2099-01-01T00:00');
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('From time must be before'));
    assert.equal(await page.locator('#search-history').isDisabled(),true);
    await page.locator('#reset-filters').click();
    await page.locator('#follow').check();
    socket.send(JSON.stringify({ type: 'log', lines: [ { kind: 'position', system: 'city', timeS: 100, text: 'Unit 1 at 39.10000, -78.00000 (TG 20)' }, { kind: 'position', system: 'city', timeS: 100, text: 'Unsupported changed log format' }, { kind: 'position', system: 'city', timeS: 100, text: 'Unit 9 at 999.00000, -78.00000 (TG 20)' } ] }));
    await page.waitForFunction(() => document.querySelector('#details').textContent.includes('39.10000'));
    await page.waitForFunction(() => Math.abs(JSON.parse(localStorage.getItem('radio-positions-settings')).view.center[0] - 102 / 360) < .000001);
    await page.locator('#zoom-in').click(); assert.equal(await page.locator('#follow').isChecked(), false);
    await page.locator('#diagnostic-panel').evaluate((e) => e.open = true);
    assert.match(await page.locator('#diagnostic-content').textContent(), /Unreadable position logs1/);
    assert.match(await page.locator('#diagnostic-content').textContent(), /Invalid fixes rejected1/);
    await page.waitForFunction(() => document.querySelector('#storage-status').textContent.includes('5 saved positions'));
    // Cancel a range query. Late pages must not mutate the model.
    hold = true;
    await page.locator('#search-history').click();
    await page.waitForFunction(() => !document.querySelector('#cancel-backfill').disabled);
    await page.locator('#cancel-backfill').click();
    socket.send(JSON.stringify({ type: 'callsResult', id: held.id, entries: [entry(999, 45)] }));
    await page.waitForTimeout(100); assert.equal(await page.locator('#count').textContent(), '2');
    hold = false;
    // Persisted fixes survive an empty greeting and page reload; preferences survive too.
    await page.locator('#auto-backfill').uncheck(); noHistory = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#count').textContent === '2');
    assert.match(await page.locator('#details').textContent(), /39.10000/);
    assert.match(await page.locator('#details').textContent(), /Vehicle <1>/);
    assert.equal(await page.locator('#radio-color').inputValue(), '#008b8b');
    assert.equal(await page.locator('#favorite').getAttribute('aria-pressed'), 'true');
    const downloadEvent = page.waitForEvent('download'); await page.locator('#export-all').click();
    const download = await downloadEvent, exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(exported.features.length, 5); assert.ok(exported.features.some((f) => f.properties.origin === 'live'));
    // Real IndexedDB validates deduplication, chronological ordering, retention, caps and clear/write ordering.
    const dbResult = await page.evaluate(async () => {
      const { BrowserHistory } = await import('./history.js');
      const db = await new BrowserHistory('regression-history').open(); await db.clear();
      const p = (time) => ({ system: 'db-test', unit: 1, time, lat: 1, lon: 2 });
      await db.save([p(1000), p(2000), p(2000), p(3000), { ...p(3000), lat: 999 }], 0);
      const initial = await db.stats(); await db.prune(1500, 1); const kept = await db.load();
      const writing = db.save([p(4000)], 0), clearing = db.clear(); await Promise.all([writing, clearing]);
      const afterClear = await db.stats(); db.db.close();
      const capped = await new BrowserHistory('regression-cap', indexedDB, 3).open(); await capped.clear();
      await capped.save([p(1000), p(2000), p(3000), p(4000), p(5000)], 0);
      const cap = await capped.load(); capped.db.close(); return { initial, kept, afterClear, cap };
    });
    assert.equal(dbResult.initial.count, 3); assert.deepEqual(dbResult.kept.map((p) => p.time), [3000]); assert.equal(dbResult.afterClear.count, 0); assert.deepEqual(dbResult.cap.map(p => p.time), [3000, 4000, 5000]);
    // No fixed positions are fabricated between observations. Cluster click zooms into a group.
    const clusterResult = await page.evaluate(async () => {
      const { PositionMap, project } = await import('./map.js');
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:500px;height:300px;position:fixed;left:0;top:0'; document.body.append(canvas);
      const map = new PositionMap(canvas, () => {}); map.center = project(-77, 38); map.zoom = 5;
      map.update([{ system: 'a', unit: 1, lat: 38, lon: -77 }, { system: 'a', unit: 2, lat: 38.001, lon: -77.001 }], { trail: () => [] }, null, false, 'none', { cluster: true });
      const group = map.hitTargets[0], rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: rect.left + group.x, clientY: rect.top + group.y }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: rect.left + group.x, clientY: rect.top + group.y }));
      const result = { groupSize: group.points.length, zoom: map.zoom }; canvas.remove(); return result;
    });
    assert.equal(clusterResult.groupSize, 2); assert.ok(clusterResult.zoom > 5);
    await page.locator('#basemap').selectOption('none');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#filter-panel').evaluate((e) => e.open = false);
    await page.locator('#radio-panel').evaluate((e) => e.open = false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const mapBox = await page.locator('.map-panel').boundingBox(); assert.ok(mapBox.width > 300);
    // Retention is persisted; clearing only deletes browser history, never sends recorder control commands.
    await page.locator('#retention').selectOption('30');
    page.once('dialog', (d) => d.accept()); await page.locator('#clear-history').click();
    await page.waitForFunction(() => document.querySelector('#storage-status').textContent.includes('0 saved positions'));
    await page.reload(); await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
    assert.equal(await page.locator('#count').textContent(), '0'); assert.equal(await page.locator('#retention').inputValue(), '30');
    // A quota failure must not stop live display or claim the new fix was saved.
    await page.evaluate(async()=>{const {BrowserHistory}=await import('./history.js');BrowserHistory.prototype.save=async()=>{throw new DOMException('Quota exceeded','QuotaExceededError')};});
    socket.send(JSON.stringify({type:'log',lines:[{kind:'position',system:'city',timeS:100,text:'Unit 3 at 37.50000, -77.00000 (TG 20)'}]}));
    await page.waitForFunction(()=>document.querySelector('#storage-status').textContent.includes('Session only: Quota exceeded'));
    assert.equal(await page.locator('#count').textContent(),'1');
    supportsCalls=false; noHistory=false; await page.reload();
    await page.waitForFunction(()=>document.querySelector('#connection').textContent==='Connected');
    assert.equal(await page.locator('#count').textContent(),'2');
    assert.equal(await page.locator('#search-history').isDisabled(),true);
    assert.match(await page.locator('#backfill-status').textContent(),/call store unavailable/);
    assert.deepEqual(errors, []);
    await context.close();
    // A browser denying IndexedDB still runs as a session-only tracker.
    const blocked = await browser.newContext(); const blockedPage = await blocked.newPage();
    await blockedPage.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { return undefined; } }); localStorage.setItem('radio-positions-basemap', 'none'); });
    await blockedPage.goto(`${base}/?demo`); await blockedPage.waitForFunction(() => document.querySelector('#count').textContent === '5');
    assert.match(await blockedPage.locator('#storage-status').textContent(), /Session only/);
    await blocked.close();
    console.log('PASS: automatic paginated backfill, real IndexedDB retention/dedup/clear, reload persistence, export, favorites/name/color, playback, follow, cancellation/late replies, diagnostics, clustering, phone layout, and blocked-storage/quota fallback');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
