package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type protocolOutput struct {
	mu      sync.Mutex
	encoder *json.Encoder
	request uint64
}

func (o *protocolOutput) send(m any) { o.mu.Lock(); defer o.mu.Unlock(); o.encoder.Encode(m) }
func (o *protocolOutput) status(state, message string) {
	o.send(map[string]any{"type": "status", "state": state, "message": message})
}

type application struct {
	closeOnce                                  sync.Once
	config                                     Config
	store                                      *PositionDB
	state                                      *runtimeState
	hub                                        *hub
	token                                      string
	fixes                                      chan Fix
	cancel                                     context.CancelFunc
	collectorDone, writerDone, maintenanceDone chan struct{}
	fatal                                      chan error
	server                                     *http.Server
	output                                     *protocolOutput
	dashboardURL                               string
	listenAddress                              string
}

func tokenFor(dir string) (string, error) {
	path := filepath.Join(dir, "dashboard-token")
	if b, e := os.ReadFile(path); e == nil {
		value := strings.TrimSpace(string(b))
		decoded, e := hex.DecodeString(value)
		if e != nil || len(decoded) != 32 {
			return "", errors.New("Invalid dashboard-token file in plugin data folder")
		}
		return value, nil
	} else if !os.IsNotExist(e) {
		return "", e
	}
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	token := hex.EncodeToString(b)
	if e := os.WriteFile(path, []byte(token), 0600); e != nil {
		return "", e
	}
	return token, nil
}
func advertise(bind string) string {
	if ip := net.ParseIP(bind); ip != nil && !ip.IsUnspecified() {
		return bind
	}
	addresses, _ := net.InterfaceAddrs()
	best := "127.0.0.1"
	for _, addr := range addresses {
		ip, _, e := net.ParseCIDR(addr.String())
		if e != nil || ip.To4() == nil || ip.IsLoopback() {
			continue
		}
		v := ip.To4()
		if v[0] == 100 && v[1] >= 64 && v[1] <= 127 {
			return ip.String()
		}
		if ip.IsPrivate() {
			best = ip.String()
		}
	}
	return best
}
func startApplication(parent context.Context, c Config, dataDir string, out *protocolOutput) (*application, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dataDir, 0700); err != nil {
		return nil, err
	}
	token, err := tokenFor(dataDir)
	if err != nil {
		return nil, err
	}
	store, err := openDB(filepath.Join(dataDir, "positions.sqlite"), c.RetentionDays, c.MaxPositions)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	a := &application{config: c, store: store, state: newState(), hub: newHub(), token: token, fixes: make(chan Fix, 8192), cancel: cancel, collectorDone: make(chan struct{}), writerDone: make(chan struct{}), fatal: make(chan error, 1), output: out}
	go func() { defer close(a.collectorDone); a.collect(ctx) }()
	go a.writePositions()
	if c.Listen == "auto" {
		timer := time.NewTimer(3 * time.Second)
		select {
		case <-a.state.configured:
			timer.Stop()
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
		}
	}
	address := c.Listen
	if address == "auto" {
		a.state.mu.RLock()
		bind := a.state.bind
		a.state.mu.RUnlock()
		// An explicitly chosen dashboard IP must also be reachable at the listener.
		// Changing only the advertised URL can otherwise publish a remote link
		// while the server still listens exclusively on recorder loopback.
		if c.AdvertiseHost != "auto" {
			bind = c.AdvertiseHost
		}
		address = net.JoinHostPort(bind, "8095")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil && c.Listen == "auto" {
		host, _, _ := net.SplitHostPort(address)
		listener, err = net.Listen("tcp", net.JoinHostPort(host, "0"))
	}
	if err != nil {
		a.close()
		return nil, fmt.Errorf("Dashboard bind address: %w", err)
	}
	a.listenAddress = listener.Addr().String()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	if c.AdvertiseHost != "auto" {
		host = c.AdvertiseHost
	} else {
		host = advertise(host)
	}
	a.dashboardURL = "http://" + net.JoinHostPort(host, port) + "/#token=" + token
	a.server = &http.Server{Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() {
		if err := a.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case a.fatal <- err:
			default:
			}
		}
	}()
	a.maintenanceDone = make(chan struct{})
	go func() {
		defer close(a.maintenanceDone)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		n := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n++
				if n%6 == 0 {
					if e := a.store.prune(time.Now()); e != nil {
						out.status("error", "GPS history retention failed: "+e.Error())
					}
				}
				a.publishStats()
			}
		}
	}()
	out.send(map[string]any{"type": "log", "level": "info", "message": fmt.Sprintf("GPS dashboard listening on %s; recorder source %s. Remote viewers must be able to reach the dashboard TCP port.", a.listenAddress, c.RecorderURL)})
	return a, nil
}
func (a *application) publishDashboard() {
	if a.config.DashboardURL == a.dashboardURL && a.config.DashboardListen == a.listenAddress {
		return
	}
	a.output.mu.Lock()
	defer a.output.mu.Unlock()
	a.output.request++
	a.output.encoder.Encode(map[string]any{"type": "settings.save", "request": a.output.request, "settings": map[string]string{"dashboard_url": a.dashboardURL, "dashboard_listen": a.listenAddress}})
}
func (a *application) writePositions() {
	defer close(a.writerDone)
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	batch := []Fix{}
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		saved, e := a.store.insert(context.Background(), batch)
		batch = nil
		if e != nil {
			a.output.status("error", "Cannot save GPS history: "+e.Error())
			select {
			case a.fatal <- e:
			default:
			}
			return false
		}
		if len(saved) > 0 {
			a.state.mu.Lock()
			a.state.lastSavedMs = time.Now().UnixMilli()
			a.state.mu.Unlock()
			a.hub.publish(map[string]any{"type": "gpsFix", "positions": saved})
			a.publishStats()
			a.publishState()
		}
		return true
	}
	for {
		select {
		case f, ok := <-a.fixes:
			if !ok {
				flush()
				return
			}
			batch = append(batch, f)
			if len(batch) >= 100 && !flush() {
				return
			}
		case <-ticker.C:
			if !flush() {
				return
			}
		}
	}
}
func (a *application) close() {
	a.closeOnce.Do(func() {
		a.cancel()
		<-a.collectorDone
		close(a.fixes)
		<-a.writerDone
		if a.maintenanceDone != nil {
			<-a.maintenanceDone
		}
		if a.server != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			a.server.Shutdown(ctx)
			cancel()
		}
		a.store.db.Close()
	})
}

type hostMessage struct {
	Type    string          `json:"type"`
	API     int             `json:"api"`
	Config  json.RawMessage `json:"config"`
	DataDir string          `json:"data_dir"`
}

func run(ctx context.Context, in <-chan hostMessage, out *protocolOutput) error {
	var hello hostMessage
	select {
	case <-ctx.Done():
		return nil
	case m, ok := <-in:
		if !ok {
			return errors.New("Expected TR Pro plugin hello on stdin")
		}
		hello = m
	}
	if hello.Type != "hello" || hello.API != 1 {
		return errors.New("Expected TR Pro plugin API 1 hello")
	}
	c, e := readConfig(hello.Config)
	if e != nil {
		return e
	}
	dir := hello.DataDir
	if dir == "" {
		dir = "."
	}
	app, e := startApplication(ctx, c, dir, out)
	if e != nil {
		return e
	}
	defer func() {
		if app != nil {
			app.close()
		}
	}()
	out.send(map[string]string{"type": "ready"})
	app.publishDashboard()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-app.fatal:
			return runtimeFailure{err}
		case m, ok := <-in:
			if !ok || m.Type == "shutdown" {
				return nil
			}
			if m.Type == "settings" {
				next, err := readConfig(m.Config)
				if err != nil {
					out.status("error", err.Error())
					continue
				}
				left, right := c, next
				left.DashboardURL = ""
				right.DashboardURL = ""
				left.DashboardListen = ""
				right.DashboardListen = ""
				if left == right {
					continue
				}
				app.close()
				app, e = startApplication(ctx, next, dir, out)
				if e != nil {
					return e
				}
				app.publishDashboard()
				c = next
			}
		}
	}
}

type runtimeFailure struct{ error }

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--describe":
			json.NewEncoder(os.Stdout).Encode(manifest())
			return
		case "--version":
			fmt.Println(version)
			return
		default:
			fmt.Fprintln(os.Stderr, "Run this executable as a TR Pro plugin, or use --describe")
			os.Exit(78)
		}
	}
	out := &protocolOutput{encoder: json.NewEncoder(os.Stdout)}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	messages := make(chan hostMessage)
	go func() {
		defer close(messages)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 65536), 16<<20)
		for scanner.Scan() {
			var m hostMessage
			if json.Unmarshal(scanner.Bytes(), &m) != nil {
				continue
			}
			select {
			case messages <- m:
			case <-ctx.Done():
				return
			}
		}
	}()
	if e := run(ctx, messages, out); e != nil {
		out.status("error", e.Error())
		fmt.Fprintln(os.Stderr, e)
		var failure runtimeFailure
		if errors.As(e, &failure) {
			os.Exit(1)
		}
		os.Exit(78)
	}
}
