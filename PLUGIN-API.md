# GPS plugin API 1

This is the plugin's own read-only API, not an addition to TR Pro's native API.
It is available only while the plugin process runs. Its only external recorder
connection is the configured recorder origin, using `/api/ws` with `subscribe`
and `callsQuery` commands. No browser command is forwarded to that connection.

## Authentication

The private dashboard URL contains `#token=<64 hex characters>`. HTTP requests
use `Authorization: Bearer <token>`. WebSocket requests use subprotocols
`trp-gps` and `token.<token>`; only `trp-gps` is echoed in the handshake. Tokens
are persistent per plugin data folder, validated in constant time, and excluded
from request URLs, referrers and logs. Cross-origin browser WebSocket requests
are refused; HTTP APIs do not enable CORS. API writes are refused.

## HTTP

- `GET /api/gps/stats`: count, oldestMs/newestMs, retentionDays, maxPositions,
  and approximate SQLite/WAL file bytes.
- `GET /api/gps/positions?from=<ms>&to=<ms>&system=<shortName>&unit=<id>&limit=<1..500>&cursor=<next>`:
  `{positions: Fix[], next: string}`. From is inclusive, To exclusive. Cursor is
  opaque and valid only for the same filters. Times are Unix milliseconds;
  results are newest first, ordered by time and internal row ID.

Only visible UI assets are publicly served; no database files, tokens, recorder
credentials, key sources or recorder file paths are served. Position data needs
valid authorization. Shared dashboard links grant read access to all plugin GPS
history, not recorder control access.

## WebSocket `/api/ws`

The client shim is served at `/api/client.js`, exporting `TrunkClient` from
`plugin-client.js`. It implements the subset the bundled dashboard needs.

On connection: `state`, sanitized `config`, `history` (up to 300 positions),
`pluginStatus`, `hello`, `pluginStats`. `hello.capabilities` contains `calls`
and `gpsHistory`. The config contains only safe system names and protocol kinds.

Incoming commands:

- `subscribe`: accepted as a no-op; the collector owns source subscriptions.
- `callsQuery {id, from?, to?, system?, unit?, limit?, cursor?}`: returns
  `callsResult {id, entries: [], positions: Fix[], next?, error?}`.
- All other commands return a read-only error; Start/Stop/config changes are
  never forwarded to TR Pro.

Outgoing updates:

- `gpsFix {positions: Fix[]}`: committed new fixes (not browser receipt events).
- `pluginStatus {collector: {connected, recorderVersion, phase, nowS, config}}`.
- `pluginStats {stats: {...}}`: database counts and retention.
- `config`/`state`: safe source state updates.

A Fix contains `system`, `unit`, `lat`, `lon`, `time`, `protocol`, `name`,
`talkgroup`, `origin` (`live` or `recorded`), and `estimatedTime`. Query/history
results have `cached: true` to distinguish restored history from new live fixes.
No decoder-specific source or GPS accuracy is invented when unavailable.

Slow viewers are disconnected rather than allowed to consume unlimited memory;
reconnecting reloads committed server history. SQLite queues and browser queries
are bounded. The dashboard still provides browser-local caching for temporary
source interruptions, but the browser does not own ongoing collection.
