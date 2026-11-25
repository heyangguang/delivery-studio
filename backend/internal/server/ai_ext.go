package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// What extends the assistant beyond the platform's own tools:
//   - skills: written know-how (troubleshooting Ansible, running Patroni, …) the model loads when a question needs it;
//     the platform ships some, an administrator can switch them off or add their own;
//   - MCP servers: external tools an administrator connects (Model Context Protocol over HTTP). By default only tools
//     that declare themselves read-only are offered, keeping the rule that the assistant reads and does not change.


type aiSkillScript struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Code        string `json:"code,omitempty"`
	Network     bool   `json:"network,omitempty"`
}

type aiSkill struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Content     string          `json:"content,omitempty"`
	Scripts     []aiSkillScript `json:"scripts,omitempty"`
	Builtin     bool            `json:"builtin"`
	Customized  bool            `json:"customized,omitempty"`
	Enabled     bool            `json:"enabled"`
	// Mine marks a skill a person wrote for their own conversations.
	Mine bool `json:"mine,omitempty"`
}

var (
	skillNameRE       = regexp.MustCompile(`^[a-z][a-z0-9-]{1,40}$`)
	skillScriptNameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,36}\.py$`)
)

var builtinSkillScripts = map[string][]aiSkillScript{
	"postgresql-patroni": {
		{
			Name:        "calc_pg_tuning.py",
			Description: "根据节点内存(memory_gb)、CPU核数(cpus)、最大连接数(max_connections)与负载类型(workload: oltp/olap/mixed)核算 PostgreSQL 关键内存与并发参数",
			Code: `import json, math, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
mem_gb = max(1.0, float(args.get("memory_gb", 16)))
cpus = max(1, int(args.get("cpus", 4)))
max_conn = max(20, int(args.get("max_connections", 300)))
workload = str(args.get("workload", "oltp")).lower()

mem_mb = int(mem_gb * 1024)
shared_mb = int(mem_mb * 0.25)
eff_cache_mb = int(mem_mb * 0.70)
maint_mb = min(2048, max(64, int(mem_mb * (0.10 if workload == "olap" else 0.05))))
pool_factor = {"oltp": 1.5, "mixed": 2.5, "olap": 4.0}.get(workload, 1.5)
work_kb = max(4096, int(((mem_mb - shared_mb) * 1024 * 0.25) / max(1.0, max_conn * pool_factor)))
wal_mb = min(64, max(16, int(shared_mb * 0.03)))

rec = {
    "input": {"memory_gb": mem_gb, "cpus": cpus, "max_connections": max_conn, "workload": workload},
    "recommended": {
        "shared_buffers": f"{shared_mb}MB",
        "effective_cache_size": f"{eff_cache_mb}MB",
        "maintenance_work_mem": f"{maint_mb}MB",
        "work_mem": f"{work_kb // 1024}MB" if work_kb >= 8192 else f"{work_kb}kB",
        "wal_buffers": f"{wal_mb}MB",
        "max_worker_processes": max(8, cpus),
        "max_parallel_workers": max(2, cpus),
        "max_parallel_workers_per_gather": max(1, min(4, cpus // 2)),
    },
    "peak_conn_mem_estimate_mb": round(shared_mb + (work_kb / 1024.0) * max_conn, 1),
    "headroom_ok": (shared_mb + (work_kb / 1024.0) * max_conn * 0.5) < mem_mb * 0.85,
}
print(json.dumps(rec, ensure_ascii=False, indent=2))
`,
		},
	},
	"etcd-ops": {
		{
			Name:        "calc_etcd_quorum.py",
			Description: "根据集群节点数(nodes)与当前库体积MB(db_size_mb)、配额GB(quota_gb)核算 etcd 法定多数派、容灾冗余及配额碎片水位",
			Code: `import json, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
nodes = max(1, int(args.get("nodes", 3)))
db_mb = max(0.0, float(args.get("db_size_mb", 128)))
quota_gb = max(1.0, min(8.0, float(args.get("quota_gb", 8))))

quorum = nodes // 2 + 1
fault_tolerance = nodes - quorum
quota_mb = quota_gb * 1024.0
usage_pct = round((db_mb / quota_mb) * 100, 2)

out = {
    "nodes": nodes,
    "odd_topology_recommended": nodes % 2 == 1,
    "quorum": quorum,
    "max_failed_nodes": fault_tolerance,
    "quota_backend_bytes": int(quota_gb * (1024 ** 3)),
    "db_usage_percent": usage_pct,
    "status": "critical_alarm_risk" if usage_pct >= 85 else ("compact_defrag_advised" if usage_pct >= 60 else "healthy"),
}
print(json.dumps(out, ensure_ascii=False, indent=2))
`,
		},
	},
	"redis-sentinel": {
		{
			Name:        "calc_redis_memory.py",
			Description: "根据宿主机内存GB(memory_gb)、持久化方式(persistence: none/rdb/aof/both)、单机实例数(instances)核算 Redis maxmemory、Copy-on-Write 安全余量与 repl-backlog-size 建议",
			Code: `import json, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
mem_gb = max(1.0, float(args.get("memory_gb", 8)))
persistence = str(args.get("persistence", "none")).lower()
instances = max(1, int(args.get("instances", 1)))
os_reserve_gb = max(1.0, min(4.0, mem_gb * 0.15))
usable_gb = max(0.5, mem_gb - os_reserve_gb)
per_inst_gb = usable_gb / instances
cow_factor = 0.50 if persistence in ("rdb", "aof", "both", "rdb+aof") else 0.78
maxmem_mb = max(128, int(per_inst_gb * 1024 * cow_factor))
repl_backlog_mb = max(16, min(512, maxmem_mb // 64))

out = {
    "input": {"memory_gb": mem_gb, "persistence": persistence, "instances": instances},
    "recommended": {
        "maxmemory": f"{maxmem_mb}mb" if maxmem_mb < 2048 else f"{round(maxmem_mb / 1024.0, 1)}gb",
        "maxmemory_mb": maxmem_mb,
        "repl_backlog_size": f"{repl_backlog_mb}mb",
        "vm_overcommit_memory": 1,
        "thp": "never",
    },
    "cow_headroom_reserved": persistence in ("rdb", "aof", "both", "rdb+aof"),
    "notes": (
        "开启 RDB/AOF 时 bgsave/bgrewriteaof fork 写时复制可能额外占用接近一倍内存，已按约 50% 可用内存保守核算。"
        if persistence in ("rdb", "aof", "both", "rdb+aof")
        else "纯缓存无持久化模式按约 78% 可用内存核算，仍预留系统缓冲、复制积压和客户端输出缓冲区空间。"
    ),
}
print(json.dumps(out, ensure_ascii=False, indent=2))
`,
		},
	},
	"linux-diagnostics": {
		{
			Name:        "parse_disk_mem_snapshot.py",
			Description: "解析参数 df_text / free_text 或 /in 下文本快照中的 df -h 与内存占用，输出超阈值挂载点与 Swap/可用内存告警",
			Code: `import json, os, re, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
warn_pct = int(args.get("warn_percent", 80))
text = str(args.get("df_text", "")) + "\n" + str(args.get("free_text", ""))
for fn in sorted(os.listdir("/in")):
    if not fn.startswith("_"):
        try:
            text += "\n" + open(os.path.join("/in", fn), encoding="utf-8", errors="ignore").read()
        except Exception:
            pass

mounts = []
for line in text.splitlines():
    m = re.search(r"^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(/\S*)$", line.strip())
    if m:
        pct = int(m.group(5))
        mounts.append({
            "filesystem": m.group(1),
            "size": m.group(2),
            "used": m.group(3),
            "avail": m.group(4),
            "use_percent": pct,
            "mount": m.group(6),
            "alert": pct >= warn_pct,
        })

print(json.dumps({
    "warn_threshold_percent": warn_pct,
    "mounts_parsed": len(mounts),
    "alerts": [x for x in mounts if x["alert"]],
    "all_mounts": mounts,
}, ensure_ascii=False, indent=2))
`,
		},
	},
	"spreadsheet-analysis": {
		{
			Name:        "profile_csv_quality.py",
			Description: "扫描 /in 目录下的 CSV 文件，统计总行数、各列空值率、去重基数与数值列最小/最大/均值摘要",
			Code: `import csv, json, os, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
key_col = str(args.get("key_column", "")).strip()
reports = []

for fn in sorted(os.listdir("/in")):
    if fn.startswith("_") or not fn.lower().endswith(".csv"):
        continue
    path = os.path.join("/in", fn)
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        cols = reader.fieldnames or []
        rows = 0
        nulls = {c: 0 for c in cols}
        nums = {c: [] for c in cols}
        seen_keys, dup_keys = set(), 0
        for row in reader:
            rows += 1
            if key_col and key_col in row:
                kv = (row.get(key_col) or "").strip()
                if kv in seen_keys:
                    dup_keys += 1
                seen_keys.add(kv)
            for c in cols:
                v = (row.get(c) or "").strip()
                if v == "":
                    nulls[c] += 1
                else:
                    try:
                        nums[c].append(float(v.replace(",", "")))
                    except ValueError:
                        pass
        col_stats = {}
        for c in cols:
            st = {"null_count": nulls[c], "null_pct": round(nulls[c] * 100.0 / max(1, rows), 2)}
            if len(nums[c]) >= max(1, int(rows * 0.6)):
                st["min"] = min(nums[c])
                st["max"] = max(nums[c])
                st["avg"] = round(sum(nums[c]) / len(nums[c]), 4)
            col_stats[c] = st
        reports.append({"file": fn, "rows": rows, "columns": len(cols), "duplicate_keys": dup_keys, "stats": col_stats})

print(json.dumps({"files": reports}, ensure_ascii=False, indent=2))
`,
		},
	},
}

func parseSkill(text string) aiSkill {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var sk aiSkill
	if strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---"); end >= 0 {
			for _, l := range strings.Split(text[4:4+end], "\n") {
				k, v, ok := strings.Cut(l, ":")
				if !ok {
					continue
				}
				v = strings.TrimSpace(v)
				switch strings.TrimSpace(k) {
				case "name":
					sk.Name = v
				case "title":
					sk.Title = v
				case "description":
					sk.Description = v
				}
			}
			text = strings.TrimLeft(text[4+end+4:], "\n")
		}
	}
	sk.Content = text
	return sk
}

func builtinSkills() []aiSkill {
	entries, _ := skillFiles.ReadDir("ai_skills")
	var out []aiSkill
	for _, e := range entries {
		b, err := skillFiles.ReadFile("ai_skills/" + e.Name())
		if err != nil {
			continue
		}
		sk := parseSkill(string(b))
		if sk.Name != "" {
			sk.Builtin = true
			if def, ok := builtinSkillScripts[sk.Name]; ok {
				sk.Scripts = append([]aiSkillScript(nil), def...)
			}
			out = append(out, sk)
		}
	}
	return out
}

type skillSettings struct {
	Disabled  []string  `json:"disabled"`
	Custom    []aiSkill `json:"custom"`
	Overrides []aiSkill `json:"overrides,omitempty"`
}

func (s *storeServer) loadSkillSettings() skillSettings {
	var st skillSettings
	if b, err := os.ReadFile(s.aiFile("ai-skills.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

func stripSkillContent(sk aiSkill) aiSkill {
	sk.Content = ""
	if len(sk.Scripts) > 0 {
		thin := make([]aiSkillScript, len(sk.Scripts))
		for i, sc := range sk.Scripts {
			thin[i] = aiSkillScript{Name: sc.Name, Description: sc.Description, Network: sc.Network}
		}
		sk.Scripts = thin
	}
	return sk
}

// skills lists every skill with whether it is on; content is included only when asked.
func (s *storeServer) skills(withContent bool) []aiSkill {
	st := s.loadSkillSettings()
	off := map[string]bool{}
	for _, n := range st.Disabled {
		off[n] = true
	}
	overrides := map[string]aiSkill{}
	for _, ov := range st.Overrides {
		overrides[ov.Name] = ov
	}
	var out []aiSkill
	for _, sk := range builtinSkills() {
		if ov, ok := overrides[sk.Name]; ok {
			if strings.TrimSpace(ov.Title) != "" {
				sk.Title = ov.Title
			}
			if strings.TrimSpace(ov.Description) != "" {
				sk.Description = ov.Description
			}
			if strings.TrimSpace(ov.Content) != "" {
				sk.Content = ov.Content
			}
			sk.Scripts = append([]aiSkillScript(nil), ov.Scripts...)
			sk.Builtin = true
			sk.Customized = true
		}
		sk.Enabled = !off[sk.Name]
		if !withContent {
			sk = stripSkillContent(sk)
		}
		out = append(out, sk)
	}
	for _, sk := range st.Custom {
		sk.Builtin = false
		sk.Customized = false
		sk.Enabled = !off[sk.Name]
		if !withContent {
			sk = stripSkillContent(sk)
		}
		out = append(out, sk)
	}
	return out
}

// skillsFor is what one person's conversations may use: the platform's skills that are on, then their own.
func (s *storeServer) skillsFor(user string, withContent bool) []aiSkill {
	var out []aiSkill
	seen := map[string]bool{}
	for _, sk := range s.skills(withContent) {
		if sk.Enabled {
			out = append(out, sk)
			seen[sk.Name] = true
		}
	}
	if user != "" {
		for _, sk := range s.userSkills(user) {
			if !seen[sk.Name] {
				sk.Enabled, sk.Mine, sk.Builtin, sk.Customized = true, true, false, false
				if !withContent {
					sk = stripSkillContent(sk)
				}
				out = append(out, sk)
			}
		}
	}
	return out
}

// skillBlock is the text of the named skills that are on, for the system prompt of a conversation that always follows
// them. An administrator can switch one off or adapt it, as with any skill.
func (s *storeServer) skillBlock(user string, names ...string) string {
	var b strings.Builder
	for _, n := range names {
		if sk, ok := s.skillFor(user, n); ok {
			b.WriteString("\n\n# 技能：" + sk.Title + "\n\n" + sk.Content)
		}
	}
	return b.String()
}

func (s *storeServer) skill(name string) (aiSkill, bool) {
	return s.skillFor("", name)
}

func (s *storeServer) skillFor(user, name string) (aiSkill, bool) {
	for _, sk := range s.skillsFor(user, true) {
		if sk.Name == name && sk.Enabled {
			return sk, true
		}
	}
	return aiSkill{}, false
}

func checkSkillScripts(scripts []aiSkillScript) ([]aiSkillScript, string) {
	if len(scripts) == 0 {
		return nil, ""
	}
	if len(scripts) > 8 {
		return nil, "单个技能最多随附 8 个脚本"
	}
	seen := map[string]bool{}
	out := make([]aiSkillScript, len(scripts))
	for i, sc := range scripts {
		sc.Name = strings.TrimSpace(sc.Name)
		sc.Description = strings.TrimSpace(sc.Description)
		if !skillScriptNameRE.MatchString(sc.Name) || seen[sc.Name] {
			return nil, "脚本文件名需以字母或数字开头，仅含字母、数字、_ 或 -，以 .py 结尾且不能重名：" + sc.Name
		}
		seen[sc.Name] = true
		if len([]rune(sc.Description)) > 200 {
			return nil, "脚本说明请控制在 200 字以内：" + sc.Name
		}
		if strings.TrimSpace(sc.Code) == "" || len(sc.Code) > 64<<10 {
			return nil, "脚本代码不能为空且不能超过 64 KiB：" + sc.Name
		}
		if aiScrub(sc.Code) != sc.Code || aiScrub(sc.Description) != sc.Description {
			return nil, "脚本中包含口令或密钥，不能保存：" + sc.Name
		}
		out[i] = sc
	}
	return out, ""
}

// checkSkills tidies skills someone wrote and says what is wrong with them, if anything. Names in taken are in use.
func checkSkills(list []aiSkill, taken map[string]bool) string {
	for i := range list {
		sk := &list[i]
		sk.Name, sk.Title, sk.Description = strings.TrimSpace(sk.Name), strings.TrimSpace(sk.Title), strings.TrimSpace(sk.Description)
		sk.Builtin, sk.Customized, sk.Enabled, sk.Mine = false, false, false, false
		if !skillNameRE.MatchString(sk.Name) || taken[sk.Name] {
			return "技能名要用小写字母开头，只含小写字母、数字和 -，且不能和已有的重复：" + sk.Name
		}
		taken[sk.Name] = true
		if sk.Title == "" || sk.Description == "" || len([]rune(sk.Description)) > 300 || strings.TrimSpace(sk.Content) == "" || len(sk.Content) > 64<<10 {
			return "每个技能要有标题、一句话说明（300 字内）和内容（64 KiB 内）"
		}
		if aiScrub(sk.Content) != sk.Content || aiScrub(sk.Description) != sk.Description {
			return "技能内容里有口令或密钥，不能保存"
		}
		cleaned, msg := checkSkillScripts(sk.Scripts)
		if msg != "" {
			return msg
		}
		sk.Scripts = cleaned
	}
	return ""
}

func checkSkillOverrides(list []aiSkill, builtins map[string]bool) string {
	seen := map[string]bool{}
	for i := range list {
		sk := &list[i]
		sk.Name, sk.Title, sk.Description = strings.TrimSpace(sk.Name), strings.TrimSpace(sk.Title), strings.TrimSpace(sk.Description)
		if !builtins[sk.Name] || seen[sk.Name] {
			return "只能定制平台内置技能，且同一技能不能重复提交：" + sk.Name
		}
		seen[sk.Name] = true
		sk.Builtin, sk.Customized, sk.Enabled, sk.Mine = true, true, false, false
		if sk.Title == "" || sk.Description == "" || len([]rune(sk.Description)) > 300 || strings.TrimSpace(sk.Content) == "" || len(sk.Content) > 64<<10 {
			return "每个技能要有标题、一句话说明（300 字内）和内容（64 KiB 内）"
		}
		if aiScrub(sk.Content) != sk.Content || aiScrub(sk.Description) != sk.Description {
			return "技能内容里有口令或密钥，不能保存"
		}
		cleaned, msg := checkSkillScripts(sk.Scripts)
		if msg != "" {
			return msg
		}
		sk.Scripts = cleaned
	}
	return ""
}

// ---- MCP ----

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Schema      map[string]any `json:"input_schema,omitempty"`
	ReadOnly    bool           `json:"read_only"`
}

type mcpServer struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	URL        string    `json:"url"`
	Enabled    bool      `json:"enabled"`
	TokenEnc   string    `json:"token_enc,omitempty"`
	AllowWrite bool      `json:"allow_write"` // also offer tools that do not declare themselves read-only
	Tools      []mcpTool `json:"tools"`
	Disabled   []string  `json:"disabled_tools,omitempty"`
	Checked    string    `json:"checked,omitempty"`
	Error      string    `json:"error,omitempty"`
	ServerName string    `json:"server_name,omitempty"`
	// Mine marks a service a person connected for their own conversations; it only offers read-only tools.
	Mine bool `json:"mine,omitempty"`
}

// mcpFor is the outside services one person's conversations may use: the platform's, then their own.
func (s *storeServer) mcpFor(user string) []mcpServer {
	out := s.loadMCP()
	if user != "" && s.aiLoad().UserMCP() {
		for _, sv := range s.loadUserMCP(user) {
			sv.Mine, sv.AllowWrite = true, false
			out = append(out, sv)
		}
	}
	return out
}

func (s *storeServer) loadMCP() []mcpServer {
	var out []mcpServer
	if b, err := os.ReadFile(s.aiFile("ai-mcp.json")); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	if out == nil {
		out = []mcpServer{}
	}
	return out
}

func (s *storeServer) saveMCP(all []mcpServer) error {
	return writeJSONFile(s.aiFile("ai-mcp.json"), all)
}

type mcpClient struct {
	url, token, session string
	next                int
	http                *http.Client
}

const mcpProtocol = "2025-06-18"

func (c *mcpClient) post(ctx context.Context, body map[string]any) (json.RawMessage, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", c.url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", mcpProtocol)
	if c.session != "" {
		req.Header.Set("Mcp-Session-Id", c.session)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.session = sid
	}
	if resp.StatusCode == 202 || body["id"] == nil {
		return nil, nil
	}
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
		return nil, fmt.Errorf("MCP 服务返回 %d：%s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var payload []byte
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64<<10), 8<<20)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			var probe struct {
				ID any `json:"id"`
			}
			if json.Unmarshal([]byte(data), &probe) == nil && fmt.Sprint(probe.ID) == fmt.Sprint(body["id"]) {
				payload = []byte(data)
				break
			}
		}
	} else {
		payload, _ = io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	}
	var msg struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &msg) != nil {
		return nil, errors.New("MCP 服务的回应无法解析")
	}
	if msg.Error != nil {
		return nil, errors.New("MCP：" + msg.Error.Message)
	}
	return msg.Result, nil
}

func (c *mcpClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.next++
	return c.post(ctx, map[string]any{"jsonrpc": "2.0", "id": c.next, "method": method, "params": params})
}

func (s *storeServer) mcpConnect(ctx context.Context, sv mcpServer) (*mcpClient, string, error) {
	token, _ := s.aiDecrypt(sv.TokenEnc)
	c := &mcpClient{url: sv.URL, token: token, http: &http.Client{Timeout: 60 * time.Second}}
	res, err := c.call(ctx, "initialize", map[string]any{"protocolVersion": mcpProtocol, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "middleware-hub", "version": version}})
	if err != nil {
		return nil, "", err
	}
	var info struct {
		ServerInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	_ = json.Unmarshal(res, &info)
	_, _ = c.post(ctx, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	return c, strings.TrimSpace(info.ServerInfo.Name + " " + info.ServerInfo.Version), nil
}

func (s *storeServer) mcpListTools(ctx context.Context, sv mcpServer) ([]mcpTool, string, error) {
	c, name, err := s.mcpConnect(ctx, sv)
	if err != nil {
		return nil, "", err
	}
	res, err := c.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, name, err
	}
	var list struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
			Annotations struct {
				ReadOnly bool `json:"readOnlyHint"`
			} `json:"annotations"`
		} `json:"tools"`
	}
	if json.Unmarshal(res, &list) != nil {
		return nil, name, errors.New("工具列表无法解析")
	}
	var out []mcpTool
	for _, t := range list.Tools {
		out = append(out, mcpTool{Name: t.Name, Description: truncRunes(t.Description, 600), Schema: t.InputSchema, ReadOnly: t.Annotations.ReadOnly})
	}
	return out, name, nil
}

var toolNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9_-]`)

func mcpToolName(serverID, tool string) string {
	n := "mcp__" + serverID + "__" + toolNameUnsafe.ReplaceAllString(tool, "_")
	if len(n) > 64 {
		n = n[:64]
	}
	return n
}

// ---- what a conversation gets ----

// aiExt is the skills and MCP tools offered to one conversation, and how to run them.
type aiExt struct {
	s      *storeServer
	tools  []aiToolDef
	prompt string
	mcp    map[string]struct {
		server mcpServer
		tool   string
	}
	mu      sync.Mutex
	clients map[string]*mcpClient
	web         bool
	user        string
	sandboxMode string
	kb          bool
	memory      bool
	table       bool
	sandbox     bool
	made        *producedFiles
	workspace   *sandboxWorkspaceSpec
	runCtx      context.Context
}

// aiOpts is what a person chose for one message: think harder, search the web, and which skills and outside services
// to allow (nil means every one that is switched on).
type aiOpts struct {
	Think       thinkLevel `json:"think"`
	Web         bool       `json:"web"`
	Skills      *[]string  `json:"skills"`
	MCP         *[]string  `json:"mcp"`
	SandboxMode string     `json:"sandbox_mode,omitempty"` // "" (follow platform default) | "ask" | "auto" | "open" (end-user choice overrides platform default)
	// NoKB leaves the person's knowledge base out of this message.
	NoKB bool `json:"no_kb"`
	// User is who is asking (set by the server): their own skills, services and knowledge base come along.
	User string `json:"-"`
	// Made collects the files the assistant makes in this turn (set by the server).
	Made *producedFiles `json:"-"`
	// Workspace exposes a scoped read-only project snapshot (/workspace) for sandbox verification when in a delivery or component chat.
	Workspace *sandboxWorkspaceSpec `json:"-"`
}

// thinkLevel is how hard to think: "" for the model's own default, otherwise one of allEfforts. The browser may send
// true (high) or false from before depth could be chosen.
type thinkLevel string

func (t *thinkLevel) UnmarshalJSON(b []byte) error {
	switch string(b) {
	case "true":
		*t = "high"
		return nil
	case "false", "null":
		*t = ""
		return nil
	}
	var v string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*t = ""
	for _, e := range allEfforts {
		if v == e {
			*t = thinkLevel(v)
		}
	}
	return nil
}

func allowed(list *[]string, name string) bool {
	if list == nil {
		return true
	}
	for _, x := range *list {
		if x == name {
			return true
		}
	}
	return false
}

// extFor collects what a feature may use. Smart form filling gets none: it only fills a form.
func (s *storeServer) extFor(feature string, opts ...aiOpts) *aiExt {
	var o aiOpts
	if len(opts) > 0 {
		o = opts[0]
	}
	x := &aiExt{s: s, mcp: map[string]struct {
		server mcpServer
		tool   string
	}{}, clients: map[string]*mcpClient{}, user: o.User, sandboxMode: strings.ToLower(strings.TrimSpace(o.SandboxMode))}
	if feature == "form" {
		return x
	}
	x.made = o.Made
	x.workspace = o.Workspace
	x.tools = append(x.tools, askTool())
	sbSettings, rt, sbOn := s.sandboxOn()
	if sbOn && o.User != "" {
		pk := ""
		if b, err := os.ReadFile(filepath.Join(rt, "manifest.txt")); err == nil {
			pk = strings.Join(strings.Fields(string(b)), "、")
		}
		hasWS := o.Workspace != nil
		x.tools = append(x.tools, runPythonTool(pk, sbSettings.NetPolicy, hasWS), runShellTool(hasWS, sbSettings.NetPolicy), viewImagesTool())
		x.sandbox = true
		netRule := "默认离线隔离运行（本机与内网服务始终不可达）"
		switch normalizeNetPolicy(sbSettings.NetPolicy) {
		case "deny":
			netRule = "禁止任何网络连接"
		case "ask":
			netRule = "默认无网络；若任务确需访问外网，可传 network=true 与 net_reason，由用户在对话卡片中实时授权放行（本机服务始终隔离）"
		case "auto":
			netRule = "默认无网络；已开启联网智能审批（未挂载文件或工作区且仅对可信公共技术/安全公告域名做只读 HTTPS GET 的 Python 查询将自动放行，并受运行时域名与只读锁保护；涉及文件挂载、非白名单域名、写请求或 Shell 仍由用户实时确认）"
		case "allow":
			netRule = "默认无网络；确需外网时可传 network=true（本机服务始终隔离）"
		}
		wsPrompt := ""
		if hasWS {
			wsPrompt = "若需批量校验脚本语法（如 bash -n / YAML 语法检查）或结合用户上传的现场日志交叉分析，可在 run_python / run_shell 中设 workspace=true，把「" + o.Workspace.Label + "」的脱敏只读快照挂载到 /workspace（环境变量 MW_WORKSPACE；始终只读，不连远程主机）。如果只是搜索或查看项目配置、模板或参数，直接用原生 search_files / read_file（毫秒级返回），不要为了 grep 启动沙箱。"
		}
		x.prompt += "\n有一个系统级隔离代码沙箱（run_python / run_shell，技能脚本亦共用此沙箱）：" + netRule + "，默认只能处理用户存储空间里的文件（/in），结果写到 /out。" + wsPrompt + "需要精确计算、转换文件格式、生成文档或图表、用 bash -n/Shell/CLI 工具核对脚本或日志时用它；不要用它做平台原生工具本来就能查到的事。查询公开 CVE/安全公告、PyPI 版本或网页资料时，应优先使用 check_package_security / web_search / web_fetch（若当前未开启「联网」开关，先提示用户开启「联网」），仅在专用安全查询和搜索工具无法获取或不可用时，再把代码沙箱作为最后兜底。只有要交给用户的成品才写到 /out（会自动存进「我的资料 / AI 生成」，并在回答下方显示成可下载的文件卡片，所以回答里不要再写下载链接，只说文件名）。只给你自己看的图片（比如把扫描件的页面渲染成 png）写到 /out/_view/，用 view_images 看，不会被保存。你写的脚本要先在沙箱里跑通再交给用户。\n"
	}
	x.prompt += "\n信息不够、有几种合理的理解、或需要用户做选择时，用 ask_user 向用户提问（本轮随即结束），不要猜着回答。能自己查到的先查。\n"
	aiSt := s.aiLoad()
	allowSkills := aiSt.Features["skills"].Enabled && s.userCanAIFeaturePerm(o.User, "skills")
	allowMCP := aiSt.Features["mcp"].Enabled && s.userCanAIFeaturePerm(o.User, "mcp")
	allowKB := aiSt.Features["kb"].Enabled && s.userCanAIFeaturePerm(o.User, "kb")
	var on []aiSkill
	if allowSkills {
		for _, sk := range s.skillsFor(o.User, false) {
			if sk.Enabled && allowed(o.Skills, sk.Name) {
				on = append(on, sk)
			}
		}
	}
	if len(on) > 0 {
		var b strings.Builder
		b.WriteString("\n可用的技能（专业操作手册）：遇到相关问题时，先用 use_skill 读取对应技能再回答。\n")
		var names, scriptNames []string
		for _, sk := range on {
			if len(sk.Scripts) > 0 {
				fmt.Fprintf(&b, "- %s：%s（含 %d 个可执行沙箱脚本）\n", sk.Name, sk.Description, len(sk.Scripts))
				scriptNames = append(scriptNames, sk.Name)
			} else {
				fmt.Fprintf(&b, "- %s：%s\n", sk.Name, sk.Description)
			}
			names = append(names, sk.Name)
		}
		if x.sandbox && len(scriptNames) > 0 {
			b.WriteString("若所选技能随附沙箱脚本，先用 use_skill 查看脚本清单与参数约定，再用 run_skill_script 在平台统一隔离沙箱中运行（仅可读取当前用户自己的文件）。\n")
		}
		x.prompt += b.String()
		x.tools = append(x.tools, aiToolDef{"use_skill", "读取一项技能（专业操作手册）的完整内容及随附脚本说明。", map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string", "enum": names, "description": "技能名"}}, "required": []string{"name"}}})
		if x.sandbox && len(scriptNames) > 0 {
			x.tools = append(x.tools, runSkillScriptTool(scriptNames, sbSettings.NetPolicy))
		}
	}
	if o.Web && s.webSettings().ready() {
		x.tools = append(x.tools, webTools()...)
		x.web = true
		x.prompt += "\n联网查询工具已开启：核查软件包的已知 CVE/GHSA 漏洞、修复版本、最新稳定版或 Python 兼容性时，首选专用工具 check_package_security（直连 OSV.dev 与 PyPI 官方接口批量查询，无需启动沙箱写脚本）；查官方文档、发行说明、报错含义或外部网页时，优先用 web_search 搜索并用 web_fetch 阅读原文（引用时注明来源网址）。仅在专用安全查询与搜索工具无法满足时，才考虑将代码沙箱作为兜底。\n"
	}
	if allowMCP {
		for _, sv := range s.mcpFor(o.User) {
			if !sv.Enabled || !allowed(o.MCP, sv.ID) {
				continue
			}
			off := map[string]bool{}
			for _, t := range sv.Disabled {
				off[t] = true
			}
			for _, t := range sv.Tools {
				if off[t.Name] || (!t.ReadOnly && !sv.AllowWrite) {
					continue
				}
				name := mcpToolName(sv.ID, t.Name)
				schema := t.Schema
				if schema == nil {
					schema = map[string]any{"type": "object", "properties": map[string]any{}}
				}
				x.tools = append(x.tools, aiToolDef{name, "[MCP · " + sv.Name + "] " + t.Description, schema})
				x.mcp[name] = struct {
					server mcpServer
					tool   string
				}{sv, t.Name}
			}
		}
	}
	if len(x.mcp) > 0 {
		x.prompt += "\n名称以 mcp__ 开头的工具来自接入的外部服务（MCP），按需调用。\n"
	}
	if o.User != "" {
		pf := s.loadPrefs(o.User)
		x.prompt += pf.prompt()
		if !pf.MemoryOff {
			x.tools = append(x.tools, memoryTool())
			x.memory = true
			x.prompt += "\n平台会在每轮对话后自动整理关于对方的长期信息，你不必为此调用工具；只有对方明确要你记住某件事时才用 save_memory。\n"
		}
	}
	if o.User != "" && s.hasSpreadsheet(o.User) {
		x.tools = append(x.tools, tableTools()...)
		x.table = true
		x.prompt += "\n用户的存储空间里有表格文件（.xlsx / .csv）。要得出数字（一共多少、各类别多少、总和、平均、有没有重复）时，必须用 table_describe 看列、table_query 计算，不要自己数或估算；回答里说明用了哪个文件、哪张表、什么条件。\n"
	}
	if o.User != "" && !o.NoKB && allowKB {
		own, team := s.kbList(o.User), s.teamDocsFor(o.User)
		if len(own)+len(team) > 0 {
			x.kb = true
			x.tools = append(x.tools, kbTools()...)
			var b strings.Builder
			b.WriteString("\n有知识库可查：")
			list := func(label string, titles []string) {
				if len(titles) == 0 {
					return
				}
				b.WriteString(label + "：")
				for i, t := range titles {
					if i >= 30 {
						fmt.Fprintf(&b, "等 %d 份", len(titles))
						break
					}
					if i > 0 {
						b.WriteString("、")
					}
					b.WriteString("《" + t + "》")
				}
				b.WriteString("。")
			}
			var ot, tt []string
			for _, d := range own {
				ot = append(ot, d.Title)
			}
			for _, d := range team {
				tt = append(tt, d.Title)
			}
			list("用户自己的资料", ot)
			list("团队知识库（团队整理的现场资料和过往问题）", tt)
			b.WriteString("问题可能和这些资料有关时，先用 search_knowledge 搜索，需要全文再用 read_knowledge；引用时说明出自哪份资料。\n")
			x.prompt += b.String()
		}
	}
	return x
}

// bindCtx connects live SSE approval & cancellation context to sandbox tool calls in this conversation turn.
func (x *aiExt) bindCtx(ctx context.Context, ev sse) context.Context {
	if x.user != "" && ev.w != nil {
		ctx = withSandboxGate(ctx, &sandboxGate{
			User:     x.user,
			UserMode: x.sandboxMode,
			Send:     ev.send,
		})
	}
	x.runCtx = ctx
	return ctx
}

// wrap puts the extension's tools in front of a conversation's own runner.
func (x *aiExt) wrap(run func(name, args string) string) func(name, args string) string {
	return func(name, args string) string {
		if name == "use_skill" {
			var a struct{ Name string }
			_ = json.Unmarshal([]byte(args), &a)
			sk, ok := x.s.skillFor(x.user, a.Name)
			if !ok {
				return "没有这个技能，或它已被停用：" + a.Name
			}
			var out strings.Builder
			out.WriteString("# 技能：" + sk.Title + "\n\n" + sk.Content)
			if len(sk.Scripts) > 0 {
				out.WriteString("\n\n## 随附可执行沙箱脚本\n")
				for _, sc := range sk.Scripts {
					netBadge := ""
					if sc.Network {
						netBadge = "（需外网授权）"
					}
					if sc.Description != "" {
						fmt.Fprintf(&out, "- `%s`%s：%s\n", sc.Name, netBadge, sc.Description)
					} else {
						fmt.Fprintf(&out, "- `%s`%s\n", sc.Name, netBadge)
					}
				}
				if x.sandbox {
					out.WriteString("\n可使用 `run_skill_script` 工具传入 `skill`（`" + sk.Name + "`）、`script`（脚本名）、`args`（JSON 参数对象）及可选的 `files`（当前用户存储空间文件）在平台统一隔离沙箱中执行。")
				} else {
					out.WriteString("\n（注：当前未开启代码沙箱，上述随附脚本暂不自动执行。）")
				}
			}
			return out.String()
		}
		if name == runSkillScriptName {
			return x.s.runSkillScript(x.runCtx, x.user, args, x.made)
		}
		if m, ok := x.mcp[name]; ok {
			return x.callMCP(m.server, m.tool, args)
		}
		if x.web && (name == "web_search" || name == "web_fetch" || name == checkPkgSecName) {
			return x.s.runWeb(name, args)
		}
		if x.sandbox && name == viewImagesName && x.made != nil {
			return x.s.viewImages(x.user, args, x.made)
		}
		if x.sandbox && name == runPythonName {
			return x.s.runPython(x.runCtx, x.user, args, x.made, x.workspace)
		}
		if x.sandbox && name == runShellName {
			return x.s.runShell(x.runCtx, x.user, args, x.made, x.workspace)
		}
		if x.table && (name == "table_describe" || name == "table_query") {
			return x.s.runTable(x.user, name, args)
		}
		if x.memory && name == "save_memory" {
			return x.s.runMemory(x.user, args)
		}
		if x.kb && (name == "search_knowledge" || name == "read_knowledge") {
			return x.s.runKB(x.user, name, args)
		}
		return run(name, args)
	}
}

func (x *aiExt) callMCP(sv mcpServer, tool, args string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	x.mu.Lock()
	c := x.clients[sv.ID]
	x.mu.Unlock()
	if c == nil {
		var err error
		if c, _, err = x.s.mcpConnect(ctx, sv); err != nil {
			return "外部服务连接失败：" + err.Error()
		}
		x.mu.Lock()
		x.clients[sv.ID] = c
		x.mu.Unlock()
	}
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	if a == nil {
		a = map[string]any{}
	}
	res, err := c.call(ctx, "tools/call", map[string]any{"name": tool, "arguments": a})
	if err != nil {
		return "外部工具调用失败：" + err.Error()
	}
	var r struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	_ = json.Unmarshal(res, &r)
	var b strings.Builder
	for _, c := range r.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
			b.WriteString("\n")
		} else {
			fmt.Fprintf(&b, "[%s 内容未展示]\n", c.Type)
		}
	}
	out := aiScrub(strings.TrimSpace(b.String()))
	if r.IsError {
		return "外部工具报错：" + out
	}
	if len(out) > aiMaxResult {
		out = out[:aiMaxResult] + "\n…（结果过长，已截断）"
	}
	return out
}

// stepKind tells the browser what kind of step a tool call is.
func stepKind(name string) string {
	switch {
	case name == "use_skill" || name == runSkillScriptName:
		return "skill"
	case strings.HasPrefix(name, "mcp__"):
		return "mcp"
	case name == "web_search" || name == "web_fetch" || name == checkPkgSecName:
		return "web"
	case name == "search_knowledge" || name == "read_knowledge":
		return "kb"
	case name == "save_memory":
		return "memory"
	case name == runPythonName || name == runShellName || name == viewImagesName:
		return "sandbox"
	}
	return "tool"
}

// ---- admin API ----

func (s *storeServer) handleAIExt(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	switch {
	case parts[0] == "skills" && len(parts) == 1 && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"skills": localizedSkills(wLang(w), s.skills(true))})
	case parts[0] == "skills" && len(parts) == 1 && r.Method == "PUT":
		var in skillSettings
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&in) != nil || len(in.Custom) > 100 || len(in.Overrides) > 50 {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		builtins := map[string]bool{}
		seen := map[string]bool{}
		for _, b := range builtinSkills() {
			builtins[b.Name] = true
			seen[b.Name] = true
		}
		if msg := checkSkillOverrides(in.Overrides, builtins); msg != "" {
			s.fail(w, 400, msg)
			return
		}
		if msg := checkSkills(in.Custom, seen); msg != "" {
			s.fail(w, 400, msg)
			return
		}
		if err := writeJSONFile(s.aiFile("ai-skills.json"), in); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "ai-skills", session.User, "")
		s.writeJSON(w, 200, map[string]any{"skills": localizedSkills(wLang(w), s.skills(true))})
	case parts[0] == "mcp":
		s.mcpAPI(w, r, session, parts, s.loadMCP, s.saveMCP, false)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

// mcpAPI manages a list of outside services: the platform's (for administrators) or one person's own (mine).
func (s *storeServer) mcpAPI(w http.ResponseWriter, r *http.Request, session storeSession, parts []string, load func() []mcpServer, save func([]mcpServer) error, mine bool) {
	switch {
	case parts[0] == "mcp" && len(parts) == 1 && r.Method == "GET":
		all := load()
		for i := range all {
			all[i].TokenEnc = map[bool]string{true: "set", false: ""}[all[i].TokenEnc != ""]
		}
		s.writeJSON(w, 200, map[string]any{"servers": all})
	case parts[0] == "mcp" && (len(parts) == 1 && r.Method == "POST" || len(parts) == 2 && r.Method == "PUT"):
		var in struct {
			mcpServer
			Token string `json:"token"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		sv := in.mcpServer
		sv.Name, sv.URL = strings.TrimSpace(sv.Name), strings.TrimSpace(sv.URL)
		if sv.Name == "" || len([]rune(sv.Name)) > 40 {
			s.fail(w, 400, "请填写名称")
			return
		}
		if err := validProviderURL(sv.URL); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		aiMu.Lock()
		defer aiMu.Unlock()
		all := load()
		if mine {
			sv.AllowWrite = false
		}
		if r.Method == "POST" {
			if len(all) >= 20 {
				s.fail(w, 409, "最多接入 20 个服务")
				return
			}
			sv.ID, sv.TokenEnc, sv.Tools = randomStoreToken(3), "", nil
			if mine {
				sv.ID = "u" + sv.ID
			}
			all = append(all, sv)
		} else {
			found := false
			for i := range all {
				if all[i].ID == parts[1] {
					sv.ID, sv.TokenEnc = all[i].ID, all[i].TokenEnc
					if all[i].URL == sv.URL {
						sv.Tools, sv.Checked, sv.ServerName = all[i].Tools, all[i].Checked, all[i].ServerName
					} else {
						sv.Tools, sv.Checked = nil, ""
					}
					all[i], found = sv, true
				}
			}
			if !found {
				s.fail(w, 404, "没有这个服务")
				return
			}
		}
		if t := strings.TrimSpace(in.Token); t != "" {
			enc, err := s.aiEncrypt(t)
			if err != nil {
				s.fail(w, 500, "令牌无法保存")
				return
			}
			for i := range all {
				if all[i].ID == sv.ID {
					all[i].TokenEnc = enc
				}
			}
		}
		if err := save(all); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, map[bool]string{true: "me-mcp", false: "ai-mcp"}[mine], session.User, sv.Name)
		s.writeJSON(w, 200, map[string]string{"id": sv.ID})
	case parts[0] == "mcp" && len(parts) == 2 && r.Method == "DELETE":
		aiMu.Lock()
		all := load()
		keep := all[:0]
		for _, x := range all {
			if x.ID != parts[1] {
				keep = append(keep, x)
			}
		}
		err := save(keep)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, map[bool]string{true: "me-mcp-delete", false: "ai-mcp-delete"}[mine], session.User, parts[1])
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case parts[0] == "mcp" && len(parts) == 3 && parts[2] == "refresh" && r.Method == "POST":
		aiMu.Lock()
		var sv mcpServer
		for _, x := range load() {
			if x.ID == parts[1] {
				sv = x
			}
		}
		aiMu.Unlock()
		if sv.ID == "" {
			s.fail(w, 404, "没有这个服务")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		tools, name, err := s.mcpListTools(ctx, sv)
		aiMu.Lock()
		all := load()
		for i := range all {
			if all[i].ID == sv.ID {
				all[i].Checked = time.Now().UTC().Format(time.RFC3339)
				all[i].Error = ""
				if err != nil {
					all[i].Error = err.Error()
				} else {
					sort.Slice(tools, func(a, b int) bool { return tools[a].Name < tools[b].Name })
					all[i].Tools, all[i].ServerName = tools, name
				}
			}
		}
		_ = save(all)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 502, err.Error())
			return
		}
		s.writeJSON(w, 200, map[string]any{"tools": tools, "server_name": name})
	default:
		s.fail(w, 404, "接口不存在")
	}
}

// aiOptions is what a person can switch on for a message: deep thinking, the web, skills and outside services.
func (s *storeServer) aiOptions(user string) map[string]any {
	aiSt := s.aiLoad()
	allowSkills := aiSt.Features["skills"].Enabled && s.userCanAIFeaturePerm(user, "skills")
	allowMCP := aiSt.Features["mcp"].Enabled && s.userCanAIFeaturePerm(user, "mcp")
	allowKB := aiSt.Features["kb"].Enabled && s.userCanAIFeaturePerm(user, "kb")
	skills := []map[string]any{}
	if allowSkills {
		for _, sk := range s.skillsFor(user, false) {
			skills = append(skills, map[string]any{"name": sk.Name, "title": sk.Title, "description": sk.Description, "mine": sk.Mine, "scripts": len(sk.Scripts)})
		}
	}
	mcp := []map[string]any{}
	if allowMCP {
		for _, sv := range s.mcpFor(user) {
			if !sv.Enabled {
				continue
			}
			n := 0
			off := map[string]bool{}
			for _, t := range sv.Disabled {
				off[t] = true
			}
			for _, t := range sv.Tools {
				if !off[t.Name] && (t.ReadOnly || sv.AllowWrite) {
					n++
				}
			}
			mcp = append(mcp, map[string]any{"id": sv.ID, "name": sv.Name, "tools": n, "mine": sv.Mine})
		}
	}
	kbCount, kbTeamCount := 0, 0
	if allowKB {
		kbCount = len(s.kbList(user))
		kbTeamCount = len(s.teamDocsFor(user))
	}
	w := s.webSettings()
	sbSt, _, sbOn := s.sandboxOn()
	return map[string]any{
		"web":                 w.ready(),
		"web_provider":        w.Provider,
		"skills":              skills,
		"mcp":                 mcp,
		"kb":                  kbCount,
		"kb_team":             kbTeamCount,
		"sandbox":             sbOn,
		"sandbox_exec_policy": sbSt.ExecPolicy,
		"sandbox_net_policy":  sbSt.NetPolicy,
	}
}
