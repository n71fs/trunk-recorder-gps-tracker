package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"github.com/coder/websocket"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

//go:embed *.html *.css *.js
var dashboard embed.FS

type hub struct {
	mu      sync.Mutex
	clients map[chan []byte]bool
}

func newHub() *hub { return &hub{clients: map[chan []byte]bool{}} }
func (h *hub) subscribe() chan []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := make(chan []byte, 128)
	h.clients[c] = true
	return c
}
func (h *hub) remove(c chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[c] {
		delete(h.clients, c)
		close(c)
	}
}
func (h *hub) publish(m any) {
	b, e := json.Marshal(m)
	if e != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c <- b:
		default:
			delete(h.clients, c)
			close(c)
		}
	}
}
func (a *application) publishState() {
	s := a.state.snapshot()
	a.hub.publish(map[string]any{"type": "pluginStatus", "collector": s})
	a.hub.publish(map[string]any{"type": "config", "config": s["config"]})
	a.hub.publish(map[string]any{"type": "state", "phase": s["phase"], "error": nil, "ended": false})
}
func (a *application) publishStats() {
	if s, e := a.store.stats(); e == nil {
		a.hub.publish(map[string]any{"type": "pluginStats", "stats": s})
	}
}
func (a *application) authorized(r *http.Request) bool {
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return len(provided) == len(a.token) && subtle.ConstantTimeCompare([]byte(provided), []byte(a.token)) == 1
}
func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/client.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Write([]byte(`export {PluginClient as TrunkClient} from "/plugin-client.js";`))
	})
	mux.HandleFunc("/api/ws", a.socket)
	mux.HandleFunc("/api/gps/stats", func(w http.ResponseWriter, r *http.Request) {
		if !a.authorized(r) {
			http.Error(w, "Private dashboard link required", 401)
			return
		}
		s, e := a.store.stats()
		if e != nil {
			http.Error(w, "History database unavailable", 503)
			return
		}
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/gps/positions", func(w http.ResponseWriter, r *http.Request) {
		if !a.authorized(r) {
			http.Error(w, "Private dashboard link required", 401)
			return
		}
		q := Query{System: r.URL.Query().Get("system"), Cursor: r.URL.Query().Get("cursor")}
		var e error
		for key, target := range map[string]*int64{"from": &q.From, "to": &q.To} {
			*target, e = intQuery(r.URL.Query().Get(key))
			if e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
		}
		limit, e := intQuery(r.URL.Query().Get("limit"))
		if e != nil || limit > 500 {
			http.Error(w, "Invalid limit", 400)
			return
		}
		q.Limit = int(limit)
		unit, e := intQuery(r.URL.Query().Get("unit"))
		if e != nil || unit > 4294967295 {
			http.Error(w, "Invalid unit", 400)
			return
		}
		q.Unit = uint32(unit)
		positions, next, e := a.store.query(r.Context(), q)
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		writeJSON(w, map[string]any{"positions": positions, "next": next})
	})
	files, _ := fs.Sub(dashboard, ".")
	fileServer := http.FileServer(http.FS(files))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Read-only GPS dashboard", 405)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func (a *application) socket(w http.ResponseWriter, r *http.Request) {
	token := ""
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		p = strings.TrimSpace(p)
		if strings.HasPrefix(p, "token.") {
			token = strings.TrimPrefix(p, "token.")
		}
	}
	if len(token) != len(a.token) || subtle.ConstantTimeCompare([]byte(token), []byte(a.token)) != 1 {
		http.Error(w, "Private dashboard link required", 401)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil || !strings.EqualFold(u.Host, r.Host) || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "Dashboard origin required", 403)
			return
		}
	}
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"trp-gps"}})
	if e != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	messages := a.hub.subscribe()
	defer a.hub.remove(messages)
	var mu sync.Mutex
	send := func(m any) error {
		b, e := json.Marshal(m)
		if e != nil {
			return e
		}
		mu.Lock()
		defer mu.Unlock()
		c, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		return conn.Write(c, websocket.MessageText, b)
	}
	state := a.state.snapshot()
	positions, next, e := a.store.query(ctx, Query{Limit: 300})
	if e != nil {
		return
	}
	initial := []any{map[string]any{"type": "state", "phase": state["phase"], "error": nil, "ended": false}, map[string]any{"type": "config", "config": state["config"]}, map[string]any{"type": "history", "entries": []any{}, "positions": positions, "next": next}, map[string]any{"type": "pluginStatus", "collector": state}, map[string]any{"type": "hello", "version": "GPS history " + version, "api": 1, "capabilities": []string{"calls", "gpsHistory"}}}
	if stats, err := a.store.stats(); err == nil {
		initial = append(initial, map[string]any{"type": "pluginStats", "stats": stats})
	}
	for _, m := range initial {
		if send(m) != nil {
			return
		}
	}
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case b, ok := <-messages:
				if !ok {
					return
				}
				mu.Lock()
				c, stop := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(c, websocket.MessageText, b)
				stop()
				mu.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()
	for {
		_, b, e := conn.Read(ctx)
		if e != nil {
			return
		}
		var m struct {
			Type string `json:"type"`
			Query
		}
		if json.Unmarshal(b, &m) != nil {
			send(map[string]any{"type": "error", "message": "Invalid GPS query"})
			continue
		}
		switch m.Type {
		case "subscribe": // The collector, not the browser, owns recorder subscriptions.
		case "callsQuery":
			fixes, next, err := a.store.query(ctx, m.Query)
			result := map[string]any{"type": "callsResult", "id": m.ID, "entries": []any{}, "positions": fixes}
			if next != "" {
				result["next"] = next
			}
			if err != nil {
				result["error"] = err.Error()
			}
			if send(result) != nil {
				return
			}
		default:
			if send(map[string]any{"type": "error", "message": "GPS history API is read-only"}) != nil {
				return
			}
		}
	}
}
