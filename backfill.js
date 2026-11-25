// One paginated request at a time. Cancellation ignores late responses safely.
export class CallSearch {
  constructor({ send, onPage = () => {}, onChange = () => {}, timeoutMs = 15000 }) {
    Object.assign(this, { send, onPage, onChange, timeoutMs });
    this.sequence = 1000000; this.generation = 0;
    this.state = { running: false, pages: 0, calls: 0, message: 'Not searched yet' };
  }
  update(patch) { Object.assign(this.state, patch); this.onChange(this.state); }
  cancel(message = 'Search cancelled; received positions are retained') {
    this.generation++;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(null); this.pending = null; }
    if (this.state.running) this.update({ running: false, message });
  }
  receive(m) {
    if (m.type !== 'callsResult' || m.id !== this.pending?.id) return false;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(m);
    return true;
  }
  request(query) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, timer: setTimeout(() => {
        this.pending = null; reject(new Error('Recorder did not answer. Reconnect or try searching again.'));
      }, this.timeoutMs) };
      try { this.send({ type: 'callsQuery', id, limit: 500, ...query }); }
      catch (e) { clearTimeout(this.pending.timer); this.pending = null; reject(e); }
    });
  }
  async start({ from, to, cursor, maxPages = 100, kind = 'range' } = {}) {
    this.cancel(); const generation = ++this.generation;
    this.update({ running: true, pages: 0, calls: 0, message: 'Searching recorded calls…', kind });
    const seen = new Set();
    try {
      do {
        const query = { ...(from != null ? { from } : {}), ...(to != null ? { to } : {}), ...(cursor ? { cursor } : {}) };
        const m = await this.request(query);
        if (!m || generation !== this.generation) return;
        if (m.error) throw new Error(m.error);
        this.onPage(m, kind);
        this.update({ pages: this.state.pages + 1, calls: this.state.calls + (m.positions?.length ?? m.entries?.length ?? 0) });
        cursor = m.next;
        if (cursor && seen.has(cursor)) throw new Error('Recorder repeated a history cursor. Narrow the date range and retry.');
        if (cursor) seen.add(cursor);
      } while (cursor && this.state.pages < maxPages);
      this.update({ running: false, message: cursor && kind !== 'older' ? 'Search limit reached. Narrow the date range to continue.' : 'Search complete' });
    } catch (e) {
      if (generation === this.generation) this.update({ running: false, message: e.message });
    }
  }
}
