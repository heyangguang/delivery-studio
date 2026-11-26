package server

import (
	"bufio"
	"encoding/json"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Every model call the platform makes, with who asked, for what, how many tokens (and of those how many came from the
// vendor's cache), how long the first token and the whole answer took, and what it cost at the prices set on the
// provider. One file per month of JSON lines, so a busy month never means rewriting everything.

type aiUsage struct {
	ID         string      `json:"id"`
	At         string      `json:"at"`
	User       string      `json:"user"`
	IP         string      `json:"ip,omitempty"`
	Feature    string      `json:"feature"`
	Job        string      `json:"job,omitempty"`    // delivery id, or component name for the workbench
	Target     string      `json:"target,omitempty"` // what the person was looking at: cluster or component
	Session    string      `json:"session,omitempty"`
	Provider   string      `json:"provider"`
	Model      string      `json:"model"`
	Endpoint   string      `json:"endpoint,omitempty"`
	HTTPStatus int         `json:"http_status,omitempty"`
	ResponseID string      `json:"response_id,omitempty"`
	Stream     bool        `json:"stream,omitempty"`
	In         int         `json:"in"`
	Out        int         `json:"out"`
	Cached     int         `json:"cached,omitempty"`
	Reasoning  int         `json:"reasoning,omitempty"`
	Rounds     int         `json:"rounds,omitempty"`
	Tools      int         `json:"tools,omitempty"`
	FirstMS    int64       `json:"first_ms,omitempty"`
	MS         int64       `json:"ms"`
	OK         bool        `json:"ok"`
	Error      string      `json:"error,omitempty"`
	Failover   bool        `json:"failover,omitempty"`
	Cost       float64     `json:"cost,omitempty"`
	Currency   string      `json:"currency,omitempty"`
	Diag       *aiCallDiag `json:"diag,omitempty"`
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *storeServer) usageDir() string { return s.aiFile("ai-usage") }

func resolveUsageEndpoint(p aiProvider, d *aiCallDiag) string {
	if d != nil {
		if d.FallbackUsed != "" || d.API == "chat" || strings.HasSuffix(d.Endpoint, "/chat/completions") {
			return "/chat/completions"
		}
		if d.API == "responses" || strings.HasSuffix(d.Endpoint, "/responses") {
			return "/responses"
		}
	}
	if p.API == "responses" {
		return "/responses"
	}
	return "/chat/completions"
}

func (u *aiUsage) applyDiag(d *aiCallDiag) {
	if u == nil || d == nil {
		return
	}
	u.Diag = d
	if u.HTTPStatus == 0 && d.HTTPStatus > 0 {
		u.HTTPStatus = d.HTTPStatus
	}
	if u.ResponseID == "" && d.ResponseID != "" {
		u.ResponseID = d.ResponseID
	}
	if u.In == 0 && d.InTokens > 0 {
		u.In = d.InTokens
	}
	if u.Out == 0 && d.OutTokens > 0 {
		u.Out = d.OutTokens
	}
	if u.Cached == 0 && d.CachedTokens > 0 {
		u.Cached = d.CachedTokens
	}
}

// usageFrom fills in what every record of a reply shares.
func usageFrom(p aiProvider, rep aiReply) aiUsage {
	u := aiUsage{
		Provider:  p.Name,
		Model:     p.Model,
		Endpoint:  resolveUsageEndpoint(p, rep.Diag),
		Stream:    true,
		In:        rep.In,
		Out:       rep.Out,
		Cached:    rep.Cached,
		Reasoning: rep.Reasoning,
		Rounds:    rep.Rounds,
		FirstMS:   rep.FirstMS,
	}
	if rep.Diag != nil {
		u.applyDiag(rep.Diag)
	}
	return u
}

func (s *storeServer) priceOf(p aiProvider, m aiModel, u aiUsage) (float64, string) {
	in, cached, out, cur := s.modelPrice(p, m)
	if cur == "" {
		return 0, ""
	}
	if cached == 0 {
		cached = in
	}
	cost := (float64(u.In-u.Cached)*in + float64(u.Cached)*cached + float64(u.Out)*out) / 1e6
	return math.Round(cost*1e6) / 1e6, cur
}

func (s *storeServer) aiRecordUsage(u aiUsage) {
	if u.Diag != nil {
		u.applyDiag(u.Diag)
		// Keep full diagnostic payload only when the call failed or triggered protocol fallback.
		if u.OK && u.Diag.FallbackUsed == "" {
			u.Diag = nil
		}
	}
	if u.ID == "" {
		u.ID = randomStoreToken(6)
	}
	if u.At == "" {
		u.At = time.Now().UTC().Format(time.RFC3339Nano)
	}
	for _, p := range s.aiLoad().Providers {
		if m, ok := p.model(u.Model); ok && p.Name == u.Provider {
			u.Cost, u.Currency = s.priceOf(p, m, u)
		}
	}
	if s.repo != nil {
		_ = s.repo.saveAIUsage(u)
		return
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	s.migrateUsage()
	if err := os.MkdirAll(s.usageDir(), 0o700); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(s.usageDir(), u.At[:7]+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_ = json.NewEncoder(f).Encode(u)
}

// migrateUsage moves the single file of earlier versions into the monthly files. Callers hold aiMu.
func (s *storeServer) migrateUsage() {
	old := s.aiFile("ai-usage.json")
	b, err := os.ReadFile(old)
	if err != nil {
		return
	}
	var all []aiUsage
	_ = json.Unmarshal(b, &all)
	_ = os.MkdirAll(s.usageDir(), 0o700)
	for _, u := range all {
		if len(u.At) < 7 {
			continue
		}
		if u.ID == "" {
			u.ID = randomStoreToken(6)
		}
		if f, err := os.OpenFile(filepath.Join(s.usageDir(), u.At[:7]+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			_ = json.NewEncoder(f).Encode(u)
			f.Close()
		}
	}
	_ = os.Rename(old, old+".migrated")
}

// usageBetween reads the records in [from, to), oldest first.
func (s *storeServer) usageBetween(from, to time.Time) []aiUsage {
	var out []aiUsage
	if s.repo != nil {
		rows, _ := s.repo.listAIUsageBetween(from.UTC().Format(time.RFC3339Nano), to.UTC().Format(time.RFC3339Nano))
		for _, u := range rows {
			t, err := time.Parse(time.RFC3339Nano, u.At)
			if err == nil && !t.Before(from) && t.Before(to) {
				out = append(out, u)
			}
		}
	} else {
		aiMu.Lock()
		s.migrateUsage()
		aiMu.Unlock()
		for m := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, time.UTC); m.Before(to); m = m.AddDate(0, 1, 0) {
			f, err := os.Open(filepath.Join(s.usageDir(), m.Format("2006-01")+".jsonl"))
			if err != nil {
				continue
			}
			sc := bufio.NewScanner(f)
			sc.Buffer(make([]byte, 64<<10), 1<<20)
			for sc.Scan() {
				var u aiUsage
				if json.Unmarshal(sc.Bytes(), &u) != nil {
					continue
				}
				t, err := time.Parse(time.RFC3339Nano, u.At)
				if err == nil && !t.Before(from) && t.Before(to) {
					out = append(out, u)
				}
			}
			f.Close()
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
	// calls made before a price was known are priced now, so adding a price shows in the history too
	providers := s.aiLoad().Providers
	for i := range out {
		if out[i].Cost != 0 || (out[i].In == 0 && out[i].Out == 0) {
			continue
		}
		for _, p := range providers {
			if m, ok := p.model(out[i].Model); ok && p.Name == out[i].Provider {
				out[i].Cost, out[i].Currency = s.priceOf(p, m, out[i])
			}
		}
	}
	return out
}

// aiCallsThisMonth counts a person's calls, for the monthly limit.
func (s *storeServer) aiCallsThisMonth(user string) int {
	now := time.Now().UTC()
	n := 0
	for _, u := range s.usageBetween(time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC), now.Add(time.Minute)) {
		if u.User == user {
			n++
		}
	}
	return n
}

// usageQuery reads the time range and filters shared by the list and the statistics.
func (s *storeServer) usageQuery(r *http.Request) (time.Time, time.Time, func(aiUsage) bool) {
	q := r.URL.Query()
	to := time.Now().UTC().Add(time.Minute)
	from := to.AddDate(0, 0, -7)
	if t, err := time.Parse(time.RFC3339, q.Get("from")); err == nil {
		from = t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, q.Get("to")); err == nil {
		to = t.UTC()
	}
	if to.Sub(from) > 400*24*time.Hour {
		from = to.AddDate(0, 0, -400)
	}
	user, feature, model, status, text := q.Get("user"), q.Get("feature"), q.Get("model"), q.Get("status"), strings.ToLower(strings.TrimSpace(q.Get("q")))
	keep := func(u aiUsage) bool {
		switch {
		case user != "" && u.User != user,
			feature != "" && u.Feature != feature,
			model != "" && u.Model != model,
			status == "ok" && !u.OK,
			status == "error" && u.OK:
			return false
		}
		if text != "" {
			hay := strings.ToLower(u.User + " " + u.IP + " " + u.Target + " " + u.Job + " " + u.Provider + " " + u.Model + " " + u.Error)
			return strings.Contains(hay, text)
		}
		return true
	}
	return from, to, keep
}

func (s *storeServer) aiUsageList(w http.ResponseWriter, r *http.Request) {
	from, to, keep := s.usageQuery(r)
	all := s.usageBetween(from, to)
	rows := make([]aiUsage, 0, len(all))
	users, models := map[string]bool{}, map[string]bool{}
	for i := len(all) - 1; i >= 0; i-- {
		users[all[i].User] = true
		models[all[i].Model] = true
		if keep(all[i]) {
			rows = append(rows, all[i])
		}
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size <= 0 || size > 200 {
		size = 50
	}
	if page < 1 {
		page = 1
	}
	total := len(rows)
	start := min((page-1)*size, total)
	s.writeJSON(w, 200, map[string]any{"rows": rows[start:min(start+size, total)], "total": total, "page": page, "size": size, "users": sortedKeys(users), "models": sortedKeys(models)})
}

type usageAgg struct {
	Key     string  `json:"key"`
	Label   string  `json:"label,omitempty"`
	Calls   int     `json:"calls"`
	Errors  int     `json:"errors"`
	In      int     `json:"in"`
	Out     int     `json:"out"`
	Cached  int     `json:"cached"`
	Cost    float64 `json:"cost"`
	MS      int64   `json:"ms"`       // total, for the average
	FirstMS int64   `json:"first_ms"` // total over calls that reported it
	FirstN  int     `json:"first_n"`
}

func (a *usageAgg) add(u aiUsage) {
	a.Calls++
	if !u.OK {
		a.Errors++
	}
	a.In += u.In
	a.Out += u.Out
	a.Cached += u.Cached
	a.Cost += u.Cost
	a.MS += u.MS
	if u.FirstMS > 0 {
		a.FirstMS += u.FirstMS
		a.FirstN++
	}
}

func (s *storeServer) aiUsageStats(w http.ResponseWriter, r *http.Request) {
	from, to, keep := s.usageQuery(r)
	loc := time.Local
	if tz, err := time.LoadLocation(r.URL.Query().Get("tz")); err == nil {
		loc = tz
	}
	hourly := to.Sub(from) <= 48*time.Hour
	var total usageAgg
	series := map[string]*usageAgg{}
	group := func(m map[string]*usageAgg, k string) *usageAgg {
		if m[k] == nil {
			m[k] = &usageAgg{Key: k}
		}
		return m[k]
	}
	byUser, byModel, byFeature, byTarget := map[string]*usageAgg{}, map[string]*usageAgg{}, map[string]*usageAgg{}, map[string]*usageAgg{}
	ps := s.loadPriceSettings()
	for _, u := range s.usageBetween(from, to) {
		if !keep(u) {
			continue
		}
		u.Cost, u.Currency = ps.convert(u.Cost, u.Currency), ps.Display
		t, _ := time.Parse(time.RFC3339Nano, u.At)
		bucket := t.In(loc).Format("2006-01-02")
		if hourly {
			bucket = t.In(loc).Format("2006-01-02 15:00")
		}
		total.add(u)
		group(series, bucket).add(u)
		group(byUser, u.User).add(u)
		group(byModel, u.Model).add(u)
		group(byFeature, u.Feature).add(u)
		if u.Target != "" || u.Job != "" {
			k := u.Job
			x := group(byTarget, k)
			x.Label = u.Target
			x.add(u)
		}
	}
	// every bucket of the range, empty ones included, so the chart has no gaps that look like data
	var points []usageAgg
	step := 24 * time.Hour
	format := "2006-01-02"
	cur := time.Date(from.In(loc).Year(), from.In(loc).Month(), from.In(loc).Day(), 0, 0, 0, 0, loc)
	if hourly {
		step, format = time.Hour, "2006-01-02 15:00"
		cur = from.In(loc).Truncate(time.Hour)
	}
	for n := 0; cur.Before(to) && n < 800; cur, n = cur.Add(step), n+1 {
		k := cur.Format(format)
		if x := series[k]; x != nil {
			points = append(points, *x)
		} else {
			points = append(points, usageAgg{Key: k})
		}
	}
	list := func(m map[string]*usageAgg) []usageAgg {
		out := make([]usageAgg, 0, len(m))
		for _, x := range m {
			out = append(out, *x)
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Cost != out[j].Cost {
				return out[i].Cost > out[j].Cost
			}
			return out[i].In+out[i].Out > out[j].In+out[j].Out
		})
		if len(out) > 20 {
			out = out[:20]
		}
		return out
	}
	s.writeJSON(w, 200, map[string]any{"total": total, "series": points, "hourly": hourly, "by_user": list(byUser), "by_model": list(byModel), "by_feature": list(byFeature), "by_target": list(byTarget), "currency": ps.Display})
}
