import { normalize } from './positions.js';
export const HISTORY_LIMIT = 100000;
export const fixId = (p) => JSON.stringify([p.system, p.unit, p.time, p.lat, p.lon]);
const completed = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error || new Error('Browser history transaction failed'));
});

// All writes are serialized; clearing cannot race an older queued save.
export class BrowserHistory {
  constructor(name = 'radio-positions-v1', factory = globalThis.indexedDB, maxRecords = HISTORY_LIMIT) {
    this.name = name; this.factory = factory; this.db = null; this.tail = Promise.resolve(); this.maxRecords = maxRecords;
  }
  async open() {
    if (!this.factory) throw new Error('Browser storage unavailable; positions are kept for this session only.');
    this.db = await new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('Browser history is blocked by another tab. Close other tracker tabs and reload.')); }, 4000);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('fixes', { keyPath: 'id' });
        store.createIndex('time', 'time');
      };
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
    this.db.onversionchange = () => this.db.close();
    return this;
  }
  serial(fn) { const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next; }
  save(fixes, cutoff) {
    return this.serial(async () => {
      const tx = this.db.transaction('fixes', 'readwrite'), done = completed(tx), store = tx.objectStore('fixes');
      for (const raw of fixes) {
        const p = normalize(raw);
        if (p && p.time >= cutoff) { delete p.cached; store.put({ ...p, id: fixId(p) }); }
      }
      store.count().onsuccess = (e) => {
        let excess = e.target.result - this.maxRecords;
        if (excess <= 0) return;
        store.index('time').openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor || excess <= 0) return;
          cursor.delete(); excess--; cursor.continue();
        };
      };
      await done;
    });
  }
  prune(cutoff, max = this.maxRecords) {
    return this.serial(async () => {
      const tx = this.db.transaction('fixes', 'readwrite'), done = completed(tx), store = tx.objectStore('fixes');
      let kept = 0;
      store.index('time').openCursor(null, 'prev').onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (cursor.value.time < cutoff || kept >= max) cursor.delete(); else kept++;
        cursor.continue();
      };
      await done;
    });
  }
  async load() {
    await this.tail;
    const tx = this.db.transaction('fixes', 'readonly'), done = completed(tx), values = [];
    tx.objectStore('fixes').index('time').openCursor(null, 'prev').onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || values.length >= this.maxRecords) return;
      const p = normalize(cursor.value);
      if (p) values.push({ ...p, cached: true });
      cursor.continue();
    };
    await done;
    return values.reverse();
  }
  async stats() {
    await this.tail;
    const tx = this.db.transaction('fixes', 'readonly'), done = completed(tx);
    let count = 0, bytes = 0, sampled = 0;
    tx.objectStore('fixes').count().onsuccess = (e) => { count = e.target.result; };
    tx.objectStore('fixes').openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || sampled >= 100) return;
      sampled++; bytes += new TextEncoder().encode(JSON.stringify(cursor.value)).length;
      cursor.continue();
    };
    await done;
    return { count, bytes: sampled ? Math.round(bytes / sampled * count) : 0 };
  }
  clear() {
    return this.serial(async () => {
      const tx = this.db.transaction('fixes', 'readwrite'), done = completed(tx);
      tx.objectStore('fixes').clear(); await done;
    });
  }
}
