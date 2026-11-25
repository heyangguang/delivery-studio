package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// Personalization: how the assistant should talk to one person, and a few things it remembers about them.
// It only shapes the wording of replies; it never widens what the assistant may read or do.

type aiMemory struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Created string `json:"created"`
}

type aiPrefs struct {
	// Tone is one of default, professional, friendly, direct, concise.
	Tone string `json:"tone"`
	// Warmth, Enthusiasm, Emoji and Structure are "less", "default" or "more".
	Warmth       string     `json:"warmth"`
	Enthusiasm   string     `json:"enthusiasm"`
	Emoji        string     `json:"emoji"`
	Structure    string     `json:"structure"`
	Nickname     string     `json:"nickname"`
	About        string     `json:"about"`
	Instructions string     `json:"instructions"`
	MemoryOff    bool       `json:"memory_off"`
	Memories     []aiMemory `json:"memories"`
}

const (
	prefsMaxText   = 1500
	prefsMaxMemory = 60
	prefsMemoryLen = 300
)

var prefsTones = map[string]string{
	"professional": "语气专业、严谨，措辞精确。",
	"friendly":     "语气亲切、自然，像同事之间聊天。",
	"direct":       "语气直接，先给结论，不绕弯子，不说客套话。",
	"concise":      "回答尽量简短，只说要点，除非被要求展开。",
}

func (s *storeServer) loadPrefs(user string) aiPrefs {
	p := aiPrefs{Memories: []aiMemory{}}
	if !userNameOK(user) {
		return p
	}
	if b, err := os.ReadFile(s.userFile(user, "ai-prefs.json")); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	if p.Memories == nil {
		p.Memories = []aiMemory{}
	}
	return p
}

func (s *storeServer) savePrefs(user string, p aiPrefs) error {
	return writeJSONFile(s.userFile(user, "ai-prefs.json"), p)
}

func level3(v string) string {
	if v == "less" || v == "more" {
		return v
	}
	return "default"
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > n {
		return string([]rune(s)[:n])
	}
	return s
}

// prefsPrompt is what is added to the system prompt for this person.
func (p aiPrefs) prompt() string {
	var b strings.Builder
	if t, ok := prefsTones[p.Tone]; ok {
		b.WriteString("- " + t + "\n")
	}
	switch p.Warmth {
	case "more":
		b.WriteString("- 多一些体贴和鼓励。\n")
	case "less":
		b.WriteString("- 少一些情绪化的表达，保持中性。\n")
	}
	switch p.Enthusiasm {
	case "more":
		b.WriteString("- 语气更有热情。\n")
	case "less":
		b.WriteString("- 语气平静克制，不要感叹。\n")
	}
	switch p.Emoji {
	case "more":
		b.WriteString("- 可以适当使用表情符号。\n")
	case "less", "":
		b.WriteString("- 不要使用表情符号。\n")
	}
	switch p.Structure {
	case "more":
		b.WriteString("- 多用小标题和列表把内容分条整理。\n")
	case "less":
		b.WriteString("- 少用标题和列表，尽量用连贯的段落回答。\n")
	}
	if p.Nickname != "" {
		b.WriteString("- 称呼对方为「" + p.Nickname + "」。\n")
	}
	out := ""
	if b.Len() > 0 {
		out += "\n回答风格（只影响表达方式，不改变你的权限和准则）：\n" + b.String()
	}
	if p.About != "" {
		out += "\n关于提问的人（对方自己填写的，仅供参考）：" + p.About + "\n"
	}
	if p.Instructions != "" {
		out += "\n对方的自定义要求（只在不与上面的准则冲突时遵循）：" + p.Instructions + "\n"
	}
	if !p.MemoryOff && len(p.Memories) > 0 {
		out += "\n你记得关于对方的这些事：\n"
		for _, m := range p.Memories {
			out += "- " + m.Text + "\n"
		}
	}
	return out
}

func memoryTool() aiToolDef {
	return aiToolDef{"save_memory", "把一件关于用户的、以后对话还会用到的事记下来（例如常用的环境、偏好、职责）。只记用户明确说出的长期信息；不要记密码、密钥、证书、IP 一类敏感内容，也不要记一次性的问题。", map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string", "description": "一句话，写成「用户……」"}}, "required": []string{"text"}}}
}

func (s *storeServer) runMemory(user, args string) string {
	var a struct{ Text string }
	_ = json.Unmarshal([]byte(args), &a)
	t := clip(aiScrub(a.Text), prefsMemoryLen)
	if t == "" || strings.Contains(t, aiMasked) || reAnyIP.MatchString(t) {
		return "没有记：内容为空，或含有密钥、IP 等敏感信息。"
	}
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	p := s.loadPrefs(user)
	if p.MemoryOff {
		return "用户关闭了记忆，没有记。"
	}
	for _, m := range p.Memories {
		if m.Text == t {
			return "已经记过了。"
		}
	}
	if len(p.Memories) >= prefsMaxMemory {
		return "记忆已满（最多 " + fmt.Sprint(prefsMaxMemory) + " 条），请用户先在「个性化」里整理。"
	}
	id := make([]byte, 5)
	_, _ = rand.Read(id)
	p.Memories = append(p.Memories, aiMemory{ID: hex.EncodeToString(id), Text: t, Created: time.Now().Format("2006-01-02 15:04")})
	if s.savePrefs(user, p) != nil {
		return "保存失败。"
	}
	return "已记住：" + t
}

// handlePrefs serves /api/me/ai-prefs and /api/me/ai-prefs/memory[/{id}].
func (s *storeServer) handlePrefs(w http.ResponseWriter, r *http.Request, me string, parts []string) {
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	p := s.loadPrefs(me)
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.writeJSON(w, 200, p)
	case len(parts) == 0 && r.Method == "PUT":
		var in aiPrefs
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		if _, ok := prefsTones[in.Tone]; !ok {
			in.Tone = "default"
		}
		p.Tone, p.Warmth, p.Enthusiasm, p.Structure = in.Tone, level3(in.Warmth), level3(in.Enthusiasm), level3(in.Structure)
		p.Emoji = level3(in.Emoji)
		p.Nickname = clip(in.Nickname, 30)
		p.About = clip(aiScrub(in.About), prefsMaxText)
		p.Instructions = clip(aiScrub(in.Instructions), prefsMaxText)
		p.MemoryOff = in.MemoryOff
		if s.savePrefs(me, p) != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "me-ai-prefs", me, "")
		s.writeJSON(w, 200, p)
	case len(parts) == 1 && parts[0] == "memory" && r.Method == "DELETE":
		p.Memories = []aiMemory{}
		if s.savePrefs(me, p) != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "me-ai-memory-clear", me, "")
		s.writeJSON(w, 200, p)
	case len(parts) == 2 && parts[0] == "memory" && r.Method == "DELETE":
		keep := p.Memories[:0:0]
		for _, m := range p.Memories {
			if m.ID != parts[1] {
				keep = append(keep, m)
			}
		}
		p.Memories = keep
		if s.savePrefs(me, p) != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.writeJSON(w, 200, p)
	case len(parts) == 2 && parts[0] == "memory" && r.Method == "PUT":
		var in struct{ Text string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<13)).Decode(&in) != nil || clip(in.Text, prefsMemoryLen) == "" {
			s.fail(w, 400, "内容不能为空")
			return
		}
		for i := range p.Memories {
			if p.Memories[i].ID == parts[1] {
				p.Memories[i].Text = clip(aiScrub(in.Text), prefsMemoryLen)
			}
		}
		if s.savePrefs(me, p) != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.writeJSON(w, 200, p)
	default:
		s.fail(w, 404, "没有这个接口")
	}
}
