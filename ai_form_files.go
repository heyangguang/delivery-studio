package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// Files given to the form assistant. A person may hand over anything: a certificate and key, a p7b bundle, a file that
// is not right. The assistant looks at what is in it (inspect_files), works out which part goes where, converts what
// needs converting (a p7b into PEM certificates, one file into the certificate and its chain) and puts the result into
// the form's certificate slots (place_certificate). The platform's own certificate check runs on the result and is
// reported back, so the assistant can say what is still wrong. Private keys are only ever read here, on the server;
// what the assistant is told about a key is its type and which certificate it belongs to, never the key.

// certPart is one thing found in a file: a certificate, or a private key (kept as PEM, never shown).
type certPart struct {
	cert   *x509.Certificate
	keyPEM []byte
	keyAlg string
	signer crypto.Signer
	enc    bool
}

type certFile struct {
	node   fileNode
	format string
	parts  []certPart
	note   string
}

func keyAlgorithm(k crypto.Signer) string {
	switch p := k.(type) {
	case *rsa.PrivateKey:
		return fmt.Sprintf("RSA %d 位", p.N.BitLen())
	case *ecdsa.PrivateKey:
		return "ECDSA " + p.Curve.Params().Name
	}
	return "其他算法"
}

// readCertFile reads whatever a file holds: PEM blocks (certificates, PKCS#7, keys), or one DER certificate, DER
// PKCS#7 bundle or DER key.
func readCertFile(n fileNode, data []byte) certFile {
	cf := certFile{node: n}
	addKey := func(block *pem.Block) {
		pp := certPart{keyPEM: pem.EncodeToMemory(block)}
		if x509.IsEncryptedPEMBlock(block) || strings.Contains(block.Type, "ENCRYPTED") {
			pp.enc = true
		} else if sg, err := privateSigner(pp.keyPEM); err == nil {
			pp.signer, pp.keyAlg = sg, keyAlgorithm(sg)
		}
		cf.parts = append(cf.parts, pp)
	}
	rest := data
	blocks := 0
	for {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		blocks++
		switch {
		case b.Type == "CERTIFICATE" || b.Type == "TRUSTED CERTIFICATE":
			if c, err := x509.ParseCertificate(b.Bytes); err == nil {
				cf.parts = append(cf.parts, certPart{cert: c})
			} else {
				cf.note += "有一个证书读不出来：" + err.Error() + "。"
			}
		case b.Type == "PKCS7" || b.Type == "CMS":
			if cs, err := p7bCertificates(pem.EncodeToMemory(b)); err == nil {
				for _, c := range cs {
					cf.parts = append(cf.parts, certPart{cert: c})
				}
				cf.format = "PKCS#7（p7b）证书包"
			} else {
				cf.format = "PKCS#7（p7b）证书包"
				cf.note += "p7b 里的证书读不出来：" + err.Error() + "。"
			}
		case strings.Contains(b.Type, "PRIVATE KEY"):
			addKey(b)
		}
	}
	if blocks > 0 {
		if cf.format == "" {
			cf.format = "PEM"
		}
		return cf
	}
	if c, err := x509.ParseCertificate(data); err == nil {
		cf.format = "DER 证书（.cer/.crt）"
		cf.parts = []certPart{{cert: c}}
		return cf
	}
	if cs, err := p7bCertificates(data); err == nil {
		cf.format = "DER 格式的 PKCS#7（p7b）证书包"
		for _, c := range cs {
			cf.parts = append(cf.parts, certPart{cert: c})
		}
		return cf
	}
	for _, t := range []string{"PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"} {
		if sg, err := privateSigner(pem.EncodeToMemory(&pem.Block{Type: t, Bytes: data})); err == nil {
			cf.format = "DER 私钥"
			cf.parts = []certPart{{keyPEM: pem.EncodeToMemory(&pem.Block{Type: t, Bytes: data}), signer: sg, keyAlg: keyAlgorithm(sg)}}
			return cf
		}
	}
	if len(data) > 4 && data[0] == 0x30 && data[1] >= 0x80 {
		cf.format = "二进制（可能是 .pfx/.p12，需要密码才能打开）"
		cf.note = "平台不能打开带密码的 .pfx/.p12。请用户在自己的机器上用 openssl 拆开后再上传：openssl pkcs12 -in 文件.pfx -nodes -out all.pem（会得到证书和未加密的私钥）"
		return cf
	}
	cf.format = "不是证书或私钥"
	return cf
}

func certRole(c *x509.Certificate) string {
	switch {
	case c.IsCA && string(c.RawIssuer) == string(c.RawSubject):
		return "根 CA（自签）"
	case c.IsCA:
		return "中间 CA"
	}
	return "服务器证书"
}

func certName(c *x509.Certificate) string {
	return firstNonEmptyStr(c.Subject.CommonName, c.Subject.String())
}

// formCertTarget is the instance and entry name the form's certificate is for, found by solving the form as it is now.
func (c *formCtx) formCertTarget() (instance, domain string) {
	instance, _, domain = c.formCertInput()
	return
}

// formCertInput is the instance and input name the certificate is for, and the name it must cover.
func (c *formCtx) formCertInput() (instance, input, domain string) {
	if c.state == nil || c.state.Deployment == nil {
		return "", "", ""
	}
	plan := mwpack.Solve(c.s.plat.cat(), c.state.Deployment)
	if len(plan.Inputs) == 0 {
		return "", "", ""
	}
	instance = plan.Inputs[0].Instance
	return instance, plan.Inputs[0].Name, tlsNameFor(plan, instance)
}

// attachedFile finds a file the person gave in this conversation by id or by name.
func (c *formCtx) attachedFile(ref string) (fileNode, bool) {
	ref = strings.TrimSpace(ref)
	for _, n := range c.files {
		if n.ID == ref || n.Name == ref {
			return n, true
		}
	}
	for _, h := range c.hist {
		if h.ID == ref || h.Name == ref {
			if ns, msg := c.s.attachments(c.user, []string{h.ID}); msg == "" && len(ns) == 1 {
				return ns[0], true
			}
		}
	}
	if ns, msg := c.s.attachments(c.user, []string{ref}); msg == "" && len(ns) == 1 {
		return ns[0], true
	}
	return fileNode{}, false
}

// blobItem is one thing to look at: an attached file, or one file inside an attached archive (ref "包名::里面的路径").
type blobItem struct {
	ref  string
	data []byte
}

const (
	archiveMax     = 16 << 20 // an attached archive may be this big
	archiveMembers = 80
	memberMax      = 2 << 20
)

// unpack lists the files of a zip, tar or tar.gz held in memory; nil when data is not an archive.
func unpack(data []byte) (map[string][]byte, []string) {
	out := map[string][]byte{}
	var order []string
	add := func(name string, r io.Reader) bool {
		name = path.Clean(strings.ReplaceAll(name, "\\", "/"))
		if strings.HasPrefix(name, "..") || strings.HasPrefix(name, "/") || len(out) >= archiveMembers {
			return len(out) < archiveMembers
		}
		b, err := io.ReadAll(io.LimitReader(r, memberMax+1))
		if err != nil || len(b) > memberMax {
			return true
		}
		out[name] = b
		order = append(order, name)
		return true
	}
	switch {
	case len(data) > 4 && data[0] == 'P' && data[1] == 'K':
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, nil
		}
		for _, f := range zr.File {
			if f.FileInfo().IsDir() || f.UncompressedSize64 > memberMax {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				continue
			}
			ok := add(f.Name, rc)
			rc.Close()
			if !ok {
				break
			}
		}
	default:
		var r io.Reader = bytes.NewReader(data)
		if len(data) > 2 && data[0] == 0x1f && data[1] == 0x8b {
			gz, err := gzip.NewReader(r)
			if err != nil {
				return nil, nil
			}
			defer gz.Close()
			r = gz
		}
		tr := tar.NewReader(r)
		n := 0
		for {
			h, err := tr.Next()
			if err != nil {
				break
			}
			n++
			if h.Typeflag != tar.TypeReg || h.Size > memberMax {
				continue
			}
			if !add(h.Name, tr) {
				break
			}
		}
		if n == 0 {
			return nil, nil
		}
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, order
}

// items opens an attachment: the file itself, or the files inside it when it is an archive. A ref with "::" names one
// file inside an archive.
func (c *formCtx) items(ref string) ([]blobItem, error) {
	arc, member, inside := strings.Cut(ref, "::")
	n, ok := c.attachedFile(arc)
	if !ok {
		return nil, fmt.Errorf("找不到文件「%s」，请用附件的名称或编号", arc)
	}
	if n.Size > archiveMax {
		return nil, fmt.Errorf("文件「%s」超过 16 MiB，不像证书材料", n.Name)
	}
	data, err := os.ReadFile(c.s.blobPath(c.user, n.ID))
	if err != nil {
		return nil, fmt.Errorf("读不到文件「%s」", n.Name)
	}
	files, order := unpack(data)
	if files == nil {
		if inside {
			return nil, fmt.Errorf("「%s」不是压缩包", n.Name)
		}
		if len(data) > 4<<20 {
			return nil, fmt.Errorf("文件「%s」超过 4 MiB，不像证书", n.Name)
		}
		return []blobItem{{ref: n.Name, data: data}}, nil
	}
	var out []blobItem
	for _, name := range order {
		if inside && name != member && path.Base(name) != member {
			continue
		}
		out = append(out, blobItem{ref: n.Name + "::" + name, data: files[name]})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("压缩包「%s」里没有「%s」", n.Name, member)
	}
	return out, nil
}

func (c *formCtx) loadCertFile(ref string) (certFile, error) {
	its, err := c.items(ref)
	if err != nil {
		return certFile{}, err
	}
	if len(its) != 1 {
		return certFile{}, fmt.Errorf("「%s」是压缩包，里面有 %d 个文件，请指定具体的一个（写成 包名::里面的路径，inspect_files 会列出）", ref, len(its))
	}
	return readCertFile(fileNode{Name: its[0].ref}, its[0].data), nil
}

func (c *formCtx) inspectFiles(refs []string) string {
	if len(refs) == 0 {
		for _, n := range c.files {
			refs = append(refs, n.ID)
		}
	}
	if len(refs) == 0 {
		// nothing new: whatever was handed over earlier in this conversation
		seen := map[string]bool{}
		for i := len(c.hist) - 1; i >= 0 && len(refs) < 8; i-- {
			if !seen[c.hist[i].ID] {
				seen[c.hist[i].ID] = true
				refs = append(refs, c.hist[i].ID)
			}
		}
	}
	if len(refs) == 0 {
		return "这条消息没有附件。用户上传文件后，附件的名称和编号会写在他的消息里。"
	}
	_, domain := c.formCertTarget()
	var all []certFile
	var texts []blobItem
	var b strings.Builder
	if domain != "" {
		fmt.Fprintf(&b, "表单里入口的域名：%s（服务器证书必须包含它）\n", domain)
	}
	for _, r := range refs {
		its, err := c.items(r)
		if err != nil {
			b.WriteString(err.Error() + "\n")
			continue
		}
		for _, it := range its {
			cf := readCertFile(fileNode{Name: it.ref}, it.data)
			if len(cf.parts) == 0 && isText(it.data) {
				texts = append(texts, it)
				continue
			}
			all = append(all, cf)
		}
	}
	var keys []certPart
	type ref struct {
		f string
		i int
		c *x509.Certificate
	}
	var certs []ref
	for _, f := range all {
		for i, p := range f.parts {
			if p.cert != nil {
				certs = append(certs, ref{f.node.Name, i, p.cert})
			} else if p.signer != nil {
				keys = append(keys, p)
			}
		}
	}
	now := time.Now()
	for _, f := range all {
		fmt.Fprintf(&b, "\n文件「%s」：%s\n", f.node.Name, f.format)
		if f.note != "" {
			b.WriteString("  " + f.note + "\n")
		}
		for i, p := range f.parts {
			switch {
			case p.cert != nil:
				cr := p.cert
				line := fmt.Sprintf("  #%d 证书「%s」，%s，签发者「%s」，有效期 %s ～ %s", i, certName(cr), certRole(cr), firstNonEmptyStr(cr.Issuer.CommonName, cr.Issuer.String()), cr.NotBefore.Format("2006-01-02"), cr.NotAfter.Format("2006-01-02"))
				if now.After(cr.NotAfter) {
					line += "【已过期】"
				} else if now.Before(cr.NotBefore) {
					line += "【还没生效】"
				}
				if len(cr.DNSNames) > 0 {
					line += "，域名 " + strings.Join(cr.DNSNames, "、")
				}
				if domain != "" && !cr.IsCA {
					if cr.VerifyHostname(domain) == nil {
						line += "，覆盖入口域名"
					} else {
						line += "，不覆盖入口域名"
					}
				}
				for _, k := range keys {
					if !cr.IsCA && keysMatch(cr, k.signer) {
						line += "，与上传的私钥是一对"
					}
				}
				b.WriteString(line + "\n")
			case p.enc:
				fmt.Fprintf(&b, "  #%d 私钥（已加密，平台不能用，需要用户先解密）\n", i)
			case p.signer != nil:
				line := fmt.Sprintf("  #%d 私钥（%s，没加密）", i, p.keyAlg)
				for _, r := range certs {
					if !r.c.IsCA && keysMatch(r.c, p.signer) {
						line += fmt.Sprintf("，对应「%s」里的 #%d 证书", r.f, r.i)
					}
				}
				b.WriteString(line + "\n")
			default:
				fmt.Fprintf(&b, "  #%d 私钥（格式读不出来）\n", i)
			}
		}
	}
	for _, t := range texts {
		fmt.Fprintf(&b, "\n文件「%s」：文本，开头是：\n%s\n", t.ref, truncRunes(aiScrub(string(t.data)), 600))
	}
	b.WriteString("\n私钥内容不会给你看。判断完用 place_certificate 放进表单；缺什么（根 CA、中间证书、匹配的私钥）就如实告诉用户。")
	return b.String()
}

// slotSpec says where one slot of the form comes from: a file, and which of the things in it (all when empty).
type slotSpec struct {
	File  string `json:"file"`
	Picks []int  `json:"picks"`
}

func (c *formCtx) slotPEM(part string, sp slotSpec) ([]byte, string, error) {
	cf, err := c.loadCertFile(sp.File)
	if err != nil {
		return nil, "", err
	}
	pick := map[int]bool{}
	for _, i := range sp.Picks {
		pick[i] = true
	}
	var out []byte
	got := 0
	for i, p := range cf.parts {
		if len(sp.Picks) > 0 && !pick[i] {
			continue
		}
		switch {
		case part == "private_key" && p.keyPEM != nil:
			if p.enc || p.signer == nil {
				return nil, "", fmt.Errorf("文件「%s」里的私钥不能用（加密的或格式不支持），请用户解密后再上传", cf.node.Name)
			}
			out, got = append(out, p.keyPEM...), got+1
		case part != "private_key" && p.cert != nil:
			out, got = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: p.cert.Raw})...), got+1
		}
	}
	if got == 0 {
		what := "证书"
		if part == "private_key" {
			what = "私钥"
		}
		return nil, "", fmt.Errorf("文件「%s」里没有可用的%s（%s）", cf.node.Name, what, cf.format)
	}
	if part == "private_key" && got > 1 {
		return nil, "", fmt.Errorf("文件「%s」里有 %d 把私钥，请用 picks 指定哪一把", cf.node.Name, got)
	}
	if part == "certificate" && got > 1 {
		return nil, "", fmt.Errorf("服务器证书只能放一份，文件「%s」里选了 %d 份，请用 picks 指定；其余的放进 intermediates 或 ca_cert", cf.node.Name, got)
	}
	return out, cf.node.Name, nil
}

var certSlotFile = map[string]string{"certificate": "server.crt", "private_key": "server.key", "ca_cert": "ca.crt", "intermediates": "intermediates.crt"}

func (c *formCtx) placeCertificate(args map[string]json.RawMessage) string {
	instance, input, domain := c.formCertInput()
	if instance == "" {
		return "现在的配置还没有需要证书的入口（例如云 ELB 域名），没有放进表单。先把入口填好，再放证书。"
	}
	slots := map[string][]byte{}
	var done []string
	for _, part := range []string{"certificate", "private_key", "ca_cert", "intermediates"} {
		raw, ok := args[part]
		if !ok || string(raw) == "null" {
			continue
		}
		var sp slotSpec
		if json.Unmarshal(raw, &sp) != nil || sp.File == "" {
			return "参数 " + part + " 写法不对，要 {file: 文件名或编号, picks: [编号…]}。"
		}
		data, from, err := c.slotPEM(part, sp)
		if err != nil {
			return err.Error() + "。没有放进表单。"
		}
		slots[part] = data
		done = append(done, fmt.Sprintf("%s ← %s", certSlotLabel[part], from))
	}
	if len(slots) == 0 {
		return "没有指定要放的内容。至少给 certificate 和 private_key。"
	}
	// the platform's own check, on exactly what goes into the form
	var verdict string
	if slots["certificate"] != nil && slots["private_key"] != nil {
		dir, err := os.MkdirTemp("", "mw-aicert-")
		if err == nil {
			defer os.RemoveAll(dir)
			paths := map[string]string{}
			for part, data := range slots {
				p := filepath.Join(dir, part+".pem")
				if privateWriteNew(p, data) == nil {
					paths[part] = p
				}
			}
			_, rep, err := deliveryMaterial(domain, deliveryCertificates{Mode: "pem", Certificate: paths["certificate"], PrivateKey: paths["private_key"], CA: paths["ca_cert"], Intermediates: paths["intermediates"]}, dir)
			if err != nil {
				verdict = "平台核对没有通过：" + err.Error()
			} else {
				verdict = fmt.Sprintf("平台核对通过（证书链完整，私钥匹配，有效期至 %v）", rep["not_after_utc"])
			}
		}
	} else {
		verdict = "还缺" + map[bool]string{true: "私钥", false: "服务器证书"}[slots["certificate"] != nil] + "，核对要等两样都有"
	}
	var out []map[string]string
	for part, data := range slots {
		out = append(out, map[string]string{"part": part, "name": certSlotFile[part], "data": base64.StdEncoding.EncodeToString(data)})
	}
	c.ev.send(map[string]any{"t": "formfiles", "v": out, "target": map[string]string{"instance": instance, "name": input}})
	return "已放进表单的「入口与证书」：" + strings.Join(done, "；") + "。\n" + verdict + "。把结果和还缺什么告诉用户。"
}

var certSlotLabel = map[string]string{"certificate": "服务器证书", "private_key": "私钥", "ca_cert": "根 CA", "intermediates": "中间证书"}

// histFiles is every file attached anywhere in a conversation.
func histFiles(msgs []aiMsg) []fileRef {
	var out []fileRef
	for _, m := range msgs {
		out = append(out, m.Files...)
	}
	return out
}

func certTools() []aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	slot := func(d string) map[string]any {
		return map[string]any{"type": "object", "description": d, "properties": map[string]any{
			"file":  str("附件的名称或编号"),
			"picks": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "取文件里的哪几项（inspect_files 里的 # 编号）；省略表示全部"},
		}, "required": []string{"file"}}
	}
	return []aiToolDef{
		{"inspect_files", "查看用户上传的文件里有什么：是证书、p7b 证书包、私钥还是别的；每个证书的主题、签发者、有效期、域名、是服务器证书/中间 CA/根 CA，哪个证书和哪把私钥是一对，是否覆盖入口域名。不会给你私钥内容。省略 files 表示这条消息的全部附件。", map[string]any{"type": "object", "properties": map[string]any{"files": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "附件名称或编号"}}, "required": []string{}}},
		{"place_certificate", "把证书材料放进表单的「入口与证书」。每一项指明取自哪个文件的哪几项：p7b 会被自动拆成 PEM 证书，一个文件里的证书可以拆开放进服务器证书、中间证书和根 CA。放完平台会立刻核对并把结果返回给你。", map[string]any{"type": "object", "properties": map[string]any{
			"certificate":   slot("服务器证书（只能一份，要覆盖入口域名）"),
			"private_key":   slot("与服务器证书配对的私钥"),
			"ca_cert":       slot("根 CA 证书（自签的那份）"),
			"intermediates": slot("中间 CA 证书（可以多份）"),
		}, "required": []string{}}},
	}
}
