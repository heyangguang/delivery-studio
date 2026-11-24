package main

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"middleware-deployer/mwpack"
)

// reportCmdCtx carries concrete deployment facts for rendering standalone, directly executable
// Linux / middleware shell commands in delivery reports (variantCmd), replacing internal automation
// wrapper scripts (setup-root-ssh-trust.sh, bootstrap-ansible.sh, mw-data-disk.sh, mw-apt-setup.sh,
// pgtest.py, pgstep_*.py, and embedded Python validation blobs) for both new and historical jobs.
type reportCmdCtx struct {
	ClusterID    string
	ProjectDir   string
	Controller   string
	ControllerIP string
	Platform     string
	IsEL         bool
	Hosts        []string          // ordered hostnames
	HostIPs      map[string]string // hostname -> IP
	LockPkgs     map[string][]string
	Plan         *mwpack.Plan
	Dep          *mwpack.Deployment
	Lang         string

	// PostgreSQL / Patroni extracted facts (populated when present)
	PGInstID      string
	PGMajor       string
	PGBin         string
	PGDataDir     string
	PGTestRoot    string
	PGStanza      string
	PGPort        int
	PatroniPort   int
	PGPrimary     string
	PGPrimaryIP   string
	PGReplicas    []string
	PGTDE         bool
	PGTLS         bool
	PGSSLMode     string
	WriterHost    string
	WriterPort    int
	WriterResolve string

	// etcd extracted facts
	EtcdInstID string
	EtcdHosts  []string
}

func (s *storeServer) buildReportCmdCtx(j storeJob, hostIPs map[string]string, lang string) reportCmdCtx {
	dep := s.readSpec(j.ID)
	plan := s.solvedJob(j.ID)
	lockPkgs := s.lockPackages(j.ID)
	ctx := reportCmdCtx{
		ClusterID:  j.ClusterID,
		ProjectDir: "/root/middleware-automation/projects/" + j.ClusterID,
		HostIPs:    map[string]string{},
		LockPkgs:   lockPkgs,
		Plan:       plan,
		Dep:        dep,
		Lang:       lang,
		PGMajor:    "17",
		PGPort:     5432,
		PatroniPort: 8008,
		PGSSLMode:  "verify-full",
	}
	for k, v := range hostIPs {
		ctx.HostIPs[k] = v
	}
	if dep != nil {
		ctx.Platform = dep.Platform
		ctx.Controller = dep.Controller
		for _, h := range dep.Hosts {
			ctx.Hosts = append(ctx.Hosts, h.Name)
			if h.IP != "" {
				ctx.HostIPs[h.Name] = h.IP
			}
		}
		if ctx.Controller == "" && len(dep.Hosts) > 0 {
			ctx.Controller = dep.Hosts[0].Name
		}
		if dep.ExecutionHost != nil && dep.ExecutionHost.Name != "" {
			ctx.Controller = dep.ExecutionHost.Name
			if dep.ExecutionHost.IP != "" {
				ctx.HostIPs[dep.ExecutionHost.Name] = dep.ExecutionHost.IP
			}
		}
		ctx.ControllerIP = ctx.HostIPs[ctx.Controller]
	}
	if ctx.ControllerIP == "" && len(ctx.Hosts) > 0 {
		ctx.ControllerIP = ctx.HostIPs[ctx.Hosts[0]]
	}
	plLow := strings.ToLower(ctx.Platform)
	ctx.IsEL = strings.Contains(plLow, "el") || strings.Contains(plLow, "rhel") || strings.Contains(plLow, "rocky") || strings.Contains(plLow, "centos") || strings.Contains(plLow, "kylin") || strings.Contains(plLow, "openeuler")

	if plan != nil {
		for _, inst := range plan.Instances {
			switch inst.Component {
			case "postgresql", "patroni":
				ctx.PGInstID = inst.ID
				if v := strings.TrimSpace(inst.Version); v != "" {
					if dot := strings.IndexByte(v, '.'); dot > 0 {
						ctx.PGMajor = v[:dot]
					} else {
						ctx.PGMajor = v
					}
				}
				if p, ok := asIntParam(inst.Params["port"]); ok && p > 0 {
					ctx.PGPort = p
				}
				if p, ok := asIntParam(inst.Params["restapi_port"]); ok && p > 0 {
					ctx.PatroniPort = p
				}
				if b, ok := inst.Params["tde"].(bool); ok {
					ctx.PGTDE = b
				}
				if b, ok := inst.Params["tls"].(bool); ok {
					ctx.PGTLS = b
				}
				if sm, ok := inst.Params["test_sslmode"].(string); ok && strings.TrimSpace(sm) != "" {
					ctx.PGSSLMode = strings.TrimSpace(sm)
				}
				if hs := inst.Roles["primary"]; len(hs) > 0 {
					ctx.PGPrimary = hs[0]
					ctx.PGPrimaryIP = ctx.HostIPs[hs[0]]
				}
				for _, r := range inst.Roles["replica"] {
					ctx.PGReplicas = append(ctx.PGReplicas, r)
				}
				if ctx.PGPrimary == "" && len(inst.Hosts) > 0 {
					ctx.PGPrimary = inst.Hosts[0]
					ctx.PGPrimaryIP = ctx.HostIPs[inst.Hosts[0]]
				}
				if f, ok := inst.Fronts["writer"]; ok {
					ctx.WriterHost = f.Address
					ctx.WriterPort = f.Listen
					if f.ResolveIP != "" {
						ctx.WriterResolve = f.ResolveIP
					}
				}
				ctx.PGStanza = ctx.ClusterID + "-" + inst.ID
			case "etcd":
				ctx.EtcdInstID = inst.ID
				ctx.EtcdHosts = append([]string(nil), inst.Hosts...)
			case "external-lb":
				if addr, ok := inst.Params["address"].(string); ok && strings.TrimSpace(addr) != "" && ctx.WriterHost == "" {
					ctx.WriterHost = strings.TrimSpace(addr)
				}
				if rip, ok := inst.Params["resolve_ip"].(string); ok && strings.TrimSpace(rip) != "" && ctx.WriterResolve == "" {
					ctx.WriterResolve = strings.TrimSpace(rip)
				}
			}
		}
	}
	if ctx.PGInstID == "" {
		ctx.PGInstID = "pg"
		ctx.PGStanza = ctx.ClusterID + "-pg"
	}
	if ctx.IsEL {
		ctx.PGBin = "/usr/pgsql-" + ctx.PGMajor + "/bin"
	} else {
		ctx.PGBin = "/usr/lib/postgresql/" + ctx.PGMajor + "/bin"
	}
	ctx.PGDataDir = "/data/pg/" + ctx.PGMajor + "/data"
	ctx.PGTestRoot = "/data/pg/" + ctx.PGMajor + "/test-accept"
	if ctx.WriterPort == 0 {
		ctx.WriterPort = ctx.PGPort
	}
	if ctx.WriterHost == "" {
		ctx.WriterHost = ctx.PGPrimaryIP
	}
	return ctx
}

func asIntParam(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		return int(x), true
	}
	return 0, false
}

func (c reportCmdCtx) hostIP(name string) string {
	if ip := c.HostIPs[name]; ip != "" {
		return ip
	}
	return name
}

func (c reportCmdCtx) firstReplica() (name, ip string) {
	if len(c.PGReplicas) > 0 {
		return c.PGReplicas[0], c.hostIP(c.PGReplicas[0])
	}
	for _, h := range c.Hosts {
		if h != c.PGPrimary {
			return h, c.hostIP(h)
		}
	}
	return c.PGPrimary, c.PGPrimaryIP
}

func (c reportCmdCtx) secondReplica() (name, ip string) {
	if len(c.PGReplicas) > 1 {
		return c.PGReplicas[1], c.hostIP(c.PGReplicas[1])
	}
	return c.firstReplica()
}

func (c reportCmdCtx) etcdEndpoints() string {
	hs := c.EtcdHosts
	if len(hs) == 0 {
		hs = c.Hosts
	}
	var eps []string
	for _, h := range hs {
		eps = append(eps, c.hostIP(h)+":2379")
	}
	return strings.Join(eps, ",")
}

func (c reportCmdCtx) lockedPkgsFor(instID, stepTitle string) []string {
	// 1. First prefer exact packages resolved for this instance in the solved plan.
	if c.Plan != nil && instID != "" {
		if inst := c.Plan.Instance(instID); inst != nil && len(inst.Packages) > 0 {
			seen := map[string]bool{}
			var out []string
			for _, pk := range inst.Packages {
				n := strings.TrimSpace(pk.Name)
				if n != "" && !seen[n] {
					seen[n] = true
					out = append(out, n)
				}
			}
			if len(out) > 0 {
				return out
			}
		}
	}
	if len(c.LockPkgs) == 0 {
		return nil
	}
	low := strings.ToLower(instID + " " + stepTitle)
	var all []string
	for k := range c.LockPkgs {
		all = append(all, k)
	}
	sort.Strings(all)

	var matched []string
	for _, pkg := range all {
		pl := strings.ToLower(pkg)
		switch {
		case strings.Contains(low, "etcd") || strings.Contains(low, "dcs"):
			if strings.Contains(pl, "etcd") {
				matched = append(matched, pkg)
			}
		case strings.Contains(low, "postgres") || strings.Contains(low, "patroni") || instID == c.PGInstID:
			if strings.Contains(pl, "postgres") || strings.Contains(pl, "patroni") || strings.Contains(pl, "pg-") || strings.Contains(pl, "pgbackrest") {
				matched = append(matched, pkg)
			}
		case strings.Contains(low, "redis"):
			if strings.Contains(pl, "redis") {
				matched = append(matched, pkg)
			}
		case strings.Contains(low, "nginx"):
			if strings.Contains(pl, "nginx") {
				matched = append(matched, pkg)
			}
		case strings.Contains(low, "haproxy"):
			if strings.Contains(pl, "haproxy") {
				matched = append(matched, pkg)
			}
		case strings.Contains(low, "keepalived"):
			if strings.Contains(pl, "keepalived") {
				matched = append(matched, pkg)
			}
		}
	}
	if len(matched) > 0 {
		return matched
	}
	return all
}

// expandManualStepToCmd translates manual prepare/bootstrap steps that invoke bundled helper scripts
// (setup-root-ssh-trust.sh, bootstrap-ansible.sh) into standard, self-contained Linux / OpenSSH
// commands for the standalone executable command report (variantCmd).
func (c reportCmdCtx) expandManualStepToCmd(st reportStep) string {
	cmd := strings.TrimSpace(st.Command)
	lang := c.Lang

	// 1. Deploy bootstrap step: offline Ansible install is an automation-only prerequisite;
	// in standalone command mode show the equivalent SSH & host readiness verification command.
	if st.Key == "deploy/deploy-bootstrap" || strings.Contains(cmd, "bootstrap-ansible.sh") {
		var ips []string
		for _, h := range c.Hosts {
			ips = append(ips, c.hostIP(h))
		}
		if len(ips) == 0 {
			return tr(lang, "# 核对各节点主机名与 IP 连通性\nhostname && hostname -I", "# Verify host identity and IP\nhostname && hostname -I")
		}
		return fmt.Sprintf(
			tr(lang,
				"# 核对全部集群节点免密连通与主机名\nfor ip in %s; do\n  ssh -o BatchMode=yes -o ConnectTimeout=5 root@\"$ip\" 'hostname && hostname -I'\ndone",
				"# Verify passwordless SSH and identity across all cluster nodes\nfor ip in %s; do\n  ssh -o BatchMode=yes -o ConnectTimeout=5 root@\"$ip\" 'hostname && hostname -I'\ndone",
			),
			strings.Join(ips, " "),
		)
	}

	// 1b. AI-amended or manual steps that run an inline Ansible playbook (e.g. ansible-playbook ... <<'YAML')
	// or ad-hoc ansible command must be translated to pure Linux commands for 命令版 (variantCmd).
	if strings.Contains(cmd, "ansible-playbook") || reAnsibleAdhocCmd.MatchString(cmd) {
		if translated, ok := expandInlineAnsibleToCmd(cmd, lang); ok {
			return translated
		}
		return tr(lang,
			"# 该现场补充步骤通过 Ansible Playbook 执行（详见「Playbook 步骤」视图）",
			"# This on-site amended step runs via Ansible Playbook (see Playbook view)",
		)
	}

	if !strings.Contains(cmd, "setup-root-ssh-trust.sh") {
		return cleanDotDotInText(cmd)
	}

	// 2. setup-root-ssh-trust.sh prepare <node>
	if m := regexp.MustCompile(`setup-root-ssh-trust\.sh\s+prepare\s+(\S+)`).FindStringSubmatch(cmd); len(m) == 2 {
		node := m[1]
		var hostsLines []string
		for _, h := range c.Hosts {
			hostsLines = append(hostsLines, fmt.Sprintf("%s %s", c.hostIP(h), h))
		}
		if len(hostsLines) == 0 {
			hostsLines = append(hostsLines, fmt.Sprintf("%s %s", c.hostIP(node), node))
		}
		var out []string
		out = append(out, tr(lang, "# 设置本机主机名", "# Set system hostname"))
		out = append(out, "hostnamectl set-hostname "+node)
		out = append(out, tr(lang, "# 写入集群节点 /etc/hosts 映射（如已存在同名记录请先核对）", "# Append cluster host entries to /etc/hosts"))
		out = append(out, "cat >> /etc/hosts <<'EOF'\n"+strings.Join(hostsLines, "\n")+"\nEOF")
		out = append(out, tr(lang, "# 核对主机名与解析生效", "# Verify hostname and hosts resolution"))
		out = append(out, "hostname && getent ahostsv4 "+node)
		return strings.Join(out, "\n")
	}

	// 3. setup-root-ssh-trust.sh source
	if strings.Contains(cmd, "setup-root-ssh-trust.sh source") {
		return strings.Join([]string{
			tr(lang, "# 在控制节点生成 root ED25519 密钥对（如已存在则复用）", "# Generate root ED25519 key pair on controller (reuse if present)"),
			"[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519",
			tr(lang, "# 查看并复制控制节点公钥（仅分发公钥，严禁外传私钥）", "# Print controller public key for distribution (never share private key)"),
			"cat /root/.ssh/id_ed25519.pub",
		}, "\n")
	}

	// 4. setup-root-ssh-trust.sh target / host-key
	if strings.Contains(cmd, "setup-root-ssh-trust.sh target") {
		return strings.Join([]string{
			tr(lang, "# 准备 root SSH 授权目录并写入控制节点公钥", "# Prepare root SSH directory and authorize controller public key"),
			"mkdir -p /root/.ssh && chmod 700 /root/.ssh",
			"cat >> /root/.ssh/authorized_keys <<'EOF'\n<粘贴控制节点 /root/.ssh/id_ed25519.pub 内容>\nEOF",
			"chmod 600 /root/.ssh/authorized_keys",
			tr(lang, "# 输出本机 SSH 主机公钥供控制节点登记 known_hosts", "# Print host SSH public key for controller known_hosts"),
			"cat /etc/ssh/ssh_host_ed25519_key.pub",
		}, "\n")
	}

	// 5. setup-root-ssh-trust.sh trust-node / trust-host / check-node / check
	if m := regexp.MustCompile(`setup-root-ssh-trust\.sh\s+(?:trust-node|check-node)\s+(\S+)`).FindStringSubmatch(cmd); len(m) == 2 {
		node := m[1]
		ip := c.hostIP(node)
		return strings.Join([]string{
			tr(lang, "# 登记目标节点 SSH 主机指纹至 known_hosts", "# Register target host SSH fingerprint in known_hosts"),
			"mkdir -p /root/.ssh && chmod 700 /root/.ssh",
			fmt.Sprintf("ssh-keyscan -H %s,%s >> /root/.ssh/known_hosts", ip, node),
			tr(lang, "# 验证控制节点到目标节点免密登录", "# Verify passwordless SSH from controller to target"),
			fmt.Sprintf("ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@%s 'hostname && hostname -I'", ip),
		}, "\n")
	}
	if m := regexp.MustCompile(`setup-root-ssh-trust\.sh\s+trust-host\s+(\S+)\s+(\S+)`).FindStringSubmatch(cmd); len(m) == 3 {
		ip, node := m[1], m[2]
		return strings.Join([]string{
			tr(lang, "# 登记目标节点 SSH 主机指纹并验证免密登录", "# Register target host key and verify passwordless SSH"),
			"mkdir -p /root/.ssh && chmod 700 /root/.ssh",
			fmt.Sprintf("ssh-keyscan -H %s,%s >> /root/.ssh/known_hosts", ip, node),
			fmt.Sprintf("ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@%s 'hostname && hostname -I'", ip),
		}, "\n")
	}

	return cleanDotDotInText(cmd)
}

var (
	reAnsibleAdhocCmd  = regexp.MustCompile(`(?m)(?:^|\s)(?:\S*/)?ansible\s+[^\n]*?-m\s+(?:shell|command)\s+-a\s+`)
	reAnsibleHeredoc   = regexp.MustCompile(`(?m)<<-?\s*['"]?([A-Za-z0-9_]+)['"]?\s*\n([\s\S]+?)\n[ \t]*([A-Za-z0-9_]+)\s*(?:\n|$)`)
	reAnsibleAdhocArg  = regexp.MustCompile(`-m\s+(?:shell|command)\s+-a\s+(?:'([^']+)'|"([^"]+)"|(\S+))`)
	reShellSafeBareTok = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)
)

func shellQuoteArg(s string) string {
	if s == "" {
		return "''"
	}
	if reShellSafeBareTok.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func posixERE(re string) string {
	return strings.ReplaceAll(re, `\s`, `[[:space:]]`)
}

// expandInlineAnsibleToCmd converts an AI-amended inline ansible-playbook heredoc or ad-hoc
// ansible command into directly executable, standard Linux shell commands (zero Ansible syntax).
func expandInlineAnsibleToCmd(cmd, lang string) (string, bool) {
	norm := strings.ReplaceAll(cmd, "\r\n", "\n")

	// Case A: ad-hoc `ansible <hosts> -m shell|command -a '<cmd>'`
	if reAnsibleAdhocCmd.MatchString(norm) && !strings.Contains(norm, "ansible-playbook") {
		if m := reAnsibleAdhocArg.FindStringSubmatch(norm); len(m) >= 4 {
			inner := firstNonEmptyStr(m[1], m[2], m[3])
			if strings.TrimSpace(inner) != "" {
				return strings.TrimSpace(inner), true
			}
		}
	}

	// Case B: inline heredoc YAML playbook (`ansible-playbook ... /dev/stdin <<'YAML' ... YAML`)
	var yamlBody string
	if m := reAnsibleHeredoc.FindStringSubmatch(norm); len(m) == 4 && m[1] == m[3] {
		yamlBody = m[2]
	} else if idx := strings.Index(norm, "\n---\n"); idx >= 0 {
		tail := norm[idx+1:]
		// Strip optional trailing heredoc delimiter line (e.g. YAML / EOF)
		lines := strings.Split(strings.TrimRight(tail, "\n"), "\n")
		if len(lines) > 1 {
			last := strings.TrimSpace(lines[len(lines)-1])
			if last == "YAML" || last == "EOF" || last == "PLAYBOOK" {
				lines = lines[:len(lines)-1]
			}
		}
		yamlBody = strings.Join(lines, "\n")
	}
	if strings.TrimSpace(yamlBody) == "" {
		return "", false
	}

	var plays []map[string]any
	if err := yaml.Unmarshal([]byte(yamlBody), &plays); err != nil || len(plays) == 0 {
		return "", false
	}

	asStr := func(v any) string {
		if v == nil {
			return ""
		}
		return strings.TrimSpace(fmt.Sprint(v))
	}
	asBool := func(v any) bool {
		if b, ok := v.(bool); ok {
			return b
		}
		s := strings.ToLower(asStr(v))
		return s == "true" || s == "yes" || s == "1"
	}
	asMap := func(v any) map[string]any {
		if m, ok := v.(map[string]any); ok {
			return m
		}
		return nil
	}

	var out []string
	for _, play := range plays {
		tasksRaw, _ := play["tasks"].([]any)
		for _, trRaw := range tasksRaw {
			task := asMap(trRaw)
			if task == nil {
				continue
			}
			taskName := asStr(task["name"])
			// Identify module key
			var modName string
			var modVal any
			for k, v := range task {
				switch k {
				case "name", "register", "when", "changed_when", "failed_when", "become", "become_user",
					"ignore_errors", "vars", "loop", "with_items", "tags", "notify", "environment", "delegate_to", "run_once":
					continue
				}
				modName = k
				modVal = v
				break
			}
			shortMod := modName
			if dot := strings.LastIndexByte(shortMod, '.'); dot >= 0 {
				shortMod = shortMod[dot+1:]
			}

			var taskLines []string
			switch shortMod {
			case "debug", "set_fact", "stat", "meta", "assert", "fail":
				// Pure Ansible telemetry/plumbing: omit from customer CLI commands.
				continue

			case "lineinfile":
				m := asMap(modVal)
				if m == nil {
					continue
				}
				filePath := firstNonEmptyStr(asStr(m["path"]), asStr(m["dest"]))
				lineVal := asStr(m["line"])
				reVal := posixERE(asStr(m["regexp"]))
				state := strings.ToLower(asStr(m["state"]))
				if filePath == "" {
					continue
				}
				if asBool(m["backup"]) {
					taskLines = append(taskLines, fmt.Sprintf("cp -a %s %s.bak.$(date +%%Y%%m%%d%%H%%M%%S)", shellQuoteArg(filePath), shellQuoteArg(filePath)))
				}
				if state == "absent" {
					if reVal != "" {
						taskLines = append(taskLines, fmt.Sprintf("sed -i -E %s %s", shellQuoteArg("/"+reVal+"/d"), shellQuoteArg(filePath)))
					} else if lineVal != "" {
						taskLines = append(taskLines, fmt.Sprintf("grep -vxF %s %s > %s.tmp && mv %s.tmp %s", shellQuoteArg(lineVal), shellQuoteArg(filePath), shellQuoteArg(filePath), shellQuoteArg(filePath), shellQuoteArg(filePath)))
					}
				} else if lineVal != "" {
					if reVal != "" {
						sedRepl := strings.NewReplacer(`\`, `\\`, `|`, `\|`, `&`, `\&`).Replace(lineVal)
						sedExpr := fmt.Sprintf("s|%s|%s|", strings.ReplaceAll(reVal, "|", `\|`), sedRepl)
						taskLines = append(taskLines,
							fmt.Sprintf("if grep -qE %s %s; then", shellQuoteArg(reVal), shellQuoteArg(filePath)),
							fmt.Sprintf("  sed -i -E %s %s", shellQuoteArg(sedExpr), shellQuoteArg(filePath)),
							"else",
							fmt.Sprintf("  printf '%%s\\n' %s >> %s", shellQuoteArg(lineVal), shellQuoteArg(filePath)),
							"fi",
						)
					} else {
						taskLines = append(taskLines, fmt.Sprintf("grep -qF %s %s || printf '%%s\\n' %s >> %s", shellQuoteArg(lineVal), shellQuoteArg(filePath), shellQuoteArg(lineVal), shellQuoteArg(filePath)))
					}
				}

			case "blockinfile":
				m := asMap(modVal)
				if m == nil {
					continue
				}
				filePath := firstNonEmptyStr(asStr(m["path"]), asStr(m["dest"]))
				blockVal := strings.TrimRight(asStr(m["block"]), "\n")
				if filePath == "" || blockVal == "" {
					continue
				}
				if asBool(m["backup"]) {
					taskLines = append(taskLines, fmt.Sprintf("cp -a %s %s.bak.$(date +%%Y%%m%%d%%H%%M%%S)", shellQuoteArg(filePath), shellQuoteArg(filePath)))
				}
				taskLines = append(taskLines, fmt.Sprintf("cat >> %s <<'EOF'\n%s\nEOF", shellQuoteArg(filePath), blockVal))

			case "command", "shell":
				if m := asMap(modVal); m != nil {
					if argv, ok := m["argv"].([]any); ok && len(argv) > 0 {
						parts := make([]string, 0, len(argv))
						for _, a := range argv {
							parts = append(parts, shellQuoteArg(fmt.Sprint(a)))
						}
						taskLines = append(taskLines, strings.Join(parts, " "))
					} else if c := firstNonEmptyStr(asStr(m["cmd"]), asStr(m["_raw_params"])); c != "" {
						taskLines = append(taskLines, c)
					}
				} else if s := asStr(modVal); s != "" {
					taskLines = append(taskLines, s)
				}

			case "copy":
				m := asMap(modVal)
				if m == nil {
					continue
				}
				dest := asStr(m["dest"])
				if dest == "" {
					continue
				}
				if asBool(m["backup"]) {
					taskLines = append(taskLines, fmt.Sprintf("[ -f %s ] && cp -a %s %s.bak.$(date +%%Y%%m%%d%%H%%M%%S)", shellQuoteArg(dest), shellQuoteArg(dest), shellQuoteArg(dest)))
				}
				if content, hasC := m["content"]; hasC {
					body := strings.TrimRight(fmt.Sprint(content), "\n")
					taskLines = append(taskLines, fmt.Sprintf("cat > %s <<'EOF'\n%s\nEOF", shellQuoteArg(dest), body))
				} else if src := asStr(m["src"]); src != "" {
					taskLines = append(taskLines, fmt.Sprintf("cp -a %s %s", shellQuoteArg(src), shellQuoteArg(dest)))
				}
				if mode := asStr(m["mode"]); mode != "" {
					taskLines = append(taskLines, fmt.Sprintf("chmod %s %s", shellQuoteArg(mode), shellQuoteArg(dest)))
				}
				if owner := asStr(m["owner"]); owner != "" {
					grp := asStr(m["group"])
					og := owner
					if grp != "" {
						og = owner + ":" + grp
					}
					taskLines = append(taskLines, fmt.Sprintf("chown %s %s", shellQuoteArg(og), shellQuoteArg(dest)))
				}

			case "file":
				m := asMap(modVal)
				if m == nil {
					continue
				}
				filePath := firstNonEmptyStr(asStr(m["path"]), asStr(m["dest"]))
				state := strings.ToLower(asStr(m["state"]))
				if filePath == "" {
					continue
				}
				switch state {
				case "directory":
					taskLines = append(taskLines, "mkdir -p "+shellQuoteArg(filePath))
				case "absent":
					taskLines = append(taskLines, "rm -rf "+shellQuoteArg(filePath))
				case "link":
					if src := asStr(m["src"]); src != "" {
						taskLines = append(taskLines, fmt.Sprintf("ln -sfn %s %s", shellQuoteArg(src), shellQuoteArg(filePath)))
					}
				case "touch":
					taskLines = append(taskLines, "touch "+shellQuoteArg(filePath))
				}
				if mode := asStr(m["mode"]); mode != "" {
					taskLines = append(taskLines, fmt.Sprintf("chmod %s %s", shellQuoteArg(mode), shellQuoteArg(filePath)))
				}
				if owner := asStr(m["owner"]); owner != "" {
					grp := asStr(m["group"])
					og := owner
					if grp != "" {
						og = owner + ":" + grp
					}
					taskLines = append(taskLines, fmt.Sprintf("chown %s %s", shellQuoteArg(og), shellQuoteArg(filePath)))
				}

			case "systemd", "systemd_service", "service":
				m := asMap(modVal)
				if m == nil {
					continue
				}
				unit := asStr(m["name"])
				if asBool(m["daemon_reload"]) {
					taskLines = append(taskLines, "systemctl daemon-reload")
				}
				if unit != "" {
					switch strings.ToLower(asStr(m["state"])) {
					case "started":
						taskLines = append(taskLines, "systemctl start "+shellQuoteArg(unit))
					case "stopped":
						taskLines = append(taskLines, "systemctl stop "+shellQuoteArg(unit))
					case "restarted":
						taskLines = append(taskLines, "systemctl restart "+shellQuoteArg(unit))
					case "reloaded":
						taskLines = append(taskLines, "systemctl reload "+shellQuoteArg(unit))
					}
					if m["enabled"] != nil {
						if asBool(m["enabled"]) {
							taskLines = append(taskLines, "systemctl enable "+shellQuoteArg(unit))
						} else {
							taskLines = append(taskLines, "systemctl disable "+shellQuoteArg(unit))
						}
					}
				}

			case "sysctl":
				if m := asMap(modVal); m != nil {
					if k, v := asStr(m["name"]), asStr(m["value"]); k != "" && v != "" {
						taskLines = append(taskLines, fmt.Sprintf("sysctl -w %s=%s", shellQuoteArg(k), shellQuoteArg(v)))
					}
				}

			case "wait_for":
				if m := asMap(modVal); m != nil {
					host := firstNonEmptyStr(asStr(m["host"]), "127.0.0.1")
					port := asStr(m["port"])
					if port != "" {
						taskLines = append(taskLines, fmt.Sprintf("nc -zv -w 5 %s %s", shellQuoteArg(host), shellQuoteArg(port)))
					}
				}
			}

			if len(taskLines) > 0 {
				if taskName != "" {
					out = append(out, "# "+taskName)
				}
				out = append(out, taskLines...)
			}
		}
	}

	if len(out) == 0 {
		return "", false
	}
	return strings.Join(out, "\n"), true
}

// sanitizeIncidentTextForCmd strips raw Ansible playbook invocation lines from incident resolution prose
// when rendering in pure-command mode (variantResultCmd).
func sanitizeIncidentTextForCmd(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var kept []string
	for _, ln := range lines {
		trim := strings.TrimSpace(ln)
		if strings.Contains(trim, "ansible-playbook") || strings.HasPrefix(trim, "cd /root/middleware-automation/") {
			continue
		}
		kept = append(kept, ln)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

var (
	rePGTestCall     = regexp.MustCompile(`python3[^\n]*pgtest\.py['"]?[ \t]+['"]?\S+['"]?[ \t]+['"]?\S+['"]?[ \t]+['"]?([a-z0-9-]+)['"]?`)
	rePGStepFile     = regexp.MustCompile(`pgstep_([a-z0-9_]+)\.(?:py|json\.j2)`)
	reDataDiskCall   = regexp.MustCompile(`/usr/local/sbin/mw-data-disk\.sh\s+('[^']*'|\S+)\s+('[^']*'|\S+)\s+('[^']*'|\S+)\s+('[^']*'|\S+)`)
	reRepoSetupCall  = regexp.MustCompile(`/usr/local/sbin/mw-repo-setup\.sh\s+('[^']*'|\S+)\s+('[^']*'|\S+)\s+(.+)`)
	reUnarchiveNote  = regexp.MustCompile(`^#\s*unarchive\s+(\S+)\s*→\s*(\S+)`)
	reWaitForNote    = regexp.MustCompile(`^#\s*等待\s+([^:\s]+):(\d+)\s+可连接`)
	reTemplateNote   = regexp.MustCompile(`^#\s*按模板\s+(\S+)\s+生成\s+(\S+)`)
	reOfflineInstall = regexp.MustCompile(`^#\s*从离线软件源安装：(.*)$`)
)

// renderPartExecutableLines converts one planStepDoc's distilled actions into clean, standalone,
// copy-paste-executable Linux / middleware commands (zero internal helper scripts or raw Python blobs).
func (c reportCmdCtx) renderPartExecutableLines(p planStepDoc) []string {
	// 1. Check if this step is a PostgreSQL / Patroni script-backed test, endpoint check, or cleanup step.
	if action := detectPGScriptAction(p); action != "" {
		if expanded := c.expandPGActionCommands(action); len(expanded) > 0 {
			return expanded
		}
	}
	if isPGFrontPreflightPart(p) {
		return c.expandPGFrontPreflightCommands()
	}

	// 2. Otherwise purify every distilled action in order, expanding platform helper scripts & placeholders.
	var out []string
	seenLine := map[string]bool{}
	for i := 0; i < len(p.Actions); i++ {
		a := p.Actions[i]
		name := mwpack.TranslateCatalogText(c.Lang, strings.ReplaceAll(strings.TrimSpace(a.Name), "\n", " "))
		cmd := strings.TrimSpace(a.Cmd)

		// Skip internal helper script copy steps (mw-data-disk.sh, mw-apt-setup.sh, mw-dnf-setup.sh, pgtest.py, pgcommon.py, pgstep_*.py).
		if isHelperScriptCopyCmd(cmd) {
			continue
		}
		// Skip raw 60-line embedded Python validation scripts from front_preflight if included inline.
		if isInlinePythonBlob(cmd) {
			if strings.Contains(cmd, "socket.getaddrinfo") || strings.Contains(cmd, "create_connection") {
				key := "__preflight_replaced__"
				if !seenLine[key] {
					seenLine[key] = true
					out = append(out, c.expandPGFrontPreflightShort())
				}
			}
			continue
		}

		if cmd == "" {
			if a.Check && name != "" {
				cond := condLabel(a.When, c.Lang)
				line := tr(c.Lang, "# 核对：", "# Check: ") + name + cond
				if !seenLine[line] {
					seenLine[line] = true
					out = append(out, line)
				}
			}
			continue
		}

		expanded := c.purifySingleAction(p, name, cmd, a.When)
		if strings.TrimSpace(expanded) == "" {
			continue
		}
		// Deduplicate exact repeated blocks (e.g. 3 identical mkdir/psql identity checks).
		if seenLine[expanded] {
			continue
		}
		seenLine[expanded] = true
		out = append(out, expanded)
	}
	return out
}

func detectPGScriptAction(p planStepDoc) string {
	for _, a := range p.Actions {
		if m := rePGStepFile.FindStringSubmatch(a.Cmd); len(m) == 2 {
			return strings.ReplaceAll(m[1], "_", "-")
		}
		if m := rePGTestCall.FindStringSubmatch(a.Cmd); len(m) == 2 {
			return m[1]
		}
	}
	// Fallback by step ID when actions already omitted or matched pgstep_ naming
	id := strings.TrimSpace(p.ID)
	switch id {
	case "ha-check", "tde", "physical-backup", "physical-restore", "full-backup", "full-restore",
		"pitr", "switchover", "failover", "switchback", "pitr-switchover", "rewind-check",
		"via-front", "tls-negative", "front-switchover", "front-failover", "front-write-switchover",
		"inspect", "clean-tests", "clean-artifacts", "reset-backups", "backup-info":
		for _, a := range p.Actions {
			if strings.Contains(a.Cmd, "pgtest") || strings.Contains(a.Cmd, "pgstep_") || strings.Contains(a.Cmd, "pgcommon") {
				return id
			}
		}
	}
	return ""
}

func isPGFrontPreflightPart(p planStepDoc) bool {
	if p.ID == "front-preflight" || strings.Contains(p.Title, "全节点入口解析") {
		return true
	}
	for _, a := range p.Actions {
		if strings.Contains(a.Cmd, "socket.getaddrinfo") && strings.Contains(a.Cmd, "needs_hosts") {
			return true
		}
	}
	return false
}

func isInternalWrapperCmd(cmd string) bool {
	if isHelperScriptCopyCmd(cmd) || isInlinePythonBlob(cmd) {
		return true
	}
	for _, needle := range []string{
		"setup-root-ssh-trust.sh",
		"bootstrap-ansible.sh",
		"mw-data-disk.sh",
		"mw-repo-setup.sh",
		"mw-apt-setup.sh",
		"mw-dnf-setup.sh",
		"pgtest.py",
		"pgcommon.py",
		"pgstep_",
	} {
		if strings.Contains(cmd, needle) {
			return true
		}
	}
	return false
}

func isHelperScriptCopyCmd(cmd string) bool {
	if strings.Contains(cmd, "cp mw-data-disk.sh ") ||
		strings.Contains(cmd, "cp mw-apt-setup.sh ") ||
		strings.Contains(cmd, "cp mw-dnf-setup.sh ") ||
		strings.Contains(cmd, "cp pgtest.py ") ||
		strings.Contains(cmd, "cp pgcommon.py ") ||
		strings.Contains(cmd, "cp pgstep_") ||
		strings.Contains(cmd, "pgtest.json.j2") {
		return true
	}
	return false
}

func isInlinePythonBlob(cmd string) bool {
	if (strings.Contains(cmd, "python3 -c") || strings.Contains(cmd, "/usr/bin/python3 -c")) && strings.Count(cmd, "\n") >= 4 {
		return true
	}
	return false
}

func condLabel(when, lang string) string {
	w := strings.TrimSpace(when)
	if w == "" || len([]rune(w)) > 100 {
		return ""
	}
	// Hide internal Ansible variable expressions like mw_pkg_family / item.stdout / pg_sysctl.changed
	if strings.Contains(w, "mw_pkg_family") || strings.Contains(w, "from_json") || strings.Contains(w, ".changed") || strings.Contains(w, ".stat.exists") || strings.Contains(w, "pg_providers") || strings.Contains(w, "pg_tde_marker") {
		return ""
	}
	return tr(lang, "（仅当 "+w+"）", " (when "+w+")")
}

func cleanDotDotInText(s string) string {
	if !strings.Contains(s, "/../") {
		return s
	}
	lines := strings.Split(s, "\n")
	for i, ln := range lines {
		if !strings.Contains(ln, "/../") {
			continue
		}
		for _, tok := range strings.Fields(ln) {
			if strings.Contains(tok, "/../") && strings.HasPrefix(tok, "/") {
				ln = strings.ReplaceAll(ln, tok, path.Clean(tok))
			}
		}
		lines[i] = ln
	}
	return strings.Join(lines, "\n")
}

func unquoteArg(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && ((s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"')) {
		return s[1 : len(s)-1]
	}
	return s
}

func (c reportCmdCtx) purifySingleAction(p planStepDoc, name, cmd, when string) string {
	lang := c.Lang
	cmd = cleanDotDotInText(cmd)
	cond := condLabel(when, lang)

	// 1. mw-data-disk.sh init/check
	if m := reDataDiskCall.FindStringSubmatch(cmd); len(m) == 5 {
		mode, disk, part, target := unquoteArg(m[1]), unquoteArg(m[2]), unquoteArg(m[3]), unquoteArg(m[4])
		if target == "" || strings.Contains(target, "<") {
			target = "/data"
		}
		if mode != "init" && mode != "check" {
			mode = "init"
			if c.Dep != nil && len(c.Dep.Hosts) > 0 && !c.Dep.Hosts[0].Initialize && strings.Contains(strings.ToLower(name), "核对") {
				mode = "check"
			}
		}
		if mode == "check" {
			return fmt.Sprintf(
				tr(lang,
					"# 检查数据盘已挂载且设备有效\nfindmnt -nro SOURCE,FSTYPE --mountpoint %s\nlsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS %s",
					"# Verify data disk is mounted\nfindmnt -nro SOURCE,FSTYPE --mountpoint %s\nlsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS %s",
				),
				target, disk,
			)
		}
		return strings.Join([]string{
			tr(lang, "# 核对目标数据盘空闲无残留分区/签名（若已格式化挂载，跳过分区与格式化步骤直接验证挂载即可）", "# Verify target disk is empty before partitioning (skip parted/mkfs if already formatted)"),
			fmt.Sprintf("lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS %s", disk),
			fmt.Sprintf("wipefs --no-act %s", disk),
			tr(lang, "# 初始化 GPT 分区并格式化为 ext4", "# Create GPT partition and format as ext4"),
			fmt.Sprintf("parted -s %s mklabel gpt", disk),
			fmt.Sprintf("parted -s -a optimal %s mkpart primary ext4 1MiB 100%%", disk),
			fmt.Sprintf("partprobe %s && udevadm settle", disk),
			fmt.Sprintf("mkfs.ext4 -L mwdata %s", part),
			tr(lang, "# 写入 /etc/fstab 并挂载数据目录", "# Persist mount in /etc/fstab and mount data directory"),
			fmt.Sprintf("UUID=$(blkid -s UUID -o value %s)", part),
			fmt.Sprintf("mkdir -p %s", target),
			fmt.Sprintf("printf 'UUID=%%s %s ext4 defaults,noatime,nodev,nosuid 0 2\\n' \"$UUID\" >> /etc/fstab", target),
			fmt.Sprintf("systemctl daemon-reload && mount %s && df -hT %s", target, target),
		}, "\n")
	}

	// 2. mw-repo-setup.sh (apt / dnf offline repo client configuration)
	if m := reRepoSetupCall.FindStringSubmatch(cmd); len(m) == 4 {
		cluster, host, portsRaw := unquoteArg(m[1]), unquoteArg(m[2]), strings.TrimSpace(m[3])
		rawFields := strings.Fields(portsRaw)
		var ports []string
		for _, pf := range rawFields {
			pClean := unquoteArg(pf)
			if pClean != "" && !strings.Contains(pClean, "<") {
				ports = append(ports, pClean)
			}
		}
		if len(ports) == 0 {
			ports = []string{"8080"}
		}
		if c.IsEL {
			var sections []string
			for idx, port := range ports {
				sections = append(sections, fmt.Sprintf("[mw-%s-%d]\nname=mw-%s-%d\nbaseurl=http://%s:%s/\nenabled=1\ngpgcheck=0", cluster, idx+1, cluster, idx+1, host, port))
			}
			return strings.Join([]string{
				tr(lang, "# 备份原有 YUM/DNF 源并切换至离线仓库源", "# Back up existing YUM/DNF repos and point to offline repository"),
				"BACKUP=/etc/yum.repos.d/backup-before-offline-$(date +%Y%m%d_%H%M%S)",
				"mkdir -p \"$BACKUP\" && mv /etc/yum.repos.d/*.repo \"$BACKUP/\" 2>/dev/null || true",
				fmt.Sprintf("cat > /etc/yum.repos.d/mw-%s.repo <<'EOF'\n%s\nEOF", cluster, strings.Join(sections, "\n")),
				"dnf clean all && dnf makecache",
			}, "\n")
		}
		var entries []string
		for _, port := range ports {
			entries = append(entries, fmt.Sprintf("deb [trusted=yes] http://%s:%s/ ./", host, port))
		}
		return strings.Join([]string{
			tr(lang, "# 验证离线仓库连通性，备份原有 APT 源并写入离线源", "# Verify offline repo, back up existing APT sources, and configure offline list"),
			fmt.Sprintf("curl -fsS --noproxy '*' http://%s:%s/Release >/dev/null", host, ports[0]),
			"BACKUP=/etc/apt/backup-before-offline-$(date +%Y%m%d_%H%M%S)",
			"mkdir -p \"$BACKUP/sources.list.d\"",
			"[ -e /etc/apt/sources.list ] && mv /etc/apt/sources.list \"$BACKUP/\"",
			"mv /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources \"$BACKUP/sources.list.d/\" 2>/dev/null || true",
			fmt.Sprintf("cat > /etc/apt/sources.list.d/mw-%s.list <<'EOF'\n%s\nEOF", cluster, strings.Join(entries, "\n")),
			fmt.Sprintf("printf 'Acquire::http::Proxy::%s \"DIRECT\";\\n' > /etc/apt/apt.conf.d/99-mw-offline-direct", host),
			"apt-get -o DPkg::Lock::Timeout=180 update",
		}, "\n")
	}

	// 3. Offline package installation placeholder (# 从离线软件源安装：<pkg_specs> or apt-get install -y <pkg_specs>)
	if strings.Contains(cmd, "<pkg_specs>") || reOfflineInstall.MatchString(cmd) {
		pkgs := c.lockedPkgsFor(p.Instance, p.Title)
		pkgArg := strings.Join(pkgs, " ")
		if pkgArg == "" {
			if m := reOfflineInstall.FindStringSubmatch(cmd); len(m) == 2 {
				pkgArg = strings.TrimSpace(m[1])
			}
		}
		if pkgArg != "" && !strings.Contains(pkgArg, "<") {
			instCmd := "DEBIAN_FRONTEND=noninteractive apt-get install -y " + pkgArg
			if c.IsEL {
				instCmd = "dnf install -y " + pkgArg
			}
			return "# " + name + "\n" + instCmd
		}
	}

	// 4. unarchive comment -> real tar -xzf
	if m := reUnarchiveNote.FindStringSubmatch(cmd); len(m) == 3 {
		return fmt.Sprintf("# %s\ntar --no-same-owner -xzf %s -C %s", name, m[1], m[2])
	}

	// 5. wait_for comment -> real TCP wait loop
	if m := reWaitForNote.FindStringSubmatch(cmd); len(m) == 3 {
		host, port := m[1], m[2]
		if host == "本机" || host == "localhost" {
			host = "127.0.0.1"
		}
		return fmt.Sprintf("# %s\ntimeout 60 bash -c 'until (echo >/dev/tcp/%s/%s) 2>/dev/null; do sleep 2; done'", name, host, port)
	}

	// 6. Template comments -> concrete executable cat > dest <<'EOF' commands
	if m := reTemplateNote.FindStringSubmatch(cmd); len(m) == 3 {
		rendered := c.renderTemplateCmd(p.Instance, m[1], m[2], cmd)
		if rendered != "" {
			return "# " + name + "\n" + rendered
		}
	}

	// 7. Truncated 99-pg-ha.conf comment -> real cat > /etc/sysctl.d/99-pg-ha.conf <<'EOF'
	if strings.Contains(cmd, "# 写入 /etc/sysctl.d/99-pg-ha.conf") {
		return strings.Join([]string{
			"# " + name,
			"cat > /etc/sysctl.d/99-pg-ha.conf <<'EOF'",
			"vm.swappiness = 1",
			"vm.overcommit_memory = 2",
			"vm.overcommit_ratio = 90",
			"vm.dirty_ratio = 10",
			"vm.dirty_background_ratio = 5",
			"net.ipv4.tcp_keepalive_time = 60",
			"net.ipv4.tcp_keepalive_intvl = 10",
			"net.ipv4.tcp_keepalive_probes = 6",
			"net.core.somaxconn = 4096",
			"EOF",
			"chmod 0644 /etc/sysctl.d/99-pg-ha.conf",
		}, "\n")
	}

	// 8. pgBackRest stanza-create runtime placeholder (<执行时得到的值>)
	if strings.Contains(cmd, "<执行时得到的值>") && strings.Contains(strings.ToLower(name), "stanza") {
		return strings.Join([]string{
			"# " + name,
			fmt.Sprintf("# 主库执行在线建库；从库追加 --no-online"),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s stanza-create", c.PGStanza),
		}, "\n")
	}

	// 9. Patroni DCS config PATCH (previously distilled as plain `curl -s http://...:8008/config`)
	if strings.Contains(cmd, ":8008/config") && (strings.Contains(name, "更新集群配置") || strings.Contains(name, "DCS")) {
		if strings.Contains(p.Title, "TDE") || strings.Contains(p.Title, "WAL 加密") {
			return fmt.Sprintf(
				"# %s\npatronictl -c /etc/patroni/patroni.yml edit-config --force -s postgresql.parameters.pg_tde.wal_encrypt=on",
				name,
			)
		}
		if strings.Contains(p.Title, "归档") || strings.Contains(strings.ToLower(p.Title), "archive") {
			return fmt.Sprintf(
				"# %s\npatronictl -c /etc/patroni/patroni.yml edit-config --force -s postgresql.parameters.archive_mode=on -s \"postgresql.parameters.archive_command=pgbackrest --stanza=%s archive-push %%p\"",
				name, c.PGStanza,
			)
		}
	}

	// 10. Unresolved loop variables in preflight/secrets
	if strings.TrimSpace(cmd) == "getent ahostsv4 <key>" && len(c.Hosts) > 0 {
		return fmt.Sprintf("# %s\nfor h in %s; do getent ahostsv4 \"$h\"; done", name, strings.Join(c.Hosts, " "))
	}
	if strings.TrimSpace(cmd) == "chmod 0600 <path>" {
		return fmt.Sprintf("# %s\nfind %s/secrets -type f -exec chmod 0600 {} +", name, c.ProjectDir)
	}
	if strings.Contains(cmd, "# 在 /etc/hosts 中写入一段配置") && c.WriterHost != "" && c.WriterResolve != "" {
		return fmt.Sprintf("# %s\ngrep -qF '%s' /etc/hosts || printf '%s %s\\n' >> /etc/hosts", name, c.WriterHost, c.WriterResolve, c.WriterHost)
	}

	// 11. Replace inline python urllib snippet in mw_offline_repo serve verification with curl
	if strings.Contains(cmd, "urllib.request.build_opener") {
		return fmt.Sprintf("# %s\nsystemctl is-active --quiet mw-repo-%s-packages && curl -fsS --noproxy '*' http://%s:8080/.mw-serve-id", name, c.ClusterID, firstNonEmptyStr(c.ControllerIP, "127.0.0.1"))
	}

	// 12. Normalize any remaining `<执行时得到的值>` so broken placeholders never appear
	if strings.TrimSpace(cmd) == "<执行时得到的值>" {
		return ""
	}

	return "# " + name + cond + "\n" + cmd
}

func (c reportCmdCtx) instFor(instID, comp string) *mwpack.Instance {
	if c.Plan == nil {
		return nil
	}
	if instID != "" {
		if inst := c.Plan.Instance(instID); inst != nil {
			return inst
		}
	}
	for _, inst := range c.Plan.Instances {
		if inst.Component == comp {
			return inst
		}
	}
	return nil
}

func strParam(params map[string]any, key, def string) string {
	if params == nil {
		return def
	}
	if v, ok := params[key]; ok && v != nil {
		s := strings.TrimSpace(fmt.Sprint(v))
		if s != "" && s != "<nil>" {
			return s
		}
	}
	return def
}

func intParamDef(params map[string]any, key string, def int) int {
	if params == nil {
		return def
	}
	if v, ok := asIntParam(params[key]); ok && v > 0 {
		return v
	}
	return def
}

func (c reportCmdCtx) renderTemplateCmd(instID, tplSrc, dest, origCmd string) string {
	// Extract trailing chown / chmod lines from original multi-line copy/template action
	var perms []string
	for _, ln := range strings.Split(origCmd, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "chown ") || strings.HasPrefix(t, "chmod ") {
			perms = append(perms, t)
		}
	}
	appendPerms := func(body string) string {
		if len(perms) == 0 {
			return body
		}
		return body + "\n" + strings.Join(perms, "\n")
	}

	base := path.Base(tplSrc)
	switch base {
	case "repo.service.j2":
		repoDir := "/opt/middleware-repositories/" + c.ClusterID + "/repo"
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
[Unit]
Description=Offline Middleware Package Repository (%s)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%s
ExecStart=/usr/bin/python3 -m http.server 8080 --bind %s --directory %s
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF`, dest, c.ClusterID, repoDir, firstNonEmptyStr(c.ControllerIP, "0.0.0.0"), repoDir))

	case "etcd.conf.yaml.j2":
		node := firstNonEmptyStr(c.Controller, "node-1")
		ip := c.hostIP(node)
		var peers []string
		hs := c.EtcdHosts
		if len(hs) == 0 {
			hs = c.Hosts
		}
		for _, h := range hs {
			peers = append(peers, fmt.Sprintf("%s=http://%s:2380", h, c.hostIP(h)))
		}
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
name: '%s'
data-dir: '/data/etcd'
listen-peer-urls: 'http://%s:2380'
listen-client-urls: 'http://%s:2379,http://127.0.0.1:2379'
initial-advertise-peer-urls: 'http://%s:2380'
advertise-client-urls: 'http://%s:2379'
initial-cluster: '%s'
initial-cluster-token: '%s-%s'
initial-cluster-state: 'new'
EOF`, dest, node, ip, ip, ip, ip, strings.Join(peers, ","), c.ClusterID, firstNonEmptyStr(c.EtcdInstID, "etcd")))

	case "patroni.yml.j2":
		node := firstNonEmptyStr(c.PGPrimary, c.Controller, "node-1")
		ip := c.hostIP(node)
		var etcdHosts []string
		hs := c.EtcdHosts
		if len(hs) == 0 {
			hs = c.Hosts
		}
		for _, h := range hs {
			etcdHosts = append(etcdHosts, "    - "+c.hostIP(h)+":2379")
		}
		sslBlock := ""
		if c.PGTLS {
			sslBlock = `        ssl: 'on'
        ssl_cert_file: /etc/pki/pg/server.crt
        ssl_key_file: /etc/pki/pg/server.key
        ssl_ca_file: /etc/pki/pg/ca.crt`
		}
		tdeLib := ""
		if c.PGTDE {
			tdeLib = "\n        shared_preload_libraries: pg_tde"
		}
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
scope: %s
name: %s
restapi:
  listen: %s:%d
  connect_address: %s:%d
etcd3:
  hosts:
%s
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    postgresql:
      use_pg_rewind: true
      parameters:
        wal_level: replica
        wal_log_hints: 'on'
        max_wal_senders: 10%s
%s
postgresql:
  listen: 0.0.0.0:%d
  connect_address: %s:%d
  data_dir: %s
  bin_dir: %s
  authentication:
    superuser:  { username: postgres,   password: "<密码：控制节点 secrets/%s/superuser>" }
    replication:{ username: replicator, password: "<密码：控制节点 secrets/%s/replication>" }
    rewind:     { username: rewind,     password: "<密码：控制节点 secrets/%s/rewind>" }
EOF`, dest, c.PGStanza, node, ip, c.PatroniPort, ip, c.PatroniPort, strings.Join(etcdHosts, "\n"), tdeLib, sslBlock, c.PGPort, ip, c.PGPort, c.PGDataDir, c.PGBin, c.PGInstID, c.PGInstID, c.PGInstID))

	case "pgbackrest.conf.j2":
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
[global]
repo1-path=/data/backup/pgbackrest
repo1-retention-full=2
process-max=2
start-fast=y
log-path=/var/log/pgbackrest

[%s]
pg1-path=%s
pg1-port=%d
pg1-socket-path=/var/run/postgresql
EOF`, dest, c.PGStanza, c.PGDataDir, c.PGPort))

	case "postgresql-single.conf.j2":
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
listen_addresses = '*'
port = %d
wal_level = replica
max_connections = 200
EOF`, dest, c.PGPort))

	case "native-postgresql.conf.j2":
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
data_directory = '%s'
hba_file = '/etc/middleware/%s/pg_hba.conf'
listen_addresses = '*'
port = %d
wal_level = replica
wal_log_hints = on
max_wal_senders = 10
EOF`, dest, c.PGDataDir, c.PGStanza, c.PGPort))

	case "pg_hba.conf.j2":
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
local   all             postgres                                peer
local   all             all                                     scram-sha-256
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             0.0.0.0/0               scram-sha-256
host    replication     replicator      0.0.0.0/0               scram-sha-256
EOF`, dest))

	case "native-postgresql.service.j2":
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
[Unit]
Description=PostgreSQL %s native replication
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=postgres
Group=postgres
ExecStart=%s/postgres -D %s -c config_file=/etc/middleware/%s/postgresql.conf
ExecReload=/bin/kill -HUP $MAINPID
KillSignal=SIGINT
TimeoutStopSec=300
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
EOF`, dest, c.PGStanza, c.PGBin, c.PGDataDir, c.PGStanza))

	case "haproxy.cfg.j2":
		inst := c.instFor(instID, "haproxy")
		var params map[string]any
		var binds []mwpack.BindFacts
		if inst != nil {
			params = inst.Params
			binds = inst.Binds
		}
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("cat > %s <<'EOF'\n", dest))
		sb.WriteString(fmt.Sprintf("global\n    log /dev/log local0\n    maxconn %d\n    user haproxy\n    group haproxy\n    daemon\n\ndefaults\n    log global\n    mode tcp\n    option tcplog\n    option dontlognull\n    timeout connect %ds\n    timeout client %dm\n    timeout server %dm\n",
			intParamDef(params, "maxconn", 4096),
			intParamDef(params, "timeout_connect", 5),
			intParamDef(params, "timeout_client", 30),
			intParamDef(params, "timeout_server", 30),
		))
		if statsOn, ok := params["stats_enabled"].(bool); ok && statsOn {
			sb.WriteString(fmt.Sprintf("\nfrontend stats\n    mode http\n    bind 127.0.0.1:%d\n    stats enable\n    stats uri /\n    stats refresh 5s\n", intParamDef(params, "stats_port", 7000)))
		}
		for _, b := range binds {
			proto := firstNonEmptyStr(b.Endpoint.Protocol, "tcp")
			sb.WriteString(fmt.Sprintf("\nlisten %s\n    bind *:%d\n    mode %s\n", b.Name, b.Listen, proto))
			if b.Check.Type == "http" {
				sb.WriteString(fmt.Sprintf("    option httpchk\n    http-check send meth GET uri %s\n    http-check expect status %d\n", firstNonEmptyStr(b.Check.Path, "/primary"), b.Check.Status))
			} else if b.Check.Type == "tcp-script" {
				sb.WriteString("    option tcp-check\n")
				if b.Check.Send != "" {
					sb.WriteString("    tcp-check send " + b.Check.Send + "\n")
				}
				if b.Check.Expect != "" {
					sb.WriteString("    tcp-check expect string " + b.Check.Expect + "\n")
				}
			}
			sb.WriteString(fmt.Sprintf("    default-server inter %ds fall %d rise %d on-marked-down shutdown-sessions\n",
				intParamDef(params, "check_interval", 3),
				intParamDef(params, "check_fall", 3),
				intParamDef(params, "check_rise", 2),
			))
			for _, be := range b.Endpoint.Backends {
				extra := ""
				if b.Check.Type == "http" {
					if cp, ok := asIntParam(b.Check.Port); ok && cp > 0 {
						extra = fmt.Sprintf(" port %d", cp)
					}
				}
				sb.WriteString(fmt.Sprintf("    server %s %s:%d check%s\n", be.Host, be.IP, be.Port, extra))
			}
		}
		sb.WriteString("EOF")
		return appendPerms(sb.String())

	case "nginx.conf.j2":
		inst := c.instFor(instID, "nginx")
		var params map[string]any
		var binds []mwpack.BindFacts
		if inst != nil {
			params = inst.Params
			binds = inst.Binds
		}
		user := "nginx"
		modInc := "/usr/share/nginx/modules/*.conf"
		if !c.IsEL {
			modInc = "/etc/nginx/modules-enabled/*.conf"
			if inst != nil && inst.Version == "1.24" {
				user = "www-data"
			}
		}
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("cat > %s <<'EOF'\n", dest))
		sb.WriteString(fmt.Sprintf("user %s;\nworker_processes auto;\npid /run/nginx.pid;\ninclude %s;\n\nevents {\n    worker_connections %d;\n}\n\nstream {\n",
			user, modInc, intParamDef(params, "worker_connections", 4096)))
		for _, b := range binds {
			up := strings.ReplaceAll(b.Name, "-", "_")
			sb.WriteString(fmt.Sprintf("    upstream %s {\n", up))
			for _, be := range b.Endpoint.Backends {
				sb.WriteString(fmt.Sprintf("        server %s:%d max_fails=%d fail_timeout=%ds;\n",
					be.IP, be.Port, intParamDef(params, "max_fails", 3), intParamDef(params, "fail_timeout", 10)))
			}
			sb.WriteString(fmt.Sprintf("    }\n    server {\n        listen %d;\n        proxy_pass %s;\n        proxy_connect_timeout %ds;\n        proxy_timeout %dm;\n    }\n",
				b.Listen, up, intParamDef(params, "proxy_connect_timeout", 5), intParamDef(params, "proxy_timeout", 30)))
		}
		sb.WriteString("}\nEOF")
		return appendPerms(sb.String())

	case "keepalived.conf.j2":
		inst := c.instFor(instID, "keepalived")
		var params map[string]any
		var nodes []string
		id := firstNonEmptyStr(instID, "vip")
		if inst != nil {
			params = inst.Params
			nodes = inst.Roles["node"]
			if len(nodes) == 0 {
				nodes = inst.Hosts
			}
			id = inst.ID
		}
		node := firstNonEmptyStr(c.Controller, "node-1")
		if len(nodes) > 0 {
			node = nodes[0]
		}
		var peers []string
		for _, h := range nodes {
			if h != node {
				peers = append(peers, "        "+c.hostIP(h))
			}
		}
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
global_defs {
    router_id %s
    enable_script_security
    script_user root
}

vrrp_script chk_service {
    script "/bin/sh -c '%s'"
    interval 2
    fall 2
    rise 2
    weight -30
}

vrrp_instance %s {
    state MASTER
    interface %s
    virtual_router_id %d
    priority 150
    advert_int %d
    unicast_src_ip %s
    unicast_peer {
%s
    }
    authentication {
        auth_type PASS
        auth_pass <密码：控制节点 secrets/%s/auth_pass>
    }
    virtual_ipaddress {
        %s/%d dev %s
    }
    track_script {
        chk_service
    }
}
EOF`, dest, node, strParam(params, "check_command", "killall -0 haproxy"), strings.ReplaceAll(id, "-", "_"),
			strParam(params, "interface", "eth0"), intParamDef(params, "vrrp_id", 51), intParamDef(params, "advert_int", 1),
			c.hostIP(node), strings.Join(peers, "\n"), id, strParam(params, "vip", "10.0.0.250"), intParamDef(params, "prefix", 24), strParam(params, "interface", "eth0")))

	case "redis.conf.j2":
		inst := c.instFor(instID, "redis")
		var params map[string]any
		id := firstNonEmptyStr(instID, "redis")
		if inst != nil {
			params = inst.Params
			id = inst.ID
		}
		rdDir := "/data/redis/" + id
		persist := strParam(params, "persistence", "rdb")
		persistBlock := "save 3600 1 300 100 60 10000\nappendonly no"
		if persist == "aof" {
			persistBlock = "save \"\"\nappendonly yes"
		} else if persist == "none" {
			persistBlock = "save \"\"\nappendonly no"
		}
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
bind %s
protected-mode yes
port %d
daemonize no
supervised systemd
pidfile /run/redis/redis-server.pid
loglevel %s
logfile %s/log/redis-server.log
databases %d
maxmemory %s
maxmemory-policy %s
%s
dir %s/data
replica-serve-stale-data yes
replica-read-only yes
requirepass <密码：控制节点 secrets/%s/redis>
masterauth <密码：控制节点 secrets/%s/redis>
EOF`, dest, strParam(params, "bind", "0.0.0.0"), intParamDef(params, "port", 6379),
			strParam(params, "loglevel", "notice"), rdDir, intParamDef(params, "databases", 16),
			strParam(params, "maxmemory", "1gb"), strParam(params, "maxmemory_policy", "noeviction"),
			persistBlock, rdDir, id, id))

	case "sentinel.conf.j2":
		inst := c.instFor(instID, "redis")
		var params map[string]any
		id := firstNonEmptyStr(instID, "redis")
		primaryIP := c.ControllerIP
		if inst != nil {
			params = inst.Params
			id = inst.ID
			if hs := inst.Roles["primary"]; len(hs) > 0 {
				primaryIP = c.hostIP(hs[0])
			} else if len(inst.Hosts) > 0 {
				primaryIP = c.hostIP(inst.Hosts[0])
			}
		}
		rdDir := "/data/redis/" + id
		masterName := c.ClusterID + "-" + id
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
port %d
bind 0.0.0.0
protected-mode no
daemonize no
supervised systemd
pidfile /run/sentinel/redis-sentinel.pid
loglevel %s
logfile %s/log/redis-sentinel.log
dir %s/data
sentinel monitor %s %s %d %d
sentinel auth-pass %s <密码：控制节点 secrets/%s/redis>
sentinel down-after-milliseconds %s %d
sentinel parallel-syncs %s %d
sentinel failover-timeout %s %d
sentinel deny-scripts-reconfig yes
EOF`, dest, intParamDef(params, "sentinel_port", 26379), strParam(params, "loglevel", "notice"),
			rdDir, rdDir, masterName, firstNonEmptyStr(primaryIP, "127.0.0.1"), intParamDef(params, "port", 6379),
			intParamDef(params, "sentinel_quorum", 2), masterName, id,
			masterName, intParamDef(params, "sentinel_down_after_ms", 5000),
			masterName, intParamDef(params, "sentinel_parallel_syncs", 1),
			masterName, intParamDef(params, "sentinel_failover_timeout_ms", 60000)))

	case "logrotate.j2":
		id := firstNonEmptyStr(instID, "redis")
		rdDir := "/data/redis/" + id
		return appendPerms(fmt.Sprintf(`cat > %s <<'EOF'
%s/log/redis-server.log %s/log/redis-sentinel.log {
    daily
    rotate 14
    maxsize 100M
    missingok
    notifempty
    compress
    delaycompress
    create 0660 redis redis
}
EOF`, dest, rdDir, rdDir))
	}
	return ""
}

func (c reportCmdCtx) expandPGFrontPreflightCommands() []string {
	lang := c.Lang
	wh := firstNonEmptyStr(c.WriterHost, c.PGPrimaryIP)
	wp := c.WriterPort
	var lines []string
	lines = append(lines, tr(lang, "# 1. 查询各数据库节点的实时主从角色", "# 1. Check live primary/replica role on each PostgreSQL node"))
	lines = append(lines, fmt.Sprintf("runuser -u postgres -- %s/psql -X -v ON_ERROR_STOP=1 -At -h /var/run/postgresql -p %d -d postgres -c \"SELECT CASE WHEN pg_is_in_recovery() THEN '从库' ELSE '主库' END;\"", c.PGBin, c.PGPort))
	lines = append(lines, tr(lang, "# 2. 核对入口域名解析与 /etc/hosts 映射无冲突", "# 2. Verify writer endpoint DNS / hosts resolution without conflicts"))
	lines = append(lines, fmt.Sprintf("getent ahostsv4 %s", wh))
	lines = append(lines, fmt.Sprintf("grep -n '%s' /etc/hosts || true", wh))
	if c.WriterResolve != "" {
		lines = append(lines, tr(lang, "# 若系统 DNS 无法解析且 /etc/hosts 无冲突，补充显式解析映射", "# Only if DNS fails and /etc/hosts has no conflict, add explicit entry"))
		lines = append(lines, fmt.Sprintf("getent ahostsv4 %s >/dev/null || printf '%s %s\\n' >> /etc/hosts", wh, c.WriterResolve, wh))
	}
	lines = append(lines, tr(lang, "# 3. 验证入口 TCP 端口可达（主库经 ELB 回流自身除外，以从库探测为准）", "# 3. Verify TCP reachability to writer endpoint (validated from replica nodes)"))
	lines = append(lines, fmt.Sprintf("nc -zv -w 5 %s %d", wh, wp))
	return lines
}

func (c reportCmdCtx) expandPGFrontPreflightShort() string {
	wh := firstNonEmptyStr(c.WriterHost, c.PGPrimaryIP)
	return fmt.Sprintf(
		tr(c.Lang,
			"# 入口解析与端口前置复验\ngetent ahostsv4 %s && nc -zv -w 5 %s %d",
			"# Entry DNS & TCP port preflight\ngetent ahostsv4 %s && nc -zv -w 5 %s %d",
		),
		wh, wh, c.WriterPort,
	)
}

func (c reportCmdCtx) expandPGActionCommands(action string) []string {
	lang := c.Lang
	psqlLocal := fmt.Sprintf("runuser -u postgres -- %s/psql -X -v ON_ERROR_STOP=1 -At -h /var/run/postgresql -p %d -d postgres", c.PGBin, c.PGPort)
	wh := firstNonEmptyStr(c.WriterHost, c.PGPrimaryIP)
	wp := c.WriterPort
	primary := firstNonEmptyStr(c.PGPrimary, c.Controller, "node-1")
	primaryIP := c.hostIP(primary)
	rep1, rep1IP := c.firstReplica()
	rep2, _ := c.secondReplica()
	sslEnv := ""
	if c.PGTLS {
		sslEnv = fmt.Sprintf("PGSSLMODE=%s PGSSLROOTCERT=/etc/pki/pg/ca.crt ", c.PGSSLMode)
	}
	basebackupBin := c.PGBin + "/pg_basebackup"
	basebackupExtra := ""
	if c.PGTDE {
		basebackupBin = c.PGBin + "/pg_tde_basebackup"
		basebackupExtra = " -E"
	}

	switch action {
	case "ha-check":
		lines := []string{
			tr(lang, "# 1. 检查 Patroni 集群角色、状态与时间线一致性", "# 1. Verify Patroni cluster roles, states, and timeline consistency"),
			"patronictl -c /etc/patroni/patroni.yml list",
			tr(lang, "# 2. 在主库核对全部从库流复制状态", "# 2. Check streaming replication status on primary"),
			fmt.Sprintf("%s -c \"SELECT application_name, state, sync_state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes FROM pg_stat_replication ORDER BY application_name;\"", psqlLocal),
		}
		if c.PGTLS {
			lines = append(lines,
				tr(lang, "# 3. 核对复制连接已启用 TLS 加密", "# 3. Verify replication links use TLS"),
				fmt.Sprintf("%s -c \"SELECT r.application_name, s.ssl, s.version FROM pg_stat_replication r JOIN pg_stat_ssl s ON s.pid = r.pid;\"", psqlLocal),
			)
		}
		lines = append(lines,
			tr(lang, "# 4. 复查归档、SSL 与 TDE 运行开关", "# 4. Re-check archive, SSL, and TDE runtime settings"),
			fmt.Sprintf("%s -c \"SHOW archive_mode; SHOW ssl; SHOW shared_preload_libraries;\"", psqlLocal),
		)
		return lines

	case "tde":
		mark := "TDE-SENTINEL-" + c.PGStanza
		return []string{
			tr(lang, "# 1. 创建加密测试表（tde_heap）与普通对照表（heap）并写入标记数据", "# 1. Create encrypted (tde_heap) and plain control (heap) tables with sentinel rows"),
			fmt.Sprintf("%s -c \"CREATE SCHEMA IF NOT EXISTS middleware_acceptance; DROP TABLE IF EXISTS middleware_acceptance.tde_plain, middleware_acceptance.tde_enc; CREATE TABLE middleware_acceptance.tde_enc(id int PRIMARY KEY, v text) USING tde_heap; SET pg_tde.enforce_encryption = off; CREATE TABLE middleware_acceptance.tde_plain(id int PRIMARY KEY, v text) USING heap; RESET pg_tde.enforce_encryption; INSERT INTO middleware_acceptance.tde_enc SELECT g, '%s' FROM generate_series(1,2000) g; INSERT INTO middleware_acceptance.tde_plain SELECT g, '%s' FROM generate_series(1,2000) g; CHECKPOINT;\"", psqlLocal, mark, mark),
			tr(lang, "# 2. 确认加密表已登记为 TDE 加密状态并获取底层数据文件路径", "# 2. Verify encryption status and fetch relation file paths"),
			fmt.Sprintf("%s -c \"SELECT pg_tde_is_encrypted('middleware_acceptance.tde_enc'::regclass);\"", psqlLocal),
			fmt.Sprintf("ENC_FILE=%s/$(%s -c \"SELECT pg_relation_filepath('middleware_acceptance.tde_enc');\")", c.PGDataDir, psqlLocal),
			fmt.Sprintf("PLAIN_FILE=%s/$(%s -c \"SELECT pg_relation_filepath('middleware_acceptance.tde_plain');\")", c.PGDataDir, psqlLocal),
			tr(lang, "# 3. 直接检索底层数据文件：对照表必须命中明文（>0），加密表必须为 0", "# 3. Grep raw data files: control table must show plaintext (>0), encrypted table must be 0"),
			fmt.Sprintf("grep -ca '%s' \"$PLAIN_FILE\" && test \"$(grep -ca '%s' \"$ENC_FILE\" || true)\" -eq 0", mark, mark),
		}

	case "physical-backup":
		lines := []string{
			tr(lang, "# 1. 触发检查点并准备独立物理备份测试目录", "# 1. Trigger checkpoint and prepare isolated physical backup directory"),
			fmt.Sprintf("%s -c 'CHECKPOINT;'", psqlLocal),
			fmt.Sprintf("mkdir -p %s/basebackup && chown -R postgres:postgres %s", c.PGTestRoot, c.PGTestRoot),
		}
		if c.PGTDE {
			lines = append(lines,
				tr(lang, "# 2. TDE 场景下预先拷贝主密钥目录到备份目标", "# 2. Copy pg_tde key metadata before running pg_tde_basebackup"),
				fmt.Sprintf("cp -a %s/pg_tde %s/basebackup/pg_tde && chown -R postgres:postgres %s/basebackup", c.PGDataDir, c.PGTestRoot, c.PGTestRoot),
			)
		}
		lines = append(lines,
			tr(lang, fmt.Sprintf("# 3. 从从库 %s (%s) 拉取流式物理备份", rep1, rep1IP), fmt.Sprintf("# 3. Take streaming base backup from replica %s (%s)", rep1, rep1IP)),
			fmt.Sprintf("runuser -u postgres -- env PGPASSWORD='<密码：控制节点 secrets/%s/replication>' %s%s -h %s -p %d -U replicator -D %s/basebackup -X stream -c fast --no-password%s",
				c.PGInstID, sslEnv, basebackupBin, rep1IP, c.PGPort, c.PGTestRoot, basebackupExtra),
		)
		return lines

	case "physical-restore":
		return []string{
			tr(lang, "# 1. 以仅本机 Unix Socket 模式在隔离端口 15433 启动物理备份实例", "# 1. Start isolated PostgreSQL instance on local socket port 15433"),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/basebackup -o \"-p 15433 -k %s -h ''\" -l %s/basebackup.log start", c.PGBin, c.PGTestRoot, c.PGTestRoot, c.PGTestRoot),
			tr(lang, "# 2. 核对隔离恢复实例中的验收标记数据", "# 2. Verify acceptance marker inside restored isolated instance"),
			fmt.Sprintf("runuser -u postgres -- %s/psql -X -v ON_ERROR_STOP=1 -At -h %s -p 15433 -d postgres -c \"SELECT cluster_id FROM middleware_acceptance.marker WHERE id = 1;\"", c.PGBin, c.PGTestRoot),
			tr(lang, "# 3. 验证通过后停止隔离实例", "# 3. Stop isolated instance after verification"),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/basebackup -m fast -w stop", c.PGBin, c.PGTestRoot),
		}

	case "full-backup":
		return []string{
			tr(lang, "# 1. 确认当前控制节点为主库并执行 pgBackRest 全量备份", "# 1. Verify controller is primary and run pgBackRest full backup"),
			fmt.Sprintf("%s -c 'SELECT NOT pg_is_in_recovery();'", psqlLocal),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s --type=full backup", c.PGStanza),
			tr(lang, "# 2. 查看备份集摘要确认全量备份已入库", "# 2. Inspect backup info to confirm full backup recorded"),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s info", c.PGStanza),
		}

	case "full-restore":
		return []string{
			tr(lang, "# 1. 将 pgBackRest 全量备份恢复到隔离目录", "# 1. Restore pgBackRest full backup into isolated directory"),
			fmt.Sprintf("mkdir -p %s/restore && chown postgres:postgres %s/restore", c.PGTestRoot, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s --pg1-path=%s/restore --type=immediate --target-action=promote restore", c.PGStanza, c.PGTestRoot),
			tr(lang, "# 2. 在本机隔离端口 15432 启动恢复实例并核对测试标记", "# 2. Start isolated instance on port 15432 and verify marker"),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/restore -o \"-p 15432 -k %s -h ''\" -l %s/restore.log start", c.PGBin, c.PGTestRoot, c.PGTestRoot, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- %s/psql -X -v ON_ERROR_STOP=1 -At -h %s -p 15432 -d postgres -c \"SELECT cluster_id FROM middleware_acceptance.marker WHERE id = 1;\"", c.PGBin, c.PGTestRoot),
			tr(lang, "# 3. 核对完成后停止隔离实例", "# 3. Stop isolated instance"),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/restore -m fast -w stop", c.PGBin, c.PGTestRoot),
		}

	case "pitr":
		return []string{
			tr(lang, "# 1. 写入时间点之前 100 条测试数据并记录恢复目标时间点", "# 1. Insert 100 pre-target rows and capture PITR target timestamp"),
			fmt.Sprintf("%s -c \"CREATE TABLE IF NOT EXISTS middleware_acceptance.pitr_test(id int PRIMARY KEY, phase text); TRUNCATE middleware_acceptance.pitr_test; INSERT INTO middleware_acceptance.pitr_test SELECT g, 'before' FROM generate_series(1,100) g;\"", psqlLocal),
			fmt.Sprintf("TARGET_TIME=$(%s -c \"SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.USTZ');\")", psqlLocal),
			tr(lang, "# 2. 写入时间点之后 100 条数据并强制归档 WAL", "# 2. Insert 100 post-target rows and switch WAL for archiving"),
			fmt.Sprintf("%s -c \"INSERT INTO middleware_acceptance.pitr_test SELECT g, 'after' FROM generate_series(101,200) g; SELECT pg_switch_wal();\"", psqlLocal),
			tr(lang, "# 3. 按目标时间点恢复到隔离目录并在端口 15434 验证结果（before=100, after=0）", "# 3. Restore to target timestamp in isolated dir and verify counts (before=100, after=0)"),
			fmt.Sprintf("mkdir -p %s/pitr && chown postgres:postgres %s/pitr", c.PGTestRoot, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s --pg1-path=%s/pitr --type=time --target=\"$TARGET_TIME\" --target-action=promote restore", c.PGStanza, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/pitr -o \"-p 15434 -k %s -h ''\" -l %s/pitr.log start", c.PGBin, c.PGTestRoot, c.PGTestRoot, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- %s/psql -X -v ON_ERROR_STOP=1 -At -h %s -p 15434 -d postgres -c \"SELECT phase, count(*) FROM middleware_acceptance.pitr_test GROUP BY phase ORDER BY phase;\"", c.PGBin, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/pitr -m fast -w stop", c.PGBin, c.PGTestRoot),
		}

	case "switchover":
		return []string{
			tr(lang, "# 1. 切换前确认集群状态并写入校验标记", "# 1. Check cluster state and write pre-switchover marker"),
			"patronictl -c /etc/patroni/patroni.yml list",
			fmt.Sprintf("%s -c \"INSERT INTO middleware_acceptance.events(note) VALUES('before-switchover');\"", psqlLocal),
			tr(lang, fmt.Sprintf("# 2. 执行计划切主到从库 %s 并核对新主数据完整", rep1), fmt.Sprintf("# 2. Perform planned switchover to %s and verify data", rep1)),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", rep1),
			"patronictl -c /etc/patroni/patroni.yml list",
			tr(lang, fmt.Sprintf("# 3. 切回原主库 %s 并复核全部节点恢复流复制", primary), fmt.Sprintf("# 3. Switch back to %s and confirm all replicas streaming", primary)),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", primary),
			"patronictl -c /etc/patroni/patroni.yml list",
		}

	case "failover":
		return []string{
			tr(lang, "# 1. 故障模拟前确认当前主库并写入校验记录", "# 1. Record current primary and write pre-failover row"),
			"patronictl -c /etc/patroni/patroni.yml list",
			fmt.Sprintf("%s -c \"INSERT INTO middleware_acceptance.events(note) VALUES('before-failover');\"", psqlLocal),
			tr(lang, fmt.Sprintf("# 2. 停止当前主库 %s 的 Patroni 进程以触发自动故障接管", primary), fmt.Sprintf("# 2. Stop Patroni on current primary %s to trigger automatic failover", primary)),
			"systemctl stop patroni",
			tr(lang, "# 3. 等待从库自动升主并核对新主库状态", "# 3. Confirm automatic promotion of a replica"),
			fmt.Sprintf("ssh root@%s 'patronictl -c /etc/patroni/patroni.yml list'", rep1IP),
			tr(lang, fmt.Sprintf("# 4. 重新启动旧主 %s 的 Patroni，验证其自动以从库身份重新加入并追平复制", primary), fmt.Sprintf("# 4. Restart Patroni on old primary %s and verify rejoin as streaming replica", primary)),
			"systemctl start patroni",
			"patronictl -c /etc/patroni/patroni.yml list",
		}

	case "switchback":
		return []string{
			tr(lang, fmt.Sprintf("# 将主库计划切回控制节点 %s 并确认全员健康", primary), fmt.Sprintf("# Switch primary back to controller %s and verify cluster health", primary)),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", primary),
			"patronictl -c /etc/patroni/patroni.yml list",
		}

	case "pitr-switchover":
		return []string{
			tr(lang, fmt.Sprintf("# 1. 切主至 %s，在新时间线写入测试数据并记录目标时间点", rep1), fmt.Sprintf("# 1. Switchover to %s, write rows on new timeline, and record timestamp", rep1)),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", rep1),
			fmt.Sprintf("ssh root@%s \"runuser -u postgres -- %s/psql -X -At -h /var/run/postgresql -p %d -d postgres -c \\\"INSERT INTO middleware_acceptance.pitr_test VALUES(201,'new-leader'); SELECT pg_switch_wal();\\\"\"", rep1IP, c.PGBin, c.PGPort),
			tr(lang, "# 2. 汇总新旧主库归档 WAL 至控制节点并按 latest 时间线执行 PITR 隔离恢复", "# 2. Sync archived WAL from new primary and run cross-timeline PITR restore"),
			fmt.Sprintf("rsync -a root@%s:/data/backup/pgbackrest/archive/%s/ /data/backup/pgbackrest/archive/%s/", rep1IP, c.PGStanza, c.PGStanza),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s --pg1-path=%s/pitr-tl --type=time --target=\"<目标时间点>\" --target-timeline=latest --target-action=promote restore", c.PGStanza, c.PGTestRoot),
			tr(lang, "# 3. 在隔离端口 15435 验证跨主库数据完整后停止实例并回切主库", "# 3. Verify cross-timeline rows on isolated port 15435, stop instance, and switch back"),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/pitr-tl -o \"-p 15435 -k %s -h ''\" -l %s/pitr-tl.log start", c.PGBin, c.PGTestRoot, c.PGTestRoot, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- %s/psql -X -At -h %s -p 15435 -d postgres -c \"SELECT count(*) FROM middleware_acceptance.pitr_test;\"", c.PGBin, c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- %s/pg_ctl -D %s/pitr-tl -m fast -w stop", c.PGBin, c.PGTestRoot),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", primary),
		}

	case "rewind-check":
		return []string{
			tr(lang, "# 1. 检查 pg_rewind 可执行文件与 Patroni 自动 rewind 开关", "# 1. Verify pg_rewind binary and Patroni use_pg_rewind setting"),
			fmt.Sprintf("test -x %s/pg_rewind && %s/pg_rewind --version", c.PGBin, c.PGBin),
			fmt.Sprintf("curl -fsS http://%s:%d/config | grep -E 'use_pg_rewind'", primaryIP, c.PatroniPort),
			tr(lang, "# 2. 核对数据校验（data_checksums）/ wal_log_hints 与 rewind 角色", "# 2. Verify data_checksums / wal_log_hints and rewind role"),
			fmt.Sprintf("%s -c \"SHOW data_checksums; SHOW wal_log_hints; SELECT rolname FROM pg_roles WHERE rolname = 'rewind';\"", psqlLocal),
			tr(lang, "# 3. 检索 Patroni 历史日志中是否发生过 pg_rewind（只读）", "# 3. Check Patroni logs for any historical pg_rewind events (read-only)"),
			"journalctl -u patroni --no-pager | grep -i 'pg_rewind' || true",
		}

	case "via-front":
		return []string{
			tr(lang, "# 1. 验证入口域名解析与 TCP 连通性", "# 1. Verify writer endpoint DNS resolution and TCP reachability"),
			fmt.Sprintf("getent ahostsv4 %s && nc -zv -w 5 %s %d", wh, wh, wp),
			tr(lang, "# 2. 经负载均衡入口连接并验证到达当前可写主库", "# 2. Connect via writer endpoint and confirm writable primary"),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -v ON_ERROR_STOP=1 -At -h %s -p %d -U postgres -d postgres -c \"SELECT NOT pg_is_in_recovery() AS writable, host(inet_server_addr()) AS backend_ip;\"",
				c.PGInstID, sslEnv, c.PGBin, wh, wp),
		}

	case "tls-negative":
		return []string{
			tr(lang, fmt.Sprintf("# 1. 正向验证：按 %s 模式经入口及各节点建立 TLS 连接", c.PGSSLMode), fmt.Sprintf("# 1. Positive check: connect with sslmode=%s via writer endpoint and nodes", c.PGSSLMode)),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -v ON_ERROR_STOP=1 -At -h %s -p %d -U postgres -d postgres -c 'SELECT 1;'", c.PGInstID, sslEnv, c.PGBin, wh, wp),
			tr(lang, "# 2. 负向验证（错误 CA）：生成自签名伪造 CA，预期因证书链校验失败被拒绝", "# 2. Negative check (wrong CA): generate dummy CA and expect certificate rejection"),
			fmt.Sprintf("openssl req -x509 -newkey rsa:2048 -nodes -keyout /dev/null -subj '/CN=wrong-ca' -days 1 -out %s/wrong-ca.crt", c.PGTestRoot),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' PGSSLMODE=%s PGSSLROOTCERT=%s/wrong-ca.crt %s/psql -h %s -p %d -U postgres -d postgres -c 'SELECT 1;'  # 预期拒绝", c.PGInstID, c.PGSSLMode, c.PGTestRoot, c.PGBin, wh, wp),
			tr(lang, "# 3. 负向验证（错误域名 SNI 与明文连接）：预期均被服务端拒绝", "# 3. Negative check (wrong hostname & plaintext): expect both rejected"),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' PGSSLMODE=disable %s/psql -h %s -p %d -U postgres -d postgres -c 'SELECT 1;'  # 预期拒绝明文", c.PGInstID, c.PGBin, wh, wp),
		}

	case "front-switchover":
		return []string{
			tr(lang, "# 1. 确认切换前入口指向当前主库", "# 1. Confirm current backend behind writer endpoint"),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -At -h %s -p %d -U postgres -d postgres -c \"SELECT host(inet_server_addr()), NOT pg_is_in_recovery();\"", c.PGInstID, sslEnv, c.PGBin, wh, wp),
			tr(lang, fmt.Sprintf("# 2. 在从库间执行计划切主至 %s 并验证入口自动跟随", rep2), fmt.Sprintf("# 2. Switchover to %s and verify writer endpoint follows", rep2)),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", rep2),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -At -h %s -p %d -U postgres -d postgres -c \"SELECT host(inet_server_addr()), NOT pg_is_in_recovery();\"", c.PGInstID, sslEnv, c.PGBin, wh, wp),
			tr(lang, fmt.Sprintf("# 3. 切回 %s 并复验入口跟随", rep1), fmt.Sprintf("# 3. Switch back to %s and re-verify endpoint routing", rep1)),
			fmt.Sprintf("patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force", rep1),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -At -h %s -p %d -U postgres -d postgres -c \"SELECT host(inet_server_addr()), NOT pg_is_in_recovery();\"", c.PGInstID, sslEnv, c.PGBin, wh, wp),
		}

	case "front-failover":
		return []string{
			tr(lang, fmt.Sprintf("# 1. 停掉当前主库 Patroni 触发自动故障接管（从备库 %s 发起入口探测避免回流）", rep1), fmt.Sprintf("# 1. Stop Patroni on current primary and probe writer endpoint from standby %s", rep1)),
			"patronictl -c /etc/patroni/patroni.yml list",
			"systemctl stop patroni  # 在当前主库执行",
			tr(lang, "# 2. 从存活备库持续经入口核验路由已自动切至新主且可写", "# 2. Verify from surviving standby that endpoint routes to newly promoted writable primary"),
			fmt.Sprintf("ssh root@%s \"env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -At -h %s -p %d -U postgres -d postgres -c 'SELECT host(inet_server_addr()), NOT pg_is_in_recovery();'\"", rep1IP, c.PGInstID, sslEnv, c.PGBin, wh, wp),
			tr(lang, "# 3. 重启旧主 Patroni 并复核三节点全部恢复流复制", "# 3. Restart old primary Patroni and confirm 3-node streaming restored"),
			"systemctl start patroni  # 在旧主库执行",
			"patronictl -c /etc/patroni/patroni.yml list",
		}

	case "front-write-switchover":
		return []string{
			tr(lang, "# 1. 准备持续写入验收表", "# 1. Create continuous-write test table via writer endpoint"),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -v ON_ERROR_STOP=1 -h %s -p %d -U postgres -d postgres -c \"CREATE TABLE IF NOT EXISTS middleware_acceptance.elb_writes(id int PRIMARY KEY, at timestamptz DEFAULT now()); TRUNCATE middleware_acceptance.elb_writes;\"", c.PGInstID, sslEnv, c.PGBin, wh, wp),
			tr(lang, "# 2. 经入口持续写入并同步执行计划切主，随后核对已确认提交行数零丢失", "# 2. Write continuously through writer endpoint across switchover and verify 0 committed rows lost"),
			fmt.Sprintf("for i in $(seq 1 30); do env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -At -h %s -p %d -U postgres -d postgres -c \"INSERT INTO middleware_acceptance.elb_writes(id) VALUES($i) ON CONFLICT DO NOTHING;\" || true; sleep 1; done &", c.PGInstID, sslEnv, c.PGBin, wh, wp),
			fmt.Sprintf("sleep 5 && patronictl -c /etc/patroni/patroni.yml switchover --candidate %s --force && wait", rep2),
			fmt.Sprintf("env PGPASSWORD='<密码：控制节点 secrets/%s/superuser>' %s%s/psql -X -At -h %s -p %d -U postgres -d postgres -c \"SELECT count(*), min(id), max(id) FROM middleware_acceptance.elb_writes;\"", c.PGInstID, sslEnv, c.PGBin, wh, wp),
		}

	case "inspect":
		return []string{
			tr(lang, "# 盘点测试目录、隔离实例进程与 pgBackRest 备份集（只读）", "# Inspect test directory, isolated instances, and pgBackRest backups (read-only)"),
			fmt.Sprintf("%s -c 'SELECT pg_is_in_recovery();'", psqlLocal),
			fmt.Sprintf("ls -la %s 2>/dev/null || echo '无残留测试目录'", c.PGTestRoot),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s info", c.PGStanza),
		}

	case "clean-tests":
		return []string{
			tr(lang, "# 核对测试标记归属本集群后删除测试 Schema 与表（不影响业务数据）", "# Verify marker belongs to this cluster and drop acceptance schema"),
			fmt.Sprintf("%s -c \"SELECT cluster_id FROM middleware_acceptance.marker WHERE id = 1;\"", psqlLocal),
			fmt.Sprintf("%s -c \"DROP SCHEMA IF EXISTS middleware_acceptance CASCADE;\"", psqlLocal),
		}

	case "clean-artifacts":
		return []string{
			tr(lang, "# 停止残留隔离实例并清理临时物理备份、PITR 恢复目录与测试日志", "# Stop any running isolated instances and clean temporary test directories"),
			fmt.Sprintf("for d in %s/*; do [ -f \"$d/postmaster.pid\" ] && runuser -u postgres -- %s/pg_ctl -D \"$d\" -m fast -w stop; done", c.PGTestRoot, c.PGBin),
			fmt.Sprintf("rm -rf %s/*", c.PGTestRoot),
		}

	case "reset-backups":
		return []string{
			tr(lang, "# 停止并重建 pgBackRest stanza 以清空测试备份历史", "# Stop, delete, recreate, and re-check pgBackRest stanza"),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s stop", c.PGStanza),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s --force stanza-delete", c.PGStanza),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s start", c.PGStanza),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s stanza-create", c.PGStanza),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s check", c.PGStanza),
		}

	case "backup-info":
		return []string{
			tr(lang, "# 查看当前 pgBackRest 备份状态", "# Inspect current pgBackRest backup status"),
			fmt.Sprintf("runuser -u postgres -- pgbackrest --stanza=%s info", c.PGStanza),
		}
	}
	return nil
}
