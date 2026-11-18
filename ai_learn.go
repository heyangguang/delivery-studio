package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Memory that keeps itself. After every answer the assistant looks back at the exchange once, on the side, and keeps
// what is worth knowing in later conversations: who the person is, what they look after, the environments and
// conventions they work with, how they like answers. Nobody has to say "remember". What is kept is shown (and can be
// removed) in the person's personalization page; nothing secret or one-off is kept, and switching memory off stops it.

const learnSystem = `你负责维护一个运维平台 AI 助手对“提问的人”的长期记忆。读下面这一轮对话，判断里面有没有以后的对话也用得上的、关于这个人的长期信息，例如：
- 身份和职责（负责哪些系统、哪个团队、什么角色）
- 长期使用的环境与约定（操作系统、云平台、网段规划习惯、命名规范、常用组件和版本、离线还是联网）
- 工作偏好（喜欢怎样的回答、界面或流程上的明确偏好、反复强调的要求）
不要记：密码、密钥、证书、令牌、IP 地址、主机名、具体的报错和一次性的问题、只对这一次任务有效的事、你自己的推测。
已经记住的内容不要重复；新的信息和已记住的冲突时，写成更新后的说法。
只输出一个 JSON 数组，每项一句话，写成「用户……」，每句不超过 60 字；没有值得记的就输出 []。不要输出别的。`

// learnLater looks at one exchange in the background and keeps what is worth remembering.
func (s *storeServer) learnLater(user, question, answer string) {
	if user == "" || len([]rune(strings.TrimSpace(question))) < 6 {
		return
	}
	s.prefMu.Lock()
	p := s.loadPrefs(user)
	s.prefMu.Unlock()
	if p.MemoryOff || len(p.Memories) >= prefsMaxMemory {
		return
	}
	st := s.aiLoad()
	providers := st.aiProvidersFor("assistant")
	if !st.Enabled || len(providers) == 0 {
		return
	}
	var known strings.Builder
	for _, m := range p.Memories {
		known.WriteString("- " + m.Text + "\n")
	}
	if known.Len() == 0 {
		known.WriteString("（还没有）\n")
	}
	ask := "已经记住的：\n" + known.String() + "\n这一轮对话：\n用户：" + truncRunes(aiScrub(question), 3000) + "\n助手：" + truncRunes(aiScrub(answer), 2000)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		pr := providers[0]
		rep, err := s.aiChat(ctx, pr, []aiMessage{{Role: "system", Content: learnSystem}, {Role: "user", Content: ask}}, nil, nil)
		u := usageFrom(pr, rep)
		u.User, u.Feature, u.Target, u.OK = user, "memory", "记忆", err == nil
		s.aiRecordUsage(u)
		if err != nil {
			return
		}
		for _, t := range parseLearned(rep.Text) {
			b, _ := json.Marshal(map[string]string{"text": t})
			s.runMemory(user, string(b))
		}
	}()
}

// parseLearned reads the model's list of things to remember; anything that is not a short list of sentences is ignored.
func parseLearned(text string) []string {
	a, b := strings.Index(text, "["), strings.LastIndex(text, "]")
	if a < 0 || b <= a {
		return nil
	}
	var list []string
	if json.Unmarshal([]byte(text[a:b+1]), &list) != nil {
		return nil
	}
	var out []string
	for _, t := range list {
		t = strings.TrimSpace(t)
		if t != "" && len([]rune(t)) <= 120 && len(out) < 3 {
			out = append(out, t)
		}
	}
	return out
}
