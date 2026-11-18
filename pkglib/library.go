package pkglib

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// FileRef is one package file of a closure.
type FileRef struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// PkgRef names a package inside a closure, for display.
type PkgRef struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// Closure is everything one package@version needs installed on a clean system of its platform: the package and the
// dependencies the target would not already have.
type Closure struct {
	Request  mwpack.PackageRequest `json:"request"`
	Platform string                `json:"platform"`
	Files    []FileRef             `json:"files"`
	Packages []PkgRef              `json:"packages"`
	Bytes    int64                 `json:"bytes"`
	Fetched  string                `json:"fetched"`
	// Via says how the closure was obtained: "container ubuntu:24.04" or "imported".
	Via     string   `json:"via"`
	Sources []string `json:"sources,omitempty"`
}

// Meta is what the repository index needs to know about one file.
type Meta struct {
	File    string `json:"file"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Arch    string `json:"arch"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	// Control is the Debian control stanza; the rpm fields are the package's entries in the repodata files.
	Control   string `json:"control,omitempty"`
	Primary   string `json:"primary,omitempty"`
	Filelists string `json:"filelists,omitempty"`
	Other     string `json:"other,omitempty"`
}

// Library stores fetched packages. Layout: <dir>/<platform>/{pool,meta,closures}, and <dir>/built for cached
// assembled repositories.
type Library struct{ Dir string }

func Open(dir string) (*Library, error) {
	if dir == "" {
		return nil, errors.New("未配置软件库目录")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Library{Dir: dir}, nil
}

var safeName = regexp.MustCompile(`[^A-Za-z0-9._+~-]`)

// SafeFile turns a package file name into one that is safe on disk and in URLs (epochs like %3a, colons).
func SafeFile(name string) string { return safeName.ReplaceAllString(name, "_") }

func closureName(r mwpack.PackageRequest) string {
	return safeName.ReplaceAllString(r.Name, "_") + "@" + safeName.ReplaceAllString(r.Version, "_") + ".json"
}

func (l *Library) pdir(platform string, parts ...string) string {
	return filepath.Join(append([]string{l.Dir, platform}, parts...)...)
}

func platformOK(platform string) error {
	if _, ok := mwpack.PlatformByID(platform); !ok {
		return fmt.Errorf("未知的操作系统 %q", platform)
	}
	return nil
}

func sumFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(append(b, '\n')); err == nil {
		err = tmp.Chmod(0o600)
	}
	if ce := tmp.Close(); err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Put adds a closure with its files. srcDir holds the package files under their original names; they are stored
// under safe names. Existing files must have identical content.
func (l *Library) Put(c Closure, metas []Meta, srcDir func(file string) string) error {
	if err := platformOK(c.Platform); err != nil {
		return err
	}
	byFile := map[string]Meta{}
	for _, m := range metas {
		byFile[m.File] = m
	}
	var total int64
	files := make([]FileRef, 0, len(c.Files))
	for _, f := range c.Files {
		m, ok := byFile[f.File]
		if !ok {
			return fmt.Errorf("闭包 %s 缺少 %s 的元数据", c.Request.Key(), f.File)
		}
		src := srcDir(f.File)
		sum, size, err := sumFile(src)
		if err != nil {
			return fmt.Errorf("读取 %s：%w", f.File, err)
		}
		if f.SHA256 != "" && f.SHA256 != sum {
			return fmt.Errorf("%s 的哈希与源上声明的不一致", f.File)
		}
		safe := SafeFile(f.File)
		dst := l.pdir(c.Platform, "pool", safe)
		if st, err := os.Stat(dst); err == nil {
			if have, _, _ := sumFile(dst); have != sum {
				return fmt.Errorf("软件库里已有同名但内容不同的文件 %s，拒绝覆盖", safe)
			}
			_ = st
		} else {
			if err := copyFile(src, dst); err != nil {
				return err
			}
		}
		m.File, m.SHA256, m.Size = safe, sum, size
		if err := writeJSONAtomic(l.pdir(c.Platform, "meta", safe+".json"), m); err != nil {
			return err
		}
		files = append(files, FileRef{safe, sum, size})
		total += size
	}
	sort.Slice(files, func(i, j int) bool { return files[i].File < files[j].File })
	c.Files, c.Bytes = files, total
	if c.Fetched == "" {
		c.Fetched = time.Now().UTC().Format(time.RFC3339)
	}
	return writeJSONAtomic(l.pdir(c.Platform, "closures", closureName(c.Request)), c)
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = io.Copy(tmp, in); err == nil {
		err = tmp.Chmod(0o600)
	}
	if ce := tmp.Close(); err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// Get loads a closure.
func (l *Library) Get(platform string, r mwpack.PackageRequest) (*Closure, error) {
	if err := platformOK(platform); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(l.pdir(platform, "closures", closureName(r)))
	if err != nil {
		return nil, err
	}
	var c Closure
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if c.Request != r || c.Platform != platform {
		return nil, fmt.Errorf("软件库记录 %s 与它的文件名不符", closureName(r))
	}
	return &c, nil
}

// HasFile reports whether a package file is stored with the size the index lists.
func (l *Library) HasFile(platform, file string, size int64) bool {
	st, err := os.Stat(l.pdir(platform, "pool", SafeFile(file)))
	return err == nil && st.Mode().IsRegular() && st.Size() == size
}

// Has reports whether a closure and all its files are present.
func (l *Library) Has(platform string, r mwpack.PackageRequest) bool {
	c, err := l.Get(platform, r)
	if err != nil {
		return false
	}
	for _, f := range c.Files {
		if st, err := os.Stat(l.pdir(platform, "pool", f.File)); err != nil || st.Size() != f.Size {
			return false
		}
	}
	return true
}

// Missing lists the requests the library cannot satisfy.
func (l *Library) Missing(platform string, reqs []mwpack.PackageRequest) []mwpack.PackageRequest {
	var out []mwpack.PackageRequest
	for _, r := range reqs {
		if !l.Has(platform, r) {
			out = append(out, r)
		}
	}
	return out
}

// List returns every closure of a platform, newest versions first within a package.
func (l *Library) List(platform string) []Closure {
	entries, _ := os.ReadDir(l.pdir(platform, "closures"))
	var out []Closure
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		b, err := os.ReadFile(l.pdir(platform, "closures", e.Name()))
		if err != nil {
			continue
		}
		var c Closure
		if json.Unmarshal(b, &c) == nil && closureName(c.Request) == e.Name() {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Request.Name != out[j].Request.Name {
			return out[i].Request.Name < out[j].Request.Name
		}
		return out[i].Request.Version > out[j].Request.Version
	})
	return out
}

// Delete removes a closure and any files no other closure still uses.
func (l *Library) Delete(platform string, r mwpack.PackageRequest) error {
	if err := platformOK(platform); err != nil {
		return err
	}
	if err := os.Remove(l.pdir(platform, "closures", closureName(r))); err != nil {
		return err
	}
	return l.gc(platform)
}

func (l *Library) gc(platform string) error {
	used := map[string]bool{}
	for _, c := range l.List(platform) {
		for _, f := range c.Files {
			used[f.File] = true
		}
	}
	for _, sub := range []string{"pool", "meta"} {
		entries, _ := os.ReadDir(l.pdir(platform, sub))
		for _, e := range entries {
			name := strings.TrimSuffix(e.Name(), ".json")
			if sub == "pool" {
				name = e.Name()
			}
			if !used[name] && !strings.HasPrefix(e.Name(), ".") {
				if err := os.Remove(l.pdir(platform, sub, e.Name())); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (l *Library) meta(platform, file string) (Meta, error) {
	var m Meta
	b, err := os.ReadFile(l.pdir(platform, "meta", file+".json"))
	if err != nil {
		return m, err
	}
	return m, json.Unmarshal(b, &m)
}

// Stats summarises a platform's library.
type Stats struct {
	Closures int   `json:"closures"`
	Files    int   `json:"files"`
	Bytes    int64 `json:"bytes"`
}

func (l *Library) Stats(platform string) Stats {
	var s Stats
	seen := map[string]bool{}
	for _, c := range l.List(platform) {
		s.Closures++
		for _, f := range c.Files {
			if !seen[f.File] {
				seen[f.File] = true
				s.Files++
				s.Bytes += f.Size
			}
		}
	}
	return s
}

// ---- packs: moving library content between machines ----

// ImportResult says what an import added.
type ImportResult struct {
	Closures int `json:"closures"`
	Files    int `json:"files"`
}

var (
	packEntryRE = regexp.MustCompile(`^library/([a-z0-9][a-z0-9.-]*)/(pool|meta|closures)/([A-Za-z0-9._+~@-]+)$`)
	maxPackFile = int64(2 << 30)
)

// Export writes the given closures, with the files they need, as a pack another platform can import. This is how
// packages prepared on a machine with network access reach a platform that has none.
func (l *Library) Export(w io.Writer, platform string, reqs []mwpack.PackageRequest) error {
	if err := platformOK(platform); err != nil {
		return err
	}
	files := map[string]bool{}
	var closures []Closure
	for _, r := range reqs {
		c, err := l.Get(platform, r)
		if err != nil || !l.Has(platform, r) {
			return fmt.Errorf("软件库没有 %s", r.Key())
		}
		closures = append(closures, *c)
		for _, f := range c.Files {
			files[f.File] = true
		}
	}
	gz := newGzip(w)
	tw := newTar(gz)
	add := func(name, path string) error { return tarFile(tw, name, path) }
	names := make([]string, 0, len(files))
	for f := range files {
		names = append(names, f)
	}
	sort.Strings(names)
	for _, f := range names {
		if err := add("library/"+platform+"/pool/"+f, l.pdir(platform, "pool", f)); err != nil {
			return err
		}
		if err := add("library/"+platform+"/meta/"+f+".json", l.pdir(platform, "meta", f+".json")); err != nil {
			return err
		}
	}
	for _, c := range closures {
		if err := add("library/"+platform+"/closures/"+closureName(c.Request), l.pdir(platform, "closures", closureName(c.Request))); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// Import reads a pack, checking every file against the hashes it declares, and adds it to the library. Nothing is
// added unless the whole pack is consistent.
func (l *Library) Import(r io.Reader) (ImportResult, error) {
	var res ImportResult
	stage, err := os.MkdirTemp(l.Dir, ".import-")
	if err != nil {
		return res, err
	}
	defer os.RemoveAll(stage)
	gz, err := newGzipReader(r)
	if err != nil {
		return res, errors.New("不是有效的软件库包（需要 .tar.gz）")
	}
	tr := newTarReader(gz)
	type placed struct{ platform, kind, name, path string }
	var got []placed
	var total int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return res, fmt.Errorf("软件库包读取失败：%v", err)
		}
		if h.Typeflag == 'x' || h.Typeflag == 'g' || h.Typeflag == '5' {
			continue
		}
		m := packEntryRE.FindStringSubmatch(h.Name)
		if h.Typeflag != '0' || m == nil || h.Size < 0 || h.Size > maxPackFile {
			return res, fmt.Errorf("软件库包含不允许的内容：%s", h.Name)
		}
		if err := platformOK(m[1]); err != nil {
			return res, err
		}
		total += h.Size
		if total > 20<<30 {
			return res, errors.New("软件库包过大")
		}
		p := filepath.Join(stage, fmt.Sprintf("%d", len(got)))
		out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			return res, err
		}
		n, err := io.Copy(out, io.LimitReader(tr, h.Size+1))
		out.Close()
		if err != nil || n != h.Size {
			return res, fmt.Errorf("%s 不完整", h.Name)
		}
		got = append(got, placed{m[1], m[2], m[3], p})
	}
	index := map[string]string{}
	for _, g := range got {
		index[g.platform+"/"+g.kind+"/"+g.name] = g.path
	}
	// Validate everything before touching the library.
	var closures []Closure
	for _, g := range got {
		if g.kind != "closures" {
			continue
		}
		b, err := os.ReadFile(g.path)
		if err != nil {
			return res, err
		}
		var c Closure
		if err := json.Unmarshal(b, &c); err != nil || c.Platform != g.platform || closureName(c.Request) != g.name {
			return res, fmt.Errorf("闭包记录 %s 无效", g.name)
		}
		for _, f := range c.Files {
			if SafeFile(f.File) != f.File {
				return res, fmt.Errorf("文件名 %s 不安全", f.File)
			}
			pool, ok := index[g.platform+"/pool/"+f.File]
			mp, mok := index[g.platform+"/meta/"+f.File+".json"]
			if !ok || !mok {
				return res, fmt.Errorf("闭包 %s 需要的 %s 不在包里", c.Request.Key(), f.File)
			}
			sum, size, err := sumFile(pool)
			if err != nil || sum != f.SHA256 || size != f.Size {
				return res, fmt.Errorf("%s 的哈希与记录不符，软件库包已损坏或被改动", f.File)
			}
			var meta Meta
			mb, _ := os.ReadFile(mp)
			if json.Unmarshal(mb, &meta) != nil || meta.SHA256 != sum || meta.File != f.File {
				return res, fmt.Errorf("%s 的元数据无效", f.File)
			}
		}
		closures = append(closures, c)
	}
	if len(closures) == 0 {
		return res, errors.New("软件库包里没有任何软件包")
	}
	seen := map[string]bool{}
	for _, g := range got {
		if g.kind == "closures" {
			continue
		}
		dst := l.pdir(g.platform, g.kind, g.name)
		if g.kind == "pool" {
			if _, err := os.Stat(dst); err == nil {
				have, _, _ := sumFile(dst)
				want, _, _ := sumFile(g.path)
				if have != want {
					return res, fmt.Errorf("软件库里已有同名但内容不同的文件 %s，拒绝覆盖", g.name)
				}
				continue
			}
			res.Files++
		}
		if err := copyFile(g.path, dst); err != nil {
			return res, err
		}
		seen[dst] = true
	}
	for _, c := range closures {
		c.Via = "导入"
		if err := writeJSONAtomic(l.pdir(c.Platform, "closures", closureName(c.Request)), c); err != nil {
			return res, err
		}
		res.Closures++
	}
	return res, nil
}

// Stamp changes whenever closures are added or removed for a platform; it lets callers reuse work done on the library.
func (l *Library) Stamp(platform string) string {
	dir := l.pdir(platform, "closures")
	info, err := os.Stat(dir)
	if err != nil {
		return "none"
	}
	entries, _ := os.ReadDir(dir)
	return fmt.Sprintf("%d-%d", info.ModTime().UnixNano(), len(entries))
}
