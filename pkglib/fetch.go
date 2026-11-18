package pkglib

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// Fetcher prepares the library: it resolves a package's dependencies and downloads them inside a container of the
// target operating system, then stores the result. This is the only place containers and the network are used.
type Fetcher struct {
	Docker  string
	Lib     *Library
	Sources *Sources
	Log     func(string)
}

func (f *Fetcher) docker() string {
	if f.Docker != "" {
		return f.Docker
	}
	return "docker"
}

func (f *Fetcher) log(format string, a ...any) {
	if f.Log != nil {
		f.Log(fmt.Sprintf(format, a...))
	}
}

// Capability says whether packages can be fetched here and why not if they cannot.
type Capability struct {
	Docker bool   `json:"docker"`
	Reason string `json:"reason,omitempty"`
}

func (f *Fetcher) Capability(ctx context.Context) Capability {
	path, err := exec.LookPath(f.docker())
	if err != nil {
		return Capability{Reason: "这台服务器没有安装 Docker：联网获取软件包需要用目标系统的容器解析依赖。离线环境请在联网机器上获取后导入。"}
	}
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(c, path, "info", "--format", "{{.ServerVersion}}").CombinedOutput(); err != nil {
		return Capability{Reason: "Docker 不可用：" + strings.TrimSpace(string(out))}
	}
	return Capability{Docker: true}
}

// ---- running a container job ----

func (f *Fetcher) workDir() (string, error) {
	dir, err := os.MkdirTemp(f.Lib.Dir, ".fetch-")
	if err != nil {
		return "", err
	}
	// apt drops privileges to an unprivileged user that must be able to read the mounted directory.
	return dir, os.Chmod(dir, 0o755)
}

// run executes script in a container of the platform with /work mounted, streaming its output to the log.
func (f *Fetcher) run(ctx context.Context, def mwpack.PlatformDef, work, script string, extra ...string) error {
	if err := os.WriteFile(filepath.Join(work, "run.sh"), []byte(script), 0o755); err != nil {
		return err
	}
	args := []string{"run", "--rm", "-v", work + ":/work:z", "-e", fmt.Sprintf("HOST_UID=%d", os.Getuid()), "-e", fmt.Sprintf("HOST_GID=%d", os.Getgid())}
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"} {
		if v := os.Getenv(k); v != "" {
			args = append(args, "-e", k+"="+v)
		}
	}
	args = append(args, extra...)
	args = append(args, def.Image, "bash", "/work/run.sh")
	cmd := exec.CommandContext(ctx, f.docker(), args...)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	var tail []string
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			f.log("%s", line)
			if tail = append(tail, line); len(tail) > 12 {
				tail = tail[1:]
			}
		}
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("容器内执行失败：%v\n%s", err, strings.Join(tail, "\n"))
	}
	return nil
}

// ---- generated container inputs ----

func (f *Fetcher) prepare(def mwpack.PlatformDef, work string) ([]Source, error) {
	srcs := f.Sources.ForPlatform(def.ID)
	if len(srcs) == 0 {
		return nil, fmt.Errorf("没有适用于 %s 的软件源：请先在“软件源”里添加", def.ID)
	}
	if err := os.MkdirAll(filepath.Join(work, "keys"), 0o755); err != nil {
		return nil, err
	}
	var apt, rpm strings.Builder
	for _, s := range srcs {
		if s.Kind != def.Family {
			return nil, fmt.Errorf("软件源 %s 的类型 %s 与系统 %s 不符", s.ID, s.Kind, def.ID)
		}
		key, err := f.Sources.Key(s.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("软件源 %s 的密钥 %s 不存在：%w", s.ID, s.KeyFile, err)
		}
		if s.KeyFile != "" {
			if err := os.WriteFile(filepath.Join(work, "keys", s.KeyFile), key, 0o644); err != nil {
				return nil, err
			}
		}
		if def.Family == "apt" {
			opt := ""
			if s.KeyFile != "" {
				opt = " [signed-by=/etc/apt/mw-keys/" + s.KeyFile + "]"
			} else {
				return nil, fmt.Errorf("apt 软件源 %s 必须有签名密钥（key_file）：平台只从验证过签名的源取包", s.ID)
			}
			fmt.Fprintf(&apt, "deb%s %s %s %s\n", opt, strings.TrimRight(s.URL, "/"), strings.Join(s.Suites[:1], ""), strings.Join(s.Components, " "))
			for _, suite := range s.Suites[1:] {
				fmt.Fprintf(&apt, "deb%s %s %s %s\n", opt, strings.TrimRight(s.URL, "/"), suite, strings.Join(s.Components, " "))
			}
		} else {
			gpg := "gpgcheck=0"
			if s.KeyFile != "" {
				gpg = "gpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/" + s.KeyFile
			} else {
				return nil, fmt.Errorf("rpm 软件源 %s 必须有签名密钥（key_file）：平台只从验证过签名的源取包", s.ID)
			}
			fmt.Fprintf(&rpm, "[%s]\nname=%s\nbaseurl=%s\nenabled=1\nsslverify=0\nmodule_hotfixes=1\n%s\n\n", s.ID, strings.NewReplacer("\n", " ").Replace(s.Title), s.BaseURL, gpg)
		}
	}
	if def.Family == "apt" {
		return srcs, os.WriteFile(filepath.Join(work, "sources.list"), []byte(apt.String()), 0o644)
	}
	return srcs, os.WriteFile(filepath.Join(work, "mw.repo"), []byte(rpm.String()), 0o644)
}

const aptSetup = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
trap 'chown -R "$HOST_UID:$HOST_GID" /work 2>/dev/null || true; chmod -R u+rwX,go+rX /work 2>/dev/null || true' EXIT
# Signatures are verified through the keys given for each source. TLS peer verification is relaxed only because a
# pristine minimal image has no CA bundle and installing one would change which dependencies count as "already there".
APT=(-o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false -o APT::Install-Recommends=false -o Acquire::Languages=none -o Acquire::Retries=5 -o Acquire::http::Timeout=60 -o Acquire::https::Timeout=60)
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
mkdir -p /etc/apt/mw-keys && cp /work/keys/* /etc/apt/mw-keys/
cp /work/sources.list /etc/apt/sources.list.d/mw.list
apt-get "${APT[@]}" update -qq
`

const rpmSetup = `set -euo pipefail
trap 'chown -R "$HOST_UID:$HOST_GID" /work 2>/dev/null || true; chmod -R u+rwX,go+rX /work 2>/dev/null || true' EXIT
rm -f /etc/yum.repos.d/*.repo
cp /work/mw.repo /etc/yum.repos.d/mw.repo
mkdir -p /etc/pki/rpm-gpg && cp /work/keys/* /etc/pki/rpm-gpg/
for k in /work/keys/*; do rpm --import "$k"; done
dnf -y -q makecache
DNF=(--setopt=retries=10 --setopt=timeout=60)
`

// ---- Fetch ----

var (
	uriRE  = regexp.MustCompile(`^'([^']+)'\s+(\S+)\s+(\d+)\s+(\S+)`)
	verRE  = regexp.MustCompile(`<version epoch="([^"]*)" ver="([^"]*)" rel="([^"]*)"`)
	nameRE = regexp.MustCompile(`<name>([^<]*)</name>`)
	archRE = regexp.MustCompile(`<arch>([^<]*)</arch>`)
	sumRE  = regexp.MustCompile(`<checksum type="sha256" pkgid="YES">([0-9a-f]{64})</checksum>`)
	hrefRE = regexp.MustCompile(`<location href="([^"]*)"`)
	pkgRE  = regexp.MustCompile(`(?s)<package[ >].*?</package>`)
	pidRE  = regexp.MustCompile(`pkgid="([0-9a-f]{64})"`)
)

// ValidRequest checks a package name and version are plain package identifiers, safe to pass to a package manager.
func ValidRequest(r mwpack.PackageRequest) error { return validRequest(r) }

func validRequest(r mwpack.PackageRequest) error {
	ok := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]*$`)
	ver := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+~:_-]*$`)
	if !ok.MatchString(r.Name) || !ver.MatchString(r.Version) {
		return fmt.Errorf("软件包 %q 的名称或版本含有不允许的字符", r.Key())
	}
	return nil
}

// Fetch resolves and downloads the requests for a platform and stores their closures in the library.
func (f *Fetcher) Fetch(ctx context.Context, def mwpack.PlatformDef, reqs []mwpack.PackageRequest) error {
	if len(reqs) == 0 {
		return errors.New("没有要获取的软件包")
	}
	for _, r := range reqs {
		if err := validRequest(r); err != nil {
			return err
		}
	}
	work, err := f.workDir()
	if err != nil {
		return err
	}
	if os.Getenv("MW_KEEP_WORK") == "" {
		defer os.RemoveAll(work)
	}
	srcs, err := f.prepare(def, work)
	if err != nil {
		return err
	}
	var ids []string
	for _, s := range srcs {
		ids = append(ids, s.ID)
	}
	var specs strings.Builder
	for _, r := range reqs {
		specs.WriteString(mwpack.PackageSpec(def.Family, r.Name, r.Version) + "\n")
	}
	if err := os.WriteFile(filepath.Join(work, "requests.txt"), []byte(specs.String()), 0o644); err != nil {
		return err
	}
	f.log("在 %s 容器里解析并下载 %d 个软件包（软件源：%s）", def.Image, len(reqs), strings.Join(ids, "、"))
	var script string
	if def.Family == "apt" {
		script = aptSetup + `mkdir -p /work/out/uris /work/out/pool
i=0
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  i=$((i+1))
  echo "== $spec"
  echo "$spec" > /work/out/uris/$i.req
  # --print-uris leaves out files already in the cache, so each request starts from an empty cache: its closure
  # must be complete on its own, whatever was fetched before it.
  rm -f /var/cache/apt/archives/*.deb
  apt-get "${APT[@]}" install -y --print-uris "$spec" | grep "^'" > /work/out/uris/$i.txt || { echo "无法解析 $spec：源里没有这个版本，或它已经包含在基础系统中" >&2; exit 3; }
  ok=0
  for try in 1 2 3; do
    if apt-get "${APT[@]}" install -y --download-only "$spec" >/dev/null; then ok=1; break; fi
    echo "下载失败，第 $try 次重试……" >&2; sleep $((try*5))
  done
  [ $ok = 1 ] || { echo "下载 $spec 失败" >&2; exit 5; }
  for f in /var/cache/apt/archives/*.deb; do
    b=$(basename "$f")
    [ -e "/work/out/pool/$b" ] || { cp "$f" /work/out/pool/; dpkg-deb -f "$f" > "/work/out/pool/$b.control"; }
  done
  # Only a request that is completely downloaded is stored; the others are simply fetched again next time.
  touch /work/out/uris/$i.done
done < /work/requests.txt
`
	} else {
		script = rpmSetup + `mkdir -p /work/out/dl
i=0
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  i=$((i+1))
  echo "== $spec"
  echo "$spec" > /work/out/dl/$i.req
  dnf -y "${DNF[@]}" install --downloadonly --setopt=install_weak_deps=False --downloaddir=/work/out/dl/$i "$spec"
  # dnf clears download directories after the next real transaction (installing createrepo_c below), so list now.
  (cd /work/out/dl/$i && ls *.rpm) > /work/out/dl/$i.list
done < /work/requests.txt
mkdir -p /work/out/pool
for f in /work/out/dl/*/*.rpm; do [ -e "/work/out/pool/$(basename "$f")" ] || cp "$f" /work/out/pool/; done
rpmkeys --checksig /work/out/pool/*.rpm | tee /work/out/checksig.txt
if grep -v 'digests signatures OK' /work/out/checksig.txt | grep -q .; then echo "有软件包签名校验未通过" >&2; exit 4; fi
dnf -y -q install --setopt=install_weak_deps=False createrepo_c
createrepo_c --no-database --simple-md-filenames /work/out/pool
`
	}
	runErr := f.run(ctx, def, work, script)
	out := filepath.Join(work, "out")
	if runErr != nil && def.Family != "apt" {
		return runErr
	}
	var closures []Closure
	var metas []Meta
	if def.Family == "apt" {
		closures, metas, err = parseApt(def, out, ids)
	} else {
		closures, metas, err = parseRpm(def, out, ids)
	}
	if err != nil {
		if runErr != nil {
			return runErr
		}
		return err
	}
	for _, c := range closures {
		f.log("入库 %s：%d 个文件", c.Request.Key(), len(c.Files))
		if err := f.Lib.Put(c, metas, func(file string) string { return filepath.Join(out, "pool", file) }); err != nil {
			return err
		}
	}
	if runErr != nil {
		return fmt.Errorf("已入库 %d 个，其余没有完成，可以再点一次获取（已有的会跳过）：%w", len(closures), runErr)
	}
	return nil
}

func controlField(control, key string) string {
	for _, l := range strings.Split(control, "\n") {
		if strings.HasPrefix(l, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(l, key+":"))
		}
	}
	return ""
}

func parseApt(def mwpack.PlatformDef, out string, srcIDs []string) ([]Closure, []Meta, error) {
	var metas []Meta
	byName := map[string]Meta{}
	pool, _ := filepath.Glob(filepath.Join(out, "pool", "*.deb"))
	for _, p := range pool {
		b, err := os.ReadFile(p + ".control")
		if err != nil {
			continue // a download that was cut short; its request is not marked done
		}
		c := strings.TrimRight(string(b), "\n")
		m := Meta{File: filepath.Base(p), Name: controlField(c, "Package"), Version: controlField(c, "Version"), Arch: controlField(c, "Architecture"), Control: c}
		if m.Name == "" || m.Version == "" {
			return nil, nil, fmt.Errorf("%s 的控制信息不完整", m.File)
		}
		metas = append(metas, m)
		byName[m.File] = m
	}
	reqs, _ := filepath.Glob(filepath.Join(out, "uris", "*.req"))
	sort.Strings(reqs)
	var closures []Closure
	for _, rf := range reqs {
		if _, err := os.Stat(strings.TrimSuffix(rf, ".req") + ".done"); err != nil {
			continue // not completely downloaded
		}
		spec, _ := os.ReadFile(rf)
		name, ver, _ := strings.Cut(strings.TrimSpace(string(spec)), "=")
		uris, err := os.ReadFile(strings.TrimSuffix(rf, ".req") + ".txt")
		if err != nil {
			return nil, nil, err
		}
		c := Closure{Request: mwpack.PackageRequest{Name: name, Version: ver}, Platform: def.ID, Via: "容器 " + def.Image, Sources: srcIDs, Fetched: time.Now().UTC().Format(time.RFC3339)}
		for _, line := range strings.Split(string(uris), "\n") {
			m := uriRE.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			meta, ok := byName[m[2]]
			if !ok {
				return nil, nil, fmt.Errorf("下载结果里没有 %s", m[2])
			}
			// apt reports whichever digest the index carries; only a SHA256 can be compared with ours.
			sum := ""
			if strings.HasPrefix(m[4], "SHA256:") {
				sum = strings.TrimPrefix(m[4], "SHA256:")
			}
			c.Files = append(c.Files, FileRef{File: m[2], SHA256: sum})
			c.Packages = append(c.Packages, PkgRef{meta.Name, meta.Version})
		}
		if len(c.Files) == 0 {
			return nil, nil, fmt.Errorf("%s 没有解析出任何文件", c.Request.Key())
		}
		// the requested package itself must be in its own closure at exactly the requested version
		found := false
		for _, p := range c.Packages {
			found = found || (p.Name == name && p.Version == ver)
		}
		if !found {
			return nil, nil, fmt.Errorf("解析 %s 时没有得到这个确切版本", c.Request.Key())
		}
		closures = append(closures, c)
	}
	return closures, metas, nil
}

func readGz(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	b, err := io.ReadAll(gz)
	return string(b), err
}

func parseRpm(def mwpack.PlatformDef, out string, srcIDs []string) ([]Closure, []Meta, error) {
	repodata := filepath.Join(out, "pool", "repodata")
	read := func(kind string) (string, error) {
		m, _ := filepath.Glob(filepath.Join(repodata, "*"+kind+".xml.gz"))
		if len(m) != 1 {
			return "", fmt.Errorf("没有生成 %s 元数据", kind)
		}
		return readGz(m[0])
	}
	prim, err := read("primary")
	if err != nil {
		return nil, nil, err
	}
	fl, err := read("filelists")
	if err != nil {
		return nil, nil, err
	}
	ot, err := read("other")
	if err != nil {
		return nil, nil, err
	}
	byID := func(doc string) map[string]string {
		m := map[string]string{}
		for _, blk := range pkgRE.FindAllString(doc, -1) {
			if id := pidRE.FindStringSubmatch(blk); id != nil {
				m[id[1]] = blk
			}
		}
		return m
	}
	flBy, otBy := byID(fl), byID(ot)
	var metas []Meta
	byFile := map[string]Meta{}
	for _, blk := range pkgRE.FindAllString(prim, -1) {
		sum := sumRE.FindStringSubmatch(blk)
		href := hrefRE.FindStringSubmatch(blk)
		nm, ar, vr := nameRE.FindStringSubmatch(blk), archRE.FindStringSubmatch(blk), verRE.FindStringSubmatch(blk)
		if sum == nil || href == nil || nm == nil || ar == nil || vr == nil {
			return nil, nil, errors.New("仓库元数据格式无法识别")
		}
		ver := vr[2] + "-" + vr[3]
		if vr[1] != "" && vr[1] != "0" {
			ver = vr[1] + ":" + ver
		}
		m := Meta{File: filepath.Base(href[1]), Name: nm[1], Version: ver, Arch: ar[1], Primary: blk, Filelists: flBy[sum[1]], Other: otBy[sum[1]]}
		if m.Filelists == "" || m.Other == "" {
			return nil, nil, fmt.Errorf("%s 缺少 filelists/other 元数据", m.File)
		}
		metas = append(metas, m)
		byFile[m.File] = m
	}
	reqs, _ := filepath.Glob(filepath.Join(out, "dl", "*.req"))
	sort.Strings(reqs)
	var closures []Closure
	for _, rf := range reqs {
		spec, _ := os.ReadFile(rf)
		full := strings.TrimSpace(string(spec))
		c := Closure{Platform: def.ID, Via: "容器 " + def.Image, Sources: srcIDs, Fetched: time.Now().UTC().Format(time.RFC3339)}
		list, err := os.ReadFile(strings.TrimSuffix(rf, ".req") + ".list")
		if err != nil {
			return nil, nil, err
		}
		for _, name := range strings.Fields(string(list)) {
			m, ok := byFile[name]
			if !ok {
				return nil, nil, fmt.Errorf("元数据里没有 %s", name)
			}
			c.Files = append(c.Files, FileRef{File: m.File})
			c.Packages = append(c.Packages, PkgRef{m.Name, m.Version})
		}
		// The requested package is the one whose name-version-release is the spec; an epoch may or may not be written
		// (dnf accepts both), and the library keeps the request exactly as the component manifest spells it.
		for _, p := range c.Packages {
			bare := p.Version
			if i := strings.Index(bare, ":"); i >= 0 {
				bare = bare[i+1:]
			}
			if full == p.Name+"-"+p.Version || full == p.Name+"-"+bare {
				c.Request = mwpack.PackageRequest{Name: p.Name, Version: strings.TrimPrefix(full, p.Name+"-")}
			}
		}
		if c.Request.Name == "" {
			return nil, nil, fmt.Errorf("解析 %s 时没有得到这个确切版本", full)
		}
		closures = append(closures, c)
	}
	return closures, metas, nil
}

// ---- Versions ----

// Versions lists the versions of a package the platform's sources currently offer, newest first.
func (f *Fetcher) Versions(ctx context.Context, def mwpack.PlatformDef, name string) ([]string, error) {
	if err := validRequest(mwpack.PackageRequest{Name: name, Version: "0"}); err != nil {
		return nil, err
	}
	work, err := f.workDir()
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	if _, err := f.prepare(def, work); err != nil {
		return nil, err
	}
	var script string
	if def.Family == "apt" {
		script = aptSetup + `mkdir -p /work/out
apt-cache madison '` + name + `' | awk -F'|' '{gsub(/ /,"",$2); print $2}' > /work/out/versions.txt
`
	} else {
		script = rpmSetup + `mkdir -p /work/out
dnf -q repoquery --showduplicates --qf '%{epoch}:%{version}-%{release}' '` + name + `' | sed 's/^0://' > /work/out/versions.txt
`
	}
	if err := f.run(ctx, def, work, script); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(work, "out", "versions.txt"))
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	for _, v := range strings.Fields(string(b)) {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("软件源里没有 %s", name)
	}
	sort.SliceStable(out, func(i, j int) bool { return compareVersions(out[i], out[j]) > 0 })
	return out, nil
}

var chunkRE = regexp.MustCompile(`[0-9]+|[A-Za-z]+`)

// compareVersions orders version strings the way people expect (numbers numerically, letters alphabetically). It is
// only used to order a list for display; the package manager decides what is actually newer.
func compareVersions(a, b string) int {
	x, y := chunkRE.FindAllString(a, -1), chunkRE.FindAllString(b, -1)
	for i := 0; i < len(x) && i < len(y); i++ {
		xn, xe := strconv.Atoi(x[i])
		yn, ye := strconv.Atoi(y[i])
		switch {
		case xe == nil && ye == nil:
			if xn != yn {
				if xn < yn {
					return -1
				}
				return 1
			}
		case xe == nil:
			return 1
		case ye == nil:
			return -1
		default:
			if c := strings.Compare(x[i], y[i]); c != 0 {
				return c
			}
		}
	}
	return len(x) - len(y)
}

// VerifyInstall proves an assembled repository is complete: in a clean container of the platform with NO network it
// installs the given packages using nothing but that repository.
func (f *Fetcher) VerifyInstall(ctx context.Context, def mwpack.PlatformDef, repoArchive string, reqs []mwpack.PackageRequest) error {
	work, err := f.workDir()
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	if err := untar(repoArchive, work); err != nil {
		return err
	}
	var specs, names []string
	for _, r := range reqs {
		if err := validRequest(r); err != nil {
			return err
		}
		specs = append(specs, "'"+mwpack.PackageSpec(def.Family, r.Name, r.Version)+"'")
		names = append(names, "'"+r.Name+"'")
	}
	var script string
	if def.Family == "apt" {
		script = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
trap 'chown -R "$HOST_UID:$HOST_GID" /work 2>/dev/null || true' EXIT
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
echo 'deb [trusted=yes] file:/work/repo ./' > /etc/apt/sources.list.d/mw.list
apt-get update -qq
apt-get install -y --no-install-recommends ` + strings.Join(specs, " ") + `
dpkg-query -W ` + strings.Join(names, " ") + `
`
	} else {
		script = `set -euo pipefail
trap 'chown -R "$HOST_UID:$HOST_GID" /work 2>/dev/null || true' EXIT
rm -f /etc/yum.repos.d/*.repo
printf '[mw]\nname=mw\nbaseurl=file:///work/repo\nenabled=1\ngpgcheck=0\nmodule_hotfixes=1\n' > /etc/yum.repos.d/mw.repo
dnf -y --setopt=install_weak_deps=False install ` + strings.Join(specs, " ") + `
rpm -q ` + strings.Join(names, " ") + `
`
	}
	f.log("在没有网络的干净 %s 容器里，只用这个仓库安装 %d 个软件包……", def.Image, len(reqs))
	return f.run(ctx, def, work, script, "--network", "none")
}

func untar(archive, dest string) error {
	in, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer in.Close()
	gz, err := gzip.NewReader(in)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(h.Name)
		if strings.HasPrefix(name, "..") || filepath.IsAbs(name) {
			return fmt.Errorf("仓库包含不安全的路径 %s", h.Name)
		}
		target := filepath.Join(dest, name)
		if h.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if h.Typeflag != tar.TypeReg {
			return fmt.Errorf("仓库包含非普通文件 %s", h.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		out.Close()
	}
}
