package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type runtimeState struct {
	mu              sync.RWMutex
	connected       bool
	recorderVersion string
	phase           string
	nowS            float64
	bind            string
	config          map[string]any
	protocols       map[string]string
	names           map[string]string
	configured      chan struct{}
	once            sync.Once
}

func newState() *runtimeState {
	return &runtimeState{phase: "idle", bind: "127.0.0.1", config: map[string]any{"systems": []any{}, "conventional": []any{}}, protocols: map[string]string{}, names: map[string]string{}, configured: make(chan struct{})}
}
func unitNameKey(system string, unit uint32) string {
	return system + "\x00" + strconv.FormatUint(uint64(unit), 10)
}
func (s *runtimeState) snapshot() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]any{"connected": s.connected, "recorderVersion": s.recorderVersion, "phase": s.phase, "nowS": s.nowS, "config": s.config}
}
func (s *runtimeState) setConnected(connected bool) {
	s.mu.Lock()
	s.connected = connected
	s.mu.Unlock()
}

var positionLine = regexp.MustCompile(`^Unit (\d+) at (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?) \(TG (\d+)\)$`)

func (s *runtimeState) decode(data []byte, now time.Time) ([]Fix, error) {
	var m struct {
		Type    string `json:"type"`
		Phase   string `json:"phase"`
		Version string `json:"version"`
		Unit    uint32 `json:"unit"`
		Alias   string `json:"alias"`
		System  string `json:"system"`
		CSV     string `json:"csv"`
		Config  struct {
			Systems []struct {
				ShortName string `json:"shortName"`
				Name      string `json:"name"`
				Type      string `json:"type"`
			} `json:"systems"`
			Conventional []struct {
				ShortName string `json:"shortName"`
				Name      string `json:"name"`
				Type      string `json:"type"`
			} `json:"conventional"`
			Server struct {
				Bind string `json:"bind"`
			} `json:"server"`
		} `json:"config"`
		Status struct {
			NowS float64 `json:"nowS"`
		} `json:"status"`
		Lines []struct {
			Kind   string   `json:"kind"`
			Text   string   `json:"text"`
			System string   `json:"system"`
			TimeS  float64  `json:"timeS"`
			Time   *float64 `json:"time"`
		} `json:"lines"`
		Entries []callEntry `json:"entries"`
		Entry   callEntry   `json:"entry"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fixes := []Fix{}
	switch m.Type {
	case "hello":
		s.recorderVersion = m.Version
		s.connected = true
	case "state":
		s.phase = m.Phase
	case "status":
		s.nowS = m.Status.NowS
	case "config":
		systems := []any{}
		conventional := []any{}
		for _, v := range m.Config.Systems {
			s.protocols[v.ShortName] = v.Type
			systems = append(systems, map[string]string{"shortName": v.ShortName, "name": v.Name, "type": v.Type})
		}
		for _, v := range m.Config.Conventional {
			kind := v.Type
			if kind == "" {
				kind = "conventional"
			}
			s.protocols[v.ShortName] = kind
			conventional = append(conventional, map[string]string{"shortName": v.ShortName, "name": v.Name, "type": kind})
		}
		// Do not expose recorder plugin credentials, key sources, server settings or paths.
		s.config = map[string]any{"systems": systems, "conventional": conventional}
		if m.Config.Server.Bind != "" {
			s.bind = m.Config.Server.Bind
		}
		s.once.Do(func() { close(s.configured) })
	case "unitAlias":
		s.names[unitNameKey(m.System, m.Unit)] = m.Alias
	case "units":
		r := csv.NewReader(strings.NewReader(m.CSV))
		r.FieldsPerRecord = -1
		for {
			row, e := r.Read()
			if e == io.EOF {
				break
			}
			if e != nil {
				break
			}
			if len(row) >= 2 {
				n, e := strconv.ParseUint(row[0], 10, 32)
				if e == nil {
					s.names[unitNameKey(m.System, uint32(n))] = row[1]
				}
			}
		}
	case "history", "concluded", "callsResult":
		entries := m.Entries
		if m.Type == "concluded" {
			entries = []callEntry{m.Entry}
		}
		for _, entry := range entries {
			r := entry.Record
			kind := r.VoiceMode
			if kind == "" {
				kind = r.SystemType
			}
			if kind == "" {
				kind = s.protocols[r.ShortName]
			}
			for _, v := range r.Sources {
				if v.Lat == nil || v.Lon == nil {
					continue
				}
				name := v.Tag
				if name == "" {
					name = v.Alias
				}
				f := Fix{System: r.ShortName, Unit: v.Unit, Lat: *v.Lat, Lon: *v.Lon, Time: int64(v.Time * 1000), Protocol: kind, Name: name, Talkgroup: r.Talkgroup, Origin: "recorded", EstimatedTime: true}
				if f.valid() {
					fixes = append(fixes, f)
					if name != "" {
						s.names[unitNameKey(r.ShortName, v.Unit)] = name
					}
				}
			}
		}
	case "log":
		for _, line := range m.Lines {
			if line.Kind != "position" {
				continue
			}
			match := positionLine.FindStringSubmatch(line.Text)
			if match == nil {
				continue
			}
			unit, e := strconv.ParseUint(match[1], 10, 32)
			if e != nil {
				continue
			}
			lat, _ := strconv.ParseFloat(match[2], 64)
			lon, _ := strconv.ParseFloat(match[3], 64)
			tg, _ := strconv.ParseUint(match[4], 10, 32)
			observed := now.UnixMilli()
			estimated := true
			if line.Time != nil && !math.IsNaN(*line.Time) && !math.IsInf(*line.Time, 0) {
				observed = int64(*line.Time * 1000)
				estimated = false
			} else if s.nowS >= line.TimeS && s.nowS > 0 {
				observed -= int64((s.nowS - line.TimeS) * 1000)
			}
			f := Fix{System: line.System, Unit: uint32(unit), Lat: lat, Lon: lon, Time: observed, Protocol: s.protocols[line.System], Name: s.names[unitNameKey(line.System, uint32(unit))], Talkgroup: uint32(tg), Origin: "live", EstimatedTime: estimated}
			if f.valid() {
				fixes = append(fixes, f)
			}
		}
	}
	return fixes, nil
}

type callEntry struct {
	Record struct {
		ShortName  string `json:"short_name"`
		VoiceMode  string `json:"voice_mode"`
		SystemType string `json:"system_type"`
		Talkgroup  uint32 `json:"talkgroup"`
		Sources    []struct {
			Unit  uint32   `json:"src"`
			Time  float64  `json:"time"`
			Lat   *float64 `json:"lat"`
			Lon   *float64 `json:"lon"`
			Tag   string   `json:"tag"`
			Alias string   `json:"tag_ota"`
		} `json:"srcList"`
	} `json:"record"`
}

func (a *application) collect(ctx context.Context) {
	delay := 500 * time.Millisecond
	for ctx.Err() == nil {
		u, _ := url.Parse(a.config.RecorderURL)
		if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
		u.Path = "/api/ws"
		dialCtx, stopDial := context.WithTimeout(ctx, 15*time.Second)
		conn, _, err := websocket.Dial(dialCtx, u.String(), nil)
		stopDial()
		if err == nil {
			backfillFrom := time.Now().Add(-time.Duration(a.config.BackfillHours) * time.Hour).UnixMilli()
			backfillTo := time.Now().UnixMilli() + 1
			backfillID := int64(900000)
			backfillPages := 0
			seen := map[string]bool{}
			conn.SetReadLimit(16 << 20)
			err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"subscribe","topics":["log"]}`))
			for err == nil {
				var data []byte
				_, data, err = conn.Read(ctx)
				if err != nil {
					break
				}
				fixes, e := a.state.decode(data, time.Now())
				if e != nil {
					continue
				}
				for _, f := range fixes {
					select {
					case a.fixes <- f:
					case <-ctx.Done():
						conn.CloseNow()
						return
					}
				}
				var msg struct {
					Type         string   `json:"type"`
					ID           int64    `json:"id"`
					Next         string   `json:"next"`
					Error        string   `json:"error"`
					Capabilities []string `json:"capabilities"`
				}
				json.Unmarshal(data, &msg)
				if msg.Type == "hello" {
					delay = 500 * time.Millisecond
					if a.config.BackfillHours > 0 {
						for _, capability := range msg.Capabilities {
							if capability == "calls" {
								backfillID++
								q, _ := json.Marshal(map[string]any{"type": "callsQuery", "id": backfillID, "from": backfillFrom, "to": backfillTo, "limit": 500})
								if e := conn.Write(ctx, websocket.MessageText, q); e != nil {
									err = e
								}
								break
							}
						}
					}
					a.output.status("ok", "Collecting GPS; open the GPS dashboard from this plugin’s settings")
				}
				if msg.Type == "callsResult" && msg.ID == backfillID {
					backfillPages++
					if msg.Error != "" {
						a.output.send(map[string]any{"type": "log", "level": "warn", "message": "Recorded GPS backfill unavailable: " + msg.Error})
					} else if msg.Next != "" && backfillPages < 100 && !seen[msg.Next] {
						seen[msg.Next] = true
						backfillID++
						q, _ := json.Marshal(map[string]any{"type": "callsQuery", "id": backfillID, "from": backfillFrom, "to": backfillTo, "cursor": msg.Next, "limit": 500})
						if e := conn.Write(ctx, websocket.MessageText, q); e != nil {
							err = e
						}
					} else if msg.Next != "" {
						a.output.send(map[string]any{"type": "log", "level": "warn", "message": "Recorded GPS backfill stopped at the page limit or a repeated cursor; live collection continues"})
					}
				}
				if msg.Type == "hello" || msg.Type == "state" || msg.Type == "config" || msg.Type == "status" {
					a.publishState()
				}
			}
			conn.CloseNow()
		}
		a.state.setConnected(false)
		a.publishState()
		if ctx.Err() != nil {
			return
		}
		a.output.status("warning", fmt.Sprintf("Recorder connection unavailable; retrying %s. Check Recorder URL if the recorder uses a custom port.", a.config.RecorderURL))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if delay < 15*time.Second {
			delay *= 2
		}
	}
}
