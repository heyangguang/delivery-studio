package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
)

// What each kind of message says. The platform ships a wording for every event; an administrator may change the title
// and body, using the variables the event provides. Anything not changed keeps the shipped wording.

type notifyVar struct {
	Key  string `json:"key"`
	Desc string `json:"desc"`
}

type notifyEvent struct {
	ID      string            `json:"id"`
	Group   string            `json:"group"`
	Title   string            `json:"title"` // what the event is called in the settings
	Desc    string            `json:"desc"`
	Vars    []notifyVar       `json:"vars"`
	Default notifyTpl         `json:"default"`
	Sample  map[string]string `json:"sample"`
}

type notifyTpl struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

var notifyEvents = []notifyEvent{
	{ID: "test", Group: "系统", Title: "测试消息", Desc: "在渠道里点“发送测试”时发出的消息。",
		Vars:    []notifyVar{{"channel", "渠道名称"}, {"link", "平台地址"}},
		Default: notifyTpl{Title: "Kyndryl Delivery Studio 测试消息", Body: "这条消息说明通知渠道「{{channel}}」可以正常送达。\n{{link}}"},
		Sample:  map[string]string{"channel": "运维值班群", "link": "https://hub.example"}},
}

func notifyEventByID(id string) (notifyEvent, bool) {
	for _, e := range notifyEvents {
		if e.ID == id {
			return e, true
		}
	}
	return notifyEvent{}, false
}

func (s *storeServer) notifyTemplates() map[string]notifyTpl {
	out := map[string]notifyTpl{}
	_ = s.loadSettingDoc("notify_templates", filepath.Join(s.settingsDir(), "notify-templates.json"), &out)
	if out == nil {
		out = map[string]notifyTpl{}
	}
	return out
}

func fillTemplate(t string, vars map[string]string) string {
	for k, v := range vars {
		t = strings.ReplaceAll(t, "{{"+k+"}}", v)
	}
	return t
}

// compose builds the message for an event from its template (the administrator's, else the shipped one).
func (s *storeServer) compose(event string, vars map[string]string, link string) notifyMessage {
	ev, ok := notifyEventByID(event)
	if !ok {
		return notifyMessage{Event: event, Title: event, Link: link}
	}
	tpl := ev.Default
	if c, ok := s.notifyTemplates()[event]; ok && (c.Title != "" || c.Body != "") {
		tpl = c
	}
	if vars == nil {
		vars = map[string]string{}
	}
	vars["link"] = link
	body := strings.TrimSpace(fillTemplate(tpl.Body, vars))
	// the link is carried by the message itself in every channel format; do not repeat it in the text
	var lines []string
	for _, l := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(l); t != "" && t != link {
			lines = append(lines, t)
		}
	}
	return notifyMessage{Event: event, Title: strings.TrimSpace(fillTemplate(tpl.Title, vars)), Lines: lines, Link: link}
}

func (s *storeServer) handleNotifyTemplates(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"events": localizedNotifyEvents(wLang(w), notifyEvents), "custom": s.notifyTemplates()})
	case len(parts) == 1 && r.Method == "PUT":
		ev, ok := notifyEventByID(parts[0])
		if !ok {
			s.fail(w, 404, "没有这个事件")
			return
		}
		var in notifyTpl
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil || len([]rune(in.Title)) > 120 || len([]rune(in.Body)) > 2000 {
			s.fail(w, 400, "标题最多 120 字，正文最多 2000 字")
			return
		}
		known := map[string]bool{}
		for _, v := range ev.Vars {
			known[v.Key] = true
		}
		for _, text := range []string{in.Title, in.Body} {
			for _, part := range strings.Split(text, "{{")[1:] {
				if end := strings.Index(part, "}}"); end < 0 || !known[part[:end]] {
					s.fail(w, 400, "模板里有不认识的变量，可用的变量见右侧列表")
					return
				}
			}
		}
		notifyMu.Lock()
		all := s.notifyTemplates()
		if strings.TrimSpace(in.Title) == "" && strings.TrimSpace(in.Body) == "" {
			delete(all, parts[0]) // empty means back to the shipped wording
		} else {
			all[parts[0]] = in
		}
		err := s.saveSettingDoc("notify_templates", filepath.Join(s.settingsDir(), "notify-templates.json"), all)
		notifyMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "notify-template", session.User, parts[0])
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 2 && parts[1] == "test" && r.Method == "POST":
		ev, ok := notifyEventByID(parts[0])
		var in struct {
			Channel string `json:"channel"`
		}
		if !ok || json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		for _, c := range s.channels() {
			if c.ID != in.Channel {
				continue
			}
			vars := map[string]string{}
			for k, v := range ev.Sample {
				vars[k] = v
			}
			vars["channel"] = c.Name
			m := s.compose(ev.ID, vars, s.cfg.PublicURL)
			m.Title = tr(wLang(w), "【示例】", "[Sample] ") + m.Title
			err := sendTo(c, m)
			a := notifyAttempt{At: nowStamp(), Channel: c.ID, Name: c.Name, Event: ev.ID, Title: m.Title, OK: err == nil}
			if err != nil {
				a.Error = err.Error()
			}
			s.logAttempt(a)
			if err != nil {
				s.fail(w, 502, err.Error())
				return
			}
			s.writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		s.fail(w, 404, "渠道不存在")
	default:
		s.fail(w, 404, "接口不存在")
	}
}
