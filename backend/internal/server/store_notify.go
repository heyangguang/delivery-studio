package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Notification channels are a platform setting: an administrator adds the places messages can go (a generic webhook,
// a WeCom, DingTalk or Feishu group robot), and each part of the platform that has something to say (security today,
// others later) chooses which channels to use. Every attempt is logged so a silent channel can be noticed.

type notifyChannel struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // webhook | wecom | dingtalk | feishu
	URL     string `json:"url"`
	Secret  string `json:"secret,omitempty"` // signing secret for DingTalk and Feishu robots
	Enabled bool   `json:"enabled"`
	Created string `json:"created"`
}

type notifyAttempt struct {
	At      string `json:"at"`
	Channel string `json:"channel"`
	Name    string `json:"name"`
	Event   string `json:"event"`
	Title   string `json:"title"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

// notifyMessage is what a part of the platform wants to say; each channel formats it its own way.
type notifyMessage struct {
	Event string   `json:"event"`
	Title string   `json:"title"`
	Lines []string `json:"lines"`
	Link  string   `json:"link,omitempty"`
}

var notifyKinds = map[string]string{"webhook": "通用 Webhook", "wecom": "企业微信机器人", "dingtalk": "钉钉机器人", "feishu": "飞书机器人"}

var notifyMu sync.Mutex

func (s *storeServer) settingsDir() string { return filepath.Join(s.cfg.DataDir, "settings") }

func (s *storeServer) channels() []notifyChannel {
	notifyMu.Lock()
	defer notifyMu.Unlock()
	return s.readChannels()
}

func (s *storeServer) readChannels() []notifyChannel {
	var out []notifyChannel
	_ = s.loadSettingDoc("notify_channels", filepath.Join(s.settingsDir(), "channels.json"), &out)
	if out == nil {
		out = []notifyChannel{}
	}
	return out
}

func (s *storeServer) saveChannels(list []notifyChannel) error {
	if list == nil {
		list = []notifyChannel{}
	}
	return s.saveSettingDoc("notify_channels", filepath.Join(s.settingsDir(), "channels.json"), list)
}

func (s *storeServer) notifyLog() []notifyAttempt {
	notifyMu.Lock()
	defer notifyMu.Unlock()
	var out []notifyAttempt
	_ = s.loadSettingDoc("notify_log", filepath.Join(s.settingsDir(), "notify-log.json"), &out)
	if out == nil {
		out = []notifyAttempt{}
	}
	return out
}

func (s *storeServer) logAttempt(a notifyAttempt) {
	notifyMu.Lock()
	defer notifyMu.Unlock()
	var all []notifyAttempt
	path := filepath.Join(s.settingsDir(), "notify-log.json")
	_ = s.loadSettingDoc("notify_log", path, &all)
	all = append([]notifyAttempt{a}, all...)
	if len(all) > 200 {
		all = all[:200]
	}
	_ = s.saveSettingDoc("notify_log", path, all)
}

var notifyClient = &http.Client{Timeout: 10 * time.Second}

// sendTo formats a message for one channel and posts it.
func sendTo(c notifyChannel, m notifyMessage) error {
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return errors.New("地址无效：需要 http 或 https 地址")
	}
	text := m.Title
	if len(m.Lines) > 0 {
		text += "\n" + strings.Join(m.Lines, "\n")
	}
	if m.Link != "" {
		text += "\n" + m.Link
	}
	md := "**" + m.Title + "**\n\n"
	for _, l := range m.Lines {
		md += "> " + l + "\n"
	}
	if m.Link != "" {
		md += "\n[在平台中查看](" + m.Link + ")"
	}
	var body any
	target := c.URL
	switch c.Kind {
	case "wecom":
		body = map[string]any{"msgtype": "markdown", "markdown": map[string]string{"content": md}}
	case "dingtalk":
		body = map[string]any{"msgtype": "markdown", "markdown": map[string]string{"title": m.Title, "text": md}}
		if c.Secret != "" {
			ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
			h := hmac.New(sha256.New, []byte(c.Secret))
			h.Write([]byte(ts + "\n" + c.Secret))
			sign := url.QueryEscape(base64.StdEncoding.EncodeToString(h.Sum(nil)))
			sep := "?"
			if strings.Contains(target, "?") {
				sep = "&"
			}
			target += sep + "timestamp=" + ts + "&sign=" + sign
		}
	case "feishu":
		b := map[string]any{"msg_type": "text", "content": map[string]string{"text": text}}
		if c.Secret != "" {
			ts := strconv.FormatInt(time.Now().Unix(), 10)
			h := hmac.New(sha256.New, []byte(ts+"\n"+c.Secret))
			b["timestamp"], b["sign"] = ts, base64.StdEncoding.EncodeToString(h.Sum(nil))
		}
		body = b
	default:
		body = map[string]any{"event": m.Event, "title": m.Title, "lines": m.Lines, "text": text, "link": m.Link, "at": time.Now().UTC().Format(time.RFC3339), "source": "middleware-hub"}
	}
	payload, _ := json.Marshal(body)
	resp, err := notifyClient.Post(target, "application/json", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("无法送达：%v", err)
	}
	defer resp.Body.Close()
	reply, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("对方返回 %d：%s", resp.StatusCode, strings.TrimSpace(string(reply)))
	}
	// the robots answer 200 with an error code in the body
	var r struct {
		ErrCode *int   `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
		Code    *int   `json:"code"`
		Msg     string `json:"msg"`
	}
	if json.Unmarshal(reply, &r) == nil {
		if r.ErrCode != nil && *r.ErrCode != 0 {
			return fmt.Errorf("机器人拒绝：%d %s", *r.ErrCode, r.ErrMsg)
		}
		if c.Kind == "feishu" && r.Code != nil && *r.Code != 0 {
			return fmt.Errorf("机器人拒绝：%d %s", *r.Code, r.Msg)
		}
	}
	return nil
}

// notify sends a message to the chosen channels in the background and logs each attempt.
func (s *storeServer) notify(ids []string, m notifyMessage) {
	if len(ids) == 0 {
		return
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	for _, c := range s.channels() {
		if !want[c.ID] || !c.Enabled {
			continue
		}
		c := c
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			err := sendTo(c, m)
			a := notifyAttempt{At: nowStamp(), Channel: c.ID, Name: c.Name, Event: m.Event, Title: m.Title, OK: err == nil}
			if err != nil {
				a.Error = err.Error()
			}
			s.logAttempt(a)
		}()
	}
}

func (s *storeServer) handleSettings(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/settings"), "/")
	parts := strings.Split(rest, "/")
	if !s.can(session.User, "settings.notify") {
		s.fail(w, 403, "没有「通知设置」权限")
		return
	}
	switch {
	case rest == "templates" || strings.HasPrefix(rest, "templates/"):
		s.handleNotifyTemplates(w, r, session, parts[1:])
	case rest == "channels" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"channels": s.channels(), "kinds": localizedNotifyKinds(wLang(w)), "log": s.notifyLog()})
	case rest == "channels" && r.Method == "POST", len(parts) == 2 && parts[0] == "channels" && r.Method == "PUT":
		var in notifyChannel
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in); err != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		in.Name, in.URL, in.Secret = strings.TrimSpace(in.Name), strings.TrimSpace(in.URL), strings.TrimSpace(in.Secret)
		if _, ok := notifyKinds[in.Kind]; !ok || in.Name == "" || len([]rune(in.Name)) > 40 {
			s.fail(w, 400, "请填写名称并选择类型")
			return
		}
		if u, err := url.Parse(in.URL); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			s.fail(w, 400, "地址需要是 http 或 https 开头的完整地址")
			return
		}
		notifyMu.Lock()
		all := s.readChannels()
		if r.Method == "POST" {
			in.ID, in.Created = randomStoreToken(6), nowStamp()
			all = append(all, in)
		} else {
			found := false
			for i := range all {
				if all[i].ID == parts[1] {
					in.ID, in.Created = all[i].ID, all[i].Created
					all[i] = in
					found = true
				}
			}
			if !found {
				notifyMu.Unlock()
				s.fail(w, 404, "渠道不存在")
				return
			}
		}
		err := s.saveChannels(all)
		notifyMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "notify-channel", session.User, in.ID)
		s.writeJSON(w, 200, in)
	case len(parts) == 2 && parts[0] == "channels" && r.Method == "DELETE":
		notifyMu.Lock()
		all := s.readChannels()
		keep := all[:0]
		for _, c := range all {
			if c.ID != parts[1] {
				keep = append(keep, c)
			}
		}
		err := s.saveChannels(keep)
		notifyMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "notify-channel-delete", session.User, parts[1])
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 3 && parts[0] == "channels" && parts[2] == "test" && r.Method == "POST":
		var ch *notifyChannel
		for _, c := range s.channels() {
			if c.ID == parts[1] {
				c := c
				ch = &c
			}
		}
		if ch == nil {
			s.fail(w, 404, "渠道不存在")
			return
		}
		m := s.compose("test", map[string]string{"channel": ch.Name}, s.cfg.PublicURL)
		err := sendTo(*ch, m)
		a := notifyAttempt{At: nowStamp(), Channel: ch.ID, Name: ch.Name, Event: "test", Title: m.Title, OK: err == nil}
		if err != nil {
			a.Error = err.Error()
		}
		s.logAttempt(a)
		if err != nil {
			s.fail(w, 502, err.Error())
			return
		}
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		s.fail(w, 404, "接口不存在")
	}
}
