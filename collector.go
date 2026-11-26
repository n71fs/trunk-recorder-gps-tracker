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

type unitNameRow struct {
	Unit string `json:"unit"`
	Name string `json:"name"`
}
type connectionGap struct {
	From int64 `json:"fromMs"`
	To   int64 `json:"toMs"`
}
type runtimeState struct {
	nameRows        map[string][]unitNameRow
	completeAliases map[string]bool
	nameModes       map[string]string
	startedMs       int64
	connectedMs     int64
	disconnectedMs  int64
	lastMessageMs   int64
	lastLiveMs      int64
	lastSavedMs     int64
	reconnects      int
	gaps            []connectionGap

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
	return &runtimeState{completeAliases: map[string]bool{}, nameRows: map[string][]unitNameRow{}, nameModes: map[string]string{}, startedMs: time.Now().UnixMilli(), phase: "idle", bind: "127.0.0.1", config: map[string]any{"systems": []any{}, "conventional": []any{}}, protocols: map[string]string{}, names: map[string]string{}, configured: make(chan struct{})}
}
func unitNameKey(system string, unit uint32) string {
	return system + "\x00" + strconv.FormatUint(uint64(unit), 10)
}
func (s *runtimeState) snapshot() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]any{"connected": s.connected, "recorderVersion": s.recorderVersion, "phase": s.phase, "nowS": s.nowS, "config": s.config, "startedMs": s.startedMs, "connectedMs": s.connectedMs, "disconnectedMs": s.disconnectedMs, "lastMessageMs": s.lastMessageMs, "lastLiveMs": s.lastLiveMs, "lastSavedMs": s.lastSavedMs, "reconnects": s.reconnects, "gaps": append([]connectionGap{}, s.gaps...)}
}
func (s *runtimeState) setConnected(connected bool) {
	s.mu.Lock()
	if s.connected && !connected {
		s.disconnectedMs = time.Now().UnixMilli()
		s.gaps = append(s.gaps, connectionGap{From: s.disconnectedMs})
		if len(s.gaps) > 20 {
			s.gaps = s.gaps[len(s.gaps)-20:]
		}
	}
	s.connected = connected
	s.mu.Unlock()
}

var positionLine = regexp.MustCompile(`^Unit (\d+) at (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?) \(TG (\d+)\)$`)

func (s *runtimeState) decode(data []byte, now time.Time) ([]Fix, error) {
	var m struct {
		Type      string        `json:"type"`
		Phase     string        `json:"phase"`
		Version   string        `json:"version"`
		Unit      uint32        `json:"unit"`
		Alias     string        `json:"alias"`
		System    string        `json:"system"`
		CSV       string        `json:"csv"`
		Name      string        `json:"name"`
		UnitNames []unitNameRow `json:"unitNames"`
		Config    struct {
			Systems []struct {
				ShortName string `json:"shortName"`
				Name      string `json:"name"`
				Type      string `json:"type"`
				UnitNames struct {
					Mode string `json:"mode"`
				} `json:"unitNames"`
			} `json:"systems"`
			Conventional []struct {
				ShortName string `json:"shortName"`
				Name      string `json:"name"`
				Type      string `json:"type"`
				UnitNames struct {
					Mode string `json:"mode"`
				} `json:"unitNames"`
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
	s.lastMessageMs = now.UnixMilli()
	fixes := []Fix{}
	switch m.Type {
	case "hello":
		s.recorderVersion = m.Version
		if !s.connected {
			s.connectedMs = now.UnixMilli()
			if s.disconnectedMs > 0 {
				s.reconnects++
				if len(s.gaps) > 0 {
					s.gaps[len(s.gaps)-1].To = s.connectedMs
				}
			}
		}
		s.connected = true
	case "state":
		s.phase = m.Phase
	case "status":
		s.nowS = m.Status.NowS
	case "config":
		systems := []any{}
		conventional := []any{}
		for _, v := range m.Config.Systems {
			s.nameModes[v.ShortName] = v.UnitNames.Mode
			s.protocols[v.ShortName] = v.Type
			systems = append(systems, map[string]string{"shortName": v.ShortName, "name": v.Name, "type": v.Type})
		}
		for _, v := range m.Config.Conventional {
			kind := v.Type
			if kind == "" {
				kind = "conventional"
			}
			s.nameModes[v.ShortName] = v.UnitNames.Mode
			s.protocols[v.ShortName] = kind
			conventional = append(conventional, map[string]string{"shortName": v.ShortName, "name": v.Name, "type": kind})
		}
		// Do not expose recorder plugin credentials, key sources, server settings or paths.
		s.config = map[string]any{"systems": systems, "conventional": conventional}
		if m.Config.Server.Bind != "" {
			s.bind = m.Config.Server.Bind
		}
		s.once.Do(func() { close(s.configured) })
	case "unitNames":
		s.nameRows[m.System] = append([]unitNameRow{}, m.UnitNames...)
	case "unitNameEdited":
		key := strconv.FormatUint(uint64(m.Unit), 10)
		rows := []unitNameRow{}
		at := -1
		for _, row := range s.nameRows[m.System] {
			if row.Unit == key {
				at = len(rows)
				continue
			}
			rows = append(rows, row)
		}
		if strings.TrimSpace(m.Name) != "" {
			if at < 0 {
				at = len(rows)
				for i, row := range rows {
					if strings.HasPrefix(row.Unit, "/") {
						at = i
						break
					}
				}
			}
			rows = append(rows, unitNameRow{})
			copy(rows[at+1:], rows[at:])
			rows[at] = unitNameRow{Unit: key, Name: strings.TrimSpace(m.Name)}
		}
		s.nameRows[m.System] = rows
	case "unitAlias":
		s.names[unitNameKey(m.System, m.Unit)] = strings.TrimSpace(m.Alias)
	case "units":
		s.completeAliases[m.System] = true
		for key := range s.names {
			if strings.HasPrefix(key, m.System+"\x00") {
				delete(s.names, key)
			}
		}
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
					// Historical names stay on the fix; never overwrite current recorder aliases.
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
				s.lastLiveMs = now.UnixMilli()
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
				if msg.Type == "unitAlias" || msg.Type == "units" || msg.Type == "unitNames" || msg.Type == "unitNameEdited" || msg.Type == "hello" || msg.Type == "config" {
					a.hub.publish(a.state.nameSnapshot())
				}
				if len(fixes) > 0 {
					a.publishState()
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

// Copy names under the lock so WebSocket serialization cannot race recorder edits.
func (s *runtimeState) nameSnapshot() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	aliases := map[string]map[string]string{}
	for key, name := range s.names {
		parts := strings.SplitN(key, "\x00", 2)
		if len(parts) != 2 {
			continue
		}
		if aliases[parts[0]] == nil {
			aliases[parts[0]] = map[string]string{}
		}
		aliases[parts[0]][parts[1]] = name
	}
	rows := map[string][]unitNameRow{}
	for system, list := range s.nameRows {
		rows[system] = append([]unitNameRow{}, list...)
	}
	modes := map[string]string{}
	for system, mode := range s.nameModes {
		modes[system] = mode
	}
	complete := map[string]bool{}
	for system, known := range s.completeAliases {
		complete[system] = known
	}
	return map[string]any{"type": "radioNames", "aliases": aliases, "rows": rows, "modes": modes, "completeAliases": complete}
}
