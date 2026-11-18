package pkglib

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// assemblerVersion changes whenever the layout or index format of an assembled repository changes, so cached
// repositories built by an older assembler are not reused.
const assemblerVersion = "1"

// RepoArchive is an assembled repository: a tar.gz holding repo/ with the package files, the index and a marker.
type RepoArchive struct {
	Path   string
	File   string
	SHA256 string
	Size   int64
	Files  int
}

var fixedTime = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)

type repoFile struct {
	ref  FileRef
	meta Meta
	path string
}

// collect gathers the union of the closures' files, checking that the library really has them.
func (l *Library) collect(platform string, reqs []mwpack.PackageRequest) ([]repoFile, error) {
	byFile := map[string]repoFile{}
	for _, r := range reqs {
		c, err := l.Get(platform, r)
		if err != nil {
			return nil, fmt.Errorf("软件库没有 %s（%s）：请先在“软件库”页获取或导入", r.Key(), platform)
		}
		for _, f := range c.Files {
			if prev, ok := byFile[f.File]; ok {
				if prev.ref.SHA256 != f.SHA256 {
					return nil, fmt.Errorf("软件库里 %s 有两个不同内容的版本", f.File)
				}
				continue
			}
			m, err := l.meta(platform, f.File)
			if err != nil {
				return nil, fmt.Errorf("软件库缺少 %s 的元数据", f.File)
			}
			byFile[f.File] = repoFile{ref: f, meta: m, path: l.pdir(platform, "pool", f.File)}
		}
	}
	out := make([]repoFile, 0, len(byFile))
	for _, f := range byFile {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ref.File < out[j].ref.File })
	return out, nil
}

// Assemble builds (or reuses) the offline repository for the requests. It needs no network and no containers.
func (l *Library) Assemble(def mwpack.PlatformDef, reqs []mwpack.PackageRequest) (*RepoArchive, error) {
	if len(reqs) == 0 {
		return nil, errors.New("没有需要的软件包")
	}
	files, err := l.collect(def.ID, reqs)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%s\n", assemblerVersion, def.Family, def.ID)
	for _, f := range files {
		fmt.Fprintf(h, "%s %s\n", f.ref.File, f.ref.SHA256)
	}
	key := hex.EncodeToString(h.Sum(nil))[:24]
	dir := filepath.Join(l.Dir, "built")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	final := filepath.Join(dir, key+".tar.gz")
	name := mwpack.RepoFileName(def.ID)
	if st, err := os.Stat(final); err == nil {
		sum, size, err := sumFile(final)
		if err == nil && size == st.Size() {
			return &RepoArchive{Path: final, File: name, SHA256: sum, Size: size, Files: len(files)}, nil
		}
	}
	tmp, err := os.CreateTemp(dir, ".build-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	hash := sha256.New()
	counted := &countWriter{}
	gz, _ := gzip.NewWriterLevel(io.MultiWriter(tmp, hash, counted), gzip.BestSpeed)
	tw := tar.NewWriter(gz)
	put := func(name string, data []byte) error {
		if err := tw.WriteHeader(&tar.Header{Name: "repo/" + name, Mode: 0o644, Size: int64(len(data)), ModTime: fixedTime, Typeflag: tar.TypeReg, Uname: "root", Gname: "root"}); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "repo/", Mode: 0o755, ModTime: fixedTime, Typeflag: tar.TypeDir, Uname: "root", Gname: "root"}); err != nil {
		return nil, err
	}
	switch def.Family {
	case "apt":
		err = l.writeApt(tw, put, files)
	case "rpm":
		err = l.writeRpm(tw, put, files)
	default:
		err = fmt.Errorf("不支持的软件包类型 %q", def.Family)
	}
	if err == nil {
		err = put(".mw-repo", []byte(fmt.Sprintf("Middleware Hub package repository\nplatform: %s\nkey: %s\n", def.ID, key)))
	}
	for _, c := range []func() error{tw.Close, gz.Close, tmp.Close} {
		if e := c(); err == nil {
			err = e
		}
	}
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return nil, err
	}
	_ = os.Chmod(final, 0o600)
	return &RepoArchive{Path: final, File: name, SHA256: hex.EncodeToString(hash.Sum(nil)), Size: counted.n, Files: len(files)}, nil
}

type countWriter struct{ n int64 }

func (c *countWriter) Write(p []byte) (int, error) { c.n += int64(len(p)); return len(p), nil }

// writeFile streams a pool file into the archive while verifying it against the library's record.
func writeFile(tw *tar.Writer, f repoFile) (md5sum string, err error) {
	in, err := os.Open(f.path)
	if err != nil {
		return "", fmt.Errorf("读取 %s：%w", f.ref.File, err)
	}
	defer in.Close()
	if err := tw.WriteHeader(&tar.Header{Name: "repo/" + f.ref.File, Mode: 0o644, Size: f.ref.Size, ModTime: fixedTime, Typeflag: tar.TypeReg, Uname: "root", Gname: "root"}); err != nil {
		return "", err
	}
	s, m := sha256.New(), md5.New()
	n, err := io.Copy(io.MultiWriter(tw, s, m), in)
	if err != nil {
		return "", err
	}
	if n != f.ref.Size || hex.EncodeToString(s.Sum(nil)) != f.ref.SHA256 {
		return "", fmt.Errorf("软件库里的 %s 已损坏（大小或哈希与记录不符），请重新获取", f.ref.File)
	}
	return hex.EncodeToString(m.Sum(nil)), nil
}

func (l *Library) writeApt(tw *tar.Writer, put func(string, []byte) error, files []repoFile) error {
	type stanza struct{ name, version, text string }
	var stanzas []stanza
	for _, f := range files {
		if !strings.HasSuffix(f.ref.File, ".deb") {
			return fmt.Errorf("%s 不是 .deb 文件", f.ref.File)
		}
		if strings.TrimSpace(f.meta.Control) == "" {
			return fmt.Errorf("%s 缺少控制信息，无法写入索引", f.ref.File)
		}
		md5sum, err := writeFile(tw, f)
		if err != nil {
			return err
		}
		var b strings.Builder
		for _, line := range strings.Split(strings.TrimRight(f.meta.Control, "\n"), "\n") {
			key := strings.SplitN(line, ":", 2)[0]
			switch key {
			case "Filename", "Size", "MD5sum", "SHA1", "SHA256", "SHA512":
				continue
			}
			b.WriteString(line + "\n")
		}
		fmt.Fprintf(&b, "Filename: ./%s\nSize: %d\nMD5sum: %s\nSHA256: %s\n", f.ref.File, f.ref.Size, md5sum, f.ref.SHA256)
		stanzas = append(stanzas, stanza{f.meta.Name, f.meta.Version, b.String()})
	}
	sort.SliceStable(stanzas, func(i, j int) bool {
		if stanzas[i].name != stanzas[j].name {
			return stanzas[i].name < stanzas[j].name
		}
		return stanzas[i].version < stanzas[j].version
	})
	var pkgs bytes.Buffer
	for _, s := range stanzas {
		pkgs.WriteString(s.text + "\n")
	}
	if err := put("Packages", pkgs.Bytes()); err != nil {
		return err
	}
	sum := sha256.Sum256(pkgs.Bytes())
	release := fmt.Sprintf("Origin: Middleware Hub\nLabel: middleware-hub\nSuite: stable\nCodename: mw\nDate: Wed, 01 Jan 2020 00:00:00 UTC\nArchitectures: amd64 all\nComponents: main\nDescription: Offline package repository assembled by Middleware Hub\nSHA256:\n %s %d Packages\n", hex.EncodeToString(sum[:]), pkgs.Len())
	return put("Release", []byte(release))
}
