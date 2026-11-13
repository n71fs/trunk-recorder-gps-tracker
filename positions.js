// Protocol-independent model. Adapters return fixes; the store never knows a decoder.
export const unitKey = (p) => JSON.stringify([p.system, p.unit]);

export function normalize(p) {
  if (!p || typeof p.system !== "string" || !p.system.trim() ||
      !Number.isSafeInteger(p.unit) || p.unit <= 0 ||
      !Number.isFinite(p.lat) || Math.abs(p.lat) > 90 ||
      !Number.isFinite(p.lon) || Math.abs(p.lon) > 180 ||
      !Number.isFinite(p.time) || p.time <= 0 || p.time > 8640000000000000) return null;
  return { system: p.system, unit: p.unit, lat: p.lat, lon: p.lon, time: p.time,
    protocol: typeof p.protocol === "string" && p.protocol ? p.protocol : "unknown",
    name: typeof p.name === "string" ? p.name : "", talkgroup: p.talkgroup ?? null,
    origin: p.origin || "adapter", estimatedTime: !!p.estimatedTime };
}

export function protocolFor(system, rec) {
  const systems = [...(rec.config?.systems ?? []), ...(rec.config?.conventional ?? [])];
  return systems.find((s) => s.shortName === system)?.type || "unknown";
}

export const recordedPositions = {
  id: "recorded-calls",
  read(message) {
    const entries = message.type === "concluded" ? [message.entry] :
      ["history", "callsResult"].includes(message.type) ? message.entries ?? [] : [];
    return entries.flatMap(({ record: r }) => (r?.srcList ?? []).map((s) => ({
      system: r.short_name, unit: s.src, lat: s.lat, lon: s.lon,
      // A record retains the source's transmission time, not a GPS timestamp.
      time: s.time * 1000, protocol: r.voice_mode || r.system_type || "unknown",
      name: s.tag || s.tag_ota || "", talkgroup: r.talkgroup, origin: "recorded", estimatedTime: true,
    })));
  },
};

export const livePositions = {
  id: "position-log",
  read(message, { rec, receivedAt = Date.now() }) {
    if (message.type !== "log") return [];
    return (message.lines ?? []).flatMap((line) => {
      if (line.kind !== "position" || !line.system) return [];
      const match = /^Unit (\d+) at (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?) \(TG (\d+)\)$/.exec(line.text);
      if (!match) return [];
      // Decoder logs use engine seconds. Estimate wall time against current status.
      const age = Number.isFinite(rec.status?.nowS) && Number.isFinite(line.timeS)
        ? Math.max(0, rec.status.nowS - line.timeS) * 1000 : 0;
      return [{ system: line.system, unit: Number(match[1]), lat: Number(match[2]),
        lon: Number(match[3]), talkgroup: Number(match[4]),
        time: Number.isFinite(line.time) ? line.time * 1000 : receivedAt - age,
        protocol: protocolFor(line.system, rec), origin: "live", estimatedTime: !Number.isFinite(line.time) }];
    });
  },
};

export class PositionStore {
  constructor({ maxUnits = 1000, maxPoints = 200, adapters = [recordedPositions, livePositions] } = {}) {
    this.units = new Map();
    this.maxUnits = maxUnits;
    this.maxPoints = maxPoints;
    this.adapters = [...adapters];
    this.rejected = 0;
    this.adapterErrors = 0;
  }
  ingest(message, context = {}) {
    let changed = false;
    for (const adapter of this.adapters) {
      try {
        for (const fix of adapter.read(message, context) ?? []) changed = this.add(fix) || changed;
      } catch { this.adapterErrors++; }
    }
    return changed;
  }
  add(raw) {
    const p = normalize(raw);
    if (!p) { this.rejected++; return false; }
    const key = unitKey(p);
    const points = this.units.get(key) ?? [];
    // Multi-site copies and greeting history may repeat the same observation.
    if (points.some((v) => v.time === p.time && v.lat === p.lat && v.lon === p.lon)) return false;
    points.push(p);
    points.sort((a, b) => a.time - b.time);
    if (points.length > this.maxPoints) points.splice(0, points.length - this.maxPoints);
    this.units.set(key, points);
    if (this.units.size > this.maxUnits) {
      const oldest = [...this.units].reduce((a, b) => a[1].at(-1).time <= b[1].at(-1).time ? a : b);
      this.units.delete(oldest[0]);
    }
    return true;
  }
  latest() { return [...this.units.values()].map((points) => points.at(-1)).sort((a, b) => b.time - a.time); }
  trail(key) { return this.units.get(key) ?? []; }
  geoJSON(keys) {
    return { type: "FeatureCollection", features: [...keys].flatMap((key) => this.trail(key).map((p) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { ...p, lat: undefined, lon: undefined, time: new Date(p.time).toISOString() },
    }))) };
  }
}
