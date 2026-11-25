package server

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// A first deployment that has not been carried out may be changed: someone finds a wrong address or parameter before
// (or while) working through it. The change is a new delivery that replaces it. Nothing is edited in place: the new one
// is generated like any other, the old one is voided when that succeeds, and the difference between the two is what
// the new delivery's page shows.

// jobRef is the short form of a delivery shown in a revision chain.
type jobRef struct {
	DeliveryMode string `json:"delivery_mode,omitempty"`
	ID           string `json:"id"`
	ClusterID    string `json:"cluster_id"`
	AppName      string `json:"app_name"`
	Version      string `json:"version"`
	State        string `json:"state"`
	Outcome      string `json:"outcome,omitempty"`
	Created      string `json:"created"`
}

func refOf(j storeJob) jobRef {
	return jobRef{j.DeliveryMode, j.ID, j.ClusterID, j.AppName, j.Version, j.State, j.Outcome, j.Created}
}

// Change is one line of the difference between a source delivery and the revision made from it.
type Change struct {
	Area  string `json:"area"` // host, instance, version, placement, param, package
	Op    string `json:"op"`   // add, remove, change
	Label string `json:"label"`
	From  string `json:"from,omitempty"`
	To    string `json:"to,omitempty"`
}

type lineage struct {
	Source     *jobRef  `json:"source,omitempty"`
	Children   []jobRef `json:"children,omitempty"`
	Changes    []Change `json:"changes,omitempty"`
	Revision   bool     `json:"revision,omitempty"`
	SourceGone bool     `json:"source_gone,omitempty"`
}

// lineageOf describes which earlier first deployment a revision replaced, and what replaced it. The caller holds no lock.
func (s *storeServer) lineageOf(j storeJob) *lineage {
	s.mu.Lock()
	var children []jobRef
	from := j.Revises
	src, haveSrc := s.jobs[from]
	for _, o := range s.jobs {
		if o.ID != j.ID && o.Revises == j.ID {
			children = append(children, refOf(o))
		}
	}
	s.mu.Unlock()
	if from == "" && len(children) == 0 {
		return nil
	}
	sort.Slice(children, func(a, b int) bool { return children[a].Created < children[b].Created })
	l := &lineage{Children: children, Revision: j.Revises != ""}
	if from != "" {
		if haveSrc {
			r := refOf(src)
			l.Source = &r
			l.Changes = s.specChanges(src.ID, j.ID)
		} else {
			l.SourceGone = true
		}
	}
	return l
}

func (s *storeServer) readSpec(id string) *mwpack.Deployment {
	path := filepath.Join(s.jobDir(id), "deployment.yml")
	st, statErr := os.Stat(path)
	if statErr != nil {
		return nil
	}
	mod := st.ModTime().UnixNano()
	sz := st.Size()

	s.cacheMu.RLock()
	if hit, ok := s.specCache[id]; ok && hit.modTime == mod && hit.size == sz {
		s.cacheMu.RUnlock()
		return hit.dep
	}
	s.cacheMu.RUnlock()

	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	d, err := mwpack.ParseSavedDeployment(b)
	if err != nil {
		return nil
	}

	s.cacheMu.Lock()
	if s.specCache == nil {
		s.specCache = map[string]cachedJobSpec{}
	}
	s.specCache[id] = cachedJobSpec{modTime: mod, size: sz, dep: d}
	s.cacheMu.Unlock()
	return d
}

func show(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []string:
		return fmt.Sprint(x)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// specChanges compares the two submitted specifications, then the package lists the deliveries would install.
func (s *storeServer) specChanges(from, to string) []Change {
	a, b := s.readSpec(from), s.readSpec(to)
	var out []Change
	if a != nil && b != nil {
		var lock struct {
			Instances []struct{ ID, Component, Version string }
		}
		if raw, err := os.ReadFile(filepath.Join(s.jobDir(from), "output", "deployment.lock.json")); err == nil && json.Unmarshal(raw, &lock) == nil {
			cp := *a
			cp.Instances = append([]mwpack.InstanceSpec{}, a.Instances...)
			for _, li := range lock.Instances {
				have := false
				for _, x := range a.Instances {
					have = have || x.ID == li.ID
				}
				if have {
					continue
				}
				for _, x := range b.Instances {
					if x.ID == li.ID && x.Component == li.Component {
						cp.Instances = append(cp.Instances, mwpack.InstanceSpec{ID: li.ID, Component: li.Component, Version: li.Version, Placement: x.Placement})
					}
				}
			}
			a = &cp
		}
		out = append(out, specDiff(a, b)...)
	}
	return append(out, s.packageChanges(from, to)...)
}

func specDiff(a, b *mwpack.Deployment) []Change {
	var out []Change
	if a.Platform != b.Platform {
		out = append(out, Change{"instance", "change", "系统平台", a.Platform, b.Platform})
	}
	hosts := map[string]mwpack.Host{}
	for _, h := range a.Hosts {
		hosts[h.Name] = h
	}
	seen := map[string]bool{}
	for _, h := range b.Hosts {
		seen[h.Name] = true
		old, ok := hosts[h.Name]
		switch {
		case !ok:
			out = append(out, Change{"host", "add", "机器 " + h.Name, "", h.IP})
		case old.IP != h.IP:
			out = append(out, Change{"host", "change", "机器 " + h.Name + " 的 IP", old.IP, h.IP})
		case !reflect.DeepEqual(old.Params, h.Params):
			out = append(out, Change{"host", "change", "机器 " + h.Name + " 的公共参数", fmt.Sprint(old.Params), fmt.Sprint(h.Params)})
		case old.Disk != h.Disk || old.Partition != h.Partition:
			out = append(out, Change{"host", "change", "机器 " + h.Name + " 的数据盘", old.Disk, h.Disk})
		}
	}
	for _, h := range a.Hosts {
		if !seen[h.Name] {
			out = append(out, Change{"host", "remove", "机器 " + h.Name, h.IP, ""})
		}
	}
	insts := map[string]mwpack.InstanceSpec{}
	for _, i := range a.Instances {
		insts[i.ID] = i
	}
	seen = map[string]bool{}
	for _, i := range b.Instances {
		seen[i.ID] = true
		old, ok := insts[i.ID]
		if !ok {
			out = append(out, Change{"instance", "add", "实例 " + i.ID, "", i.Component + " " + i.Version})
			continue
		}
		if old.Version != i.Version {
			out = append(out, Change{"version", "change", i.ID + " 的版本", old.Version, i.Version})
		}
		roles := map[string]bool{}
		for r := range old.Placement {
			roles[r] = true
		}
		for r := range i.Placement {
			roles[r] = true
		}
		names := make([]string, 0, len(roles))
		for r := range roles {
			names = append(names, r)
		}
		sort.Strings(names)
		for _, r := range names {
			x, y := old.Placement[r], i.Placement[r]
			if !reflect.DeepEqual(x, y) && !(len(x) == 0 && len(y) == 0) {
				out = append(out, Change{"placement", "change", i.ID + " · " + r + " 所在机器", show(x), show(y)})
			}
		}
		bindOf := func(l []mwpack.BindSpec) map[string]string {
			m := map[string]string{}
			for _, b := range l {
				m[b.Endpoint] = fmt.Sprint(b.Listen)
			}
			return m
		}
		ob, nb := bindOf(old.Binds), bindOf(i.Binds)
		for e, v := range nb {
			if ob[e] != v {
				out = append(out, Change{"param", "change", i.ID + " · 代理 " + e + " 的监听端口", ob[e], v})
			}
		}
		addonSet := func(l []mwpack.AddonSel) map[string]bool {
			m := map[string]bool{}
			for _, x := range l {
				m[x.ID+" "+strings.Join(x.Databases, ",")] = true
			}
			return m
		}
		oa, na := addonSet(old.Addons), addonSet(i.Addons)
		for k := range na {
			if !oa[k] {
				out = append(out, Change{"param", "add", i.ID + " · 扩展 " + strings.TrimSpace(k), "", "安装"})
			}
		}
		for k := range oa {
			if !na[k] {
				out = append(out, Change{"param", "remove", i.ID + " · 扩展 " + strings.TrimSpace(k), "已装", ""})
			}
		}
		keys := map[string]bool{}
		for k := range old.Params {
			keys[k] = true
		}
		for k := range i.Params {
			keys[k] = true
		}
		pk := make([]string, 0, len(keys))
		for k := range keys {
			pk = append(pk, k)
		}
		sort.Strings(pk)
		for _, k := range pk {
			x, hx := old.Params[k]
			y, hy := i.Params[k]
			if hx && hy && reflect.DeepEqual(x, y) {
				continue
			}
			op := "change"
			if !hx {
				op = "add"
			} else if !hy {
				op = "remove"
			}
			out = append(out, Change{"param", op, i.ID + " · " + k, show(x), show(y)})
		}
	}
	for _, i := range a.Instances {
		if !seen[i.ID] {
			out = append(out, Change{"instance", "remove", "实例 " + i.ID, i.Component + " " + i.Version, ""})
		}
	}
	return out
}

// lockPackages reads name -> versions from a delivery's package lock; empty when the lock is missing.
func (s *storeServer) lockPackages(id string) map[string][]string {
	b, err := os.ReadFile(filepath.Join(s.jobDir(id), "output", "deployment.lock.json"))
	if err != nil {
		return nil
	}
	var lock struct {
		Instances []struct {
			Packages []struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"packages"`
		} `json:"instances"`
	}
	if json.Unmarshal(b, &lock) != nil {
		return nil
	}
	out := map[string][]string{}
	for _, i := range lock.Instances {
		for _, p := range i.Packages {
			dup := false
			for _, v := range out[p.Name] {
				dup = dup || v == p.Version
			}
			if !dup {
				out[p.Name] = append(out[p.Name], p.Version)
			}
		}
	}
	for _, v := range out {
		sort.Strings(v)
	}
	return out
}

func (s *storeServer) packageChanges(from, to string) []Change {
	a, b := s.lockPackages(from), s.lockPackages(to)
	if a == nil || b == nil {
		return nil
	}
	names := map[string]bool{}
	for n := range a {
		names[n] = true
	}
	for n := range b {
		names[n] = true
	}
	list := make([]string, 0, len(names))
	for n := range names {
		list = append(list, n)
	}
	sort.Strings(list)
	var out []Change
	for _, n := range list {
		x, hx := a[n]
		y, hy := b[n]
		switch {
		case hx && hy && reflect.DeepEqual(x, y):
		case !hx:
			out = append(out, Change{"package", "add", n, "", show(y)})
		case !hy:
			out = append(out, Change{"package", "remove", n, show(x), ""})
		default:
			out = append(out, Change{"package", "change", n, show(x), show(y)})
		}
	}
	return out
}

// extractProjectFileRel matches "middleware-automation/projects/<project>/files/<rel>" inside a
// delivery tarball, accepting both the bare cluster ID and versioned change project directories
// such as "<clusterID>.01", "<clusterID>.02", etc.
func extractProjectFileRel(tarPath, clusterID string) (string, bool) {
	name := strings.TrimPrefix(filepath.ToSlash(tarPath), "./")
	const rootPrefix = "middleware-automation/projects/"
	after, ok := strings.CutPrefix(name, rootPrefix)
	if !ok {
		return "", false
	}
	idx := strings.Index(after, "/files/")
	if idx <= 0 {
		return "", false
	}
	proj := after[:idx]
	rest := after[idx+len("/files/"):]
	if rest == "" {
		return "", false
	}
	if clusterID != "" && proj != clusterID && !strings.HasPrefix(proj, clusterID+".") {
		return "", false
	}
	return rest, true
}

// sourceCertificates are the certificate files a delivery carries, by instance/input/file, read from its controller
// package. They were checked when that delivery was made.
func (s *storeServer) sourceCertificates(id string) map[string][]byte {
	out := map[string][]byte{}
	s.mu.Lock()
	j := s.jobs[id]
	s.mu.Unlock()
	clusterID := j.ClusterID
	if clusterID == "" {
		if dep := s.readSpec(id); dep != nil {
			clusterID = dep.ID
		}
	}
	if clusterID == "" {
		return out
	}
	readTar := func(path string) {
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		zr, err := gzip.NewReader(f)
		if err != nil {
			return
		}
		defer zr.Close()
		tr := tar.NewReader(zr)
		for {
			h, err := tr.Next()
			if err != nil {
				break
			}
			if (h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA) || h.Size > 2<<20 {
				continue
			}
			rest, ok := extractProjectFileRel(h.Name, clusterID)
			if !ok {
				continue
			}
			if parts := strings.Split(rest, "/"); len(parts) == 3 && (parts[2] == "server.crt" || parts[2] == "server.key" || parts[2] == "ca.crt") {
				if b, err := io.ReadAll(io.LimitReader(tr, 2<<20)); err == nil {
					out[rest] = b
				}
			}
		}
	}
	nodeFiles, _ := filepath.Glob(filepath.Join(s.jobDir(id), "output", "node*.tar.gz"))
	sort.Strings(nodeFiles)
	for _, path := range nodeFiles {
		readTar(path)
		if len(out) > 0 {
			break
		}
	}
	// Overlay any newer certificate updates carried in update-*.tar.gz bundles.
	updateFiles, _ := filepath.Glob(filepath.Join(s.jobDir(id), "output", "update-*.tar.gz"))
	sort.Strings(updateFiles)
	for _, path := range updateFiles {
		readTar(path)
	}
	return out
}

// reviseBlocker says why the first deployment id cannot be revised into a delivery for cluster; empty when it can.
func (s *storeServer) reviseBlocker(id, user, cluster string) string {
	vis := s.visibleJobs(user)
	s.mu.Lock()
	defer s.mu.Unlock()
	if src, ok := s.jobs[id]; !ok || !vis(src.Owner) {
		return "找不到要修改的首次部署"
	}
	return s.reviseBlockerLocked(id, user, cluster)
}

// reviseBlockerLocked is reviseBlocker for a caller that holds s.mu and has checked the person may see the job.
func (s *storeServer) reviseBlockerLocked(id, user, cluster string) string {
	src, ok := s.jobs[id]
	switch {
	case !ok:
		return "找不到要修改的首次部署"
	case src.ClusterID != cluster:
		return "修改配置时集群标识不能变；要换标识，请新建一个集群"
	case src.Seq != 0:
		return "只有首次部署可以在执行前修改配置"
	case src.State != "succeeded":
		return "这份首次部署还没有生成完成，生成后才能修改"
	case src.finished():
		return "这份首次部署已经完成；运行中集群的变更请使用变更演练生成实施方案"
	case src.Outcome == outcomeVoid:
		return "这份首次部署已经作废"
	}
	if h, ok := clusterHolder(s.clusterOf(cluster)); !ok || h.ID != id {
		return "这份首次部署已经被新的修订版取代，请修改最新的那份"
	}
	for _, o := range s.jobs {
		if o.Revises == id && o.live() && (o.State == "queued" || o.State == "running") {
			return "已经有一份修订版正在生成，请等它完成"
		}
	}
	return ""
}

// supersede voids the revised delivery once its replacement is generated.
func (s *storeServer) supersede(old, by, user string) {
	s.mu.Lock()
	j, ok := s.jobs[old]
	if !ok || j.Outcome == outcomeVoid {
		s.mu.Unlock()
		return
	}
	note := "配置修改后重新生成了首次部署，这一份被取代，不再执行"
	if j.Outcome == outcomeFailed {
		note = "执行到一半失败，配置修改后重新生成了首次部署，这一份被取代；已经执行过的部分请按新交付核对或清理"
	}
	j.Outcome, j.OutcomeNote, j.RevisedBy = outcomeVoid, note, by
	j.Marked, j.MarkedBy = time.Now().UTC().Format(time.RFC3339Nano), user
	s.jobs[old] = j
	s.mu.Unlock()
	_ = s.persistJob(j)
	s.audit("job-revised", user, old)
}
