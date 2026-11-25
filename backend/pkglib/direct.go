package pkglib

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// FetchDirect downloads the packages the cached index says each request needs, straight from the sources. Every file
// is checked against the size and SHA256 of the signed index before it is stored, so the result is as trustworthy as
// apt's own download, and no container is involved. Closures already in the library are skipped.
func (x *Index) FetchDirect(ctx context.Context, lib *Library, def mwpack.PlatformDef, srcs *Sources, reqs []mwpack.PackageRequest, rep *Reporter) (err error) {
	say := rep.Logf
	if len(reqs) == 0 {
		return fmt.Errorf("没有要获取的软件包")
	}
	var plans []*Plan
	for _, r := range reqs {
		if err := validRequest(r); err != nil {
			return err
		}
		p, err := x.Resolve(def, r)
		if err != nil {
			return err
		}
		if len(p.Unresolved) > 0 {
			return fmt.Errorf("%s 的依赖无法在软件源里找全：%s", r.Key(), strings.Join(p.Unresolved, "；"))
		}
		plans = append(plans, p)
	}
	byID := map[string]Source{}
	for _, s := range srcs.ForPlatform(def.ID) {
		byID[s.ID] = s
	}
	work, err := os.MkdirTemp(lib.Dir, ".fetch-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	done := map[string]bool{} // files already downloaded for an earlier request in this run
	// announce everything first: each request, and each file once, with what the library already has marked
	announced := map[string]bool{}
	for _, plan := range plans {
		rep.Emit(StepEvent{ID: "req|" + plan.Request.Key(), Group: "软件包", Label: plan.Request.Name + " " + plan.Request.Version, State: "pending", Detail: fmt.Sprintf("%d 个软件包 · %s", len(plan.Packages), humanBytes(plan.Bytes))})
		for _, p := range plan.Packages {
			if announced[p.File] {
				continue
			}
			announced[p.File] = true
			ev := StepEvent{ID: "f|" + p.File, Group: plan.Request.Name + " " + plan.Request.Version, Label: p.Name + " " + p.Version, State: "pending", Size: p.Size}
			if lib.HasFile(def.ID, p.File, p.Size) {
				ev.State, ev.Detail = "skipped", "库里已有"
			}
			rep.Emit(ev)
		}
	}
	cur := ""
	defer func() {
		if err != nil && cur != "" {
			rep.Emit(StepEvent{ID: cur, State: "failed", Detail: err.Error()})
		}
	}()
	for n, plan := range plans {
		say("[%d/%d] %s：%d 个软件包，%s", n+1, len(plans), plan.Request.Key(), len(plan.Packages), humanBytes(plan.Bytes))
		rep.Emit(StepEvent{ID: "req|" + plan.Request.Key(), State: "running"})
		var metas []Meta
		var closure = Closure{Request: plan.Request, Platform: def.ID, Via: "软件源索引直取（已验签）", Fetched: time.Now().UTC().Format(time.RFC3339)}
		usedSrc := map[string]bool{}
		for _, p := range plan.Packages {
			s, ok := byID[p.Source]
			if !ok {
				return fmt.Errorf("软件源 %s 已不存在，请重新更新索引", p.Source)
			}
			usedSrc[p.Source] = true
			dst := filepath.Join(work, p.File)
			if !done[p.File] {
				if st, err := os.Stat(filepath.Join(lib.pdir(def.ID, "pool"), p.File)); err == nil && st.Size() == p.Size {
					if sum, _, err := sumFile(filepath.Join(lib.pdir(def.ID, "pool"), p.File)); err == nil && sum == p.SHA256 {
						dst = filepath.Join(lib.pdir(def.ID, "pool"), p.File) // already stored: reuse without downloading
						done[p.File] = true
					}
				}
			}
			if !done[p.File] {
				say("  下载 %s %s（%s）", p.Name, p.Version, humanBytes(p.Size))
				cur = "f|" + p.File
				rep.Emit(StepEvent{ID: cur, State: "running", Detail: "下载并校验"})
				base := strings.TrimRight(s.URL, "/") + "/"
				if def.Family == "rpm" {
					base = rpmBase(s)
				}
				body, err := x.get(ctx, base+p.Filename, 1<<30)
				if err != nil {
					return fmt.Errorf("下载 %s：%w", p.Name, err)
				}
				sum := sha256.Sum256(body)
				if int64(len(body)) != p.Size || hex.EncodeToString(sum[:]) != p.SHA256 {
					return fmt.Errorf("%s 下载下来的内容与已签名的索引不一致，拒绝入库", p.Name)
				}
				if err := os.WriteFile(dst, body, 0o600); err != nil {
					return err
				}
				done[p.File] = true
				rep.Emit(StepEvent{ID: cur, State: "done", Detail: "已校验"})
			}
			closure.Files = append(closure.Files, FileRef{File: p.File, SHA256: p.SHA256, Size: p.Size})
			closure.Packages = append(closure.Packages, PkgRef{p.Name, p.Version})
		}
		for id := range usedSrc {
			closure.Sources = append(closure.Sources, id)
		}
		if def.Family == "rpm" {
			metas, err = x.rpmMetas(ctx, def, byID, plan)
		} else {
			metas, err = x.metasFor(def, work, plan)
		}
		if err != nil {
			return err
		}
		say("  入库 %s：%d 个文件", plan.Request.Key(), len(closure.Files))
		cur = "req|" + plan.Request.Key()
		poolDir := lib.pdir(def.ID, "pool")
		if err := lib.Put(closure, metas, func(file string) string {
			if p := filepath.Join(work, file); fileExists(p) {
				return p
			}
			return filepath.Join(poolDir, file)
		}); err != nil {
			return err
		}
		rep.Emit(StepEvent{ID: cur, State: "done", Detail: fmt.Sprintf("已入库 · %d 个文件", len(closure.Files))})
	}
	return nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// metasFor builds the repository metadata of each package of a plan from its stanza in the Packages file.
func (x *Index) metasFor(def mwpack.PlatformDef, work string, plan *Plan) ([]Meta, error) {
	st := x.State(def.ID)
	want := map[string]PlanPkg{} // source|suite|name|version
	for _, p := range plan.Packages {
		want[p.Source+"|"+p.Suite+"|"+p.Name+"|"+p.Version] = p
	}
	found := map[string]Meta{}
	for _, f := range st.Files {
		need := false
		for k := range want {
			if strings.HasPrefix(k, f.Source+"|"+f.Suite+"|") {
				need = true
				break
			}
		}
		if !need {
			continue
		}
		gz, err := os.ReadFile(filepath.Join(x.pdir(def.ID), f.File))
		if err != nil {
			return nil, err
		}
		err = stanzas(gz, func(lines []string) bool {
			name, ver := "", ""
			for _, l := range lines {
				if strings.HasPrefix(l, "Package:") {
					name = strings.TrimSpace(l[8:])
				} else if strings.HasPrefix(l, "Version:") {
					ver = strings.TrimSpace(l[8:])
				}
			}
			k := f.Source + "|" + f.Suite + "|" + name + "|" + ver
			p, ok := want[k]
			if !ok {
				return true
			}
			if _, dup := found[k]; dup {
				return true
			}
			found[k] = Meta{File: p.File, Name: name, Version: ver, Arch: fieldOf(lines, "Architecture"), Control: controlStanza(lines)}
			return true
		})
		if err != nil {
			return nil, err
		}
	}
	var metas []Meta
	for k, p := range want {
		m, ok := found[k]
		if !ok {
			return nil, fmt.Errorf("索引里找不到 %s %s 的控制信息，请重新更新索引", p.Name, p.Version)
		}
		metas = append(metas, m)
	}
	return metas, nil
}

// controlStanza is the package's control file: the index stanza without the fields that describe the file in the
// archive, which is what dpkg-deb -f prints.
func controlStanza(lines []string) string {
	skip := map[string]bool{"Filename": true, "Size": true, "MD5sum": true, "SHA1": true, "SHA256": true, "SHA512": true, "Description-md5": true, "Origin": true, "Bugs": true, "Supported": true, "Task": true, "Phased-Update-Percentage": true}
	var out []string
	drop := false
	for _, l := range lines {
		if l != "" && (l[0] == ' ' || l[0] == '\t') {
			if !drop {
				out = append(out, l)
			}
			continue
		}
		k, _, _ := strings.Cut(l, ":")
		drop = skip[k]
		if !drop {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}
