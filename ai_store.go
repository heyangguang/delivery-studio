package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// AI in the platform: an assistant that reads freely (through read-only tools the platform defines) and never writes.
// Settings live here: which model providers are connected, which features are on, and the data boundary. Provider
// keys are stored encrypted with a key file beside them and are never sent back to the browser.

// aiModel is one model of a provider: whether it is offered, what the tests found out about it, and what it costs.
type aiModel struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	Enabled bool   `json:"enabled"`
	Context int    `json:"context,omitempty"` // tokens, when the provider says
	// Declared is what the provider's model list says about images ("yes" or ""); the test below is what counts.
	Declared string `json:"declared,omitempty"`
	// What the last test found out: "yes", "no" or "" when unknown.
	Tools    string      `json:"tools,omitempty"`
	Vision   string      `json:"vision,omitempty"`
	Tested   string      `json:"tested,omitempty"`
	TestOK   bool        `json:"test_ok,omitempty"`
	TestMS   int64       `json:"test_ms,omitempty"`
	TestErr  string      `json:"test_err,omitempty"`
	TestWarn string      `json:"test_warn,omitempty"`
	TestDiag *aiCallDiag `json:"test_diag,omitempty"`
	// Prices per million tokens, used to estimate what each call cost; 0 means not set. Cached input is billed apart
	// by most vendors.
	PriceIn     float64 `json:"price_in,omitempty"`
	PriceOut    float64 `json:"price_out,omitempty"`
	PriceCached float64 `json:"price_cached,omitempty"`
	// Default is the table's price when none was typed here; it is only filled on what the browser sees.
	Default *priceEntry `json:"price_default,omitempty"`
	// Efforts are the thinking depths people may pick for this model, as the administrator set them. Unset means all of
	// allEfforts: the depth is only a request parameter, so one the model cannot take simply has no effect. An empty
	// list turns the choice off for this model.
	Efforts *[]string `json:"efforts,omitempty"`
	// Think is how depth was set before Efforts existed ("none" turned it off).
	Think string `json:"think,omitempty"`
}

// allEfforts are the depths a person can ask for, shallowest first.
var allEfforts = []string{"low", "medium", "high", "xhigh", "max", "ultra"}

// effortOffer is what a person may pick for this model.
func (m aiModel) effortOffer() []string {
	switch {
	case m.Efforts != nil:
		return append([]string{}, (*m.Efforts)...)
	case m.Think == "none":
		return []string{}
	}
	return append([]string{}, allEfforts...)
}

// aiProvider is a connection: where it is, how to log in, and the models it offers. The fields from Model down are
// only filled on the copy handed to a call (see withModel) and on settings files written before a provider had models.
type aiProvider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Preset  string `json:"preset"` // see aiPresets; "custom" for any OpenAI compatible address
	URL     string `json:"url"`
	Private bool   `json:"private"` // runs inside the customer's network; allowed when "private only" is on
	Enabled bool   `json:"enabled"`
	// APIVersion is only used by Azure OpenAI.
	APIVersion string `json:"api_version,omitempty"`
	// API is the interface to use: "" or "chat" for Chat Completions, "responses" for the Responses API, which also
	// returns a summary of the model's reasoning.
	API        string    `json:"api,omitempty"`
	TimeoutSec int       `json:"timeout_sec,omitempty"`
	MaxTokens  int       `json:"max_tokens,omitempty"`
	Currency   string    `json:"currency,omitempty"`
	KeyEnc     string    `json:"key_enc,omitempty"`
	Models     []aiModel `json:"models"`
	// Icon is how a custom provider is drawn: "preset:<id>" borrows a vendor's mark, or a data: URL of a small
	// picture; Color tints the letter mark when there is no picture.
	Icon  string `json:"icon,omitempty"`
	Color string `json:"color,omitempty"`

	Model       string    `json:"model,omitempty"`
	Think       string    `json:"think,omitempty"`
	Efforts     *[]string `json:"efforts,omitempty"`
	Tools       string    `json:"tools,omitempty"`
	Vision      string    `json:"vision,omitempty"`
	Tested      string      `json:"tested,omitempty"`
	TestOK      bool        `json:"test_ok,omitempty"`
	TestMS      int64       `json:"test_ms,omitempty"`
	TestErr     string      `json:"test_err,omitempty"`
	TestWarn    string      `json:"test_warn,omitempty"`
	TestDiag    *aiCallDiag `json:"test_diag,omitempty"`
	PriceIn     float64     `json:"price_in,omitempty"`
	PriceOut    float64     `json:"price_out,omitempty"`
	PriceCached float64     `json:"price_cached,omitempty"`
}

// withModel is the provider as one call sees it: the connection plus one model's name, abilities and prices.
func (p aiProvider) withModel(m aiModel) aiProvider {
	p.Models = nil
	p.Model, p.Tools, p.Vision, p.Think, p.Efforts = m.ID, m.Tools, m.Vision, m.Think, m.Efforts
	p.Tested, p.TestOK, p.TestMS, p.TestErr, p.TestWarn, p.TestDiag = m.Tested, m.TestOK, m.TestMS, m.TestErr, m.TestWarn, m.TestDiag
	p.PriceIn, p.PriceOut, p.PriceCached = m.PriceIn, m.PriceOut, m.PriceCached
	return p
}

func (p aiProvider) model(id string) (aiModel, bool) {
	for _, m := range p.Models {
		if m.ID == id {
			return m, true
		}
	}
	return aiModel{}, false
}

// migrate turns a provider written when it had a single model into one with a list of models.
func (p *aiProvider) migrate() {
	if len(p.Models) == 0 && p.Model != "" {
		p.Models = []aiModel{{ID: p.Model, Enabled: true, Tools: p.Tools, Vision: p.Vision, Tested: p.Tested, TestOK: p.TestOK, TestMS: p.TestMS, TestErr: p.TestErr, TestWarn: p.TestWarn, TestDiag: p.TestDiag, PriceIn: p.PriceIn, PriceOut: p.PriceOut, PriceCached: p.PriceCached}}
	}
	p.Model, p.Tools, p.Vision, p.Tested, p.TestOK, p.TestMS, p.TestErr, p.TestWarn, p.TestDiag = "", "", "", "", false, 0, "", "", nil
	p.PriceIn, p.PriceOut, p.PriceCached = 0, 0, 0
	if p.Models == nil {
		p.Models = []aiModel{}
	}
}

// aiRef names a model of a provider in a feature's assignment: "<provider>|<model>"; a bare provider id (settings of
// earlier versions) means its first enabled model.
func aiRef(provider, model string) string { return provider + "|" + model }

type aiFeature struct {
	Enabled bool   `json:"enabled"`
	Primary string `json:"primary,omitempty"`
	Backup  string `json:"backup,omitempty"`
}

type aiSettings struct {
	Enabled   bool                 `json:"enabled"`
	Providers []aiProvider         `json:"providers"`
	Features  map[string]aiFeature `json:"features"`
	// RedactHosts replaces IP addresses and host names with placeholders before anything leaves the platform and puts
	// the real ones back in the answer. Off by default: the answers are used on site, so real names are what help.
	RedactHosts bool `json:"redact_hosts"`
	// PrivateOnly refuses providers that are not marked private.
	PrivateOnly  bool `json:"private_only"`
	MonthlyLimit int  `json:"monthly_limit"` // calls per person per month; 0 is unlimited
	// UserModels are the models ("provider|model") people may pick themselves in a conversation. Empty means they
	// cannot choose: each feature uses the model set for it.
	UserModels []string `json:"user_models"`
	// NoUserMCP stops people from connecting outside services of their own.
	NoUserMCP bool `json:"no_user_mcp,omitempty"`
	// Web is searching and reading web pages (see ai_web.go).
	Web aiWeb `json:"web"`
}

// UserMCP says whether people may connect outside services of their own.
func (st aiSettings) UserMCP() bool { return !st.NoUserMCP }

// aiFeatures are the places the assistant is offered, in the order the settings page lists them.
var aiFeatures = []struct{ ID, Title, Help string }{
	{"change_rehearsal", "变更演练", "在已交付集群上通过只读采集探针与测试环境分步演练，生成经实测验证的生产变更实施方案（SOP）"},
	{"troubleshoot", "现场排障", "执行手册遇到问题时，贴回报错或截图，和 AI 一起分析直到解决"},
	{"assistant", "AI 助手", "统一的对话页：随时提问，可以关联某个交付或组件，让它读取相关内容再回答"},
	{"form", "智能填表", "新建交付时和 AI 对话：它查组件、把规格直接填进表单，你最后确认一次"},
	{"component", "组件工作台", "在组件工作台里对话：起草、修错、补全、评审组件，改动先过平台检查再由你确认写入草稿"},
	{"review", "交付评审", "在交付详情里点开，让 AI 评审这份交付并回答追问"},
	{"docs", "文档起草", "在集群的文档里起草说明文字（概述、风险、结论、根因等），检查文字和执行记录是否一致；由你确认后才算数"},
}

var aiFeaturesEn = map[string][2]string{
	"change_rehearsal": {"Change Rehearsal", "Run read-only discovery probes and step-by-step staging rehearsals on delivered clusters to produce a field-verified production change SOP"},
	"troubleshoot":     {"Troubleshooting", "Paste errors or screenshots during runbook execution to diagnose and resolve issues together with AI"},
	"assistant":        {"AI Assistant", "Unified chat workspace: ask questions anytime and attach a delivery or component for context-aware answers"},
	"form":             {"Smart Form Fill", "Chat with AI while creating a delivery: it inspects components, fills specs into the form, and leaves final confirmation to you"},
	"component":        {"Component Workbench", "Collaborate in Component Workbench to draft, fix, complete, and review components; edits pass platform checks before saving to draft"},
	"review":           {"Delivery Review", "Open from Delivery Details to let AI review the delivery plan and answer follow-up questions"},
	"docs":             {"Doc Drafting", "Draft narrative sections (overview, risks, conclusions, root cause) in cluster documents and check consistency with execution logs; finalized only upon your approval"},
}

func localizedAIFeatures(lang string) []struct{ ID, Title, Help string } {
	out := append([]struct{ ID, Title, Help string }(nil), aiFeatures...)
	if !isEnLang(lang) {
		return out
	}
	for i := range out {
		if pair, ok := aiFeaturesEn[out[i].ID]; ok {
			out[i].Title, out[i].Help = pair[0], pair[1]
		}
	}
	return out
}

func localizedAIPresets(lang string) []aiPreset {
	out := append([]aiPreset(nil), aiPresets...)
	if !isEnLang(lang) {
		return out
	}
	enPresets := map[string]struct{ Name, URL, Hint string }{
		"azure":    {"Azure OpenAI", "https://<resource>.openai.azure.com/openai/deployments/<deployment>", "Include /deployments/<deployment> in URL; enter deployment name as model ID"},
		"qwen":     {"Qwen / Alibaba Model Studio", "", ""},
		"kimi":     {"Kimi (Moonshot)", "", ""},
		"zhipu":    {"Zhipu GLM / Z.ai", "", ""},
		"stepfun":  {"StepFun", "", ""},
		"mimo":     {"Xiaomi MiMo", "", "See vendor documentation for endpoint URL"},
		"qianfan":  {"Baidu Qianfan", "", ""},
		"hunyuan":  {"Tencent Hunyuan", "", ""},
		"huawei":   {"Huawei Cloud", "", "See Huawei Cloud ModelArts docs for endpoint URL"},
		"ark":      {"Volcengine Ark", "", ""},
		"ollama":   {"Ollama (Local)", "", ""},
		"lmstudio": {"LM Studio (Local)", "", ""},
		"custom":   {"Custom Provider", "", "Any OpenAI-compatible base URL"},
	}
	for i := range out {
		if trp, ok := enPresets[out[i].ID]; ok {
			if trp.Name != "" {
				out[i].Name = trp.Name
			}
			if trp.URL != "" {
				out[i].URL = trp.URL
			}
			if trp.Hint != "" {
				out[i].Hint = trp.Hint
			}
		}
	}
	return out
}

type aiPreset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Group   string `json:"group"` // intl | cn | private
	URL     string `json:"url"`
	Private bool   `json:"private,omitempty"`
	Hint    string `json:"hint,omitempty"`
	// Soon marks providers that need their own protocol and are not available yet.
	Soon bool `json:"soon,omitempty"`
}

var aiPresets = []aiPreset{
	{ID: "openai", Name: "OpenAI", Group: "intl", URL: "https://api.openai.com/v1"},
	{ID: "azure", Name: "Azure OpenAI", Group: "intl", URL: "https://<资源名>.openai.azure.com/openai/deployments/<部署名>", Hint: "地址填到部署名；模型名填部署名"},
	{ID: "openrouter", Name: "OpenRouter", Group: "intl", URL: "https://openrouter.ai/api/v1"},
	{ID: "xai", Name: "xAI (Grok)", Group: "intl", URL: "https://api.x.ai/v1"},
	{ID: "mistral", Name: "Mistral", Group: "intl", URL: "https://api.mistral.ai/v1"},
	{ID: "groq", Name: "Groq", Group: "intl", URL: "https://api.groq.com/openai/v1"},
	{ID: "deepseek", Name: "DeepSeek", Group: "cn", URL: "https://api.deepseek.com/v1"},
	{ID: "qwen", Name: "通义千问 / 阿里云百炼", Group: "cn", URL: "https://dashscope.aliyuncs.com/compatible-mode/v1"},
	{ID: "kimi", Name: "Kimi（月之暗面）", Group: "cn", URL: "https://api.moonshot.cn/v1"},
	{ID: "zhipu", Name: "智谱 GLM / Z.ai", Group: "cn", URL: "https://open.bigmodel.cn/api/paas/v4"},
	{ID: "minimax", Name: "MiniMax", Group: "cn", URL: "https://api.minimax.chat/v1"},
	{ID: "stepfun", Name: "阶跃星辰 StepFun", Group: "cn", URL: "https://api.stepfun.com/v1"},
	{ID: "mimo", Name: "小米 MiMo", Group: "cn", URL: "", Hint: "地址见厂商文档"},
	{ID: "qianfan", Name: "百度千帆", Group: "cn", URL: "https://qianfan.baidubce.com/v2"},
	{ID: "hunyuan", Name: "腾讯云混元", Group: "cn", URL: "https://api.hunyuan.cloud.tencent.com/v1"},
	{ID: "huawei", Name: "华为云", Group: "cn", URL: "", Hint: "地址见华为云 ModelArts 文档"},
	{ID: "ark", Name: "火山引擎方舟", Group: "cn", URL: "https://ark.cn-beijing.volces.com/api/v3"},
	{ID: "ollama", Name: "Ollama（本机）", Group: "local", URL: "http://localhost:11434/v1", Private: true},
	{ID: "vllm", Name: "vLLM", Group: "local", URL: "http://localhost:8000/v1", Private: true},
	{ID: "xinference", Name: "Xinference", Group: "local", URL: "http://localhost:9997/v1", Private: true},
	{ID: "lmstudio", Name: "LM Studio（本机）", Group: "local", URL: "http://localhost:1234/v1", Private: true},
	{ID: "custom", Name: "自定义供应商", Group: "custom", URL: "", Hint: "任意 OpenAI 兼容的地址"},
	{ID: "anthropic", Name: "Anthropic (Claude)", Group: "soon", Soon: true},
	{ID: "gemini", Name: "Google Gemini", Group: "soon", Soon: true},
	{ID: "vertex", Name: "Vertex AI", Group: "soon", Soon: true},
	{ID: "bedrock", Name: "Amazon Bedrock", Group: "soon", Soon: true},
}

var aiMu sync.Mutex

func (s *storeServer) aiFile(name string) string { return filepath.Join(s.settingsDir(), name) }

func (st *aiSettings) validRefs() (all map[string]bool, modelsOnly map[string]bool) {
	all = map[string]bool{}
	modelsOnly = map[string]bool{}
	for _, p := range st.Providers {
		if p.ID == "" {
			continue
		}
		all[p.ID] = true
		for _, m := range p.Models {
			if m.ID == "" {
				continue
			}
			ref := aiRef(p.ID, m.ID)
			all[ref] = true
			modelsOnly[ref] = true
		}
	}
	return all, modelsOnly
}

// pruneDeletedRefs removes dangling provider or model references left behind when a provider or one of its models was
// deleted. Models that still exist in p.Models with Enabled == false are intentionally kept so temporarily disabling a
// model and turning it back on restores its feature and user_models assignments.
func (st *aiSettings) pruneDeletedRefs() bool {
	all, modelsOnly := st.validRefs()
	changed := false
	for id, f := range st.Features {
		fChanged := false
		if f.Primary != "" && !all[f.Primary] {
			f.Primary = ""
			fChanged = true
		}
		if f.Backup != "" && !all[f.Backup] {
			f.Backup = ""
			fChanged = true
		}
		if fChanged {
			st.Features[id] = f
			changed = true
		}
	}
	if len(st.UserModels) > 0 {
		var kept []string
		seen := map[string]bool{}
		for _, ref := range st.UserModels {
			if modelsOnly[ref] && !seen[ref] {
				seen[ref] = true
				kept = append(kept, ref)
			} else {
				changed = true
			}
		}
		st.UserModels = kept
	}
	return changed
}

func (s *storeServer) aiLoad() aiSettings {
	st := aiSettings{Providers: []aiProvider{}, Features: map[string]aiFeature{}}
	if b, err := os.ReadFile(s.aiFile("ai.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Providers == nil {
		st.Providers = []aiProvider{}
	}
	for i := range st.Providers {
		st.Providers[i].migrate()
	}
	if st.Features == nil {
		st.Features = map[string]aiFeature{}
	}
	for _, f := range aiFeatures {
		if _, ok := st.Features[f.ID]; !ok {
			st.Features[f.ID] = aiFeature{Enabled: true}
		}
	}
	st.pruneDeletedRefs()
	return st
}

func (s *storeServer) aiSave(st aiSettings) error {
	return writeJSONFile(s.aiFile("ai.json"), st)
}

// ---- keys ----

func (s *storeServer) aiKey() ([]byte, error) {
	path := s.aiFile("ai.key")
	if b, err := os.ReadFile(path); err == nil && len(b) == 32 {
		return b, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, os.WriteFile(path, k, 0o600)
}

func (s *storeServer) aiEncrypt(plain string) (string, error) {
	k, err := s.aiKey()
	if err != nil {
		return "", err
	}
	blk, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(blk)
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (s *storeServer) aiDecrypt(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	k, err := s.aiKey()
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	blk, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(blk)
	if err != nil || len(raw) < gcm.NonceSize() {
		return "", errors.New("密钥无法解密")
	}
	out, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("密钥无法解密")
	}
	return string(out), nil
}

// providerView is what the browser sees: everything except the key, which is only reported as set or not.
type providerView struct {
	aiProvider
	KeyEnc   string `json:"-"`
	KeySet   bool   `json:"key_set"`
	KeyLast4 string `json:"key_last4,omitempty"`
}

func (s *storeServer) aiView(p aiProvider) providerView {
	p.Models = append([]aiModel(nil), p.Models...)
	for i := range p.Models {
		if e, _, ok := s.defaultPrice(p.Models[i].ID); ok {
			p.Models[i].Default = &e
		}
	}
	v := providerView{aiProvider: p, KeySet: p.KeyEnc != ""}
	v.aiProvider.KeyEnc = ""
	if k, err := s.aiDecrypt(p.KeyEnc); err == nil && len(k) >= 4 {
		v.KeyLast4 = k[len(k)-4:]
	}
	return v
}

func validProviderURL(raw string) error {
	if strings.Contains(raw, "<") {
		return errors.New("地址里还有没填的占位符")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return errors.New("地址需要是 http 或 https 开头的完整地址")
	}
	return nil
}

// ---- who may use what ----

type aiStatus struct {
	Enabled       bool            `json:"enabled"`
	MasterEnabled bool            `json:"master_enabled"`
	Configured    bool            `json:"configured"`
	Features      map[string]bool `json:"features"`
	// NoVision lists the features whose model is known not to read images; screenshots cannot be sent to it.
	NoVision map[string]bool `json:"no_vision"`
}

// aiProviderFor picks the provider a feature uses: its primary, else the first enabled one that is allowed.
func (st aiSettings) aiProvidersFor(feature string) []aiProvider {
	f := st.Features[feature]
	byID := map[string]aiProvider{}
	for _, p := range st.Providers {
		byID[p.ID] = p
	}
	usable := func(p aiProvider) bool {
		return p.Enabled && (p.KeyEnc != "" || p.Private) && (!st.PrivateOnly || p.Private)
	}
	first := func(p aiProvider) (aiModel, bool) {
		for _, m := range p.Models {
			if m.Enabled {
				return m, true
			}
		}
		return aiModel{}, false
	}
	var out []aiProvider
	seen := map[string]bool{}
	add := func(p aiProvider, m aiModel) {
		if k := aiRef(p.ID, m.ID); !seen[k] {
			seen[k] = true
			out = append(out, p.withModel(m))
		}
	}
	for _, ref := range []string{f.Primary, f.Backup} {
		pid, mid, _ := strings.Cut(ref, "|")
		p, ok := byID[pid]
		if !ok || !usable(p) {
			continue
		}
		if mid == "" {
			if m, ok := first(p); ok {
				add(p, m)
			}
		} else if m, ok := p.model(mid); ok && m.Enabled {
			add(p, m)
		}
	}
	if len(out) == 0 {
		for _, p := range st.Providers {
			if m, ok := first(p); ok && usable(p) {
				add(p, m)
				break
			}
		}
	}
	return out
}

// aiProvidersForPick is aiProvidersFor with the person's own choice of model first, when it is one they may use.
func (st aiSettings) aiProvidersForPick(feature, pick string) []aiProvider {
	base := st.aiProvidersFor(feature)
	if pick == "" {
		return base
	}
	allowed := false
	for _, r := range st.UserModels {
		allowed = allowed || r == pick
	}
	if !allowed {
		return base
	}
	pid, mid, _ := strings.Cut(pick, "|")
	for _, p := range st.Providers {
		if p.ID != pid || !p.Enabled || (p.KeyEnc == "" && !p.Private) || (st.PrivateOnly && !p.Private) {
			continue
		}
		if m, ok := p.model(mid); ok && m.Enabled {
			out := []aiProvider{p.withModel(m)}
			for _, b := range base {
				if b.ID != pid || b.Model != mid {
					out = append(out, b)
				}
			}
			return out
		}
	}
	return base
}

// pickable is what one person sees in the model menu of a conversation.
type pickable struct {
	Ref      string   `json:"ref"`
	Provider string   `json:"provider"`
	Preset   string   `json:"preset"`
	Icon     string   `json:"icon,omitempty"`
	Color    string   `json:"color,omitempty"`
	Model    string   `json:"model"`
	Name     string   `json:"name,omitempty"`
	Vision   string   `json:"vision,omitempty"`
	Tools    string   `json:"tools,omitempty"`
	Context  int      `json:"context,omitempty"`
	Effort   []string `json:"effort"`
}

func makePickable(p aiProvider, m aiModel) pickable {
	return pickable{
		Ref:      aiRef(p.ID, m.ID),
		Provider: p.Name,
		Preset:   p.Preset,
		Icon:     p.Icon,
		Color:    p.Color,
		Model:    m.ID,
		Name:     m.Name,
		Vision:   m.Vision,
		Tools:    m.Tools,
		Context:  m.Context,
		Effort:   m.effortOffer(),
	}
}

func (s *storeServer) aiModels() map[string]any {
	st := s.aiLoad()
	out := []pickable{}
	defaults := map[string]string{}
	defaultModels := map[string]pickable{}
	if !st.Enabled {
		return map[string]any{"models": out, "defaults": defaults, "default_models": defaultModels}
	}
	for _, ref := range st.UserModels {
		pid, mid, _ := strings.Cut(ref, "|")
		for _, p := range st.Providers {
			if p.ID != pid || !p.Enabled {
				continue
			}
			if m, ok := p.model(mid); ok && m.Enabled {
				out = append(out, makePickable(p, m))
			}
		}
	}
	byID := map[string]aiProvider{}
	for _, p := range st.Providers {
		byID[p.ID] = p
	}
	for _, f := range aiFeatures {
		if ps := st.aiProvidersFor(f.ID); len(ps) > 0 {
			defaults[f.ID] = aiRef(ps[0].ID, ps[0].Model)
			if origP, ok := byID[ps[0].ID]; ok {
				if m, ok := origP.model(ps[0].Model); ok {
					defaultModels[f.ID] = makePickable(origP, m)
					continue
				}
			}
			defaultModels[f.ID] = makePickable(ps[0], aiModel{
				ID:      ps[0].Model,
				Vision:  ps[0].Vision,
				Tools:   ps[0].Tools,
				Think:   ps[0].Think,
				Efforts: ps[0].Efforts,
			})
		}
	}
	return map[string]any{"models": out, "defaults": defaults, "default_models": defaultModels}
}

func (s *storeServer) aiStatus() aiStatus {
	st := s.aiLoad()
	configured := false
	for _, f := range aiFeatures {
		if len(st.aiProvidersFor(f.ID)) > 0 {
			configured = true
			break
		}
	}
	out := aiStatus{
		MasterEnabled: st.Enabled,
		Configured:    configured,
		Features:      map[string]bool{},
		NoVision:      map[string]bool{},
	}
	if !st.Enabled {
		return out
	}
	for _, f := range aiFeatures {
		on := st.Features[f.ID].Enabled && len(st.aiProvidersFor(f.ID)) > 0
		out.Features[f.ID] = on
		out.Enabled = out.Enabled || on
		if ps := st.aiProvidersFor(f.ID); len(ps) > 0 && ps[0].Vision == "no" {
			out.NoVision[f.ID] = true
		}
	}
	return out
}

// handleAIToggle flips the platform-wide one-click AI master switch without losing configured providers or features.
func (s *storeServer) handleAIToggle(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.need(w, session.User, "ai.settings") {
		return
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512)).Decode(&in); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	aiMu.Lock()
	st := s.aiLoad()
	st.Enabled = in.Enabled
	err := s.aiSave(st)
	aiMu.Unlock()
	if err != nil {
		s.fail(w, 500, "保存失败，请稍后重试")
		return
	}
	s.auditReq(r, "ai-toggle", session.User, map[bool]string{true: "开启", false: "关闭"}[in.Enabled])
	s.writeJSON(w, 200, s.aiStatus())
}

// ---- admin API ----

func (s *storeServer) handleAISettings(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/settings/ai"), "/")
	parts := strings.Split(rest, "/")
	if !s.can(session.User, "ai.settings") && !(strings.HasPrefix(rest, "usage") && r.Method == "GET" && s.can(session.User, "ai.usage")) {
		s.fail(w, 403, "没有「AI 设置」权限")
		return
	}
	switch {
	case rest == "" && r.Method == "GET":
		lang := wLang(w)
		st := s.aiLoad()
		views := make([]providerView, 0, len(st.Providers))
		for _, p := range st.Providers {
			v := s.aiView(p)
			if isEnLang(lang) {
				for i := range v.Models {
					if v.Models[i].TestErr != "" {
						v.Models[i].TestErr = localizeGoMessage(lang, v.Models[i].TestErr)
					}
					if v.Models[i].TestWarn != "" {
						v.Models[i].TestWarn = localizeGoMessage(lang, v.Models[i].TestWarn)
					}
				}
			}
			views = append(views, v)
		}
		s.writeJSON(w, 200, map[string]any{"enabled": st.Enabled, "providers": views, "features": st.Features, "redact_hosts": st.RedactHosts, "private_only": st.PrivateOnly, "monthly_limit": st.MonthlyLimit, "user_models": nz(st.UserModels), "no_user_mcp": st.NoUserMCP, "presets": localizedAIPresets(lang), "feature_list": localizedAIFeatures(lang)})
	case rest == "user-mcp" && r.Method == "PUT":
		var in struct {
			Allowed bool `json:"allowed"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		aiMu.Lock()
		st := s.aiLoad()
		st.NoUserMCP = !in.Allowed
		err := s.aiSave(st)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "ai-user-mcp", session.User, map[bool]string{true: "允许", false: "不允许"}[in.Allowed])
		s.writeJSON(w, 200, map[string]bool{"allowed": in.Allowed})
	case rest == "" && r.Method == "PUT":
		var in struct {
			Enabled      bool                 `json:"enabled"`
			Features     map[string]aiFeature `json:"features"`
			RedactHosts  bool                 `json:"redact_hosts"`
			PrivateOnly  bool                 `json:"private_only"`
			MonthlyLimit int                  `json:"monthly_limit"`
			UserModels   []string             `json:"user_models"`
			NoUserMCP    *bool                `json:"no_user_mcp"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in); err != nil || in.MonthlyLimit < 0 {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		aiMu.Lock()
		st := s.aiLoad()
		st.Enabled, st.RedactHosts, st.PrivateOnly, st.MonthlyLimit = in.Enabled, in.RedactHosts, in.PrivateOnly, in.MonthlyLimit
		st.UserModels = nil
		if in.NoUserMCP != nil {
			st.NoUserMCP = *in.NoUserMCP
		}
		allRefs, modelRefs := st.validRefs()
		for _, f := range aiFeatures {
			x := in.Features[f.ID]
			if x.Primary != "" && !allRefs[x.Primary] {
				x.Primary = ""
			}
			if x.Backup != "" && !allRefs[x.Backup] {
				x.Backup = ""
			}
			st.Features[f.ID] = x
		}
		seenUserModels := map[string]bool{}
		for _, ref := range in.UserModels {
			if modelRefs[ref] && !seenUserModels[ref] {
				seenUserModels[ref] = true
				st.UserModels = append(st.UserModels, ref)
			}
		}
		st.pruneDeletedRefs()
		err := s.aiSave(st)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "ai-settings", session.User, "")
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case rest == "providers" && r.Method == "POST", len(parts) == 2 && parts[0] == "providers" && r.Method == "PUT":
		var in struct {
			aiProvider
			Key string `json:"key"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in); err != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		p := in.aiProvider
		p.Name, p.URL = strings.TrimSpace(p.Name), strings.TrimRight(strings.TrimSpace(p.URL), "/")
		if p.Name == "" || len([]rune(p.Name)) > 40 {
			s.fail(w, 400, "请填写名称")
			return
		}
		if len(p.Models) > 200 {
			s.fail(w, 400, "一个供应商最多管理 200 个模型")
			return
		}
		seenModel := map[string]bool{}
		enabledModels := 0
		for i := range p.Models {
			m := &p.Models[i]
			m.Default = nil
			m.ID, m.Name = strings.TrimSpace(m.ID), strings.TrimSpace(m.Name)
			if m.ID == "" || len(m.ID) > 160 || seenModel[m.ID] || strings.Contains(m.ID, "|") {
				s.fail(w, 400, "模型名不能为空、不能重复，也不能含 |")
				return
			}
			seenModel[m.ID] = true
			if m.PriceIn < 0 || m.PriceOut < 0 || m.PriceCached < 0 || m.PriceIn > 10000 || m.PriceOut > 10000 || m.PriceCached > 10000 {
				s.fail(w, 400, "价格要填大于等于 0 的数字")
				return
			}
			if m.Enabled {
				enabledModels++
			}
		}
		if enabledModels == 0 {
			s.fail(w, 400, "至少启用一个模型")
			return
		}
		if err := validProviderURL(p.URL); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		known := false
		for _, pr := range aiPresets {
			known = known || (pr.ID == p.Preset && !pr.Soon)
		}
		if !known {
			s.fail(w, 400, "这个供应商暂不支持")
			return
		}
		if p.Currency == "" {
			p.Currency = "CNY"
		}
		if p.Icon != "" && !strings.HasPrefix(p.Icon, "preset:") && !(regexp.MustCompile(`^data:image/(png|jpeg|webp|svg\+xml);base64,`).MatchString(p.Icon) && len(p.Icon) <= 200<<10) {
			s.fail(w, 400, "图标需要是 png、jpg、webp 或 svg，且不超过 150 KiB")
			return
		}
		if p.Color != "" && !regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(p.Color) {
			s.fail(w, 400, "颜色格式不对")
			return
		}
		if p.Currency != "CNY" && p.Currency != "USD" {
			s.fail(w, 400, "不支持这个币种")
			return
		}
		if p.TimeoutSec < 0 || p.TimeoutSec > 600 || p.MaxTokens < 0 || p.MaxTokens > 200000 {
			s.fail(w, 400, "超时时间或输出长度不在允许范围内")
			return
		}
		aiMu.Lock()
		defer aiMu.Unlock()
		st := s.aiLoad()
		if r.Method == "POST" {
			p.ID, p.KeyEnc = randomStoreToken(6), ""
		} else {
			idx := -1
			for i := range st.Providers {
				if st.Providers[i].ID == parts[1] {
					idx = i
				}
			}
			if idx < 0 {
				s.fail(w, 404, "供应商不存在")
				return
			}
			old := st.Providers[idx]
			p.ID, p.KeyEnc = old.ID, old.KeyEnc
			// what a test found out is kept for a model that stays, unless the address changed
			for i := range p.Models {
				if om, ok := old.model(p.Models[i].ID); ok && old.URL == p.URL {
					m := &p.Models[i]
					m.Tools, m.Vision, m.Tested, m.TestOK, m.TestMS, m.TestErr = om.Tools, om.Vision, om.Tested, om.TestOK, om.TestMS, om.TestErr
					if old.API == p.API {
						m.TestWarn, m.TestDiag = om.TestWarn, om.TestDiag
					} else {
						m.TestWarn, m.TestDiag = "", nil
					}
				}
			}
		}
		if k := strings.TrimSpace(in.Key); k != "" {
			enc, err := s.aiEncrypt(k)
			if err != nil {
				s.fail(w, 500, "密钥无法保存")
				return
			}
			p.KeyEnc = enc
		}
		p.migrate()
		if r.Method == "POST" {
			st.Providers = append(st.Providers, p)
		} else {
			for i := range st.Providers {
				if st.Providers[i].ID == p.ID {
					st.Providers[i] = p
				}
			}
		}
		st.pruneDeletedRefs()
		if err := s.aiSave(st); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "ai-provider", session.User, p.ID)
		s.writeJSON(w, 200, s.aiView(p))
	case len(parts) == 2 && parts[0] == "providers" && r.Method == "DELETE":
		aiMu.Lock()
		defer aiMu.Unlock()
		st := s.aiLoad()
		keep := st.Providers[:0]
		for _, p := range st.Providers {
			if p.ID != parts[1] {
				keep = append(keep, p)
			}
		}
		st.Providers = keep
		st.pruneDeletedRefs()
		if err := s.aiSave(st); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "ai-provider-delete", session.User, parts[1])
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 3 && parts[0] == "providers" && parts[2] == "test" && r.Method == "POST":
		s.aiTestProvider(w, parts[1], r.URL.Query().Get("model"))
	case parts[0] == "web":
		s.handleWebSettings(w, r, session, parts)
	case parts[0] == "skills" || parts[0] == "mcp":
		s.handleAIExt(w, r, session, parts)
	case rest == "prices":
		s.handleAIPrices(w, r)
	case rest == "models" && r.Method == "POST":
		s.aiListModels(w, r)
	case rest == "usage" && r.Method == "GET":
		s.aiUsageList(w, r)
	case rest == "usage/stats" && r.Method == "GET":
		s.aiUsageStats(w, r)
	default:
		s.fail(w, 404, "接口不存在")
	}
}
