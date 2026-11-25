package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func configFor(t *testing.T, raw string) Config {
	t.Helper()
	c, e := readConfig(json.RawMessage(raw))
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func testFix(unit uint32, at int64) Fix {
	return Fix{System: "city", Unit: unit, Time: at, Lat: 38, Lon: -77, Protocol: "dmr", Origin: "live", EstimatedTime: true}
}
func TestConfigAndManifest(t *testing.T) {
	c := configFor(t, `{}`)
	if c.RetentionDays != 30 || c.RecorderURL != "http://127.0.0.1:8080" {
		t.Fatal(c)
	}
	for _, raw := range []string{`{"retention_days":0}`, `{"max_positions":9}`, `{"recorder_url":"file:///secret"}`, `{"recorder_url":"http://user:password@localhost:8080"}`, `{"listen":"bad-address"}`} {
		if _, e := readConfig([]byte(raw)); e == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	m := manifest()
	if m["id"] != "gps-history" || len(m["subscribe"].([]string)) != 0 {
		t.Fatal(m)
	}
}
func TestPositionParserAndSanitization(t *testing.T) {
	s := newState()
	now := time.Now()
	messages := []string{`{"type":"config","config":{"systems":[{"shortName":"city","type":"dmr"}],"server":{"bind":"127.0.0.1"},"plugins":{"secret":"DO-NOT-EXPOSE"}}}`, `{"type":"status","status":{"nowS":100}}`, `{"type":"unitAlias","system":"city","unit":42,"alias":"Rescue"}`}
	for _, m := range messages {
		if _, e := s.decode([]byte(m), now); e != nil {
			t.Fatal(e)
		}
	}
	fixes, e := s.decode([]byte(`{"type":"log","lines":[{"kind":"position","system":"city","timeS":99,"text":"Unit 42 at 38.90000, -77.10000 (TG 20)"},{"kind":"position","system":"city","timeS":99,"text":"Unit 0 at 38.90000, -77.10000 (TG 20)"},{"kind":"position","system":"city","timeS":99,"text":"Unit 42 at 999.00000, -77.10000 (TG 20)"}]}`), now)
	if e != nil || len(fixes) != 1 {
		t.Fatalf("%v %v", fixes, e)
	}
	f := fixes[0]
	if f.Name != "Rescue" || f.Protocol != "dmr" || f.Time != now.UnixMilli()-1000 {
		t.Fatal(f)
	}
	b, _ := json.Marshal(s.snapshot())
	if strings.Contains(string(b), "DO-NOT-EXPOSE") {
		t.Fatal("secret leaked")
	}
	records, e := s.decode([]byte(fmt.Sprintf(`{"type":"concluded","entry":{"record":{"short_name":"city","voice_mode":"dmr","talkgroup":20,"srcList":[{"src":42,"time":%f,"lat":1,"lon":2,"tag":"Engine"},{"src":5,"time":1}]}}}`, float64(now.UnixMilli())/1000)), now)
	if e != nil || len(records) != 1 || records[0].Name != "Engine" || records[0].Origin != "recorded" {
		t.Fatalf("%v %v", records, e)
	}
}
func TestDatabasePersistencePagingAndRetention(t *testing.T) {
	path := filepath.Join(t.TempDir(), "positions.sqlite")
	db, e := openDB(path, 30, 3)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UnixMilli()
	f := []Fix{testFix(1, now), testFix(2, now), testFix(3, now), testFix(3, now), testFix(4, now-31*86400000)}
	inserted, e := db.insert(context.Background(), f)
	if e != nil || len(inserted) != 3 {
		t.Fatalf("%v %v", inserted, e)
	}
	page, next, e := db.query(context.Background(), Query{Limit: 1})
	if e != nil || len(page) != 1 || next == "" {
		t.Fatalf("%v %s %v", page, next, e)
	}
	page2, _, e := db.query(context.Background(), Query{Limit: 1, Cursor: next})
	if e != nil || page2[0].Unit == page[0].Unit {
		t.Fatal(page2, e)
	}
	if _, _, e = db.query(context.Background(), Query{Limit: 1, From: now - 1, Cursor: next}); e == nil {
		t.Fatal("accepted cursor from different query")
	}
	db.db.Close()
	db, e = openDB(path, 30, 2)
	if e != nil {
		t.Fatal(e)
	}
	defer db.db.Close()
	stats, e := db.stats()
	if e != nil || stats["count"].(int64) != 2 {
		t.Fatal(stats, e)
	}
	if _, _, e = db.query(context.Background(), Query{Limit: 501}); e == nil {
		t.Fatal("unbounded query accepted")
	}
	if _, _, e = db.query(context.Background(), Query{System: "' OR 1=1 --"}); e != nil {
		t.Fatal(e)
	}
}
func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
func TestCollectsWithNoBrowserAndReopensHistory(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connections := make(chan *websocket.Conn, 4)
	recorder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(1 << 20)
		for _, m := range []string{`{"type":"config","config":{"systems":[{"shortName":"city","type":"dmr"}],"server":{"bind":"127.0.0.1"}}}`, `{"type":"state","phase":"running"}`, `{"type":"hello","version":"v0.3.9-gps.1"}`} {
			if c.Write(ctx, websocket.MessageText, []byte(m)) != nil {
				return
			}
		}
		_, b, e := c.Read(ctx)
		if e != nil {
			return
		}
		if !strings.Contains(string(b), `"log"`) {
			return
		}
		connections <- c
		for {
			if _, _, e = c.Read(ctx); e != nil {
				return
			}
		}
	}))
	defer recorder.Close()
	raw, _ := json.Marshal(map[string]any{"recorder_url": recorder.URL, "listen": "127.0.0.1:0"})
	c := configFor(t, string(raw))
	data := t.TempDir()
	out := &protocolOutput{encoder: json.NewEncoder(io.Discard)}
	app, e := startApplication(ctx, c, data, out)
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		if app != nil {
			app.close()
		}
	}()
	source := <-connections
	for _, text := range []string{"Unit 42 at 38.90000, -77.10000 (TG 20)", "Unit 42 at 38.91000, -77.11000 (TG 20)"} {
		m, _ := json.Marshal(map[string]any{"type": "log", "lines": []any{map[string]any{"kind": "position", "system": "city", "timeS": 1, "text": text}}})
		if source.Write(ctx, websocket.MessageText, m) != nil {
			t.Fatal("source failed")
		}
	}
	eventually(t, func() bool { stats, _ := app.store.stats(); return stats["count"] == int64(2) })
	u, _ := url.Parse(app.dashboardURL)
	u.Fragment = ""
	base := u.String()
	response, e := http.Get(base + "api/gps/positions")
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("history not protected")
	}
	request, _ := http.NewRequest("GET", base+"api/gps/positions?limit=1", nil)
	request.Header.Set("Authorization", "Bearer "+app.token)
	response, e = http.DefaultClient.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	var body struct {
		Positions []Fix  `json:"positions"`
		Next      string `json:"next"`
	}
	json.NewDecoder(response.Body).Decode(&body)
	response.Body.Close()
	if len(body.Positions) != 1 || body.Next == "" {
		t.Fatal(body)
	}
	u.Scheme = "ws"
	u.Path = "/api/ws"
	bad, resp, _ := websocket.Dial(ctx, u.String(), nil)
	if bad != nil {
		bad.CloseNow()
	}
	if resp == nil || resp.StatusCode != 401 {
		t.Fatal("unauthenticated WebSocket allowed")
	}
	cross, denied, _ := websocket.Dial(ctx, u.String(), &websocket.DialOptions{Subprotocols: []string{"trp-gps", "token." + app.token}, HTTPHeader: http.Header{"Origin": []string{"https://untrusted.example"}}})
	if cross != nil {
		cross.CloseNow()
	}
	if denied == nil || denied.StatusCode != 403 {
		t.Fatal("cross-origin socket accepted")
	}
	request, _ = http.NewRequest("POST", base+"api/gps/positions", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer "+app.token)
	response, e = http.DefaultClient.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 405 {
		t.Fatal("API write accepted")
	}
	viewer, _, e := websocket.Dial(ctx, u.String(), &websocket.DialOptions{Subprotocols: []string{"trp-gps", "token." + app.token}})
	if e != nil {
		t.Fatal(e)
	}
	for {
		_, b, e := viewer.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(string(b), `"type":"hello"`) {
			break
		}
	}
	viewer.Write(ctx, websocket.MessageText, []byte(`{"type":"stop"}`))
	for {
		_, b, e := viewer.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(string(b), `"type":"error"`) {
			break
		}
	}
	viewer.CloseNow()
	token := app.token
	app.close()
	app, e = startApplication(ctx, c, data, out)
	if e != nil {
		t.Fatal(e)
	}
	if app.token != token {
		t.Fatal("dashboard token changed on restart")
	}
	stats, _ := app.store.stats()
	if stats["count"] != int64(2) {
		t.Fatal(stats)
	}
}

func TestDatabaseEnforcesCapDuringCollection(t *testing.T) {
	db, e := openDB(filepath.Join(t.TempDir(), "positions.sqlite"), 30, 2)
	if e != nil {
		t.Fatal(e)
	}
	defer db.db.Close()
	now := time.Now().UnixMilli()
	saved, e := db.insert(context.Background(), []Fix{testFix(1, now-1000), testFix(2, now), testFix(3, now+1000)})
	if e != nil || len(saved) != 2 {
		t.Fatal(saved, e)
	}
	stats, _ := db.stats()
	if stats["count"] != int64(2) {
		t.Fatal(stats)
	}
}
func TestSourceMetadataBackfill(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queries := make(chan int64, 4)
	recorder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer c.CloseNow()
		c.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","version":"test","capabilities":["calls"]}`))
		pages := 0
		for {
			_, b, e := c.Read(ctx)
			if e != nil {
				return
			}
			var m struct {
				Type string `json:"type"`
				ID   int64  `json:"id"`
				From int64  `json:"from"`
				To   int64  `json:"to"`
			}
			json.Unmarshal(b, &m)
			if m.Type != "callsQuery" {
				continue
			}
			queries <- m.From
			pages++
			next := "next"
			if pages == 2 {
				next = ""
			}
			response := map[string]any{"type": "callsResult", "id": m.ID, "next": next, "entries": []any{map[string]any{"record": map[string]any{"short_name": "city", "system_type": "dmr", "srcList": []any{map[string]any{"src": pages, "time": float64(time.Now().Add(-time.Hour).UnixMilli()) / 1000, "lat": 38, "lon": -77}}}}}}
			data, _ := json.Marshal(response)
			if c.Write(ctx, websocket.MessageText, data) != nil {
				return
			}
		}
	}))
	defer recorder.Close()
	raw, _ := json.Marshal(map[string]any{"recorder_url": recorder.URL, "listen": "127.0.0.1:0"})
	a, e := startApplication(ctx, configFor(t, string(raw)), t.TempDir(), &protocolOutput{encoder: json.NewEncoder(io.Discard)})
	if e != nil {
		t.Fatal(e)
	}
	defer a.close()
	eventually(t, func() bool { stats, _ := a.store.stats(); return stats["count"] == int64(2) })
	first, second := <-queries, <-queries
	if first != second || first <= time.Now().Add(-25*time.Hour).UnixMilli() {
		t.Fatal("backfill range not fixed")
	}
}
