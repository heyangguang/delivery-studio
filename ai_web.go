package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Looking things up on the web. An administrator turns it on and picks a search service: DuckDuckGo needs no key,
// Tavily, Brave and Bocha need one, and a self-hosted SearXNG keeps searching inside the network. Pages are fetched
// only from public addresses unless the administrator allows private ones, so the assistant cannot be used to look
// around the internal network.

type aiWeb struct {
	Enabled      bool   `json:"enabled"`
	Provider     string `json:"provider"` // duckduckgo | tavily | brave | bocha | searxng
	URL          string `json:"url,omitempty"`
	KeyEnc       string `json:"key_enc,omitempty"`
	AllowPrivate bool   `json:"allow_private"`
}

var webProviders = []map[string]any{
	{"id": "duckduckgo", "name": "DuckDuckGo", "key": false, "hint": "无需密钥；结果来自公开网页，偶尔会被限流"},
	{"id": "tavily", "name": "Tavily", "key": true, "hint": "专为 AI 设计的搜索接口，需要 API Key（tavily.com）"},
	{"id": "brave", "name": "Brave Search", "key": true, "hint": "需要 API Key（api.search.brave.com）"},
	{"id": "bocha", "name": "博查", "key": true, "hint": "国内可用，需要 API Key（open.bochaai.com）"},
	{"id": "searxng", "name": "SearXNG（自建）", "key": false, "url": true, "hint": "填写自建 SearXNG 的地址，需开启 JSON 输出"},
}

type webResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

func (s *storeServer) webSettings() aiWeb {
	w := s.aiLoad().Web
	if w.Provider == "" {
		w.Provider = "duckduckgo"
	}
	return w
}

// webReady says whether searching can work as configured.
func (w aiWeb) ready() bool {
	if !w.Enabled {
		return false
	}
	switch w.Provider {
	case "duckduckgo":
		return true
	case "searxng":
		return w.URL != ""
	}
	return w.KeyEnc != ""
}

const webUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 MiddlewareHub"

func (s *storeServer) webSearch(ctx context.Context, w aiWeb, query string, n int) ([]webResult, error) {
	if n <= 0 || n > 10 {
		n = 6
	}
	key, _ := s.aiDecrypt(w.KeyEnc)
	client := &http.Client{Timeout: 20 * time.Second}
	do := func(req *http.Request) ([]byte, error) {
		req.Header.Set("User-Agent", webUA)
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if resp.StatusCode/100 != 2 {
			return nil, fmt.Errorf("搜索服务返回 %d", resp.StatusCode)
		}
		return b, nil
	}
	var out []webResult
	switch w.Provider {
	case "tavily":
		body, _ := json.Marshal(map[string]any{"query": query, "max_results": n, "search_depth": "basic"})
		req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.tavily.com/search", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		b, err := do(req)
		if err != nil {
			return nil, err
		}
		var r struct {
			Results []struct{ Title, URL, Content string } `json:"results"`
		}
		_ = json.Unmarshal(b, &r)
		for _, x := range r.Results {
			out = append(out, webResult{x.Title, x.URL, x.Content})
		}
	case "brave":
		req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.search.brave.com/res/v1/web/search?count="+fmt.Sprint(n)+"&q="+url.QueryEscape(query), nil)
		req.Header.Set("X-Subscription-Token", key)
		req.Header.Set("Accept", "application/json")
		b, err := do(req)
		if err != nil {
			return nil, err
		}
		var r struct {
			Web struct {
				Results []struct {
					Title, URL, Description string
				} `json:"results"`
			} `json:"web"`
		}
		_ = json.Unmarshal(b, &r)
		for _, x := range r.Web.Results {
			out = append(out, webResult{stripTags(x.Title), x.URL, stripTags(x.Description)})
		}
	case "bocha":
		body, _ := json.Marshal(map[string]any{"query": query, "count": n, "summary": true})
		req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.bochaai.com/v1/web-search", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		b, err := do(req)
		if err != nil {
			return nil, err
		}
		var r struct {
			Data struct {
				WebPages struct {
					Value []struct {
						Name, URL, Snippet, Summary string
					} `json:"value"`
				} `json:"webPages"`
			} `json:"data"`
		}
		_ = json.Unmarshal(b, &r)
		for _, x := range r.Data.WebPages.Value {
			sn := x.Summary
			if sn == "" {
				sn = x.Snippet
			}
			out = append(out, webResult{x.Name, x.URL, sn})
		}
	case "searxng":
		req, _ := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(w.URL, "/")+"/search?format=json&q="+url.QueryEscape(query), nil)
		b, err := do(req)
		if err != nil {
			return nil, err
		}
		var r struct {
			Results []struct{ Title, URL, Content string } `json:"results"`
		}
		_ = json.Unmarshal(b, &r)
		for _, x := range r.Results {
			out = append(out, webResult{x.Title, x.URL, x.Content})
		}
	default: // duckduckgo
		req, _ := http.NewRequestWithContext(ctx, "GET", "https://html.duckduckgo.com/html/?q="+url.QueryEscape(query), nil)
		b, err := do(req)
		if err != nil {
			return nil, err
		}
		out = parseDDG(string(b))
	}
	if len(out) > n {
		out = out[:n]
	}
	return out, nil
}

var (
	reDDGResult  = regexp.MustCompile(`(?s)class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>`)
	reTag        = regexp.MustCompile(`(?s)<[^>]+>`)
	reSpace      = regexp.MustCompile(`[ \t\r\f\v]+`)
	reBlankLines = regexp.MustCompile(`\n\s*\n\s*\n+`)
	reDrop       = regexp.MustCompile(`(?is)<(script|style|noscript|svg|nav|footer|header|form|iframe)\b.*?</\s*(script|style|noscript|svg|nav|footer|header|form|iframe)\s*>`)
	reBlock      = regexp.MustCompile(`(?i)</?(p|div|br|li|ul|ol|h[1-6]|tr|table|pre|section|article|blockquote)\b[^>]*>`)
	reTitle      = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
)

func stripTags(s string) string {
	return strings.TrimSpace(html.UnescapeString(reTag.ReplaceAllString(s, "")))
}

func parseDDG(page string) []webResult {
	var out []webResult
	for _, m := range reDDGResult.FindAllStringSubmatch(page, -1) {
		link := html.UnescapeString(m[1])
		if u, err := url.Parse(link); err == nil {
			if real := u.Query().Get("uddg"); real != "" {
				link = real
			}
		}
		if strings.HasPrefix(link, "//") {
			link = "https:" + link
		}
		if strings.Contains(link, "duckduckgo.com/y.js") {
			continue // an advertisement
		}
		out = append(out, webResult{stripTags(m[2]), link, stripTags(m[3])})
	}
	return out
}

// htmlText turns a page into readable text: scripts, styles and page chrome dropped, blocks on their own lines.
func htmlText(page string) (string, string) {
	title := ""
	if m := reTitle.FindStringSubmatch(page); m != nil {
		title = stripTags(m[1])
	}
	t := reDrop.ReplaceAllString(page, "")
	t = reBlock.ReplaceAllString(t, "\n")
	t = html.UnescapeString(reTag.ReplaceAllString(t, ""))
	t = reSpace.ReplaceAllString(t, " ")
	lines := strings.Split(t, "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	t = reBlankLines.ReplaceAllString(strings.Join(lines, "\n"), "\n\n")
	return title, strings.TrimSpace(t)
}

var errPrivate = errors.New("这是内网地址，平台不允许 AI 访问（管理员可在联网搜索设置里放开）")

func privateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() || ip.Equal(net.IPv4bcast) ||
		// carrier-grade NAT and other non-public ranges
		(ip.To4() != nil && (ip.To4()[0] == 100 && ip.To4()[1]&0xc0 == 64 || ip.To4()[0] == 0))
}

// webFetch reads one page. The address is checked when the connection is made, not only when the name is looked
// up, so a name that resolves differently the second time cannot reach the internal network.
func (s *storeServer) webFetch(ctx context.Context, w aiWeb, raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("只能打开 http 或 https 网址")
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if !w.AllowPrivate {
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			host, _, _ := net.SplitHostPort(address)
			if ip := net.ParseIP(host); ip == nil || privateIP(ip) {
				return errPrivate
			}
			return nil
		}
	}
	client := &http.Client{Timeout: 25 * time.Second, Transport: &http.Transport{DialContext: dialer.DialContext, Proxy: nil, TLSHandshakeTimeout: 10 * time.Second},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("重定向太多")
			}
			return nil
		}}
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Accept", "text/html,text/plain,application/json;q=0.9,*/*;q=0.5")
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, errPrivate) || strings.Contains(err.Error(), errPrivate.Error()) {
			return "", errPrivate
		}
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("网页返回 %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 3<<20))
	ct := resp.Header.Get("Content-Type")
	body := string(b)
	title := ""
	switch {
	case strings.Contains(ct, "html") || strings.HasPrefix(strings.TrimSpace(body), "<"):
		title, body = htmlText(body)
	case strings.Contains(ct, "json"), strings.HasPrefix(ct, "text/"):
	default:
		return "", fmt.Errorf("这个网址不是网页或文本（%s）", ct)
	}
	out := "网址：" + resp.Request.URL.String() + "\n"
	if title != "" {
		out += "标题：" + title + "\n"
	}
	out += "\n" + body
	if len(out) > aiMaxResult {
		cut := out[:aiMaxResult]
		for len(cut) > 0 && !strings.HasSuffix(cut, "\n") && len(out)-len(cut) < 2000 {
			cut = cut[:len(cut)-1]
		}
		out = cut + "\n…（网页较长，已截断）"
	}
	return out, nil
}

func webTools() []aiToolDef {
	return []aiToolDef{
		{"web_search", "在互联网上搜索。平台和交付里查不到、或需要最新资料（版本说明、已知问题、官方文档、报错含义）时使用。返回标题、网址和摘要。", map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string", "description": "搜索词，简洁具体；中英文都可以，技术报错原文用英文搜效果更好"}, "count": map[string]any{"type": "integer", "description": "返回几条，默认 6"}}, "required": []string{"query"}}},
		{"web_fetch", "打开一个网页，读取正文。用于读 web_search 找到的文档或文章。", map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string", "description": "完整网址"}}, "required": []string{"url"}}},
	}
}

func (s *storeServer) runWeb(name, args string) string {
	w := s.webSettings()
	if !w.ready() {
		return "联网搜索没有开启。"
	}
	var a struct {
		Query string `json:"query"`
		Count int    `json:"count"`
		URL   string `json:"url"`
	}
	_ = json.Unmarshal([]byte(args), &a)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	if name == "web_fetch" {
		out, err := s.webFetch(ctx, w, a.URL)
		if err != nil {
			return "网页打开失败：" + err.Error()
		}
		return aiScrub(out)
	}
	if strings.TrimSpace(a.Query) == "" {
		return "没有搜索词。"
	}
	res, err := s.webSearch(ctx, w, a.Query, a.Count)
	if err != nil {
		return "搜索失败：" + err.Error()
	}
	if len(res) == 0 {
		return "没有搜到结果，换个说法试试。"
	}
	var b strings.Builder
	for i, r := range res {
		fmt.Fprintf(&b, "%d. %s\n   %s\n   %s\n", i+1, r.Title, r.URL, truncRunes(r.Snippet, 300))
	}
	return aiScrub(b.String())
}

func (s *storeServer) handleWebSettings(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	switch {
	case len(parts) == 1 && r.Method == "GET":
		ws := s.webSettings()
		ws.KeyEnc = map[bool]string{true: "set", false: ""}[ws.KeyEnc != ""]
		s.writeJSON(w, 200, map[string]any{"web": ws, "providers": webProviders})
	case len(parts) == 1 && r.Method == "PUT":
		var in struct {
			aiWeb
			Key string `json:"key"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		ok := false
		for _, p := range webProviders {
			ok = ok || p["id"] == in.Provider
		}
		if !ok {
			s.fail(w, 400, "不支持这个搜索服务")
			return
		}
		if in.Provider == "searxng" {
			if err := validProviderURL(in.URL); err != nil {
				s.fail(w, 400, err.Error())
				return
			}
		}
		aiMu.Lock()
		st := s.aiLoad()
		old := st.Web
		next := in.aiWeb
		next.KeyEnc = old.KeyEnc
		if old.Provider != next.Provider {
			next.KeyEnc = ""
		}
		if k := strings.TrimSpace(in.Key); k != "" {
			enc, err := s.aiEncrypt(k)
			if err != nil {
				aiMu.Unlock()
				s.fail(w, 500, "密钥无法保存")
				return
			}
			next.KeyEnc = enc
		}
		st.Web = next
		err := s.aiSave(st)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "ai-web", session.User, next.Provider)
		s.writeJSON(w, 200, map[string]bool{"ok": true, "ready": next.ready()})
	case len(parts) == 2 && parts[1] == "test" && r.Method == "POST":
		var in struct {
			Query string `json:"query"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&in)
		if strings.TrimSpace(in.Query) == "" {
			in.Query = "etcd database space exceeded"
		}
		ws := s.webSettings()
		ws.Enabled = true
		if !ws.ready() {
			s.fail(w, 409, "先选择搜索服务并填好密钥或地址")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		t0 := time.Now()
		res, err := s.webSearch(ctx, ws, in.Query, 5)
		if err != nil {
			s.fail(w, 502, err.Error())
			return
		}
		s.writeJSON(w, 200, map[string]any{"results": res, "ms": time.Since(t0).Milliseconds()})
	default:
		s.fail(w, 404, "接口不存在")
	}
}
