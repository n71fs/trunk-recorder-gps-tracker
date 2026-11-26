export function collectionSummary(connected, source) {
  if (!connected) return 'Dashboard disconnected · reconnecting automatically. Saved browser positions remain available.';
  if (!source?.connected) return 'Recorder disconnected · collection interrupted; retrying automatically. Saved history remains available.';
  if (source.phase !== 'running') return 'Recorder connected · idle. Waiting for TR Pro to start decoding.';
  if (!source.lastLiveMs) return 'Recorder connected · waiting for the first live GPS fix. No live GPS has arrived since collection started.';
  return 'Recorder connected · listening for decoded GPS. The latest location may be stale if a radio has not reported again.';
}
