package pkglib

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// indexPackKind marks a state.json as a source index pack.
const indexPackKind = "mw-index/v1"

var packNameRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,200}$`)

type indexPackState struct {
	Kind string `json:"kind"`
	IndexState
}

// Export writes the cached index of a platform as a pack another platform can import: the state, each signed Release
// and each Packages file. This is how an offline platform gets an index: update it on a platform that has the network,
// export it, and import it there.
func (x *Index) Export(w io.Writer, platform string) error {
	st := x.State(platform)
	if len(st.Files) == 0 {
		return errors.New("还没有索引可以导出")
	}
	if len(st.Releases) == 0 {
		return errors.New("这份索引是旧版本留下的，没有保存签名清单：先点一次“更新索引”（没有变化的文件不会重新下载），再导出")
	}
	gz := newGzip(w)
	tw := newTar(gz)
	state, err := json.MarshalIndent(indexPackState{Kind: indexPackKind, IndexState: st}, "", "  ")
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "state.json", Mode: 0o600, Size: int64(len(state)), ModTime: fixedTime, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(state); err != nil {
		return err
	}
	var names []string
	for _, r := range st.Releases {
		names = append(names, r.File)
		if r.Sig != "" {
			names = append(names, r.Sig)
		}
	}
	for _, f := range st.Files {
		names = append(names, f.File)
	}
	for _, n := range names {
		if err := tarFile(tw, n, filepath.Join(x.pdir(platform), n)); err != nil {
			return fmt.Errorf("索引文件 %s：%w", n, err)
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// Import installs an index pack. Nothing in the pack is trusted: every Release is verified again with this
// platform's own key for the source, every Packages file against the hashes the signed Release lists, and an index
// older than the one already here is refused.
func (x *Index) Import(r io.Reader, def mwpack.PlatformDef, srcs *Sources) (IndexState, error) {
	var none IndexState
	x.mu.Lock()
	if x.syncing[def.ID] {
		x.mu.Unlock()
		return none, errors.New("这个系统的索引正在更新")
	}
	x.syncing[def.ID] = true
	x.mu.Unlock()
	defer func() {
		x.mu.Lock()
		delete(x.syncing, def.ID)
		x.mu.Unlock()
	}()
	if err := os.MkdirAll(x.Dir, 0o700); err != nil {
		return none, err
	}
	stage, err := os.MkdirTemp(x.Dir, ".import-")
	if err != nil {
		return none, err
	}
	defer os.RemoveAll(stage)
	gz, err := newGzipReader(r)
	if err != nil {
		return none, errors.New("不是有效的索引包（需要 .tar.gz）")
	}
	tr := newTarReader(gz)
	var total int64
	have := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return none, fmt.Errorf("索引包读取失败：%v", err)
		}
		if h.Typeflag == 'x' || h.Typeflag == 'g' {
			continue
		}
		if h.Typeflag != tar.TypeReg || !packNameRE.MatchString(h.Name) || h.Size < 0 || h.Size > 512<<20 {
			return none, fmt.Errorf("索引包含不允许的内容：%s", h.Name)
		}
		if total += h.Size; total > 2<<30 {
			return none, errors.New("索引包过大")
		}
		out, err := os.OpenFile(filepath.Join(stage, h.Name), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			return none, fmt.Errorf("索引包里有重复的文件 %s", h.Name)
		}
		n, err := io.Copy(out, io.LimitReader(tr, h.Size+1))
		out.Close()
		if err != nil || n != h.Size {
			return none, fmt.Errorf("%s 不完整", h.Name)
		}
		have[h.Name] = true
	}
	raw, err := os.ReadFile(filepath.Join(stage, "state.json"))
	if err != nil {
		return none, errors.New("不是索引包：缺少 state.json")
	}
	var ps indexPackState
	if json.Unmarshal(raw, &ps) != nil || ps.Kind != indexPackKind {
		return none, errors.New("不是索引包，或版本不支持")
	}
	if ps.Platform != def.ID {
		return none, fmt.Errorf("这是 %s 的索引，不能导入到 %s", ps.Platform, def.ID)
	}
	local := map[string]Source{}
	for _, s := range srcs.ForPlatform(def.ID) {
		local[s.ID] = s
	}
	var releases []IndexRelease
	var files []IndexFile
	if def.Family == "rpm" {
		releases, files, err = x.verifyRpmPack(def, srcs, local, stage, have, ps.IndexState)
	} else {
		releases, files, err = x.verifyAptPack(def, srcs, local, stage, have, ps.IndexState)
	}
	if err != nil {
		return none, err
	}
	// everything checked: install it
	dir := x.pdir(def.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return none, err
	}
	for _, name := range append(releaseNames(releases), fileNames(files)...) {
		if err := os.Rename(filepath.Join(stage, name), filepath.Join(dir, name)); err != nil {
			return none, err
		}
	}
	st := IndexState{Platform: def.ID, Updated: ps.Updated, Imported: time.Now().UTC().Format(time.RFC3339), Files: files, Releases: releases}
	if err := writeJSONAtomic(filepath.Join(dir, "state.json"), st); err != nil {
		return none, err
	}
	keep := map[string]bool{"state.json": true}
	for _, n := range append(releaseNames(releases), fileNames(files)...) {
		keep[n] = true
	}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if !keep[e.Name()] {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	x.mu.Lock()
	delete(x.loaded, def.ID)
	x.mu.Unlock()
	_, _ = x.load(def)
	return x.State(def.ID), nil
}

func releaseNames(rs []IndexRelease) []string {
	var out []string
	for _, r := range rs {
		out = append(out, r.File)
		if r.Sig != "" {
			out = append(out, r.Sig)
		}
	}
	return out
}

func fileNames(fs []IndexFile) []string {
	var out []string
	for _, f := range fs {
		out = append(out, f.File)
	}
	return out
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// parseReleaseDate reads the Date field of a Release file.
func parseReleaseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, "Mon, 2 Jan 2006 15:04:05 MST"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// verifyAptPack checks the releases and Packages files of an apt index pack against this platform's own keys.
func (x *Index) verifyAptPack(def mwpack.PlatformDef, srcs *Sources, local map[string]Source, stage string, have map[string]bool, ps IndexState) ([]IndexRelease, []IndexFile, error) {
	current := map[string]time.Time{}
	for _, r := range x.State(def.ID).Releases {
		if t, ok := parseReleaseDate(r.Date); ok {
			current[r.Source+"|"+r.Suite] = t
		}
	}
	type relInfo struct {
		hashes map[string]relHash
		date   string
	}
	rels := map[string]relInfo{}
	var releases []IndexRelease
	for _, r := range ps.Releases {
		s, ok := local[r.Source]
		if !ok {
			return nil, nil, fmt.Errorf("索引来自软件源 %q，这个平台没有这个软件源（先在“软件源”里加上同 id 的源）", r.Source)
		}
		if !containsStr(s.Suites, r.Suite) || !have[r.File] || !packNameRE.MatchString(r.File) {
			return nil, nil, fmt.Errorf("软件源 %s 的 %s 发布清单无效", r.Source, r.Suite)
		}
		key, err := srcs.Key(s.KeyFile)
		if err != nil || len(key) == 0 {
			return nil, nil, fmt.Errorf("软件源 %s 缺少签名密钥", s.ID)
		}
		ring, err := readKeyRing(key)
		if err != nil {
			return nil, nil, fmt.Errorf("软件源 %s 的密钥无法读取：%w", s.ID, err)
		}
		rel, _ := os.ReadFile(filepath.Join(stage, r.File))
		text, err := verifyInRelease(rel, ring)
		if err != nil {
			return nil, nil, fmt.Errorf("%s / %s 的签名验证没有通过：%w", s.ID, r.Suite, err)
		}
		hashes, date := parseRelease(text)
		if t, ok := parseReleaseDate(date); ok {
			if prev, had := current[r.Source+"|"+r.Suite]; had && t.Before(prev) {
				return nil, nil, fmt.Errorf("%s / %s 的索引（%s）比本机现有的更旧，拒绝回退", s.ID, r.Suite, date)
			}
		}
		rels[r.Source+"|"+r.Suite] = relInfo{hashes, date}
		releases = append(releases, IndexRelease{Source: r.Source, Suite: r.Suite, File: r.File, Date: date})
	}
	if len(ps.Files) == 0 {
		return nil, nil, errors.New("索引包里没有任何软件包索引")
	}
	var files []IndexFile
	for _, f := range ps.Files {
		ri, ok := rels[f.Source+"|"+f.Suite]
		s := local[f.Source]
		if !ok || !containsStr(s.Components, f.Component) || !have[f.File] || !packNameRE.MatchString(f.File) {
			return nil, nil, fmt.Errorf("索引文件 %s 没有对应的签名清单", f.File)
		}
		h, ok := ri.hashes[f.Component+"/binary-"+def.Arch+"/Packages.gz"]
		body, err := os.ReadFile(filepath.Join(stage, f.File))
		if err != nil {
			return nil, nil, err
		}
		sum := sha256.Sum256(body)
		if !ok || int64(len(body)) != h.size || hex.EncodeToString(sum[:]) != h.sum {
			return nil, nil, fmt.Errorf("索引文件 %s 与已签名的发布清单不一致，索引包已损坏或被改动", f.File)
		}
		n, err := countPackages(body)
		if err != nil {
			return nil, nil, fmt.Errorf("索引文件 %s 无法解析：%w", f.File, err)
		}
		files = append(files, IndexFile{Source: f.Source, Suite: f.Suite, Component: f.Component, File: f.File, SHA256: h.sum, Packages: n, Date: ri.date})
	}
	return releases, files, nil
}

// verifyRpmPack checks an rpm index pack: every repomd.xml against its detached signature with this platform's key
// for the source, every primary file against the hash the signed repomd.xml lists, and refuses an older repomd.
func (x *Index) verifyRpmPack(def mwpack.PlatformDef, srcs *Sources, local map[string]Source, stage string, have map[string]bool, ps IndexState) ([]IndexRelease, []IndexFile, error) {
	current := map[string]int64{}
	for _, r := range x.State(def.ID).Releases {
		if n, err := strconv.ParseInt(r.Date, 10, 64); err == nil {
			current[r.Source] = n
		}
	}
	prim := map[string]repoData{}
	revs := map[string]string{}
	var releases []IndexRelease
	for _, r := range ps.Releases {
		s, ok := local[r.Source]
		if !ok {
			return nil, nil, fmt.Errorf("索引来自软件源 %q，这个平台没有这个软件源（先在“软件源”里加上同 id 的源）", r.Source)
		}
		if !have[r.File] || !have[r.Sig] || !packNameRE.MatchString(r.File) || !packNameRE.MatchString(r.Sig) {
			return nil, nil, fmt.Errorf("软件源 %s 的仓库清单或签名缺失", r.Source)
		}
		key, err := srcs.Key(s.KeyFile)
		if err != nil || len(key) == 0 {
			return nil, nil, fmt.Errorf("软件源 %s 缺少签名密钥", s.ID)
		}
		ring, err := readKeyRing(key)
		if err != nil {
			return nil, nil, fmt.Errorf("软件源 %s 的密钥无法读取：%w", s.ID, err)
		}
		md, _ := os.ReadFile(filepath.Join(stage, r.File))
		sig, _ := os.ReadFile(filepath.Join(stage, r.Sig))
		if err := verifyRepomd(md, sig, ring); err != nil {
			return nil, nil, fmt.Errorf("%s 的签名验证没有通过：%w", s.ID, err)
		}
		rev, data, err := parseRepomd(md)
		if err != nil {
			return nil, nil, err
		}
		if n, err := strconv.ParseInt(rev, 10, 64); err == nil {
			if prev, had := current[r.Source]; had && n < prev {
				return nil, nil, fmt.Errorf("%s 的索引比本机现有的更旧，拒绝回退", s.ID)
			}
		}
		p, ok := data["primary"]
		if !ok {
			return nil, nil, fmt.Errorf("%s 的仓库清单没有列出 primary", s.ID)
		}
		prim[r.Source], revs[r.Source] = p, rev
		releases = append(releases, IndexRelease{Source: r.Source, File: r.File, Sig: r.Sig, Date: rev})
	}
	if len(ps.Files) == 0 {
		return nil, nil, errors.New("索引包里没有任何软件包索引")
	}
	var files []IndexFile
	for _, f := range ps.Files {
		p, ok := prim[f.Source]
		if !ok || !have[f.File] || !packNameRE.MatchString(f.File) {
			return nil, nil, fmt.Errorf("索引文件 %s 没有对应的签名清单", f.File)
		}
		body, err := os.ReadFile(filepath.Join(stage, f.File))
		if err != nil {
			return nil, nil, err
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != p.SHA256 {
			return nil, nil, fmt.Errorf("索引文件 %s 与已签名的仓库清单不一致，索引包已损坏或被改动", f.File)
		}
		n, err := countRpmPackages(body)
		if err != nil {
			return nil, nil, fmt.Errorf("索引文件 %s 无法解析：%w", f.File, err)
		}
		files = append(files, IndexFile{Source: f.Source, Component: "primary", File: f.File, SHA256: p.SHA256, Packages: n, Date: revs[f.Source]})
	}
	return releases, files, nil
}
