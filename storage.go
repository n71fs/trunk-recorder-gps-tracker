package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	_ "modernc.org/sqlite"
	"os"
	"strconv"
	"time"
)

type Fix struct {
	ID            int64   `json:"-"`
	System        string  `json:"system"`
	Unit          uint32  `json:"unit"`
	Lat           float64 `json:"lat"`
	Lon           float64 `json:"lon"`
	Time          int64   `json:"time"`
	Protocol      string  `json:"protocol"`
	Name          string  `json:"name"`
	Talkgroup     uint32  `json:"talkgroup"`
	Origin        string  `json:"origin"`
	EstimatedTime bool    `json:"estimatedTime"`
	Cached        bool    `json:"cached,omitempty"`
}

func (f Fix) valid() bool {
	return f.System != "" && len(f.System) <= 512 && f.Unit > 0 && !math.IsNaN(f.Lat) && !math.IsNaN(f.Lon) && math.Abs(f.Lat) <= 90 && math.Abs(f.Lon) <= 180 && f.Time > 0 && f.Time <= 8640000000000000
}

type PositionDB struct {
	db        *sql.DB
	path      string
	retention int
	maximum   int
}

func openDB(path string, retention, maximum int) (*PositionDB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY, system TEXT NOT NULL, unit INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, time INTEGER NOT NULL, protocol TEXT NOT NULL, name TEXT NOT NULL, talkgroup INTEGER NOT NULL, origin TEXT NOT NULL, estimated INTEGER NOT NULL, UNIQUE(system,unit,time,lat,lon));
 CREATE INDEX IF NOT EXISTS positions_time ON positions(time DESC,id DESC);
 CREATE INDEX IF NOT EXISTS positions_radio ON positions(system,unit,time DESC,id DESC);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	p := &PositionDB{db: db, path: path, retention: retention, maximum: maximum}
	if err = p.prune(time.Now()); err != nil {
		db.Close()
		return nil, err
	}
	return p, nil
}
func (p *PositionDB) insert(ctx context.Context, fixes []Fix) ([]Fix, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO positions(system,unit,lat,lon,time,protocol,name,talkgroup,origin,estimated) VALUES(?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	saved := []Fix{}
	cutoff := time.Now().Add(-time.Duration(p.retention) * 24 * time.Hour).UnixMilli()
	for _, f := range fixes {
		if !f.valid() || f.Time < cutoff {
			continue
		}
		if f.Protocol == "" {
			f.Protocol = "unknown"
		}
		if len(f.Name) > 1024 {
			f.Name = f.Name[:1024]
		}
		r, e := stmt.ExecContext(ctx, f.System, f.Unit, f.Lat, f.Lon, f.Time, f.Protocol, f.Name, f.Talkgroup, f.Origin, f.EstimatedTime)
		if e != nil {
			return nil, e
		}
		n, _ := r.RowsAffected()
		if n > 0 {
			f.ID, _ = r.LastInsertId()
			saved = append(saved, f)
		}
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM positions").Scan(&count); err != nil {
		return nil, err
	}
	if count > p.maximum {
		if _, err = tx.ExecContext(ctx, `DELETE FROM positions WHERE id IN (SELECT id FROM positions ORDER BY time ASC,id ASC LIMIT ?)`, count-p.maximum); err != nil {
			return nil, err
		}
		kept := saved[:0]
		for _, f := range saved {
			var exists bool
			if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM positions WHERE id=?)", f.ID).Scan(&exists); err != nil {
				return nil, err
			}
			if exists {
				kept = append(kept, f)
			}
		}
		saved = kept
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return saved, nil
}
func (p *PositionDB) prune(now time.Time) error {
	_, err := p.db.Exec(`DELETE FROM positions WHERE time < ?`, now.Add(-time.Duration(p.retention)*24*time.Hour).UnixMilli())
	if err != nil {
		return err
	}
	_, err = p.db.Exec(`DELETE FROM positions WHERE id IN (SELECT id FROM positions ORDER BY time DESC,id DESC LIMIT -1 OFFSET ?)`, p.maximum)
	return err
}

type Query struct {
	ID     int64  `json:"id"`
	From   int64  `json:"from"`
	To     int64  `json:"to"`
	System string `json:"system"`
	Unit   uint32 `json:"unit"`
	Cursor string `json:"cursor"`
	Limit  int    `json:"limit"`
}
type pageCursor struct {
	Time   int64  `json:"t"`
	ID     int64  `json:"i"`
	From   int64  `json:"f"`
	To     int64  `json:"u"`
	System string `json:"s"`
	Unit   uint32 `json:"r"`
}

func (p *PositionDB) query(ctx context.Context, q Query) ([]Fix, string, error) {
	if q.Limit == 0 {
		q.Limit = 300
	}
	if q.Limit < 1 || q.Limit > 500 {
		return nil, "", errors.New("limit must be 1–500")
	}
	if q.From < 0 || q.To < 0 || (q.To != 0 && q.From > q.To) {
		return nil, "", errors.New("invalid time range")
	}
	where := " WHERE 1=1"
	args := []any{}
	if q.From > 0 {
		where += " AND time >= ?"
		args = append(args, q.From)
	}
	if q.To > 0 {
		where += " AND time < ?"
		args = append(args, q.To)
	}
	if q.System != "" {
		where += " AND system = ?"
		args = append(args, q.System)
	}
	if q.Unit > 0 {
		where += " AND unit = ?"
		args = append(args, q.Unit)
	}
	if q.Cursor != "" {
		var c pageCursor
		b, e := base64.RawURLEncoding.DecodeString(q.Cursor)
		if e != nil || json.Unmarshal(b, &c) != nil || c.ID <= 0 || c.Time <= 0 || c.From != q.From || c.To != q.To || c.System != q.System || c.Unit != q.Unit {
			return nil, "", errors.New("invalid cursor for this query")
		}
		where += " AND (time < ? OR (time = ? AND id < ?))"
		args = append(args, c.Time, c.Time, c.ID)
	}
	args = append(args, q.Limit+1)
	rows, err := p.db.QueryContext(ctx, `SELECT id,system,unit,lat,lon,time,protocol,name,talkgroup,origin,estimated FROM positions`+where+` ORDER BY time DESC,id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	fixes := []Fix{}
	for rows.Next() {
		var f Fix
		if err = rows.Scan(&f.ID, &f.System, &f.Unit, &f.Lat, &f.Lon, &f.Time, &f.Protocol, &f.Name, &f.Talkgroup, &f.Origin, &f.EstimatedTime); err != nil {
			return nil, "", err
		}
		f.Cached = true
		fixes = append(fixes, f)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(fixes) > q.Limit {
		fixes = fixes[:q.Limit]
		last := fixes[len(fixes)-1]
		b, _ := json.Marshal(pageCursor{last.Time, last.ID, q.From, q.To, q.System, q.Unit})
		next = base64.RawURLEncoding.EncodeToString(b)
	}
	return fixes, next, nil
}
func (p *PositionDB) stats() (map[string]any, error) {
	var count int64
	var oldest, newest sql.NullInt64
	err := p.db.QueryRow(`SELECT count(*),min(time),max(time) FROM positions`).Scan(&count, &oldest, &newest)
	if err != nil {
		return nil, err
	}
	var bytes int64
	for _, path := range []string{p.path, p.path + "-wal"} {
		if st, e := os.Stat(path); e == nil {
			bytes += st.Size()
		}
	}
	return map[string]any{"count": count, "oldestMs": oldest.Int64, "newestMs": newest.Int64, "retentionDays": p.retention, "maxPositions": p.maximum, "bytes": bytes}, nil
}
func intQuery(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	n, e := strconv.ParseInt(value, 10, 64)
	if e != nil || n < 0 {
		return 0, fmt.Errorf("invalid positive integer %q", value)
	}
	return n, nil
}
