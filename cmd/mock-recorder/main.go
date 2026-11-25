// Local integration-test recorder. It is not included in plugin archives.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

func main() {
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		panic(e)
	}
	var mu sync.Mutex
	clients := map[*websocket.Conn]bool{}
	ctx := context.Background()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ws", func(w http.ResponseWriter, r *http.Request) {
		c, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer c.CloseNow()
		for _, m := range []string{`{"type":"config","config":{"systems":[{"shortName":"city","type":"dmr"}],"server":{"bind":"127.0.0.1"},"plugins":{"secret":"do-not-leak"}}}`, `{"type":"state","phase":"running"}`, `{"type":"unitAlias","system":"city","unit":42,"alias":"Rescue 42"}`, `{"type":"hello","version":"v0.3.9-gps.1"}`} {
			if c.Write(ctx, websocket.MessageText, []byte(m)) != nil {
				return
			}
		}
		for {
			_, b, e := c.Read(ctx)
			if e != nil {
				break
			}
			var m struct {
				Type string `json:"type"`
			}
			json.Unmarshal(b, &m)
			if m.Type == "subscribe" {
				mu.Lock()
				clients[c] = true
				mu.Unlock()
			}
		}
		mu.Lock()
		delete(clients, c)
		mu.Unlock()
	})
	mux.HandleFunc("/test/position", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Lat  float64 `json:"lat"`
			Lon  float64 `json:"lon"`
			Unit uint32  `json:"unit"`
		}
		if json.NewDecoder(r.Body).Decode(&p) != nil {
			http.Error(w, "bad fixture", 400)
			return
		}
		if p.Unit == 0 {
			p.Unit = 42
		}
		m, _ := json.Marshal(map[string]any{"type": "log", "lines": []any{map[string]any{"kind": "position", "system": "city", "time": float64(time.Now().UnixMilli()) / 1000, "text": fmt.Sprintf("Unit %d at %.5f, %.5f (TG 20)", p.Unit, p.Lat, p.Lon)}}})
		mu.Lock()
		defer mu.Unlock()
		for c := range clients {
			if c.Write(ctx, websocket.MessageText, m) != nil {
				delete(clients, c)
			}
		}
		json.NewEncoder(w).Encode(map[string]int{"subscribers": len(clients)})
	})
	mux.HandleFunc("/test/status", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		json.NewEncoder(w).Encode(map[string]int{"subscribers": len(clients)})
	})
	fmt.Fprintln(os.Stdout, "http://"+listener.Addr().String())
	http.Serve(listener, mux)
}
