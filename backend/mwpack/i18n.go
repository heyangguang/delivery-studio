package mwpack

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

//go:embed catalog_en.json
var catalogEnJSON []byte

var catalogEnMap = func() map[string]string {
	m := map[string]string{}
	_ = json.Unmarshal(catalogEnJSON, &m)
	return m
}()

func isEnLang(lang string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(lang)), "en")
}

func hasCatalogCJK(s string) bool {
	for _, r := range s {
		if r >= 0x4E00 && r <= 0x9FFF {
			return true
		}
	}
	return false
}

type catRule struct {
	re *regexp.Regexp
	fn func(lang string, m []string) string
}

var catalogRules []catRule

func init() {
	catalogRules = []catRule{
	{regexp.MustCompile(`^把各机器的上传包与控制节点的离线材料通过堡垒机上传到 (.+)，然后在控制节点核对哈希。$`), func(_ string, m []string) string {
		return fmt.Sprintf("Upload per-host archives and controller offline materials via bastion to %s, then verify checksums on the controller.", m[1])
	}},
	{regexp.MustCompile(`^把本方案的上传包与离线材料通过堡垒机上传到 (.+)，然后在控制节点核对哈希。$`), func(_ string, m []string) string {
		return fmt.Sprintf("Upload delivery bundles and offline artifacts via bastion to %s, then verify checksums on the controller.", m[1])
	}},
	{regexp.MustCompile(`^解包并准备 (.+)$`), func(_ string, m []string) string {
		return fmt.Sprintf("Unpack and prepare %s", m[1])
	}},
	{regexp.MustCompile(`^上传包 (.+?) 及同名 \.sha256。只解出本方案的项目 projects/([^ ]+) 和 Ansible 引导文件，已有的项目与集群不受影响；本方案的项目已存在时命令会停止。$`), func(_ string, m []string) string {
		return fmt.Sprintf("Upload bundle %s and matching .sha256. Extracts only project projects/%s and Ansible bootstrap files without affecting existing projects or clusters; stops if project directory already exists.", m[1], m[2])
	}},
	{regexp.MustCompile(`^把上一份方案项目（([^）]+)）的 secrets/ 原样复制到本方案的项目，保持权限。密码必须与运行中的集群一致，不会重新生成。$`), func(_ string, m []string) string {
		return fmt.Sprintf("Copy secrets/ verbatim from %s to this project while preserving permissions. Secrets must match the running cluster and are not regenerated.", m[1])
	}},
	{regexp.MustCompile(`^上传包 (.+?) 及同名 \.sha256；已有部署目录时命令会停止，不覆盖旧环境。(.*)$`), func(_ string, m []string) string {
		extra := ""
		if strings.Contains(m[2], "独立管理机只核对现有主机名和 IP") {
			extra = " Standalone execution host verifies only hostname and IP without altering hostnames or /etc/hosts."
		}
		return fmt.Sprintf("Upload bundle %s and matching .sha256; stops if a previous deployment directory exists without overwriting.%s", m[1], extra)
	}},
	{regexp.MustCompile(`^在 (.+?) 接受公钥并取回主机公钥$`), func(_ string, m []string) string {
		return fmt.Sprintf("Accept controller public key on %s and retrieve host key", m[1])
	}},
	{regexp.MustCompile(`^在控制节点信任 (.+?) 并核对$`), func(_ string, m []string) string {
		return fmt.Sprintf("Trust %s on controller and verify SSH connectivity", m[1])
	}},
	{regexp.MustCompile(`^粘贴 (.+?) 刚才输出的主机公钥；check-node 须显示免密登录成功。$`), func(_ string, m []string) string {
		return fmt.Sprintf("Paste the host public key printed by %s; check-node must report passwordless SSH succeeded.", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 没有 Ansible 运行环境$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s lacks Ansible runtime", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 的软件库缺 (\d+) 个软件包$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s library missing %s package(s)", m[1], m[2])
	}},
	{regexp.MustCompile(`^离线材料未就绪：(.+)$`), func(_ string, m []string) string {
		return fmt.Sprintf("Offline artifact missing: %s", m[1])
	}},
	{regexp.MustCompile(`^还没有 (.+?) 的 Ansible 运行环境，暂时不能为它生成交付（控制节点需要它离线安装 Ansible）$`), func(_ string, m []string) string {
		return fmt.Sprintf("No Ansible runtime available for %s; cannot build delivery yet (controller uses it to install Ansible offline).", m[1])
	}},
	{regexp.MustCompile(`^软件库里没有 (.+?)（([^）]+)）。.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Library missing packages: %s (%s). Download online on the Library page, or export from an online host and import.", strings.ReplaceAll(m[1], "、", ", "), m[2])
	}},
	{regexp.MustCompile(`^主机名「(.+?)」不合规：.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Invalid hostname %q: start with a lowercase letter; use lowercase letters, digits, and hyphens only", m[1])
	}},
	{regexp.MustCompile(`^主机名「(.+?)」重复，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Duplicate hostname %q: each host must have a distinct name", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 还没有填 IP 地址$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s is missing an IP address", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 的 IP「(.+?)」不是有效的 IPv4 地址.*$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s IP %q is not a valid unicast IPv4 address (cannot be 0.0.0.0, 127.x, or multicast)", m[1], m[2])
	}},
	{regexp.MustCompile(`^IP (.+?) 被两台机器重复使用$`), func(_ string, m []string) string {
		return fmt.Sprintf("IP %s is assigned to multiple hosts", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 勾选了初始化数据盘，请填写要初始化的磁盘.*$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s enabled data disk initialization; specify a device path such as /dev/sdb", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 的数据盘要填 /dev/ 开头的设备.*$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s data disk must start with /dev/ (for example /dev/sdb)", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 的数据盘 ([^ ]+) 一般是系统盘，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s data disk %s appears to be a system disk; select another disk", m[1], m[2])
	}},
	{regexp.MustCompile(`^控制节点「(.+?)」不在机器列表里，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Controller %q is not in the host list; select one of your hosts", m[1])
	}},
	{regexp.MustCompile(`^请填写「(.+?)」$`), func(lang string, m []string) string {
		return fmt.Sprintf("Field %q is required", TranslateCatalogText(lang, m[1]))
	}},
	{regexp.MustCompile(`^「(.+?)」不能小于 (.+)$`), func(lang string, m []string) string {
		return fmt.Sprintf("%q cannot be less than %s", TranslateCatalogText(lang, m[1]), m[2])
	}},
	{regexp.MustCompile(`^「(.+?)」不能大于 (.+)$`), func(lang string, m []string) string {
		return fmt.Sprintf("%q cannot be greater than %s", TranslateCatalogText(lang, m[1]), m[2])
	}},
	{regexp.MustCompile(`^「(.+?)」只能选：(.+)$`), func(lang string, m []string) string {
		return fmt.Sprintf("%q must be one of: %s", TranslateCatalogText(lang, m[1]), strings.ReplaceAll(m[2], "、", ", "))
	}},
	{regexp.MustCompile(`^「(.+?)」要写成网段，.+$`), func(lang string, m []string) string {
		return fmt.Sprintf("%q must be a valid CIDR block (for example 10.20.0.0/16)", TranslateCatalogText(lang, m[1]))
	}},
	{regexp.MustCompile(`^「(.+?)」里的「(.+?)」不是有效的网段，.+$`), func(lang string, m []string) string {
		return fmt.Sprintf("Invalid CIDR %q in %q (for example 10.20.0.0/16)", m[2], TranslateCatalogText(lang, m[1]))
	}},
	{regexp.MustCompile(`^「(.+?)」要填一个有效的 IPv4 地址$`), func(lang string, m []string) string {
		return fmt.Sprintf("%q must be a valid IPv4 address", TranslateCatalogText(lang, m[1]))
	}},
	{regexp.MustCompile(`^「(.+?)」的格式不对$`), func(lang string, m []string) string {
		return fmt.Sprintf("%q has invalid format", TranslateCatalogText(lang, m[1]))
	}},
	{regexp.MustCompile(`^(.+?) 在当前选择下不生效，已忽略$`), func(lang string, m []string) string {
		return fmt.Sprintf("%s does not apply to current options and is ignored", TranslateCatalogText(lang, m[1]))
	}},
	{regexp.MustCompile(`^(.+?) 的「(.+?)」需要 (?:至少 (\d+) 台|(\d+) 到 (\d+) 台)，现在放了 (\d+) 台$`), func(lang string, m []string) string {
		rng := ""
		if m[3] != "" {
			rng = "at least " + m[3] + " host(s)"
		} else {
			rng = m[4] + " to " + m[5] + " host(s)"
		}
		return fmt.Sprintf("%s role %q requires %s (%s assigned)", m[1], TranslateCatalogText(lang, m[2]), rng, m[6])
	}},
	{regexp.MustCompile(`^(.+?) 还没有放到任何机器上$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s is not placed on any host yet", m[1])
	}},
	{regexp.MustCompile(`^机器 (.+?) 同时放了 (.+?)，这个组件不允许放在同一台上$`), func(lang string, m []string) string {
		return fmt.Sprintf("Host %s cannot co-locate roles (%s) for this component", m[1], TranslateCatalogText(lang, strings.ReplaceAll(m[2], "、", ", ")))
	}},
	{regexp.MustCompile(`^所选组件不支持 (.+?)，可以换成：(.+)$`), func(_ string, m []string) string {
		return fmt.Sprintf("Selected components do not support %s; supported options: %s", m[1], strings.ReplaceAll(m[2], "、", ", "))
	}},
	{regexp.MustCompile(`^实例标识「(.+?)」不合规：.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Invalid instance ID %q: start with lowercase letter; lowercase letters, digits, and hyphens only", m[1])
	}},
	{regexp.MustCompile(`^组件「(.+?)」在平台里找不到$`), func(_ string, m []string) string {
		return fmt.Sprintf("Component %q not found in catalog", m[1])
	}},
	{regexp.MustCompile(`^实例「(.+?)」不存在$`), func(_ string, m []string) string {
		return fmt.Sprintf("Instance %q does not exist", m[1])
	}},
	{regexp.MustCompile(`^实例 (.+?) 不提供 (.+)$`), func(_ string, m []string) string {
		return fmt.Sprintf("Instance %s does not provide %s", m[1], m[2])
	}},
	{regexp.MustCompile(`^有多个实例都提供 ([^（]+)（([^）]+)），请指定用哪一个$`), func(_ string, m []string) string {
		return fmt.Sprintf("Multiple instances provide %s (%s); specify one", m[1], m[2])
	}},
	{regexp.MustCompile(`^(.+?) 需要「(.+?)」，但部署里没有实例能提供，.+$`), func(lang string, m []string) string {
		return fmt.Sprintf("%s requires %q, which no instance or default provides", TranslateCatalogText(lang, m[1]), m[2])
	}},
	{regexp.MustCompile(`^(.+?) 需要单独的 ([^：]+)：请添加一个 ([^ ]+) 实例，放到专门的机器上$`), func(lang string, m []string) string {
		return fmt.Sprintf("%s requires a dedicated %s: add a %s instance on dedicated host(s)", TranslateCatalogText(lang, m[1]), m[2], m[3])
	}},
	{regexp.MustCompile(`^机器 (.+?) 的 ([A-Z]+) 端口 (\d+) 被 (.+?) 和 (.+?) 同时占用，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Host %s %s port %s conflicts between %s and %s; change one", m[1], m[2], m[3], m[4], m[5])
	}},
	{regexp.MustCompile(`^控制节点 (.+?) 的 TCP 端口 (\d+) 要用来提供离线软件仓库，但已被 (.+?) 占用，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Controller %s TCP port %s is reserved for the offline package repo but already used by %s; assign another port", m[1], m[2], m[3])
	}},
	{regexp.MustCompile(`^(.+?) 部署架构$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s Deployment Architecture", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 主从架构$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s Replication Architecture", m[1])
	}},
	{regexp.MustCompile(`^(.+?) 的状态是「(草稿|待验证)」，尚未在空环境验证，不要用于生产$`), func(_ string, m []string) string {
		st := map[string]string{"草稿": "Draft", "待验证": "Verifying"}[m[2]]
		if st == "" {
			st = m[2]
		}
		return fmt.Sprintf("%s status is \"%s\" (not yet verified on a clean environment); do not use in production", m[1], st)
	}},
	{regexp.MustCompile(`^(.+?) 在 (.+?) 上尚未实测验证，不要用于生产$`), func(_ string, m []string) string {
		return fmt.Sprintf("%s has not been verified on %s yet; do not use in production", m[1], m[2])
	}},
	{regexp.MustCompile(`^当前实例由 ([^ ]+) 管理；([^ ]+) 不单独执行此项，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("Managed by %s; %s does not run this check separately—see the managing component's checks", m[1], m[2])
	}},
	{regexp.MustCompile(`^每台机器原来的软件源都移到了备份目录（.*?），要恢复就把备份里的文件移回原处，删除 ([^ ]+) 的源文件，再刷新软件包列表。控制节点上的仓库服务用 (.+?) 停掉。$`), func(_ string, m []string) string {
		return fmt.Sprintf("Original package repos were moved to a backup directory (see Old sources saved to in step output). To roll back, restore backed-up files, remove %s repo files, refresh package metadata, and stop the controller repo service via %s.", m[1], m[2])
	}},
	{regexp.MustCompile(`^仅在本步骤修改过的节点，以 Ansible blockinfile 删除本实例受管块：(.+?)。保留其他条目，.+$`), func(_ string, m []string) string {
		return fmt.Sprintf("On nodes modified by this step only, remove this instance's managed block via Ansible blockinfile (%s) while preserving other entries; re-verify host resolution and endpoint ports afterward.", m[1])
	}},
	{regexp.MustCompile(`^\[([^\]]+)\]\s*(.+)$`), func(lang string, m []string) string {
		return "[" + m[1] + "] " + TranslateCatalogText(lang, m[2])
	}},
	{regexp.MustCompile(`^阶段[：:]\s*(.+)$`), func(lang string, m []string) string {
		return "Phase: " + TranslateCatalogText(lang, m[1])
	}},
	{regexp.MustCompile(`^(.+?) 需要(.+)$`), func(lang string, m []string) string {
		return fmt.Sprintf("%s requires %s", TranslateCatalogText(lang, strings.TrimSpace(m[1])), TranslateCatalogText(lang, strings.TrimSpace(m[2])))
	}},
	}
}

// LocalizeYAMLValue recursively translates string scalars inside decoded YAML structures for read-only views.
func LocalizeYAMLValue(lang string, v any) any {
	if !isEnLang(lang) || v == nil {
		return v
	}
	switch x := v.(type) {
	case string:
		return TranslateCatalogText(lang, x)
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = LocalizeYAMLValue(lang, item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			if k == "script" || k == "when" || k == "playbook" || k == "template" || k == "run" {
				out[k] = val
			} else if k == "cmd" {
				if s, ok := val.(string); ok {
					out[k] = localizeCmdPlaceholder(lang, s)
				} else {
					out[k] = val
				}
			} else {
				out[k] = LocalizeYAMLValue(lang, val)
			}
		}
		return out
	default:
		return v
	}
}

func localizeCmdPlaceholder(lang, s string) string {
	if !isEnLang(lang) || s == "" {
		return s
	}
	if en, ok := catalogEnMap[s]; ok && en != "" {
		return en
	}
	return strings.NewReplacer(
		"虚拟 IP 不在本机", "vip-not-on-this-host",
		"不在本机", "not-on-this-host",
		"<成员名>", "<member-name>",
		"<密码>", "<password>",
	).Replace(s)
}

// TranslateCatalogText translates a built-in manifest/platform string into English when lang is en*,
// falling back cleanly to dynamic patterns, line-by-line lookup, or the original string when no translation is needed.
func TranslateCatalogText(lang, text string) string {
	if !isEnLang(lang) || text == "" {
		return text
	}
	if en, ok := catalogEnMap[text]; ok && en != "" {
		return en
	}
	trimmed := strings.TrimSpace(text)
	if trimmed != text {
		if en, ok := catalogEnMap[trimmed]; ok && en != "" {
			return en
		}
	}
	if hasCatalogCJK(trimmed) {
		for _, r := range catalogRules {
			if m := r.re.FindStringSubmatch(trimmed); m != nil {
				return r.fn(lang, m)
			}
		}
	}
	if strings.Contains(text, "\n") {
		lines := strings.Split(text, "\n")
		changed := false
		for i, ln := range lines {
			t := strings.TrimSpace(ln)
			if en, ok := catalogEnMap[t]; ok && en != "" {
				lines[i] = en
				changed = true
			}
		}
		if changed {
			return strings.Join(lines, "\n")
		}
	}
	return text
}

// LocalizePlanStep returns a localized shallow copy of s without mutating the original PlanStep.
func LocalizePlanStep(lang string, st *PlanStep) *PlanStep {
	if st == nil || !isEnLang(lang) {
		return st
	}
	cp := *st
	cp.Title = TranslateCatalogText(lang, cp.Title)
	cp.Desc = TranslateCatalogText(lang, cp.Desc)
	cp.Expect = TranslateCatalogText(lang, cp.Expect)
	cp.Rollback = TranslateCatalogText(lang, cp.Rollback)
	cp.Skipped = TranslateCatalogText(lang, cp.Skipped)
	return &cp
}

// LocalizePlatformTitle translates OS platform titles (for example RHEL family title) when lang is en*.
func LocalizePlatformTitle(lang, title string) string {
	return TranslateCatalogText(lang, title)
}

func cloneStrings(src []string, fn func(string) string) []string {
	if src == nil {
		return nil
	}
	out := make([]string, len(src))
	for i, s := range src {
		if fn != nil {
			out[i] = fn(s)
		} else {
			out[i] = s
		}
	}
	return out
}

// LocalizeSeriesContract translates capability contract fields without mutating the original struct.
func LocalizeSeriesContract(lang string, c *SeriesContract) *SeriesContract {
	return localizeContract(lang, c)
}

func localizeContract(lang string, c *SeriesContract) *SeriesContract {
	if c == nil || !isEnLang(lang) {
		return c
	}
	cp := *c
	cp.Mechanism = TranslateCatalogText(lang, cp.Mechanism)
	cp.ReadAccess = TranslateCatalogText(lang, cp.ReadAccess)
	cp.Limitations = cloneStrings(cp.Limitations, func(s string) string { return TranslateCatalogText(lang, s) })
	cp.Acceptance = cloneStrings(cp.Acceptance, func(s string) string { return TranslateCatalogText(lang, s) })
	cp.Operations = cloneStrings(cp.Operations, func(s string) string { return TranslateCatalogText(lang, s) })
	return &cp
}

func localizeNamedTexts(lang string, src []NamedText) []NamedText {
	if src == nil || !isEnLang(lang) {
		return src
	}
	out := make([]NamedText, len(src))
	for i, nt := range src {
		out[i] = NamedText{
			Name: TranslateCatalogText(lang, nt.Name),
			Text: TranslateCatalogText(lang, nt.Text),
		}
	}
	return out
}

func localizeRoles(lang string, src []RoleSpec) []RoleSpec {
	if src == nil || !isEnLang(lang) {
		return src
	}
	out := make([]RoleSpec, len(src))
	for i, r := range src {
		r.Title = TranslateCatalogText(lang, r.Title)
		r.AdviseWhy = TranslateCatalogText(lang, r.AdviseWhy)
		out[i] = r
	}
	return out
}

func localizeFlows(lang string, src []FlowSpec) []FlowSpec {
	if src == nil || !isEnLang(lang) {
		return src
	}
	out := make([]FlowSpec, len(src))
	for i, f := range src {
		f.Title = TranslateCatalogText(lang, f.Title)
		out[i] = f
	}
	return out
}

func localizePresets(lang string, src []Preset) []Preset {
	if src == nil || !isEnLang(lang) {
		return src
	}
	out := make([]Preset, len(src))
	for i, p := range src {
		p.Name = TranslateCatalogText(lang, p.Name)
		p.Tag = TranslateCatalogText(lang, p.Tag)
		p.Spec = TranslateCatalogText(lang, p.Spec)
		p.Contract = localizeContract(lang, p.Contract)
		p.Roles = append([]RoleCount(nil), p.Roles...)
		out[i] = p
	}
	return out
}

func LocalizeOperations(lang string, ops *Operations) *Operations {
	if ops == nil || !isEnLang(lang) {
		return ops
	}
	out := &Operations{
		Overview: TranslateCatalogText(lang, ops.Overview),
		Logs:     localizeNamedTexts(lang, ops.Logs),
	}
	if ops.Checks != nil {
		out.Checks = make([]OpsItem, len(ops.Checks))
		for i, it := range ops.Checks {
			it.Title = TranslateCatalogText(lang, it.Title)
			it.Hosts = TranslateCatalogText(lang, it.Hosts)
			it.Cmd = TranslateCatalogText(lang, it.Cmd)
			it.Expect = TranslateCatalogText(lang, it.Expect)
			it.Note = TranslateCatalogText(lang, it.Note)
			out.Checks[i] = it
		}
	}
	if ops.Tasks != nil {
		out.Tasks = make([]OpsItem, len(ops.Tasks))
		for i, it := range ops.Tasks {
			it.Title = TranslateCatalogText(lang, it.Title)
			it.Hosts = TranslateCatalogText(lang, it.Hosts)
			it.Cmd = TranslateCatalogText(lang, it.Cmd)
			it.Expect = TranslateCatalogText(lang, it.Expect)
			it.Note = TranslateCatalogText(lang, it.Note)
			out.Tasks[i] = it
		}
	}
	if ops.Faults != nil {
		out.Faults = make([]OpsFault, len(ops.Faults))
		for i, f := range ops.Faults {
			f.Title = TranslateCatalogText(lang, f.Title)
			f.Symptom = TranslateCatalogText(lang, f.Symptom)
			f.Cmd = TranslateCatalogText(lang, f.Cmd)
			f.Steps = cloneStrings(f.Steps, func(s string) string { return TranslateCatalogText(lang, s) })
			out.Faults[i] = f
		}
	}
	return out
}

// LocalizeInfo returns a deep copy of info with catalog metadata translated when lang is en*.
func LocalizeInfo(lang string, info Info) Info {
	if !isEnLang(lang) {
		return info
	}
	info.Title = TranslateCatalogText(lang, info.Title)
	info.Category = TranslateCatalogText(lang, info.Category)
	info.Summary = TranslateCatalogText(lang, info.Summary)
	info.Tags = cloneStrings(info.Tags, func(s string) string { return TranslateCatalogText(lang, s) })
	if info.Detail != nil {
		d := *info.Detail
		d.Tagline = TranslateCatalogText(lang, d.Tagline)
		d.Scale = TranslateCatalogText(lang, d.Scale)
		d.Capabilities = localizeNamedTexts(lang, d.Capabilities)
		d.Includes = localizeNamedTexts(lang, d.Includes)
		d.Limits = cloneStrings(d.Limits, func(s string) string { return TranslateCatalogText(lang, s) })
		d.Presets = localizePresets(lang, d.Presets)
		info.Detail = &d
	}
	info.Operations = LocalizeOperations(lang, info.Operations)
	info.Roles = localizeRoles(lang, info.Roles)
	info.Flows = localizeFlows(lang, info.Flows)
	if info.Versions != nil {
		vs := make([]VerInfo, len(info.Versions))
		for i, v := range info.Versions {
			v.Notes = cloneStrings(v.Notes, func(s string) string { return TranslateCatalogText(lang, s) })
			vs[i] = v
		}
		info.Versions = vs
	}
	return info
}

func localizeParams(lang string, src []Param) []Param {
	if src == nil || !isEnLang(lang) {
		return src
	}
	out := make([]Param, len(src))
	for i, p := range src {
		p.Label = TranslateCatalogText(lang, p.Label)
		p.Unit = TranslateCatalogText(lang, p.Unit)
		p.Hint = TranslateCatalogText(lang, p.Hint)
		if def, ok := p.Default.(string); ok && hasCatalogCJK(def) {
			p.Default = TranslateCatalogText(lang, def)
		}
		out[i] = p
	}
	return out
}

// LocalizeSchema returns a translated Schema copy without mutating underlying Catalog caches.
func LocalizeSchema(lang string, s *Schema) *Schema {
	if s == nil || !isEnLang(lang) {
		return s
	}
	cp := *s
	cp.Title = TranslateCatalogText(lang, s.Title)
	cp.Roles = localizeRoles(lang, s.Roles)
	if s.Groups != nil {
		cp.Groups = make([]Group, len(s.Groups))
		for i, g := range s.Groups {
			g.Label = TranslateCatalogText(lang, g.Label)
			cp.Groups[i] = g
		}
	}
	cp.Params = localizeParams(lang, s.Params)
	if s.Rules != nil {
		cp.Rules = make([]RuleView, len(s.Rules))
		for i, r := range s.Rules {
			r.Message = TranslateCatalogText(lang, r.Message)
			cp.Rules[i] = r
		}
	}
	if s.Requires != nil {
		cp.Requires = make([]Require, len(s.Requires))
		for i, req := range s.Requires {
			req.Title = TranslateCatalogText(lang, req.Title)
			cp.Requires[i] = req
		}
	}
	if s.Endpoints != nil {
		cp.Endpoints = make([]Endpoint, len(s.Endpoints))
		for i, ep := range s.Endpoints {
			ep.Title = TranslateCatalogText(lang, ep.Title)
			ep.Note = TranslateCatalogText(lang, ep.Note)
			cp.Endpoints[i] = ep
		}
	}
	if s.Inputs != nil {
		cp.Inputs = make([]Input, len(s.Inputs))
		for i, in := range s.Inputs {
			in.Label = TranslateCatalogText(lang, in.Label)
			cp.Inputs[i] = in
		}
	}
	if s.Addons != nil {
		as := *s.Addons
		as.Items = make([]Addon, len(s.Addons.Items))
		for i, it := range s.Addons.Items {
			it.Title = TranslateCatalogText(lang, it.Title)
			it.Params = localizeParams(lang, it.Params)
			as.Items[i] = it
		}
		cp.Addons = &as
	}
	cp.Presets = localizePresets(lang, s.Presets)
	return &cp
}

// LocalizeHostContract translates platform shared parameter metadata into English when lang is en*.
func LocalizeHostContract(lang string, c *HostContract) *HostContract {
	if c == nil || !isEnLang(lang) {
		return c
	}
	cp := *c
	cp.Parameters = make([]HostParameter, len(c.Parameters))
	for i, p := range c.Parameters {
		p.Label = TranslateCatalogText(lang, p.Label)
		p.Help = TranslateCatalogText(lang, p.Help)
		if p.Options != nil {
			opts := make([]HostOption, len(p.Options))
			for j, o := range p.Options {
				o.Label = TranslateCatalogText(lang, o.Label)
				opts[j] = o
			}
			p.Options = opts
		}
		cp.Parameters[i] = p
	}
	cp.Rules = make([]HostRule, len(c.Rules))
	for i, r := range c.Rules {
		r.Message = TranslateCatalogText(lang, r.Message)
		cp.Rules[i] = r
	}
	return &cp
}

func LocalizeSchemeSummary(lang string, ss *SchemeSummary) *SchemeSummary {
	if ss == nil || !isEnLang(lang) {
		return ss
	}
	cp := *ss
	cp.Name = TranslateCatalogText(lang, ss.Name)
	cp.Contract = localizeContract(lang, ss.Contract)
	if ss.Evidence != nil {
		cp.Evidence = cloneStrings(ss.Evidence, func(s string) string { return TranslateCatalogText(lang, s) })
	}
	if cp.Topology != "" {
		parts := strings.Split(cp.Topology, " · ")
		for i, p := range parts {
			if idx := strings.Index(p, " × "); idx > 0 {
				parts[i] = TranslateCatalogText(lang, p[:idx]) + p[idx:]
			} else {
				parts[i] = TranslateCatalogText(lang, p)
			}
		}
		cp.Topology = strings.Join(parts, " · ")
	}
	return &cp
}

func localizeInstanceView(lang string, iv InstanceView) InstanceView {
	iv.Title = TranslateCatalogText(lang, iv.Title)
	iv.AutoReason = TranslateCatalogText(lang, iv.AutoReason)
	iv.Scheme = LocalizeSchemeSummary(lang, iv.Scheme)
	iv.Contract = localizeContract(lang, iv.Contract)
	if iv.RoleTitles != nil {
		rt := make(map[string]string, len(iv.RoleTitles))
		for k, val := range iv.RoleTitles {
			rt[k] = TranslateCatalogText(lang, val)
		}
		iv.RoleTitles = rt
	}
	if iv.Flows != nil {
		fl := make([]FlowView, len(iv.Flows))
		for j, f := range iv.Flows {
			f.Title = TranslateCatalogText(lang, f.Title)
			fl[j] = f
		}
		iv.Flows = fl
	}
	if iv.Endpoints != nil {
		eps := make([]EndpointFacts, len(iv.Endpoints))
		for j, ep := range iv.Endpoints {
			ep.Title = TranslateCatalogText(lang, ep.Title)
			ep.Note = TranslateCatalogText(lang, ep.Note)
			eps[j] = ep
		}
		iv.Endpoints = eps
	}
	return iv
}

func localizePlanSteps(lang string, steps []*PlanStep) []*PlanStep {
	if steps == nil {
		return nil
	}
	out := make([]*PlanStep, len(steps))
	for i, st := range steps {
		out[i] = LocalizePlanStep(lang, st)
	}
	return out
}

// LocalizePlanView translates user-facing labels on a resolved or persisted PlanView copy.
func LocalizePlanView(lang string, v PlanView) PlanView {
	if !isEnLang(lang) {
		return v
	}
	if v.Issues != nil {
		issues := make([]Problem, len(v.Issues))
		for i, p := range v.Issues {
			p.Message = TranslateCatalogText(lang, p.Message)
			issues[i] = p
		}
		v.Issues = issues
	}
	if v.Inputs != nil {
		inputs := make([]InputReq, len(v.Inputs))
		for i, in := range v.Inputs {
			in.Label = TranslateCatalogText(lang, in.Label)
			inputs[i] = in
		}
		v.Inputs = inputs
	}
	if v.Artifacts != nil {
		arts := make([]ArtifactView, len(v.Artifacts))
		for i, a := range v.Artifacts {
			a.Name = TranslateCatalogText(lang, a.Name)
			arts[i] = a
		}
		v.Artifacts = arts
	}
	if v.Instances != nil {
		insts := make([]InstanceView, len(v.Instances))
		for i, iv := range v.Instances {
			insts[i] = localizeInstanceView(lang, iv)
		}
		v.Instances = insts
	}
	if v.Phases != nil {
		phs := make([]PhaseView, len(v.Phases))
		for i, ph := range v.Phases {
			ph.Title = TranslateCatalogText(lang, ph.Title)
			ph.Steps = localizePlanSteps(lang, ph.Steps)
			phs[i] = ph
		}
		v.Phases = phs
	}
	return v
}

// LocalizePlanJSON translates instances, phases, steps, and warnings inside a persisted plan.json payload
// without mutating unknown fields or altering cached disk artifacts.
func LocalizePlanJSON(lang string, raw json.RawMessage) json.RawMessage {
	if !isEnLang(lang) || len(raw) == 0 {
		return raw
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return raw
	}
	if b, ok := doc["instances"]; ok && len(b) > 0 {
		var insts []InstanceView
		if json.Unmarshal(b, &insts) == nil {
			for i, iv := range insts {
				insts[i] = localizeInstanceView(lang, iv)
			}
			if nb, err := json.Marshal(insts); err == nil {
				doc["instances"] = nb
			}
		}
	}
	for _, key := range []string{"prepare", "tests", "endpoint_tests", "cleanup"} {
		if b, ok := doc[key]; ok && len(b) > 0 {
			var steps []*PlanStep
			if json.Unmarshal(b, &steps) == nil {
				if nb, err := json.Marshal(localizePlanSteps(lang, steps)); err == nil {
					doc[key] = nb
				}
			}
		}
	}
	if b, ok := doc["deploy"]; ok && len(b) > 0 {
		var phases []map[string]json.RawMessage
		if json.Unmarshal(b, &phases) == nil {
			for _, ph := range phases {
				if tb, ok := ph["title"]; ok {
					var title string
					if json.Unmarshal(tb, &title) == nil {
						if nb, err := json.Marshal(TranslateCatalogText(lang, title)); err == nil {
							ph["title"] = nb
						}
					}
				}
				if sb, ok := ph["steps"]; ok {
					var steps []*PlanStep
					if json.Unmarshal(sb, &steps) == nil {
						if nb, err := json.Marshal(localizePlanSteps(lang, steps)); err == nil {
							ph["steps"] = nb
						}
					}
				}
			}
			if nb, err := json.Marshal(phases); err == nil {
				doc["deploy"] = nb
			}
		}
	}
	if b, ok := doc["warnings"]; ok && len(b) > 0 {
		var warns []Problem
		if json.Unmarshal(b, &warns) == nil {
			for i, w := range warns {
				w.Message = TranslateCatalogText(lang, w.Message)
				warns[i] = w
			}
			if nb, err := json.Marshal(warns); err == nil {
				doc["warnings"] = nb
			}
		}
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return raw
	}
	return out
}
