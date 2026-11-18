package pkglib

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/openpgp"

	"middleware-deployer/mwpack"
)

// rpmDep is one entry of a package's provides or requires.
type rpmDep struct {
	Name string
	Op   string // "" EQ LT LE GT GE
	EVR  string
}

// rpmInfo is what resolving and downloading need about an rpm package, beyond what every index package has.
type rpmInfo struct {
	Pkgid   string
	SrcName string // the source package it was built from

	Requires []rpmDep
	Provides []rpmDep
	Files    []string
}

// repoData is one metadata file a signed repomd.xml lists.
type repoData struct {
	Type     string
	Location string
	SHA256   string
	Size     int64
}

type repomdDoc struct {
	Revision string `xml:"revision"`
	Data     []struct {
		Type     string `xml:"type,attr"`
		Checksum struct {
			Type  string `xml:"type,attr"`
			Value string `xml:",chardata"`
		} `xml:"checksum"`
		Location struct {
			Href string `xml:"href,attr"`
		} `xml:"location"`
		Size int64 `xml:"size"`
	} `xml:"data"`
}

func parseRepomd(b []byte) (string, map[string]repoData, error) {
	var d repomdDoc
	if err := xml.Unmarshal(b, &d); err != nil {
		return "", nil, fmt.Errorf("repomd.xml 无法解析：%w", err)
	}
	out := map[string]repoData{}
	for _, x := range d.Data {
		if x.Checksum.Type != "sha256" {
			continue
		}
		out[x.Type] = repoData{x.Type, x.Location.Href, strings.TrimSpace(x.Checksum.Value), x.Size}
	}
	return strings.TrimSpace(d.Revision), out, nil
}

// verifyRepomd checks the detached signature of a repomd.xml with the source's key.
func verifyRepomd(data, sig []byte, ring openpgp.EntityList) error {
	if _, err := openpgp.CheckArmoredDetachedSignature(ring, bytes.NewReader(data), bytes.NewReader(sig)); err != nil {
		if _, err2 := openpgp.CheckDetachedSignature(ring, bytes.NewReader(data), bytes.NewReader(sig)); err2 != nil {
			return err
		}
	}
	return nil
}

func rpmBase(s Source) string { return strings.TrimRight(s.BaseURL, "/") + "/" }

// updateRpm downloads the signed repository metadata of every rpm source of the platform: repomd.xml with its detached
// signature (checked with the source's key) and the primary.xml.gz it lists (checked against the signed hash).
// filelists and other are fetched only when packages are downloaded, since only then are they needed.
func (x *Index) updateRpm(ctx context.Context, def mwpack.PlatformDef, srcs *Sources, rep *Reporter, list []Source, dir string) (err error) {
	old := map[string]IndexFile{}
	for _, f := range x.State(def.ID).Files {
		old[f.File] = f
	}
	for _, s := range list {
		rep.Emit(StepEvent{ID: "rel|" + s.ID, Group: s.Title, Label: "仓库清单与签名", State: "pending"})
		rep.Emit(StepEvent{ID: "pk|" + s.ID, Group: s.Title, Label: "软件包清单", State: "pending"})
	}
	cur := ""
	defer func() {
		if err != nil && cur != "" {
			rep.Emit(StepEvent{ID: cur, State: "failed", Detail: err.Error()})
		}
	}()
	var files []IndexFile
	var releases []IndexRelease
	for _, s := range list {
		if s.Kind != "rpm" {
			return fmt.Errorf("软件源 %s 的类型 %s 与系统 %s 不符", s.ID, s.Kind, def.ID)
		}
		key, err := srcs.Key(s.KeyFile)
		if err != nil || len(key) == 0 {
			return fmt.Errorf("软件源 %s 缺少签名密钥 %s：平台只用验证过签名的软件源", s.ID, s.KeyFile)
		}
		ring, err := readKeyRing(key)
		if err != nil {
			return fmt.Errorf("软件源 %s 的密钥无法读取：%w", s.ID, err)
		}
		cur = "rel|" + s.ID
		rep.Logf("读取 %s 的仓库清单", s.Title)
		rep.Emit(StepEvent{ID: cur, State: "running", Detail: "读取并验证签名"})
		md, err := x.get(ctx, rpmBase(s)+"repodata/repomd.xml", 8<<20)
		if err != nil {
			return fmt.Errorf("%s：%w", s.ID, err)
		}
		sig, err := x.get(ctx, rpmBase(s)+"repodata/repomd.xml.asc", 1<<20)
		if err != nil {
			return fmt.Errorf("%s 没有提供 repomd.xml 的签名：%w", s.ID, err)
		}
		if err := verifyRepomd(md, sig, ring); err != nil {
			return fmt.Errorf("%s 的签名验证没有通过：%w", s.ID, err)
		}
		rev, data, err := parseRepomd(md)
		if err != nil {
			return fmt.Errorf("%s：%w", s.ID, err)
		}
		prim, ok := data["primary"]
		if !ok {
			return fmt.Errorf("%s 的 repomd.xml 没有列出 primary", s.ID)
		}
		relName := SafeFile(s.ID + ".repomd.xml")
		for name, body := range map[string][]byte{relName: md, relName + ".asc": sig} {
			if err := os.WriteFile(filepath.Join(dir, name+".tmp"), body, 0o600); err != nil {
				return err
			}
			if err := os.Rename(filepath.Join(dir, name+".tmp"), filepath.Join(dir, name)); err != nil {
				return err
			}
		}
		releases = append(releases, IndexRelease{Source: s.ID, File: relName, Sig: relName + ".asc", Date: rev})
		rep.Emit(StepEvent{ID: cur, State: "done", Detail: "签名有效"})

		cur = "pk|" + s.ID
		name := SafeFile(s.ID + ".primary.xml.gz")
		f := IndexFile{Source: s.ID, Component: "primary", File: name, SHA256: prim.SHA256, Date: rev}
		if o, ok := old[name]; ok && o.SHA256 == prim.SHA256 {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				f.Packages = o.Packages
				rep.Emit(StepEvent{ID: cur, State: "skipped", Detail: fmt.Sprintf("没有变化 · %s 个版本", humanCount(o.Packages))})
				files = append(files, f)
				continue
			}
		}
		rep.Logf("  下载 %s（%s）", prim.Location, humanBytes(prim.Size))
		rep.Emit(StepEvent{ID: cur, State: "running", Detail: "下载 " + humanBytes(prim.Size), Size: prim.Size})
		body, err := x.get(ctx, rpmBase(s)+prim.Location, 512<<20)
		if err != nil {
			return fmt.Errorf("%s：%w", s.ID, err)
		}
		sum := sha256.Sum256(body)
		if (prim.Size > 0 && int64(len(body)) != prim.Size) || hex.EncodeToString(sum[:]) != prim.SHA256 {
			return fmt.Errorf("%s 的 primary 与已签名的仓库清单不一致，拒绝使用", s.ID)
		}
		n, err := countRpmPackages(body)
		if err != nil {
			return fmt.Errorf("%s 的 primary 无法解析：%w", s.ID, err)
		}
		f.Packages = n
		if err := os.WriteFile(filepath.Join(dir, name+".tmp"), body, 0o600); err != nil {
			return err
		}
		if err := os.Rename(filepath.Join(dir, name+".tmp"), filepath.Join(dir, name)); err != nil {
			return err
		}
		rep.Emit(StepEvent{ID: cur, State: "done", Detail: fmt.Sprintf("%s 个版本 · %s", humanCount(n), humanBytes(prim.Size)), Size: prim.Size})
		files = append(files, f)
	}
	return x.commitState(def, dir, files, releases, rep)
}

// commitState writes the new index state, drops files no longer in it and reloads the index into memory.
func (x *Index) commitState(def mwpack.PlatformDef, dir string, files []IndexFile, releases []IndexRelease, rep *Reporter) error {
	st := IndexState{Platform: def.ID, Updated: time.Now().UTC().Format(time.RFC3339), Files: files, Releases: releases}
	if err := writeJSONAtomic(filepath.Join(dir, "state.json"), st); err != nil {
		return err
	}
	keep := map[string]bool{"state.json": true}
	for _, f := range files {
		keep[f.File] = true
	}
	for _, r := range releases {
		keep[r.File] = true
		if r.Sig != "" {
			keep[r.Sig] = true
		}
	}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			// filelists/other fetched for downloads are kept while their repomd is current
			if !keep[e.Name()] && !strings.HasPrefix(e.Name(), "cache-") {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	x.mu.Lock()
	delete(x.loaded, def.ID)
	x.mu.Unlock()
	_, _ = x.load(def)
	total := 0
	for _, f := range files {
		total += f.Packages
	}
	rep.Logf("索引已更新：%d 个软件包版本", total)
	return nil
}

// ---- reading primary.xml ----

type xmlEntry struct {
	Name  string `xml:"name,attr"`
	Flags string `xml:"flags,attr"`
	Epoch string `xml:"epoch,attr"`
	Ver   string `xml:"ver,attr"`
	Rel   string `xml:"rel,attr"`
}

type xmlPackage struct {
	Type    string `xml:"type,attr"`
	Name    string `xml:"name"`
	Arch    string `xml:"arch"`
	Version struct {
		Epoch string `xml:"epoch,attr"`
		Ver   string `xml:"ver,attr"`
		Rel   string `xml:"rel,attr"`
	} `xml:"version"`
	Checksum struct {
		Type  string `xml:"type,attr"`
		Value string `xml:",chardata"`
	} `xml:"checksum"`
	Summary string `xml:"summary"`
	Size    struct {
		Package int64 `xml:"package,attr"`
	} `xml:"size"`
	Location struct {
		Href string `xml:"href,attr"`
	} `xml:"location"`
	Format struct {
		SrcRPM   string     `xml:"sourcerpm"`
		Provides []xmlEntry `xml:"provides>entry"`
		Requires []xmlEntry `xml:"requires>entry"`
		Files    []string   `xml:"file"`
	} `xml:"format"`
}

func entryEVR(e xmlEntry) string {
	if e.Ver == "" {
		return ""
	}
	return evr{e: atoiSafe(e.Epoch), v: e.Ver, r: e.Rel}.String()
}

func atoiSafe(s string) int { n, _ := strconv.Atoi(s); return n }

// rpmVersion writes a package version the way dnf and the library do: epoch only when it is not 0.
func rpmVersion(epoch, ver, rel string) string {
	return evr{e: atoiSafe(epoch), v: ver, r: rel}.String()
}

func eachRpmPackage(gz []byte, fn func(p *xmlPackage) bool) error {
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return err
	}
	defer zr.Close()
	dec := xml.NewDecoder(bufio.NewReaderSize(zr, 1<<20))
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "package" {
			continue
		}
		var p xmlPackage
		if err := dec.DecodeElement(&p, &se); err != nil {
			return err
		}
		if !fn(&p) {
			return nil
		}
	}
}

func countRpmPackages(gz []byte) (int, error) {
	n := 0
	err := eachRpmPackage(gz, func(*xmlPackage) bool { n++; return true })
	return n, err
}

var flagOp = map[string]string{"EQ": "EQ", "LT": "LT", "LE": "LE", "GT": "GT", "GE": "GE"}

// loadRpm parses the cached primary files of a platform. The caller holds the index lock.
func (x *Index) loadRpm(def mwpack.PlatformDef, st IndexState) (*platIndex, error) {
	pi := &platIndex{state: st, byName: map[string][]*IndexPkg{}, prov: map[string][]provided{}}
	seen := map[string]bool{}
	for _, f := range st.Files {
		gz, err := os.ReadFile(filepath.Join(x.pdir(def.ID), f.File))
		if err != nil {
			return nil, fmt.Errorf("索引文件 %s 缺失，请重新更新索引：%w", f.File, err)
		}
		err = eachRpmPackage(gz, func(xp *xmlPackage) bool {
			if xp.Arch != "x86_64" && xp.Arch != "noarch" {
				return true
			}
			p := &IndexPkg{Name: xp.Name, Version: rpmVersion(xp.Version.Epoch, xp.Version.Ver, xp.Version.Rel), Arch: xp.Arch, Filename: xp.Location.Href, Size: xp.Size.Package, Source: f.Source, Desc: xp.Summary}
			if xp.Checksum.Type == "sha256" {
				p.SHA256 = strings.TrimSpace(xp.Checksum.Value)
			}
			k := p.Name + "\x00" + p.Version + "\x00" + p.Arch
			if seen[k] || p.SHA256 == "" {
				return true
			}
			seen[k] = true
			info := &rpmInfo{Pkgid: p.SHA256, SrcName: srpmName(xp.Format.SrcRPM), Files: xp.Format.Files}
			for _, e := range xp.Format.Provides {
				info.Provides = append(info.Provides, rpmDep{e.Name, flagOp[e.Flags], entryEVR(e)})
			}
			for _, e := range xp.Format.Requires {
				if strings.HasPrefix(e.Name, "rpmlib(") {
					continue
				}
				info.Requires = append(info.Requires, rpmDep{e.Name, flagOp[e.Flags], entryEVR(e)})
			}
			p.rpm = info
			pi.byName[p.Name] = append(pi.byName[p.Name], p)
			return true
		})
		if err != nil {
			return nil, fmt.Errorf("读取索引 %s：%w", f.File, err)
		}
	}
	for name, list := range pi.byName {
		sort.SliceStable(list, func(i, j int) bool { return CompareRPM(list[i].Version, list[j].Version) > 0 })
		for _, p := range list {
			for _, d := range p.rpm.Provides {
				if d.Name != name {
					pi.prov[d.Name] = append(pi.prov[d.Name], provided{p, d.EVR})
				}
			}
			for _, file := range p.rpm.Files {
				pi.prov[file] = append(pi.prov[file], provided{p, ""})
			}
		}
	}
	b, err := loadBaseSet(def.ID)
	if err != nil {
		return nil, err
	}
	pi.base = b
	return pi, nil
}

// ---- metadata for the assembled repository ----

var pkgidRE = regexp.MustCompile(`pkgid="([0-9a-f]{64})"`)
var primarySumRE = regexp.MustCompile(`<checksum type="sha256" pkgid="YES">([0-9a-f]{64})</checksum>`)

// packageBlocks streams a gzip compressed repodata XML file and calls fn with the text of every <package> element
// whose id is wanted. id picks the id out of a block.
func packageBlocks(r io.Reader, id func(block string) string, want map[string]bool, fn func(id, block string)) error {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer zr.Close()
	br := bufio.NewReaderSize(zr, 1<<20)
	var cur strings.Builder
	in := false
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			t := strings.TrimSpace(line)
			if !in && strings.HasPrefix(t, "<package") {
				in = true
				cur.Reset()
			}
			if in {
				cur.WriteString(line)
				if strings.HasPrefix(t, "</package>") || (strings.HasPrefix(t, "<package") && strings.HasSuffix(t, "/>")) {
					in = false
					blk := strings.TrimRight(strings.TrimSpace(cur.String()), "\n")
					if k := id(blk); want[k] {
						fn(k, blk)
					}
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func firstGroup(re *regexp.Regexp) func(string) string {
	return func(s string) string {
		if m := re.FindStringSubmatch(s); m != nil {
			return m[1]
		}
		return ""
	}
}

// rpmMetas builds the repository metadata of each package of a plan: its primary entry from the cached primary file,
// and its filelists and other entries from those files, which are downloaded (and checked against the signed
// repomd.xml) the first time they are needed and then kept beside the index.
func (x *Index) rpmMetas(ctx context.Context, def mwpack.PlatformDef, srcs map[string]Source, plan *Plan) ([]Meta, error) {
	st := x.State(def.ID)
	dir := x.pdir(def.ID)
	bySource := map[string]map[string]PlanPkg{} // source -> pkgid -> package
	for _, p := range plan.Packages {
		if bySource[p.Source] == nil {
			bySource[p.Source] = map[string]PlanPkg{}
		}
		bySource[p.Source][p.SHA256] = p
	}
	metas := map[string]*Meta{}
	for _, p := range plan.Packages {
		metas[p.SHA256] = &Meta{File: p.File, Name: p.Name, Version: p.Version, Arch: p.Arch, SHA256: p.SHA256, Size: p.Size}
	}
	for src, pkgs := range bySource {
		want := map[string]bool{}
		for id := range pkgs {
			want[id] = true
		}
		var prim string
		var rel IndexRelease
		for _, f := range st.Files {
			if f.Source == src {
				prim = f.File
			}
		}
		for _, r := range st.Releases {
			if r.Source == src {
				rel = r
			}
		}
		if prim == "" || rel.File == "" {
			return nil, fmt.Errorf("索引里没有软件源 %s，请重新更新索引", src)
		}
		pf, err := os.Open(filepath.Join(dir, prim))
		if err != nil {
			return nil, err
		}
		err = packageBlocks(pf, firstGroup(primarySumRE), want, func(id, blk string) { metas[id].Primary = blk })
		pf.Close()
		if err != nil {
			return nil, err
		}
		md, err := os.ReadFile(filepath.Join(dir, rel.File))
		if err != nil {
			return nil, err
		}
		_, data, err := parseRepomd(md)
		if err != nil {
			return nil, err
		}
		for _, kind := range []string{"filelists", "other"} {
			d, ok := data[kind]
			if !ok {
				return nil, fmt.Errorf("软件源 %s 没有 %s 元数据", src, kind)
			}
			cache := filepath.Join(dir, "cache-"+d.SHA256+"-"+kind+".xml.gz")
			if _, err := os.Stat(cache); err != nil {
				s, ok := srcs[src]
				if !ok {
					return nil, fmt.Errorf("软件源 %s 已不存在，请重新更新索引", src)
				}
				body, err := x.get(ctx, rpmBase(s)+d.Location, 1<<30)
				if err != nil {
					return nil, fmt.Errorf("下载 %s 的 %s：%w", src, kind, err)
				}
				sum := sha256.Sum256(body)
				if hex.EncodeToString(sum[:]) != d.SHA256 {
					return nil, fmt.Errorf("%s 的 %s 与已签名的仓库清单不一致，拒绝使用", src, kind)
				}
				// filelists and other of an older repomd are no longer useful
				if old, _ := filepath.Glob(filepath.Join(dir, "cache-*-"+kind+".xml.gz")); len(old) > 0 {
					for _, o := range old {
						_ = os.Remove(o)
					}
				}
				if err := os.WriteFile(cache, body, 0o600); err != nil {
					return nil, err
				}
			}
			cf, err := os.Open(cache)
			if err != nil {
				return nil, err
			}
			err = packageBlocks(cf, firstGroup(pkgidRE), want, func(id, blk string) {
				if kind == "filelists" {
					metas[id].Filelists = blk
				} else {
					metas[id].Other = blk
				}
			})
			cf.Close()
			if err != nil {
				return nil, err
			}
		}
	}
	var out []Meta
	for _, p := range plan.Packages {
		m := metas[p.SHA256]
		if m.Primary == "" || m.Filelists == "" || m.Other == "" {
			return nil, fmt.Errorf("仓库元数据里找不到 %s %s，请重新更新索引", p.Name, p.Version)
		}
		out = append(out, *m)
	}
	return out, nil
}

// srpmName is the package name part of a source rpm file name: "openssl-3.5.8-2.el9_8.src.rpm" → "openssl".
func srpmName(s string) string {
	s = strings.TrimSuffix(s, ".src.rpm")
	for k := 0; k < 2; k++ {
		if i := strings.LastIndexByte(s, '-'); i > 0 {
			s = s[:i]
		}
	}
	return s
}

// rpmFileName is the name a downloaded rpm has in the library: the last part of its location, as dnf names it.
func rpmFileName(href string) string { return SafeFile(path.Base(href)) }

// loadRpmBase reads the base system of an rpm platform: "name<TAB>epoch:version-release<TAB>arch<TAB>provides|…" lines,
// and the list of its files (for requirements on paths such as /bin/sh).
func loadRpmBase(tsv, filesGz []byte) (*baseSet, error) {
	s := &baseSet{have: map[string]string{}, prov: map[string][]provided{}, requires: map[string][]rpmDep{}}
	for _, line := range strings.Split(strings.TrimSpace(string(tsv)), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 {
			continue
		}
		v := strings.TrimPrefix(f[1], "0:")
		s.have[f[0]] = v
		if len(f) > 4 {
			for _, r := range strings.Split(f[4], "|") {
				parts := strings.Fields(r)
				if len(parts) == 0 || strings.HasPrefix(parts[0], "rpmlib(") {
					continue
				}
				d := rpmDep{Name: parts[0]}
				if len(parts) == 3 {
					d.Op, d.EVR = symOp[parts[1]], parts[2]
				}
				s.requires[f[0]] = append(s.requires[f[0]], d)
			}
		}
		owner := &IndexPkg{Name: f[0], Version: v}
		if len(f) > 3 {
			for _, p := range strings.Split(f[3], "|") {
				parts := strings.Fields(p)
				if len(parts) == 0 {
					continue
				}
				ver := ""
				if len(parts) == 3 {
					ver = parts[2]
				}
				s.prov[parts[0]] = append(s.prov[parts[0]], provided{owner, ver})
			}
		}
	}
	zr, err := gzip.NewReader(bytes.NewReader(filesGz))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	sc := bufio.NewScanner(zr)
	sc.Buffer(make([]byte, 1<<16), 1<<20)
	files := &IndexPkg{Name: "(基础系统)"}
	for sc.Scan() {
		if p := strings.TrimSpace(sc.Text()); p != "" {
			s.prov[p] = append(s.prov[p], provided{files, ""})
		}
	}
	return s, sc.Err()
}

func attr(se xml.StartElement, name string) string {
	for _, a := range se.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}
