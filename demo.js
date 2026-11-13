// Deliberately separate from the recorder path. No real positions or unit identities.
export function seedDemo(store, now = Date.now()) {
  const radios = [
    ["metro-demo", 1201, "Patrol 12", "p25", 38.907, -77.037, 101],
    ["metro-demo", 1202, "Patrol 24", "p25_phase2", 38.914, -77.022, 101],
    ["metro-demo", 3108, "Engine 8", "p25", 38.899, -77.016, 203],
    ["county-demo", 1201, "Rescue 1", "future-gps", 38.921, -77.048, 420],
    ["county-demo", 8204, "Service 4", "future-gps", 38.889, -77.041, 510],
  ];
  radios.forEach(([system, unit, name, protocol, lat, lon, talkgroup], index) => {
    for (let i = 0; i < 12; i++) store.add({ system, unit, name, protocol, talkgroup,
      lat: lat + (i - 11) * .00035, lon: lon + Math.sin(i / 3 + index) * .0015,
      time: now - (11 - i) * 45000 - (index === 4 ? 900000 : index * 22000), origin: "demo" });
  });
}
