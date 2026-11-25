package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"delivery-studio/catalog"
	"delivery-studio/mwpack"
	"delivery-studio/pkglib"
)

// platformConfig says where the platform keeps what generation needs.
type platformConfig struct {
	ComponentsDir string
	ArtifactsDir  string
	LibraryDir    string
	SourcesFile   string
	// Runtimes maps an operating system id to the offline Ansible runtime archive its controller unpacks.
	Runtimes map[string]string
	Docker   string
}

// platform owns what generation needs besides the request: the component catalog, plain offline files, the package
// library with its sources, and the offline Ansible runtimes shipped to controllers.
type platform struct {
	catalog atomic.Pointer[mwpack.Catalog]
	broken  atomic.Pointer[[]brokenComponent]
	cfg     platformConfig
	lib     *pkglib.Library
	sources atomic.Pointer[pkglib.Sources]
	fetcher *pkglib.Fetcher
	idx     *pkglib.Index
	py      *pkglib.PyStore
	mu      sync.Mutex
	hashes  map[string]cachedHash

	componentsDir string
	artifactsDir  string
}

// cat is the catalog currently in force. It is swapped as a whole when components change, so a running
// generation keeps the catalog it started with.
func (p *platform) cat() *mwpack.Catalog { return p.catalog.Load() }

type cachedHash struct {
	size int64
	mod  int64
	sum  string
}

func loadPlatform(cfg platformConfig) (*platform, error) {
	p := &platform{cfg: cfg, componentsDir: cfg.ComponentsDir, artifactsDir: cfg.ArtifactsDir, hashes: map[string]cachedHash{}}
	cat, broken, err := p.load(cfg.ComponentsDir)
	if err != nil {
		return nil, err
	}
	p.catalog.Store(cat)
	p.broken.Store(&broken)
	if cfg.LibraryDir == "" {
		// A platform without a library directory cannot build deliveries that need packages, but can still validate.
		cfg.LibraryDir = filepath.Join(os.TempDir(), "mw-empty-library")
	}
	if p.lib, err = pkglib.Open(cfg.LibraryDir); err != nil {
		return nil, err
	}
	if err = p.reloadSources(); err != nil {
		return nil, err
	}
	p.fetcher = &pkglib.Fetcher{Docker: cfg.Docker, Lib: p.lib, Sources: p.sources.Load()}
	p.idx = pkglib.OpenIndex(cfg.LibraryDir)
	p.py = pkglib.NewPyStore(cfg.LibraryDir)
	p.migrateRuntimes()
	for _, def := range mwpack.Platforms {
		p.idx.Preload(def)
	}
	return p, nil
}

func (p *platform) reloadSources() error {
	s, err := pkglib.LoadSources(p.cfg.SourcesFile)
	if err != nil {
		return err
	}
	p.sources.Store(s)
	if p.fetcher != nil {
		p.fetcher.Sources = s
	}
	return nil
}

// brokenComponent is a custom component that could not be loaded; it is skipped instead of stopping the platform.
type brokenComponent struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// single exposes one top-level directory of a filesystem, so one component can be validated on its own.
type single struct {
	fs.FS
	name string
}

func (s single) ReadDir(name string) ([]fs.DirEntry, error) {
	if name != "." {
		return fs.ReadDir(s.FS, name)
	}
	all, err := fs.ReadDir(s.FS, ".")
	if err != nil {
		return nil, err
	}
	for _, e := range all {
		if e.Name() == s.name {
			return []fs.DirEntry{e}, nil
		}
	}
	return nil, nil
}

// load builds a catalog from the built-in components and the pack directory. A built-in component that fails is a
// fatal error (the program is broken); a custom one is skipped and reported, so one bad pack never stops the platform.
func (p *platform) load(packs string) (*mwpack.Catalog, []brokenComponent, error) {
	if _, err := mwpack.LoadCatalog(catalog.FS); err != nil {
		return nil, nil, err
	}
	sources := []fs.FS{catalog.FS}
	var broken []brokenComponent
	if packs != "" {
		if entries, err := os.ReadDir(packs); err == nil {
			custom := os.DirFS(packs)
			for _, e := range entries {
				if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
					continue
				}
				one := single{custom, e.Name()}
				if _, err := mwpack.LoadCatalog(catalog.FS, one); err != nil {
					msg := err.Error()
					if i := strings.Index(msg, "：\n"); i >= 0 {
						msg = strings.TrimSpace(msg[i+len("：\n"):])
					}
					broken = append(broken, brokenComponent{e.Name(), msg})
					continue
				}
				sources = append(sources, one)
			}
		}
	}
	cat, err := mwpack.LoadCatalog(sources...)
	if err == nil {
		cat, err = p.loadShared(cat)
	}
	return cat, broken, err
}

// reload re-reads the pack directory; on any error the catalog in force stays unchanged.
func (p *platform) reload() error {
	cat, broken, err := p.load(p.componentsDir)
	if err != nil {
		return err
	}
	p.catalog.Store(cat)
	p.broken.Store(&broken)
	return nil
}

// brokenList is the custom components skipped at the last load.
func (p *platform) brokenList() []brokenComponent {
	if b := p.broken.Load(); b != nil {
		return *b
	}
	return nil
}

// runtimeFor is the Ansible runtime archive for an operating system, or "" when there is none.
func (p *platform) runtimeFor(id string) string {
	path := p.cfg.Runtimes[id]
	if path == "" {
		return ""
	}
	if st, err := os.Stat(path); err != nil || !st.Mode().IsRegular() {
		return ""
	}
	return path
}

// artifactInfo reports an offline file with its SHA256, cached by size and modification time.
func (p *platform) artifactInfo(file string) (mwpack.ArtifactInfo, bool) {
	if file == "" || filepath.Base(file) != file || strings.ContainsAny(file, "\\\x00") || p.artifactsDir == "" {
		return mwpack.ArtifactInfo{}, false
	}
	name := filepath.Join(p.artifactsDir, file)
	st, err := os.Lstat(name)
	if err != nil || !st.Mode().IsRegular() {
		return mwpack.ArtifactInfo{}, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok := p.hashes[file]; ok && c.size == st.Size() && c.mod == st.ModTime().UnixNano() {
		return mwpack.ArtifactInfo{File: file, SHA256: c.sum, Size: st.Size()}, true
	}
	f, err := os.Open(name)
	if err != nil {
		return mwpack.ArtifactInfo{}, false
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return mwpack.ArtifactInfo{}, false
	}
	sum := hex.EncodeToString(h.Sum(nil))
	p.hashes[file] = cachedHash{st.Size(), st.ModTime().UnixNano(), sum}
	return mwpack.ArtifactInfo{File: file, SHA256: sum, Size: st.Size()}, true
}

// artifactsFor builds the store view Render needs for the plain files a plan uses.
func (p *platform) artifactsFor(plan *mwpack.Plan) map[string]mwpack.ArtifactInfo {
	out := map[string]mwpack.ArtifactInfo{}
	for _, a := range plan.Artifacts() {
		if info, ok := p.artifactInfo(a.File); ok {
			out[a.File] = info
		}
	}
	return out
}

// readiness lists what stops a plan from being generated for reasons outside the spec: packages the library does
// not have, and operating systems that have no Ansible runtime.
func (p *platform) readiness(plan *mwpack.Plan) []mwpack.Problem {
	if plan.Dep.DeliveryMode == "configuration" {
		return nil
	}
	var out []mwpack.Problem
	if plan.Platform.ID == "" {
		return out
	}
	if !p.runtimeReady(plan.Platform.ID) {
		out = append(out, mwpack.Problem{Severity: "error", Path: "platform", Message: fmt.Sprintf("还没有 %s 的 Ansible 运行环境，暂时不能为它生成交付（控制节点需要它离线安装 Ansible）", plan.Platform.Title)})
	}
	if reqs := plan.Requests(); len(reqs) > 0 {
		if missing := p.lib.Missing(plan.Platform.ID, reqs); len(missing) > 0 {
			var names []string
			for _, m := range missing {
				names = append(names, m.Key())
			}
			out = append(out, mwpack.Problem{Severity: "error", Path: "packages", Message: fmt.Sprintf("软件库里没有 %s（%s）。能联网时到“软件库”页获取；离线时在联网机器上获取后导出，再到“软件库”页导入", strings.Join(names, "、"), plan.Platform.Title)})
		}
	}
	return out
}

// ---- catalog ----

type coverage struct {
	Ready      bool                    `json:"ready"`
	Deployable bool                    `json:"deployable"`
	Missing    []mwpack.PackageRequest `json:"missing,omitempty"`
}

type versionEntry struct {
	mwpack.VerInfo
	// Coverage says, per operating system, whether the library holds the version's (unconditional) packages.
	Coverage map[string]coverage `json:"coverage"`
}

// catalogEntry is a component as the application catalog shows it.
type catalogEntry struct {
	mwpack.Info
	Versions            []versionEntry    `json:"versions"`
	Platform            string            `json:"platform"`
	Available           bool              `json:"available"`
	DeploymentAvailable bool              `json:"deployment_available"`
	Reason              string            `json:"reason,omitempty"`
	Materials           []catalogMaterial `json:"materials"`
	Plans               []catalogPlan     `json:"plans,omitempty"`
}

type catalogMaterial struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Bytes   int64  `json:"bytes"`
	Updated string `json:"updated"`
}

type catalogPlan struct {
	Contract *mwpack.SeriesContract `json:"contract,omitempty"`
	ID       string                 `json:"id"`
	Name     string                 `json:"name"`
	Tag      string                 `json:"tag,omitempty"`
	Spec     string                 `json:"spec,omitempty"`
	Topology []mwpack.RoleCount     `json:"topology"`
	Params   map[string]any         `json:"params,omitempty"`
}

func (p *platform) entries() []catalogEntry { return p.entriesWith(false) }

// entriesWith lists components; includeExternal adds the customer-operated ones the wizard offers as fronts.
func (p *platform) entriesWith(includeExternal bool) []catalogEntry {
	rtReadyCache := map[string]bool{}
	poolCache := map[string]map[string]int64{}
	pkgHasCache := map[string]bool{}
	isRuntimeReady := func(pl string) bool {
		if v, ok := rtReadyCache[pl]; ok {
			return v
		}
		v := p.runtimeReady(pl)
		rtReadyCache[pl] = v
		return v
	}
	missingFor := func(pl string, reqs []mwpack.PackageRequest) []mwpack.PackageRequest {
		if len(reqs) == 0 {
			return nil
		}
		pool, ok := poolCache[pl]
		if !ok {
			pool = p.lib.PoolSizes(pl)
			poolCache[pl] = pool
		}
		var out []mwpack.PackageRequest
		for _, r := range reqs {
			key := pl + "\x00" + r.Key()
			has, seen := pkgHasCache[key]
			if !seen {
				has = p.lib.HasInPool(pl, r, pool)
				pkgHasCache[key] = has
			}
			if !has {
				out = append(out, r)
			}
		}
		return out
	}

	var out []catalogEntry
	for _, info := range p.cat().Infos() {
		// External components (a customer's own load balancer) only make sense as the front of something else.
		if (info.Kind == "external" || info.Context != "") && !includeExternal {
			continue
		}
		e := catalogEntry{Info: info, Materials: []catalogMaterial{}}
		e.Versions = make([]versionEntry, 0, len(info.Versions))
		anyReady := info.Kind == "external"
		var why []string
		for _, v := range info.Versions {
			ve := versionEntry{VerInfo: v, Coverage: map[string]coverage{}}
			for _, pl := range v.Platforms {
				cv := coverage{Deployable: isRuntimeReady(pl)}
				cv.Missing = missingFor(pl, v.Packages[pl])
				cv.Ready = len(cv.Missing) == 0
				ve.Coverage[pl] = cv
				if cv.Ready && cv.Deployable {
					anyReady = true
				} else if v.ID == info.Default {
					if !cv.Deployable {
						why = append(why, pl+" 没有 Ansible 运行环境")
					} else {
						why = append(why, fmt.Sprintf("%s 的软件库缺 %d 个软件包", pl, len(cv.Missing)))
					}
				}
			}
			e.Versions = append(e.Versions, ve)
		}
		e.Available = anyReady
		if !anyReady && len(why) > 0 {
			e.Reason = strings.Join(why, "；")
		}
		e.Platform = "—"
		var titles []string
		for _, v := range info.Versions {
			if v.ID != info.Default {
				continue
			}
			for _, pl := range v.Platforms {
				if def, ok := mwpack.PlatformByID(pl); ok {
					titles = append(titles, def.Title)
				}
			}
		}
		if len(titles) > 0 {
			e.Platform = strings.Join(titles, " / ")
		}
		for _, a := range info.Artifacts {
			st, err := os.Stat(filepath.Join(p.artifactsDir, a.File))
			if p.artifactsDir == "" || err != nil || !st.Mode().IsRegular() {
				e.Available = false
				e.Reason = "离线材料未就绪：" + a.File
				continue
			}
			e.Materials = append(e.Materials, catalogMaterial{"file", a.File, st.Size(), st.ModTime().UTC().Format("2006-01-02T15:04:05Z")})
		}
		e.DeploymentAvailable = e.Available
		for _, mode := range info.DeliveryModes {
			if mode == "configuration" {
				e.Available = true
				e.Reason = ""
			}
		}
		if info.Detail != nil {
			for _, pr := range info.Detail.Presets {
				pr.Name = mwpack.PresetTitle(info.Name, pr.ID, pr.Name)
				if info.Name == "postgresql" && pr.ID == "patroni" {
					pr.Spec = "Patroni 管理主从 · 自动故障切换 · 平台部署 etcd"
				}
				e.Plans = append(e.Plans, catalogPlan{pr.Contract, pr.ID, pr.Name, pr.Tag, pr.Spec, pr.Roles, pr.Params})
			}
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Category+out[i].Title < out[j].Category+out[j].Title })
	return out
}
