package pkglib

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto"
	"crypto/sha256"
	_ "crypto/sha256" // signature hashes
	_ "crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/openpgp"
	"golang.org/x/crypto/openpgp/clearsign"
	"golang.org/x/crypto/openpgp/packet"

	"middleware-deployer/mwpack"
)

// IndexPkg is one package version as a signed repository index lists it. Only what searching, resolving and
// downloading need is kept in memory.
type IndexPkg struct {
	Name     string   `json:"name"`
	Version  string   `json:"version"`
	Arch     string   `json:"arch"`
	Deps     string   `json:"-"` // Pre-Depends and Depends, comma separated
	Provides string   `json:"-"`
	Filename string   `json:"-"`
	Size     int64    `json:"size"`
	SHA256   string   `json:"-"`
	Source   string   `json:"source"`
	Suite    string   `json:"suite"`
	Desc     string   `json:"desc,omitempty"`
	rpm      *rpmInfo // requires, provides and files of an rpm package; nil for deb packages
}

// IndexFile is one downloaded and verified Packages file.
type IndexFile struct {
	Source    string `json:"source"`
	Suite     string `json:"suite"`
	Component string `json:"component"`
	File      string `json:"file"`
	SHA256    string `json:"sha256"`
	Packages  int    `json:"packages"`
	Date      string `json:"date,omitempty"` // the Release date the index was published
}

// IndexRelease is a signed Release file kept beside the Packages files, so the index can be verified again wherever
// it is moved to.
type IndexRelease struct {
	Source string `json:"source"`
	Suite  string `json:"suite"`
	File   string `json:"file"`
	Sig    string `json:"sig,omitempty"` // a detached signature of File (rpm repositories)
	Date   string `json:"date,omitempty"`
}

// IndexState says what the cached index of one platform contains.
type IndexState struct {
	Platform string         `json:"platform"`
	Updated  string         `json:"updated,omitempty"`
	Imported string         `json:"imported,omitempty"` // set when the index came from another platform as a pack
	Files    []IndexFile    `json:"files"`
	Releases []IndexRelease `json:"releases,omitempty"`
	Packages int            `json:"packages"`
}

// Index caches the signed package indexes of every platform on disk and searches them in memory. It is what makes
// "which versions exist" and "what would this need" instant, without a container and without the network.
type Index struct {
	Dir     string // <library>/index
	HTTP    *http.Client
	mu      sync.Mutex
	loaded  map[string]*platIndex
	syncing map[string]bool
}

type platIndex struct {
	state  IndexState
	byName map[string][]*IndexPkg // newest first
	prov   map[string][]provided  // virtual name -> providers
	base   *baseSet
}

type provided struct {
	pkg *IndexPkg
	ver string // the version the provide declares, "" when unversioned
}

// OpenIndex prepares the index directory beside the library's platform directories.
func OpenIndex(libraryDir string) *Index {
	return &Index{Dir: filepath.Join(libraryDir, "index"), HTTP: &http.Client{Timeout: 5 * time.Minute}, loaded: map[string]*platIndex{}, syncing: map[string]bool{}}
}

func (x *Index) pdir(platform string) string { return filepath.Join(x.Dir, platform) }

// State reports what is cached for a platform; an empty state means the index has never been updated.
func (x *Index) State(platform string) IndexState {
	b, err := os.ReadFile(filepath.Join(x.pdir(platform), "state.json"))
	st := IndexState{Platform: platform, Files: []IndexFile{}}
	if err == nil {
		_ = json.Unmarshal(b, &st)
	}
	st.Platform = platform
	if st.Files == nil {
		st.Files = []IndexFile{}
	}
	for _, f := range st.Files {
		st.Packages += f.Packages
	}
	return st
}

// Ready reports whether the platform has an index to search.
func (x *Index) Ready(platform string) bool { return len(x.State(platform).Files) > 0 }

// ---- update (network) ----

// Update downloads the indexes of every apt source of the platform, verifying each Release signature with the
// source's key and each Packages file against the hash the signed Release lists. A Packages file that is already
// cached with the same hash is not downloaded again.
func (x *Index) Update(ctx context.Context, def mwpack.PlatformDef, srcs *Sources, rep *Reporter) (err error) {
	x.mu.Lock()
	if x.syncing[def.ID] {
		x.mu.Unlock()
		return errors.New("这个系统的索引正在更新")
	}
	x.syncing[def.ID] = true
	x.mu.Unlock()
	defer func() {
		x.mu.Lock()
		delete(x.syncing, def.ID)
		x.mu.Unlock()
	}()
	say := rep.Logf
	list := srcs.ForPlatform(def.ID)
	if len(list) == 0 {
		return fmt.Errorf("没有适用于 %s 的软件源", def.ID)
	}
	// every step is announced up front, so the page can show what is coming and how far along it is
	for _, s := range list {
		for _, suite := range s.Suites {
			rep.Emit(StepEvent{ID: "rel|" + s.ID + "|" + suite, Group: s.Title, Label: suite + " · 发布清单与签名", State: "pending"})
			for _, comp := range s.Components {
				rep.Emit(StepEvent{ID: "pk|" + s.ID + "|" + suite + "|" + comp, Group: s.Title, Label: suite + " · " + comp + " 软件包清单", State: "pending"})
			}
		}
	}
	cur := ""
	defer func() {
		if err != nil && cur != "" {
			rep.Emit(StepEvent{ID: cur, State: "failed", Detail: err.Error()})
		}
	}()
	dir := x.pdir(def.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if def.Family == "rpm" {
		return x.updateRpm(ctx, def, srcs, rep, list, dir)
	}
	old := map[string]IndexFile{}
	for _, f := range x.State(def.ID).Files {
		old[f.File] = f
	}
	var files []IndexFile
	var releases []IndexRelease
	for _, s := range list {
		if s.Kind != "apt" {
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
		for _, suite := range s.Suites {
			base := strings.TrimRight(s.URL, "/") + "/dists/" + suite + "/"
			say("读取 %s / %s 的发布清单", s.Title, suite)
			cur = "rel|" + s.ID + "|" + suite
			rep.Emit(StepEvent{ID: cur, Group: s.Title, Label: suite + " · 发布清单与签名", State: "running", Detail: "读取并验证签名"})
			rel, err := x.get(ctx, base+"InRelease", 8<<20)
			if err != nil {
				return fmt.Errorf("%s / %s：%w", s.ID, suite, err)
			}
			text, err := verifyInRelease(rel, ring)
			if err != nil {
				return fmt.Errorf("%s / %s 的签名验证没有通过：%w", s.ID, suite, err)
			}
			hashes, date := parseRelease(text)
			relName := SafeFile(s.ID + "__" + suite + ".InRelease")
			tmpRel := filepath.Join(dir, relName+".tmp")
			if err := os.WriteFile(tmpRel, rel, 0o600); err != nil {
				return err
			}
			if err := os.Rename(tmpRel, filepath.Join(dir, relName)); err != nil {
				return err
			}
			releases = append(releases, IndexRelease{Source: s.ID, Suite: suite, File: relName, Date: date})
			rep.Emit(StepEvent{ID: cur, State: "done", Detail: "签名有效"})
			for _, comp := range s.Components {
				path := comp + "/binary-" + def.Arch + "/Packages.gz"
				cur = "pk|" + s.ID + "|" + suite + "|" + comp
				h, ok := hashes[path]
				if !ok {
					return fmt.Errorf("%s / %s 没有 %s（目前只读取 gz 压缩的索引）", s.ID, suite, path)
				}
				name := SafeFile(s.ID + "__" + suite + "__" + comp + ".Packages.gz")
				f := IndexFile{Source: s.ID, Suite: suite, Component: comp, File: name, SHA256: h.sum, Date: date}
				if o, ok := old[name]; ok && o.SHA256 == h.sum {
					if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
						f.Packages = o.Packages
						say("  %s 没有变化，沿用本地", path)
						rep.Emit(StepEvent{ID: cur, State: "skipped", Detail: fmt.Sprintf("没有变化 · %s 个版本", humanCount(o.Packages))})
						files = append(files, f)
						continue
					}
				}
				say("  下载 %s（%s）", path, humanBytes(h.size))
				rep.Emit(StepEvent{ID: cur, State: "running", Detail: "下载 " + humanBytes(h.size), Size: h.size})
				body, err := x.get(ctx, base+path, 256<<20)
				if err != nil {
					return fmt.Errorf("%s / %s：%w", s.ID, suite, err)
				}
				sum := sha256.Sum256(body)
				if int64(len(body)) != h.size || hex.EncodeToString(sum[:]) != h.sum {
					return fmt.Errorf("%s / %s 的 %s 与已签名的发布清单不一致，拒绝使用", s.ID, suite, path)
				}
				n, err := countPackages(body)
				if err != nil {
					return fmt.Errorf("%s / %s 的 %s 无法解析：%w", s.ID, suite, path, err)
				}
				f.Packages = n
				rep.Emit(StepEvent{ID: cur, State: "done", Detail: fmt.Sprintf("%s 个版本 · %s", humanCount(n), humanBytes(h.size)), Size: h.size})
				tmp := filepath.Join(dir, name+".tmp")
				if err := os.WriteFile(tmp, body, 0o600); err != nil {
					return err
				}
				if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
					return err
				}
				files = append(files, f)
			}
		}
	}
	// index files of sources that are gone or changed are dropped only after the new state is complete
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
	total := 0
	for _, f := range files {
		total += f.Packages
	}
	say("索引已更新：%d 个软件包版本", total)
	return nil
}

func (x *Index) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	var last error
	for try := 1; try <= 3; try++ {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := x.HTTP.Do(req)
		if err == nil {
			b, rerr := io.ReadAll(io.LimitReader(resp.Body, limit+1))
			resp.Body.Close()
			switch {
			case rerr != nil:
				err = rerr
			case resp.StatusCode != 200:
				err = fmt.Errorf("%s 返回 %d", url, resp.StatusCode)
				if resp.StatusCode == 404 {
					return nil, err
				}
			case int64(len(b)) > limit:
				return nil, fmt.Errorf("%s 太大", url)
			default:
				return b, nil
			}
		}
		last = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(try) * 2 * time.Second):
		}
	}
	return nil, fmt.Errorf("下载失败：%w", last)
}

func humanCount(n int) string {
	if n >= 1000 {
		return fmt.Sprintf("%d,%03d", n/1000, n%1000)
	}
	return fmt.Sprint(n)
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func readKeyRing(b []byte) (openpgp.EntityList, error) {
	if ring, err := openpgp.ReadKeyRing(bytes.NewReader(b)); err == nil && len(ring) > 0 {
		return ring, nil
	}
	return openpgp.ReadArmoredKeyRing(bytes.NewReader(b))
}

// verifyInRelease checks a clearsigned InRelease against the keyring and returns the signed text. Any one valid
// signature from a key in the ring is enough, as with apt.
func verifyInRelease(data []byte, ring openpgp.EntityList) (string, error) {
	blk, rest := clearsign.Decode(data)
	if blk == nil {
		_ = rest
		return "", errors.New("不是有效的 InRelease（缺少签名）")
	}
	pr := packet.NewReader(blk.ArmoredSignature.Body)
	var last error = errors.New("没有找到签名")
	for {
		p, err := pr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			last = err
			break
		}
		sig, ok := p.(*packet.Signature)
		if !ok || sig.IssuerKeyId == nil {
			continue
		}
		for _, k := range ring.KeysById(*sig.IssuerKeyId) {
			h := sig.Hash.New()
			h.Write(blk.Bytes)
			if err := k.PublicKey.VerifySignature(h, sig); err == nil {
				return string(blk.Plaintext), nil
			} else {
				last = err
			}
		}
		if last != nil && len(ring.KeysById(*sig.IssuerKeyId)) == 0 {
			last = fmt.Errorf("签名者 %016X 不在这个软件源的密钥里", *sig.IssuerKeyId)
		}
	}
	return "", last
}

var _ = crypto.SHA256

type relHash struct {
	sum  string
	size int64
}

// parseRelease reads the SHA256 section of a Release file.
func parseRelease(text string) (map[string]relHash, string) {
	out := map[string]relHash{}
	date := ""
	in := false
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "Date:"):
			date = strings.TrimSpace(strings.TrimPrefix(line, "Date:"))
			in = false
		case strings.HasPrefix(line, "SHA256:"):
			in = true
		case in && strings.HasPrefix(line, " "):
			f := strings.Fields(line)
			if len(f) == 3 {
				if n, err := strconv.ParseInt(f[1], 10, 64); err == nil {
					out[f[2]] = relHash{f[0], n}
				}
			}
		default:
			in = false
		}
	}
	return out, date
}

// ---- parsing Packages ----

// stanzas calls fn with every stanza of a gzip compressed Packages file.
func stanzas(gz []byte, fn func(lines []string) bool) error {
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return err
	}
	defer zr.Close()
	return stanzaReader(zr, fn)
}

func stanzaReader(r io.Reader, fn func(lines []string) bool) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	var cur []string
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if len(cur) > 0 {
				if !fn(cur) {
					return nil
				}
				cur = cur[:0]
			}
			continue
		}
		cur = append(cur, line)
	}
	if len(cur) > 0 {
		fn(cur)
	}
	return sc.Err()
}

func fieldOf(lines []string, key string) string {
	p := key + ":"
	for i, l := range lines {
		if strings.HasPrefix(l, p) {
			v := strings.TrimSpace(l[len(p):])
			for _, c := range lines[i+1:] {
				if !strings.HasPrefix(c, " ") && !strings.HasPrefix(c, "\t") {
					break
				}
				v += "\n" + c
			}
			return v
		}
	}
	return ""
}

func countPackages(gz []byte) (int, error) {
	n := 0
	err := stanzas(gz, func(lines []string) bool {
		if strings.HasPrefix(lines[0], "Package:") {
			n++
		}
		return true
	})
	return n, err
}

func parsePkg(lines []string, source, suite string) *IndexPkg {
	p := &IndexPkg{Source: source, Suite: suite}
	var deps []string
	var pre, dep string
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if l == "" || l[0] == ' ' || l[0] == '\t' {
			continue
		}
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "Package":
			p.Name = v
		case "Version":
			p.Version = v
		case "Architecture":
			p.Arch = v
		case "Pre-Depends":
			pre = joinContinued(lines, i, v)
		case "Depends":
			dep = joinContinued(lines, i, v)
		case "Provides":
			p.Provides = joinContinued(lines, i, v)
		case "Filename":
			p.Filename = v
		case "Size":
			p.Size, _ = strconv.ParseInt(v, 10, 64)
		case "SHA256":
			p.SHA256 = v
		case "Description":
			p.Desc = v
		}
	}
	if pre != "" {
		deps = append(deps, pre)
	}
	if dep != "" {
		deps = append(deps, dep)
	}
	p.Deps = strings.Join(deps, ", ")
	if p.Name == "" || p.Version == "" || p.Filename == "" {
		return nil
	}
	return p
}

func joinContinued(lines []string, i int, v string) string {
	for _, c := range lines[i+1:] {
		if !strings.HasPrefix(c, " ") && !strings.HasPrefix(c, "\t") {
			break
		}
		v += " " + strings.TrimSpace(c)
	}
	return v
}

// ---- in memory ----

func (x *Index) load(def mwpack.PlatformDef) (*platIndex, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if pi, ok := x.loaded[def.ID]; ok {
		return pi, nil
	}
	st := x.State(def.ID)
	if len(st.Files) == 0 {
		return nil, errors.New("还没有这个系统的软件源索引：先点“更新索引”（需要联网一次）")
	}
	if def.Family == "rpm" {
		pi, err := x.loadRpm(def, st)
		if err != nil {
			return nil, err
		}
		x.loaded[def.ID] = pi
		return pi, nil
	}
	pi := &platIndex{state: st, byName: map[string][]*IndexPkg{}, prov: map[string][]provided{}}
	seen := map[string]bool{}
	for _, f := range st.Files {
		gz, err := os.ReadFile(filepath.Join(x.pdir(def.ID), f.File))
		if err != nil {
			return nil, fmt.Errorf("索引文件 %s 缺失，请重新更新索引：%w", f.File, err)
		}
		err = stanzas(gz, func(lines []string) bool {
			p := parsePkg(lines, f.Source, f.Suite)
			if p == nil || (p.Arch != def.Arch && p.Arch != "all") {
				return true
			}
			k := p.Name + "\x00" + p.Version
			if seen[k] {
				return true // the same version in a later suite: the first source listed wins
			}
			seen[k] = true
			pi.byName[p.Name] = append(pi.byName[p.Name], p)
			return true
		})
		if err != nil {
			return nil, fmt.Errorf("读取索引 %s：%w", f.File, err)
		}
	}
	for name, list := range pi.byName {
		sort.SliceStable(list, func(i, j int) bool { return CompareDeb(list[i].Version, list[j].Version) > 0 })
		for _, p := range list {
			if p.Provides == "" {
				continue
			}
			for _, alt := range strings.Split(p.Provides, ",") {
				n, v := splitProvide(alt)
				if n != "" && n != name {
					pi.prov[n] = append(pi.prov[n], provided{p, v})
				}
			}
		}
	}
	b, err := loadBaseSet(def.ID)
	if err != nil {
		return nil, err
	}
	pi.base = b
	x.loaded[def.ID] = pi
	return pi, nil
}

func splitProvide(s string) (name, ver string) {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '('); i >= 0 {
		v := strings.TrimSpace(strings.Trim(s[i:], "()"))
		v = strings.TrimSpace(strings.TrimPrefix(v, "="))
		return strings.TrimSpace(strings.TrimSuffix(s[:i], ":any")), v
	}
	return strings.TrimSuffix(s, ":any"), ""
}

// Preload parses the cached index of a platform into memory in the background, so the first search after a start or
// an update is as fast as the rest. It does nothing when there is no index yet.
func (x *Index) Preload(def mwpack.PlatformDef) {
	if !x.Ready(def.ID) {
		return
	}
	go func() { _, _ = x.load(def) }()
}

// ---- search ----

// SearchHit is one package name matching a query.
type SearchHit struct {
	Name     string `json:"name"`
	Latest   string `json:"latest"`
	Versions int    `json:"versions"`
	Desc     string `json:"desc,omitempty"`
	Source   string `json:"source"`
}

// Search finds package names by name (exact, prefix, then substring) and then by description, best matches first.
func (x *Index) Search(def mwpack.PlatformDef, q string, limit int) ([]SearchHit, error) {
	pi, err := x.load(def)
	if err != nil {
		return nil, err
	}
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return []SearchHit{}, nil
	}
	type scored struct {
		hit  SearchHit
		rank int
	}
	var hits []scored
	for name, list := range pi.byName {
		rank := -1
		ln := strings.ToLower(name)
		switch {
		case ln == q:
			rank = 0
		case strings.HasPrefix(ln, q):
			rank = 1
		case strings.Contains(ln, q):
			rank = 2
		case strings.Contains(strings.ToLower(list[0].Desc), q):
			rank = 3
		}
		if rank < 0 {
			continue
		}
		hits = append(hits, scored{SearchHit{Name: name, Latest: list[0].Version, Versions: len(list), Desc: list[0].Desc, Source: list[0].Source}, rank})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].rank != hits[j].rank {
			return hits[i].rank < hits[j].rank
		}
		if len(hits[i].hit.Name) != len(hits[j].hit.Name) {
			return len(hits[i].hit.Name) < len(hits[j].hit.Name)
		}
		return hits[i].hit.Name < hits[j].hit.Name
	})
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]SearchHit, len(hits))
	for i, h := range hits {
		out[i] = h.hit
	}
	return out, nil
}

// Versions lists every version of a package the cached indexes offer, newest first.
func (x *Index) Versions(def mwpack.PlatformDef, name string) ([]IndexPkg, error) {
	pi, err := x.load(def)
	if err != nil {
		return nil, err
	}
	list := pi.byName[name]
	if len(list) == 0 {
		return nil, fmt.Errorf("软件源里没有 %s", name)
	}
	out := make([]IndexPkg, len(list))
	for i, p := range list {
		out[i] = *p
	}
	return out, nil
}
