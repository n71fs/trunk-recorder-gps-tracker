package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
)

const pluginID = "gps-history"
const version = "0.4.0"

type Config struct {
	BackfillHours int    `json:"backfill_hours"`
	RecorderURL   string `json:"recorder_url"`
	Listen        string `json:"listen"`
	AdvertiseHost string `json:"advertise_host"`
	RetentionDays int    `json:"retention_days"`
	MaxPositions  int    `json:"max_positions"`
	DashboardURL  string `json:"dashboard_url"`
}

func readConfig(raw json.RawMessage) (Config, error) {
	c := Config{RecorderURL: "http://127.0.0.1:8080", Listen: "auto", AdvertiseHost: "auto", RetentionDays: 30, BackfillHours: 24, MaxPositions: 1000000}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &c); err != nil {
			return c, err
		}
	}
	u, err := url.Parse(c.RecorderURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return c, errors.New("recorder_url must be an http(s) recorder origin, without credentials, a path, or a query")
	}
	c.RecorderURL = u.Scheme + "://" + u.Host
	if c.Listen != "auto" {
		if _, _, err := net.SplitHostPort(c.Listen); err != nil {
			return c, fmt.Errorf("listen: %w", err)
		}
	}
	if c.AdvertiseHost != "auto" && (c.AdvertiseHost == "" || net.ParseIP(c.AdvertiseHost) == nil) {
		return c, errors.New("advertise_host must be auto or an IP address")
	}
	if c.BackfillHours < 0 || c.BackfillHours > 720 {
		return c, errors.New("backfill_hours must be 0–720")
	}
	if c.RetentionDays < 1 || c.RetentionDays > 365 {
		return c, errors.New("retention_days must be 1–365")
	}
	if c.MaxPositions < 1000 || c.MaxPositions > 10000000 {
		return c, errors.New("max_positions must be 1000–10000000")
	}
	return c, nil
}
func manifest() map[string]any {
	prop := func(typ, title string, def any) map[string]any {
		return map[string]any{"type": typ, "title": title, "default": def}
	}
	return map[string]any{
		"id": pluginID, "name": "GPS history", "version": version, "description": "Save decoded GPS positions on the recorder machine and open a bundled tracking dashboard.", "api": 1,
		"subscribe": []string{}, "audio_formats": []string{}, "license": "GPL-3.0-or-later", "repository": "https://github.com/n71fs/trunk-recorder-gps-tracker",
		"page": map[string]string{"title": "GPS history"}, "live_settings": true,
		"config": map[string]any{"type": "object", "properties": map[string]any{
			"recorder_url":   prop("string", "Recorder URL", "http://127.0.0.1:8080"),
			"listen":         map[string]any{"type": "string", "title": "Dashboard bind address", "default": "auto", "description": "auto follows the recorder's bind address on port 8095, choosing a free port if needed"},
			"advertise_host": map[string]any{"type": "string", "title": "Dashboard address", "default": "auto", "description": "auto prefers a Tailscale address for a network-facing recorder"},
			"backfill_hours": map[string]any{"type": "integer", "title": "Backfill recorded GPS, hours", "default": 24, "minimum": 0, "maximum": 720, "description": "Read available call metadata on connection; 0 disables this, and searches stop after 50,000 calls"},
			"retention_days": map[string]any{"type": "integer", "title": "Keep GPS history, days", "default": 30, "minimum": 1, "maximum": 365},
			"max_positions":  map[string]any{"type": "integer", "title": "Maximum saved positions", "default": 1000000, "minimum": 1000, "maximum": 10000000},
			"dashboard_url":  map[string]any{"type": "string", "title": "GPS dashboard", "format": "uri", "readOnly": true, "x-open": "Open GPS dashboard", "description": "Private read-only access link; share only with intended viewers"},
		}},
	}
}
