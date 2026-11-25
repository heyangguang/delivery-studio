package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Changing the delivery's own automation. A step of the handbook can be added or its command replaced (proposals), but
// a problem is often in the automation itself: an entry test that runs on the wrong machine, a task that needs one more
// condition. The assistant can propose a change to a file of the delivery's project. Accepting it keeps the file as the
// delivery now has it (the patch), shows it in the delivery's record, and gives the controller an update package with
// every patched file and the command that puts them in place. The component is not touched: fixing that is what the
// suggestion to improve the component is for, and a later sync keeps the patches on top of whatever the component says.

type deliveryPatch struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Before  string `json:"before,omitempty"` // empty and New: the file did not exist
	New     bool   `json:"new,omitempty"`
	Reason  string `json:"reason"`
	By      string `json:"by"`
	At      string `json:"at"`
}

func (s *storeServer) patchesPath(id string) string {
	return filepath.Join(s.jobDir(id), "patches.json")
}

func (s *storeServer) loadPatches(id string) []deliveryPatch {
	var out []deliveryPatch
	if b, err := os.ReadFile(s.patchesPath(id)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

// patchedFiles is each patched file as it is now (the latest patch of a path wins).
func (s *storeServer) patchedFiles(id string) map[string][]byte {
	out := map[string][]byte{}
	for _, p := range s.loadPatches(id) {
		out[p.Path] = []byte(p.Content)
	}
	return out
}

var patchableDirs = []string{"roles/", "playbooks/", "tests/", "tests-endpoint/", "cleanup/", "inventory/group_vars/", "ansible.cfg"}

func patchablePath(p string) error {
	p = path.Clean(p)
	if p == "." || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "..") || strings.Contains(p, "..") {
		return fmt.Errorf("路径要写成项目目录下的相对路径")
	}
	if aiDeniedFile.MatchString(p) {
		return fmt.Errorf("密钥、证书和凭据类文件不能通过提案修改")
	}
	for _, d := range patchableDirs {
		if p == d || strings.HasPrefix(p, d) {
			if strings.HasPrefix(p, "roles/mw_secrets/") {
				return fmt.Errorf("密码生成与分发的角色不能修改")
			}
			return nil
		}
	}
	return fmt.Errorf("只能修改项目里的 roles/、playbooks/、tests/、tests-endpoint/、cleanup/ 和 inventory/group_vars/ 下的文件")
}

// projectFile reads one file of the delivery's project as it is now (patches included).
func (s *storeServer) projectFile(id, rel string) ([]byte, bool) {
	var got []byte
	found := false
	_ = s.walkProject(id, func(r string, size int64, rd io.Reader) bool {
		if r != rel {
			return true
		}
		var b bytes.Buffer
		_, _ = b.ReadFrom(rd)
		got, found = b.Bytes(), true
		return false
	})
	return got, found
}

// proposeFile is the propose_file_change tool.
func (c aiToolCtx) proposeFile(a map[string]any) string {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	rel, reason := path.Clean(str("path")), str("reason")
	if err := patchablePath(rel); err != nil {
		return err.Error() + "。没有保存。"
	}
	if reason == "" || len([]rune(reason)) > 600 {
		return "reason 必填，写清根因和为什么这样改（600 字内）。没有保存。"
	}
	cur, exists := c.s.projectFile(c.job.ID, rel)
	var next string
	if edits, _ := a["edits"].([]any); len(edits) > 0 {
		if !exists {
			return "文件 " + rel + " 不存在，不能局部修改；新增文件请用 content。没有保存。"
		}
		next = string(cur)
		for i, e := range edits {
			em, _ := e.(map[string]any)
			o, _ := em["old"].(string)
			n, _ := em["new"].(string)
			if o == "" {
				return fmt.Sprintf("第 %d 处修改缺少 old。没有保存。", i+1)
			}
			if k := strings.Count(next, o); k != 1 {
				return fmt.Sprintf("第 %d 处修改：old 在文件里出现了 %d 次，必须恰好一次。请先用 read_file 看原文，带上更多上下文。没有保存。", i+1, k)
			}
			next = strings.Replace(next, o, n, 1)
		}
	} else if v, ok := a["content"].(string); ok && strings.TrimSpace(v) != "" {
		next = v
	} else {
		return "要么给 edits（局部替换，优先），要么给 content（新文件或整个重写）。没有保存。"
	}
	if len(next) > 256<<10 {
		return "文件太大。没有保存。"
	}
	if next == string(cur) {
		return "改完和原来一样，没有保存。"
	}
	if aiScrub(next) != next {
		return "文件里含有口令、令牌或密钥，不能写进交付。改成读取控制节点 secrets/ 里的文件或变量。没有保存。"
	}
	if reForbidden.MatchString(next) {
		return "文件里含有格式化、分区、递归删除根目录、重启关机等高危操作，平台不会写进交付；请在回答里把这类操作的步骤和风险讲清楚，交给用户自己决定。没有保存。"
	}
	if strings.HasSuffix(rel, ".yml") || strings.HasSuffix(rel, ".yaml") {
		var v any
		if err := yaml.Unmarshal([]byte(next), &v); err != nil {
			return "改完的 YAML 解析不了：" + err.Error() + "。没有保存。"
		}
	}
	p := aiProposal{ID: randomStoreToken(6), Kind: "file", Status: "pending", Session: c.session, Phase: "deploy", Reason: reason, At: time.Now().UTC().Format(time.RFC3339)}
	p.File = &aiFilePatch{Path: rel, Content: next, Before: string(cur), New: !exists, Diff: lineDiff(string(cur), next, 120)}
	p.Step.Title = rel
	if !exists {
		p.Warnings = append(p.Warnings, "新增文件")
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	all := c.s.loadProposals(c.job.ID)
	for _, x := range all {
		if x.Session == p.Session && x.Kind == "file" && x.Status == "pending" && x.File != nil && x.File.Path == rel && x.File.Content == next {
			return "这条提案已经提交过（#" + x.ID + "），等待用户决定。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(c.s.proposalsPath(c.job.ID), all); err != nil {
		return "提案无法保存"
	}
	*c.proposed = append(*c.proposed, p.ID)
	return "提案 #" + p.ID + " 已提交，等待用户审核，尚未生效。采纳后平台会给控制节点生成更新包和覆盖命令，用户把它放到控制节点后，这份交付的自动化就是改过的样子。请在回答里用一两句话说明改了什么、为什么；若已通过 component_sync_status 确认最新组件尚未修复该通用缺陷，再同时用 suggest_component_change 建议修组件（若当前组件已修复则不要重复建议）。"
}

type aiFilePatch struct {
	Path    string `json:"path"`
	Content string `json:"content,omitempty"`
	Before  string `json:"before,omitempty"`
	New     bool   `json:"new,omitempty"`
	Diff    string `json:"diff,omitempty"`
}

func aiFileTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{"propose_file_change", "提议修改这份交付自动化项目里的一个文件（角色任务、Playbook、测试、group_vars），用于手册命令之外、问题出在自动化本身的情况，例如入口测试在了不该跑的机器上。只改这一份交付，不改组件。先用 list_files / read_file 看清原文，优先用 edits 做局部替换。用户采纳后平台生成覆盖用的更新包。", map[string]any{"type": "object", "properties": map[string]any{
		"path":    str("项目内相对路径，如 roles/postgresql/tasks/test.yml"),
		"edits":   map[string]any{"type": "array", "description": "局部替换：每项 {old, new}，old 必须在文件里恰好出现一次", "items": map[string]any{"type": "object", "properties": map[string]any{"old": str("原文"), "new": str("替换成")}, "required": []string{"old", "new"}}},
		"content": str("新文件，或整个重写时的完整内容"),
		"reason":  str("根因和为什么这样改"),
	}, "required": []string{"path", "reason"}}}
}

// acceptFilePatch keeps an accepted file proposal as a patch and writes the update package for the controller.
func (s *storeServer) acceptFilePatch(j storeJob, p aiProposal, user string) (jobSync, error) {
	if p.File == nil {
		return jobSync{}, fmt.Errorf("提案里没有文件")
	}
	if err := patchablePath(p.File.Path); err != nil {
		return jobSync{}, err
	}
	cur, exists := s.projectFile(j.ID, p.File.Path)
	if exists && string(cur) != p.File.Before {
		return jobSync{}, fmt.Errorf("这个文件在提案之后又变过，请让 AI 基于现在的内容重新提案")
	}
	at := time.Now().UTC().Format(time.RFC3339)
	patches := append(s.loadPatches(j.ID), deliveryPatch{ID: p.ID, Path: p.File.Path, Content: p.File.Content, Before: p.File.Before, New: p.File.New, Reason: p.Reason, By: user, At: at})
	if err := writeJSONFile(s.patchesPath(j.ID), patches); err != nil {
		return jobSync{}, err
	}
	n := len(j.Syncs) + 1
	prefix := s.projectPrefix(j.ID)
	latest := s.patchedFiles(j.ID)
	// Keep update packages cumulative across earlier syncs so the latest update archive alone brings any prior
	// controller state up to date.
	pack := map[string][]byte{}
	for k, v := range latest {
		pack[k] = v
	}
	removeSet := map[string]bool{}
	for _, prev := range j.Syncs {
		for _, f := range prev.Files {
			if _, ok := pack[f]; !ok {
				if data, exists := s.projectFile(j.ID, f); exists {
					pack[f] = data
				}
			}
		}
		for f := range prev.FileHashes {
			if _, ok := pack[f]; !ok {
				if data, exists := s.projectFile(j.ID, f); exists {
					pack[f] = data
				}
			}
		}
		for _, r := range prev.Remove {
			if _, ok := pack[r]; !ok {
				if _, exists := s.projectFile(j.ID, r); !exists {
					removeSet[r] = true
				}
			}
		}
	}
	var names []string
	for k := range pack {
		names = append(names, k)
	}
	sort.Strings(names)
	var removes []string
	for r := range removeSet {
		removes = append(removes, r)
	}
	sort.Strings(removes)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	fileHashes := map[string]string{}
	for _, name := range names {
		b := pack[name]
		fileHashes[name] = digest(b)
		if err := tw.WriteHeader(&tar.Header{Name: prefix + name, Mode: 0o644, Size: int64(len(b)), ModTime: time.Now(), Typeflag: tar.TypeReg}); err != nil {
			return jobSync{}, err
		}
		if _, err := tw.Write(b); err != nil {
			return jobSync{}, err
		}
	}
	tw.Close()
	gz.Close()
	upd := fmt.Sprintf("update-%d-%s.tar.gz", n, path.Base(strings.TrimSuffix(prefix, "/")))
	out := filepath.Join(s.jobDir(j.ID), "output")
	if err := os.WriteFile(filepath.Join(out, upd), buf.Bytes(), 0o600); err != nil {
		return jobSync{}, err
	}
	sum := digest(buf.Bytes())
	_ = os.WriteFile(filepath.Join(out, upd+".sha256"), []byte(sum+"  "+upd+"\n"), 0o600)
	if sums, err := os.ReadFile(filepath.Join(out, "SHA256SUMS")); err == nil {
		_ = os.WriteFile(filepath.Join(out, "SHA256SUMS"), append(sums, []byte(sum+"  "+upd+"\n")...), 0o600)
	}
	var patchNames []string
	for k := range latest {
		patchNames = append(patchNames, k)
	}
	sort.Strings(patchNames)
	sy := jobSync{N: n, At: at, By: user, Kind: "patch", Reason: p.Reason, Files: patchNames, Steps: []string{}, Update: upd, Remove: removes, FileHashes: fileHashes, UpdateSHA: sum}
	s.mu.Lock()
	cj := s.jobs[j.ID]
	cj.Syncs = append(cj.Syncs, sy)
	if err := s.persistJob(cj); err != nil {
		s.mu.Unlock()
		return sy, err
	}
	s.jobs[j.ID] = cj
	doc := s.readProgress(j.ID)
	doc.Events = append(doc.Events, progressEvent{At: at, By: user, Key: "patch-" + strconv.Itoa(n), Title: "修改了交付的自动化文件 " + p.File.Path, State: "sync"})
	_ = s.writeProgress(j.ID, doc)
	s.mu.Unlock()
	_ = s.applyAmendmentDocs(j.ID)
	return sy, nil
}
