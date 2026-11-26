import { currentRadioName, hasCurrentRadioName } from './radio-names.js';
// Read-only client for the GPS plugin's own API, not a proxy for recorder controls.
export class PluginClient {
  constructor() {
    Object.assign(this, { connected: false, version: null, capabilities: [], config: null,
      phase: { phase: 'idle' }, status: null, history: [], calls: [], collector: null, pluginStats: null });
    this.handlers = new Map(); this.closed = false; this.retry = 500;
    this.token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (!this.token) {
      queueMicrotask(() => this.emit('message', { type: 'error', message: 'Open GPS dashboard from the TR Pro plugin’s settings to authorize this browser.' }));
      return;
    }
    this.connect();
  }
  on(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); return () => this.handlers.get(type)?.delete(fn); }
  emit(type, value) { for (const fn of this.handlers.get(type) || []) { try { fn(value); } catch (e) { console.error(e); } } }
  connect() {
    if (this.closed) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    const ws = this.ws = new WebSocket(url, ['trp-gps', `token.${this.token}`]);
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (m.type === 'hello') { this.version = m.version; this.capabilities = m.capabilities || []; this.connected = true; this.retry = 500; this.emit('connection', true); }
      if (m.type === 'config') this.config = m.config;
      if (m.type === 'state') this.phase = { phase: m.phase, error: m.error, ended: m.ended };
      if (m.type === 'pluginStatus') { this.collector = m.collector; this.status = { nowS: m.collector.nowS }; }
      if (m.type === 'radioNames') this.radioNames = m;
      if (m.type === 'pluginInfo') this.info = m;
      if (m.type === 'pluginStats') this.pluginStats = m.stats;
      this.emit(m.type, m); this.emit('message', m); this.emit('change', this);
    };
    ws.onclose = () => {
      this.connected = false; this.emit('connection', false); this.emit('change', this);
      if (!this.closed) { setTimeout(() => this.connect(), this.retry); this.retry = Math.min(15000, this.retry * 2); }
    };
    ws.onerror = () => {};
  }
  send(message) {
    if (!['subscribe', 'callsQuery'].includes(message.type)) throw new Error('GPS plugin access is read-only');
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('GPS plugin disconnected');
    this.ws.send(JSON.stringify(message));
  }
  subscribe(topics) { this.send({ type: 'subscribe', topics }); }
  unitName(system, unit) { return currentRadioName(this.radioNames, system, unit); }
  hasUnitNames(system, unit) { return hasCurrentRadioName(this.radioNames, system, unit); }
  close() { this.closed = true; this.ws?.close(); }
}
