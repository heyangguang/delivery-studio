package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"delivery-studio/mwpack"
	"delivery-studio/pkglib"
)

// ---- read-only platform API: component schemas, live resolution, spec import and export ----

func (s *storeServer) componentSchema(w http.ResponseWriter, r *http.Request, name string) {
	c, ok := s.plat.cat().Get(name)
	if !ok {
		s.fail(w, 404, "组件不存在")
		return
	}
	rawVer := strings.TrimSpace(r.URL.Query().Get("version"))
	sc, err := c.Describe(rawVer)
	if err != nil && rawVer != "" {
		// Normalize distro package versions from imported baselines (e.g. "4.1.5-1.noble" -> "4.1" or "4",
		// "1:3.5.33-1.noble" -> "3.5") before falling back to the component's default version schema.
		norm := rawVer
		if idx := strings.Index(norm, ":"); idx >= 0 {
			norm = norm[idx+1:]
		}
		if idx := strings.IndexAny(norm, "-+~ "); idx >= 0 {
			norm = norm[:idx]
		}
		parts := strings.Split(norm, ".")
		candidates := []string{norm}
		if len(parts) >= 2 {
			candidates = append(candidates, parts[0]+"."+parts[1])
		}
		if len(parts) >= 1 && parts[0] != "" {
			candidates = append(candidates, parts[0])
		}
		candidates = append(candidates, "")
		for _, cand := range candidates {
			if sc2, err2 := c.Describe(cand); err2 == nil {
				sc, err = sc2, nil
				break
			}
		}
	}
	if err != nil {
		s.fail(w, 404, err.Error())
		return
	}
	s.writeJSON(w, 200, mwpack.LocalizeSchema(wLang(w), sc))
}

func (s *storeServer) readDeployment(w http.ResponseWriter, r *http.Request) (*mwpack.Deployment, bool) {
	var d mwpack.Deployment
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&d); err != nil {
		s.fail(w, 400, "部署规格有问题："+err.Error())
		return nil, false
	}
	if d.Schema == "" {
		d.Schema = mwpack.DeploymentSchema
	}
	return &d, true
}

// resolve validates a deployment against the catalog and returns the expanded plan with every problem found, so a
// form can show them all at once and show what the platform added on its own.
func (s *storeServer) resolve(w http.ResponseWriter, r *http.Request, session storeSession) {
	d, ok := s.readDeployment(w, r)
	if !ok {
		return
	}
	purpose := strings.TrimSpace(r.URL.Query().Get("purpose"))
	if purpose == "verification" && !s.can(session.User, "component.edit") && !s.can(session.User, "component.publish") {
		s.fail(w, 403, "只有组件维护者可以使用组件验证测试通道")
		return
	}
	plan := mwpack.Solve(s.plat.cat(), d)
	plan.Issues = append(plan.Issues, s.releaseGateIssues(plan, purpose)...)
	type pkgInfo struct {
		Platform string                  `json:"platform"`
		Total    int                     `json:"total"`
		Missing  []mwpack.PackageRequest `json:"missing"`
	}
	pk := pkgInfo{Platform: plan.Platform.ID, Missing: []mwpack.PackageRequest{}}
	var cachedMissing []mwpack.PackageRequest
	var checkedReqs []mwpack.PackageRequest
	missingComputed := false
	if d.DeliveryMode != "configuration" && plan.Platform.ID != "" {
		checkedReqs = plan.Requests()
		pk.Total = len(checkedReqs)
		if len(checkedReqs) > 0 {
			if m := s.plat.lib.Missing(plan.Platform.ID, checkedReqs); m != nil {
				cachedMissing = m
				pk.Missing = m
			}
			missingComputed = true
		}
	}
	if len(plan.Errors()) == 0 {
		if plan.Dep.DeliveryMode != "configuration" && plan.Platform.ID != "" {
			if !s.plat.runtimeReady(plan.Platform.ID) {
				plan.Issues = append(plan.Issues, mwpack.Problem{Severity: "error", Path: "platform", Message: fmt.Sprintf("还没有 %s 的 Ansible 运行环境，暂时不能为它生成交付（控制节点需要它离线安装 Ansible）", plan.Platform.Title)})
			}
			var missing []mwpack.PackageRequest
			if missingComputed {
				missing = cachedMissing
			} else if reqs := plan.Requests(); len(reqs) > 0 {
				missing = s.plat.lib.Missing(plan.Platform.ID, reqs)
			}
			if len(missing) > 0 {
				var names []string
				for _, m := range missing {
					names = append(names, m.Key())
				}
				plan.Issues = append(plan.Issues, mwpack.Problem{Severity: "error", Path: "packages", Message: fmt.Sprintf("软件库里没有 %s（%s）。能联网时到“软件库”页获取；离线时在联网机器上获取后导出，再到“软件库”页导入", strings.Join(names, "、"), plan.Platform.Title)})
			}
		}
		if e := mwpack.ValidateDeliveryMode(plan); e != nil {
			plan.Issues = append(plan.Issues, mwpack.Problem{Severity: "error", Path: "delivery_mode", Message: e.Error()})
		}
		if plan.Dep.DeliveryMode == "configuration" {
			plan.Inputs = nil
		}
	}
	view := mwpack.LocalizePlanView(wLang(w), plan.View())
	if d.DeliveryMode == "configuration" {
		view.Artifacts = []mwpack.ArtifactView{}
		view.Phases = nil
	}
	// Artifacts the delivery would carry, and whether the library has them.
	type artifact struct {
		mwpack.ArtifactView
		Present bool  `json:"present"`
		Bytes   int64 `json:"bytes,omitempty"`
	}
	arts := []artifact{}
	for _, a := range view.Artifacts {
		info, present := s.plat.artifactInfo(a.File)
		arts = append(arts, artifact{a, present, info.Size})
	}
	s.writeJSON(w, 200, map[string]any{"plan": view, "artifacts": arts, "packages": pk})
}

func (s *storeServer) specImport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		YAML string `json:"yaml"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	d, err := mwpack.ParseDeployment([]byte(body.YAML))
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.writeJSON(w, 200, d)
}

func (s *storeServer) specExport(w http.ResponseWriter, r *http.Request) {
	d, ok := s.readDeployment(w, r)
	if !ok {
		return
	}
	b, err := d.YAML()
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.writeJSON(w, 200, map[string]string{"yaml": string(b)})
}

// ---- job creation ----

// uploadField names a certificate part: tls:<instance>:<input>:<certificate|private_key|ca_cert|intermediates>.
func uploadField(instance, input, part string) string {
	return "tls:" + instance + ":" + input + ":" + part
}

func (s *storeServer) createJob(w http.ResponseWriter, r *http.Request, session storeSession) {
	r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		s.fail(w, 400, "上传的内容有问题，或者超过了 12 MiB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	var input struct {
		Deployment   *mwpack.Deployment `json:"deployment"`
		Revises      string             `json:"revises"`
		Purpose      string             `json:"purpose"`
		VerifyTarget *verifyTarget      `json:"verify_target"`
	}
	if err := json.Unmarshal([]byte(r.FormValue("request")), &input); err != nil || input.Deployment == nil {
		s.fail(w, 400, "提交的配置读不出来，请刷新页面后重试")
		return
	}
	if !s.need(w, session.User, "delivery.create") {
		return
	}
	input.Purpose = strings.TrimSpace(input.Purpose)
	if input.Purpose != "" && input.Purpose != "verification" {
		s.fail(w, 400, "交付用途参数无效")
		return
	}
	if input.Purpose == "verification" && !s.can(session.User, "component.edit") && !s.can(session.User, "component.publish") {
		s.fail(w, 403, "只有组件维护者可以发起组件验证交付")
		return
	}
	d := input.Deployment
	if input.Revises != "" {
		unlock := s.lockExecutionJob(input.Revises)
		defer unlock()
		executionMu.Lock()
		locked := s.executionLocked(input.Revises)
		executionMu.Unlock()
		if locked {
			s.fail(w, 409, "原交付正在自动执行或等待核实，请先结束该批次再修改配置")
			return
		}
	}
	if input.Revises != "" {
		if msg := s.reviseBlocker(input.Revises, session.User, d.ID); msg != "" {
			s.fail(w, 409, msg)
			return
		}
		// Inherit verification purpose when revising an existing verification delivery.
		s.mu.Lock()
		if prev, ok := s.jobs[input.Revises]; ok && prev.Purpose == "verification" && input.Purpose == "" {
			input.Purpose = prev.Purpose
			if input.VerifyTarget == nil {
				input.VerifyTarget = prev.VerifyTarget
			}
		}
		s.mu.Unlock()
	}
	if d.Schema == "" {
		d.Schema = mwpack.DeploymentSchema
	}
	plan := mwpack.Solve(s.plat.cat(), d)
	if err := mwpack.ValidateDeliveryMode(plan); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	if d.DeliveryMode == "configuration" {
		plan.Inputs = nil
	}
	if len(plan.Errors()) == 0 {
		plan.Issues = append(plan.Issues, s.releaseGateIssues(plan, input.Purpose)...)
	}
	if len(plan.Errors()) == 0 {
		plan.Issues = append(plan.Issues, s.plat.readiness(plan)...)
	}
	if err := plan.Err(); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	for _, a := range plan.Artifacts() {
		if d.DeliveryMode == "configuration" {
			break
		}
		if _, ok := s.plat.artifactInfo(a.File); !ok {
			s.fail(w, 400, "这份交付需要的离线软件包还没准备好："+a.File)
			return
		}
	}
	// The job is named after the first instance the user chose, not one the platform added.
	primary := deliveryPrimary(plan, d)
	var vTarget *verifyTarget
	if input.Purpose == "verification" {
		if input.VerifyTarget != nil && input.VerifyTarget.Component != "" {
			vt := *input.VerifyTarget
			if vt.Platform == "" {
				vt.Platform = plan.Platform.ID
			}
			vTarget = &vt
		} else if primary != nil {
			vTarget = &verifyTarget{
				Component: primary.Component,
				Version:   primary.Version,
				Platform:  plan.Platform.ID,
			}
		}
	}

	// Reserve queue capacity before accepting private material.
	s.mu.Lock()
	pending, userPending := 0, 0
	for _, j := range s.jobs {
		if j.State == "queued" || j.State == "running" {
			pending++
			if j.Owner == session.User {
				userPending++
			}
		}
	}
	if pending >= 20 || userPending >= 3 {
		s.mu.Unlock()
		s.fail(w, 429, "现在生成任务比较多，请等已有的任务完成后再试")
		return
	}
	// The cluster rules are checked again under the lock, so two people cannot start the same cluster twice.
	if input.Revises != "" {
		if msg := s.reviseBlockerLocked(input.Revises, session.User, d.ID); msg != "" {
			s.mu.Unlock()
			s.fail(w, 409, msg)
			return
		}
	} else {
		if msg := s.clusterTaken(d.ID); msg != "" {
			s.mu.Unlock()
			s.fail(w, 409, msg)
			return
		}
	}
	id := randomStoreToken(16)
	now := nowStamp()
	j := storeJob{Purpose: input.Purpose, VerifyTarget: vTarget, Scheme: primary.SchemeSummary(), ID: id, Owner: session.User, AppID: primary.Component, AppName: primary.Title, Version: primary.Version, ClusterID: d.ID, Revises: input.Revises, Seq: 0, State: "queued", Stage: "等待生成", Created: now, Updated: now, Logs: []string{}}
	j.DeliveryMode = d.DeliveryMode
	s.jobs[id] = j
	s.mu.Unlock()
	dir := s.jobDir(id)
	if err := os.MkdirAll(filepath.Join(dir, "certificates"), 0700); err != nil {
		s.removeFailedReservation(id)
		s.fail(w, 500, "生成前的准备失败了，请稍后重试")
		return
	}
	failUpload := func(message string) { s.removeFailedReservation(id); os.RemoveAll(dir); s.fail(w, 400, message) }

	// Certificates: stored privately, then validated like before. The name they must cover is the address of a
	// domain front, if any; with no front only the chain, validity and key match are checked.
	materials := map[string][]byte{}
	// a revision made from a delivery keeps that delivery's certificates unless new ones are uploaded
	var inherited map[string][]byte
	if input.Revises != "" {
		inherited = s.sourceCertificates(input.Revises)
	}
	for _, in := range plan.Inputs {
		if in.Kind != "tls-bundle" {
			continue
		}
		if _, _, err := r.FormFile(uploadField(in.Instance, in.Name, "certificate")); err != nil {
			base := in.Instance + "/" + in.Name + "/"
			if inherited[base+"server.crt"] != nil && inherited[base+"server.key"] != nil {
				for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
					materials[base+f] = inherited[base+f]
				}
				continue
			}
		}
		paths := map[string]string{}
		for _, part := range []string{"certificate", "private_key", "ca_cert", "intermediates"} {
			file, header, err := r.FormFile(uploadField(in.Instance, in.Name, part))
			if err != nil {
				if part == "certificate" || part == "private_key" {
					failUpload("请上传「" + in.Label + "」的服务器证书和对应的私钥")
					return
				}
				continue
			}
			if header.Size > 2<<20 {
				file.Close()
				failUpload("单个证书文件不能超过 2 MiB")
				return
			}
			data, err := io.ReadAll(io.LimitReader(file, (2<<20)+1))
			file.Close()
			if err != nil || len(data) > 2<<20 {
				failUpload("证书文件读取失败，请重新上传")
				return
			}
			sub := filepath.Join(dir, "certificates", in.Instance, in.Name)
			if err = os.MkdirAll(sub, 0700); err != nil {
				failUpload("证书文件保存失败，请稍后重试")
				return
			}
			filename := filepath.Join(sub, part+".pem")
			if err = privateWriteNew(filename, data); err != nil {
				failUpload("证书文件保存失败，请稍后重试")
				return
			}
			paths[part] = filename
		}
		m, _, err := deliveryMaterial(tlsNameFor(plan, in.Instance), deliveryCertificates{Mode: "auto", Certificate: paths["certificate"], PrivateKey: paths["private_key"], CA: paths["ca_cert"], Intermediates: paths["intermediates"]}, dir)
		if err != nil {
			failUpload(in.Label + "：" + err.Error())
			return
		}
		materials[in.Instance+"/"+in.Name+"/server.crt"] = m.Server
		materials[in.Instance+"/"+in.Name+"/server.key"] = m.Key
		materials[in.Instance+"/"+in.Name+"/ca.crt"] = m.CA
	}
	specBytes, specErr := plan.Normalized().YAML()
	if specErr != nil || s.writeJobSpecBytes(id, j.ClusterID, specBytes) != nil {
		failUpload("保存配置失败，请稍后重试")
		return
	}
	if err := s.persistJob(j); err != nil {
		failUpload("保存任务失败，请稍后重试")
		return
	}
	s.auditReq(r, "job-create", session.User, id)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.sem <- struct{}{}
		defer func() { <-s.sem }()
		s.updateJob(id, "running", "开始生成", "")
		outDir := filepath.Join(dir, "output")
		err := s.generate(plan, materials, outDir, func(m string) { s.updateJob(id, "running", m, "") })
		os.RemoveAll(filepath.Join(dir, "certificates")) // validated material now lives only in the delivery
		if err != nil {
			s.updateJob(id, "failed", "生成失败", err.Error())
			s.audit("job-failed", session.User, id)
		} else {
			if s.repo != nil {
				pb, _ := os.ReadFile(filepath.Join(outDir, "plan.json"))
				lb, _ := os.ReadFile(filepath.Join(outDir, "deployment.lock.json"))
				_ = s.writeJobPlanAndLock(id, j.ClusterID, pb, lb)
			}
			s.updateJob(id, "succeeded", "交付材料已生成", "")
			s.audit("job-succeeded", session.User, id)
			if input.Revises != "" {
				s.supersede(input.Revises, id, session.User)
			}
		}
	}()
	s.writeJSON(w, 202, j)
}

// tlsNameFor is the name a certificate must cover: the domain of an external front on the instance, else any
// front address that is a name rather than an IP; empty when there is nothing to check.
func tlsNameFor(plan *mwpack.Plan, instance string) string {
	inst := plan.Instance(instance)
	if inst == nil {
		return ""
	}
	for _, f := range inst.Fronts {
		if f.Mode == "domain" || (f.Mode == "" && strings.Contains(f.Address, ".") && !isIPv4(f.Address)) {
			return f.Address
		}
	}
	return ""
}

func (s *storeServer) generate(plan *mwpack.Plan, materials map[string][]byte, output string, emit func(string)) error {
	if err := mwpack.ValidateDeliveryMode(plan); err != nil {
		return err
	}
	if plan.Dep.DeliveryMode == "configuration" {
		emit("生成配置文件，不执行部署")
		return generateConfiguration(plan, output)
	}
	emit("[1/5] 校验部署规格，从软件库拼装离线软件仓库")
	opt := mwpack.RenderOptions{Artifacts: s.plat.artifactsFor(plan), Materials: materials}
	var repo *pkglib.RepoArchive
	if plan.NeedsPackages() {
		var err error
		if repo, err = s.plat.lib.Assemble(plan.Platform, plan.Requests()); err != nil {
			return err
		}
		opt.PackageRepo = &mwpack.PackageRepo{File: repo.File, SHA256: repo.SHA256, Size: repo.Size}
	}
	bundle, err := mwpack.Render(plan, opt)
	if err != nil {
		return err
	}
	return packageDelivery(bundle, s.plat, repo, output, emit)
}

// jobSpec returns what the user submitted, as YAML, for display and for "create again from this".
func (s *storeServer) jobSpec(id string) any {
	b, err := s.readJobSpecBytes(id)
	if err != nil {
		return nil
	}
	if d, err := mwpack.ParseDeployment(b); err == nil {
		return map[string]any{"deployment": d, "yaml": string(b)}
	}
	d, err := mwpack.ParseSavedDeployment(b)
	if err != nil {
		return nil
	}
	y := string(b)
	if cy, err := d.YAML(); err == nil {
		y = string(cy)
	}
	return map[string]any{"deployment": d, "yaml": y}
}

// jobPlan returns the structured handbook (plan.json) of a generated delivery. Deliveries made before a display field
// existed (role names, data flows) lack it, so those fields are filled in from the submitted specification solved
// against the current catalog; nothing that was generated changes.
func (s *storeServer) jobPlan(id string) json.RawMessage {
	var mod, sz int64
	if s.repo != nil {
		s.cacheMu.RLock()
		if hit, ok := s.planCache[id]; ok && hit.modTime == -1 {
			s.cacheMu.RUnlock()
			return hit.raw
		}
		s.cacheMu.RUnlock()
		mod = -1
	} else {
		path := filepath.Join(s.jobDir(id), "output", "plan.json")
		st, statErr := os.Stat(path)
		if statErr != nil {
			return nil
		}
		mod = st.ModTime().UnixNano()
		sz = st.Size()

		s.cacheMu.RLock()
		if hit, ok := s.planCache[id]; ok && hit.modTime == mod && hit.size == sz {
			s.cacheMu.RUnlock()
			return hit.raw
		}
		s.cacheMu.RUnlock()
	}

	b, err := s.readJobPlanBytes(id)
	if err != nil || len(b) == 0 {
		return nil
	}
	if sz == 0 {
		sz = int64(len(b))
	}
	res := json.RawMessage(b)
	var doc map[string]json.RawMessage
	var insts []map[string]json.RawMessage
	if json.Unmarshal(b, &doc) == nil && json.Unmarshal(doc["instances"], &insts) == nil {
		needsBackfill := false
		needsPackages := false
		for _, in := range insts {
			if _, has := in["role_titles"]; !has {
				needsBackfill = true
			}
			if _, has := in["packages"]; !has {
				needsPackages = true
			}
		}
		changed := false
		if needsPackages {
			if lb, err := s.readJobLockBytes(id); err == nil {
				var lockDoc struct {
					Instances []struct {
						ID       string                  `json:"id"`
						Packages []mwpack.PackageRequest `json:"packages"`
					} `json:"instances"`
				}
				if json.Unmarshal(lb, &lockDoc) == nil {
					pkgByID := map[string][]mwpack.PackageRequest{}
					for _, li := range lockDoc.Instances {
						if li.ID != "" && len(li.Packages) > 0 {
							pkgByID[li.ID] = li.Packages
						}
					}
					for _, in := range insts {
						if _, has := in["packages"]; has {
							continue
						}
						var iid string
						_ = json.Unmarshal(in["id"], &iid)
						if pks := pkgByID[iid]; len(pks) > 0 {
							in["packages"], _ = json.Marshal(pks)
							changed = true
						}
					}
				}
			}
		}
		if needsBackfill {
			if spec, err := s.readJobSpecBytes(id); err == nil {
				if dep, err := mwpack.ParseSavedDeployment(spec); err == nil {
					view := mwpack.Solve(s.plat.cat(), dep).View()
					byID := map[string]mwpack.InstanceView{}
					for _, iv := range view.Instances {
						byID[iv.ID] = iv
					}
					for _, in := range insts {
						var iid string
						_ = json.Unmarshal(in["id"], &iid)
						iv, ok := byID[iid]
						if !ok {
							continue
						}
						if _, has := in["flows"]; !has && len(iv.Flows) > 0 {
							in["flows"], _ = json.Marshal(iv.Flows)
							changed = true
						}
						if _, has := in["role_titles"]; !has && len(iv.RoleTitles) > 0 {
							in["role_titles"], _ = json.Marshal(iv.RoleTitles)
							changed = true
						}
						if _, has := in["packages"]; !has && len(iv.Packages) > 0 {
							in["packages"], _ = json.Marshal(iv.Packages)
							changed = true
						}
					}
				}
			}
		}
		if changed {
			doc["instances"], _ = json.Marshal(insts)
			if out, err := json.Marshal(doc); err == nil {
				res = out
			}
		}
	}

	s.cacheMu.Lock()
	if s.planCache == nil {
		s.planCache = map[string]cachedJobPlan{}
	}
	s.planCache[id] = cachedJobPlan{modTime: mod, size: sz, raw: res}
	s.cacheMu.Unlock()
	return res
}

var _ = url.PathEscape

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func isIPv4(v string) bool {
	ip := net.ParseIP(v)
	return ip != nil && ip.To4() != nil
}

var nameRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

// checkCertificates validates a certificate bundle the moment it is chosen on the form, against the entry domain the
// form has now, so a wrong file or a mistyped domain shows up there and not when the delivery is generated. Nothing is
// kept: the files go to a private temporary directory that is removed afterwards.
func (s *storeServer) checkCertificates(w http.ResponseWriter, r *http.Request, session storeSession) {
	r.Body = http.MaxBytesReader(w, r.Body, 9<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		s.fail(w, 400, "上传的内容有问题，或者超过了大小限制")
		return
	}
	defer r.MultipartForm.RemoveAll()
	var in struct {
		Deployment *mwpack.Deployment `json:"deployment"`
		Instance   string             `json:"instance"`
	}
	if json.Unmarshal([]byte(r.FormValue("request")), &in) != nil || in.Deployment == nil {
		s.fail(w, 400, "提交的配置读不出来，请刷新页面后重试")
		return
	}
	plan := mwpack.Solve(s.plat.cat(), in.Deployment)
	domain := tlsNameFor(plan, in.Instance)
	dir, err := os.MkdirTemp("", "mw-certcheck-")
	if err != nil {
		s.fail(w, 500, "暂时无法检查证书")
		return
	}
	defer os.RemoveAll(dir)
	paths := map[string]string{}
	for _, part := range []string{"certificate", "private_key", "ca_cert", "intermediates"} {
		file, header, err := r.FormFile(part)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, (2<<20)+1))
		file.Close()
		if err != nil || header.Size > 2<<20 || len(data) > 2<<20 {
			s.fail(w, 400, "单个证书文件不能超过 2 MiB")
			return
		}
		p := filepath.Join(dir, part+".pem")
		if err := privateWriteNew(p, data); err != nil {
			s.fail(w, 500, "暂时无法检查证书")
			return
		}
		paths[part] = p
	}
	if paths["certificate"] == "" || paths["private_key"] == "" {
		s.fail(w, 400, "请先选择服务器证书和私钥")
		return
	}
	_, rep, err := deliveryMaterial(domain, deliveryCertificates{Mode: "auto", Certificate: paths["certificate"], PrivateKey: paths["private_key"], CA: paths["ca_cert"], Intermediates: paths["intermediates"]}, dir)
	out := map[string]any{"ok": err == nil, "domain": domain}
	if err != nil {
		out["error"] = err.Error()
	} else {
		out["names"], out["not_after"] = rep["san_dns"], rep["not_after_utc"]
	}
	s.writeJSON(w, 200, out)
}
