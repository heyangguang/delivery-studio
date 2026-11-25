package server

import (
	"bytes"
	"crypto"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type certificateMaterial struct{ CA, Server, Key []byte }

func pemCertificates(b []byte) ([]*x509.Certificate, error) {
	var certificates []*x509.Certificate
	for len(bytes.TrimSpace(b)) > 0 {
		block, rest := pem.Decode(b)
		if block == nil || block.Type != "CERTIFICATE" {
			return nil, errors.New("证书文件要是 PEM 格式的证书；不能是 p7b，也不能把私钥放在证书文件里")
		}
		c, e := x509.ParseCertificate(block.Bytes)
		if e != nil {
			return nil, e
		}
		certificates = append(certificates, c)
		b = rest
	}
	if len(certificates) == 0 {
		return nil, errors.New("证书文件是空的")
	}
	return certificates, nil
}
func privateSigner(b []byte) (crypto.Signer, error) {
	block, rest := pem.Decode(b)
	if block == nil || len(bytes.TrimSpace(rest)) > 0 {
		return nil, errors.New("私钥文件里要有且只有一个没加密的 PEM 私钥")
	}
	if x509.IsEncryptedPEMBlock(block) || strings.Contains(block.Type, "ENCRYPTED") {
		return nil, errors.New("私钥是加密的，平台不能用。请在现场安全地解密后再上传，不要把私钥密码写进配置")
	}
	var key any
	var e error
	switch block.Type {
	case "RSA PRIVATE KEY":
		key, e = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		key, e = x509.ParseECPrivateKey(block.Bytes)
	case "PRIVATE KEY":
		key, e = x509.ParsePKCS8PrivateKey(block.Bytes)
	default:
		return nil, errors.New("这种私钥格式不支持，请换成 RSA 或 ECDSA 私钥的 PEM 文件")
	}
	if e != nil {
		return nil, e
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, errors.New("这种私钥算法不支持，请换成 RSA 或 ECDSA")
	}
	return signer, nil
}
func keysMatch(cert *x509.Certificate, key crypto.Signer) bool {
	a, e := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if e != nil {
		return false
	}
	b, e := x509.MarshalPKIXPublicKey(key.Public())
	return e == nil && bytes.Equal(a, b)
}
func readCertificateFile(path string, private bool) ([]byte, error) {
	info, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("证书或私钥必须是普通文件，不能是符号链接：%s", path)
	}
	if private && runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("私钥文件只能让当前用户读写，请先执行 chmod 600：%s", path)
	}
	return os.ReadFile(path)
}
func pemKey(key crypto.Signer) ([]byte, error) {
	raw, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		return nil, e
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}), nil
}

// validateMaterial checks a certificate bundle: CA is a real CA, the chain verifies for server authentication, the key
// matches the leaf, and (when a name is given) the leaf covers that name so clients can use verify-full.
func validateMaterial(domain string, m certificateMaterial) error {
	cas, e := pemCertificates(m.CA)
	if e != nil {
		return fmt.Errorf("CA: %w", e)
	}
	chain, e := pemCertificates(m.Server)
	if e != nil {
		return fmt.Errorf("服务器证书: %w", e)
	}
	roots := x509.NewCertPool()
	for _, ca := range cas {
		if !ca.IsCA || !ca.BasicConstraintsValid || ca.KeyUsage&x509.KeyUsageCertSign == 0 {
			return errors.New("CA 文件里要是能签发证书的 CA 证书，不能用服务器证书代替")
		}
		roots.AddCert(ca)
	}
	leaf := chain[0]
	if leaf.IsCA {
		return errors.New("服务器证书不能是 CA 证书，请上传签发给服务器的证书")
	}
	key, e := privateSigner(m.Key)
	if e != nil {
		return e
	}
	if !keysMatch(leaf, key) {
		return errors.New("服务器证书和私钥对不上，请确认它们是一对")
	}
	intermediates := x509.NewCertPool()
	for _, cert := range chain[1:] {
		if !cert.IsCA {
			return errors.New("服务器证书后面附带的证书必须是中间 CA")
		}
		intermediates.AddCert(cert)
	}
	if _, e = leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, CurrentTime: time.Now()}); e != nil {
		return fmt.Errorf("服务器证书的证书链、用途或有效期有问题：%w", e)
	}
	if domain != "" {
		if e = leaf.VerifyHostname(domain); e != nil {
			return fmt.Errorf("服务器证书里没有包含入口域名 %s，应用用 verify-full 连接时会失败：%w", domain, e)
		}
	}
	return nil
}

type deliveryCertificates struct {
	Mode          string `json:"mode"`
	Certificate   string `json:"certificate"`
	PrivateKey    string `json:"private_key"`
	CA            string `json:"ca_cert,omitempty"`
	Intermediates string `json:"intermediates,omitempty"`
}

// PKCS#7 certificates-only SignedData is a container, not a certificate issuer.
// Only X.509 certificates are extracted; their chain is verified separately.
func p7bCertificates(data []byte) ([]*x509.Certificate, error) {
	if bytes.HasPrefix(bytes.TrimSpace(data), []byte("-----BEGIN")) {
		block, rest := pem.Decode(data)
		if block == nil || (block.Type != "PKCS7" && block.Type != "CMS") || len(bytes.TrimSpace(rest)) != 0 {
			return nil, errors.New("P7B 文件要是单个 PEM 块或 DER 格式")
		}
		data = block.Bytes
	}
	var outer asn1.RawValue
	rest, err := asn1.Unmarshal(data, &outer)
	if err != nil || len(rest) != 0 || outer.Tag != asn1.TagSequence || outer.Class != 0 {
		return nil, errors.New("这个 P7B 文件读不出来，请提供 DER 或 PEM 编码的 P7B")
	}
	var oid asn1.ObjectIdentifier
	rest, err = asn1.Unmarshal(outer.Bytes, &oid)
	if err != nil || !oid.Equal(asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}) {
		return nil, errors.New("P7B必须包含PKCS7 SignedData")
	}
	var wrapper, signed asn1.RawValue
	trailing, err := asn1.Unmarshal(rest, &wrapper)
	if err != nil || len(trailing) != 0 || wrapper.Class != 2 || wrapper.Tag != 0 {
		return nil, errors.New("P7B SignedData包装无效")
	}
	trailing, err = asn1.Unmarshal(wrapper.Bytes, &signed)
	if err != nil || len(trailing) != 0 || signed.Class != 0 || signed.Tag != asn1.TagSequence {
		return nil, errors.New("P7B SignedData内容无效")
	}
	remaining := signed.Bytes
	for i := 0; i < 3; i++ { // version, digestAlgorithms, encapsulatedContentInfo
		var item asn1.RawValue
		remaining, err = asn1.Unmarshal(remaining, &item)
		if err != nil {
			return nil, errors.New("P7B SignedData字段不完整")
		}
	}
	var set asn1.RawValue
	if _, err = asn1.Unmarshal(remaining, &set); err != nil || set.Class != 2 || set.Tag != 0 {
		return nil, errors.New("P7B 文件里没有证书")
	}
	remaining = set.Bytes
	var certs []*x509.Certificate
	for len(remaining) > 0 {
		var item asn1.RawValue
		remaining, err = asn1.Unmarshal(remaining, &item)
		if err != nil || item.Class != 0 || item.Tag != asn1.TagSequence {
			return nil, errors.New("P7B包含不支持的证书类型")
		}
		cert, err := x509.ParseCertificate(item.FullBytes)
		if err != nil {
			return nil, fmt.Errorf("P7B 里的证书读取失败：%w", err)
		}
		certs = append(certs, cert)
	}
	if len(certs) == 0 {
		return nil, errors.New("P7B 文件里没有证书")
	}
	return certs, nil
}

// leafMismatch says exactly why no server certificate fits: the key belongs to none of them, or it does but the
// certificate does not name the entry domain (with the names it does carry, and a hint when they differ by a typo).
func leafMismatch(domain string, certs []*x509.Certificate, key crypto.Signer) error {
	var keyed *x509.Certificate
	for _, c := range certs {
		if !c.IsCA && keysMatch(c, key) {
			keyed = c
			break
		}
	}
	if keyed == nil {
		return errors.New("私钥和上传的服务器证书不是一对：请确认私钥是为这张证书生成的")
	}
	names := append([]string{}, keyed.DNSNames...)
	for _, ip := range keyed.IPAddresses {
		names = append(names, ip.String())
	}
	if len(names) == 0 {
		names = []string{"（没有任何名称）"}
	}
	msg := fmt.Sprintf("证书里没有入口域名 %s：证书只包含 %s。应用用 verify-full 连这个域名会被拒绝。", domain, strings.Join(names, "、"))
	for _, n := range keyed.DNSNames {
		if d := editDistance(strings.ToLower(n), strings.ToLower(domain)); d > 0 && d <= 2 {
			msg += fmt.Sprintf("两者只差 %d 个字符，多半是入口域名写错了，请在「入口与证书」里把入口域名改成 %s。", d, n)
			break
		}
	}
	if !strings.Contains(msg, "多半是") {
		msg += "请换一张包含该域名的证书，或把入口域名改成证书里的名称。"
	}
	return errors.New(msg)
}

// editDistance is the Levenshtein distance, for spotting a mistyped domain.
func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}

func deliveryMaterial(domain string, spec deliveryCertificates, base string) (certificateMaterial, map[string]any, error) {
	read := func(name string, private bool) ([]byte, error) {
		if name == "" {
			return nil, nil
		}
		if !filepath.IsAbs(name) {
			name = filepath.Join(base, name)
		}
		return readCertificateFile(name, private)
	}
	var m certificateMaterial
	if spec.Certificate == "" || spec.PrivateKey == "" {
		return m, nil, errors.New("请提供证书和对应的私钥")
	}
	mode := spec.Mode
	if mode == "" {
		mode = "auto"
	}
	if mode != "auto" && mode != "p7b" && mode != "pem" {
		return m, nil, errors.New("certificates.mode仅支持auto、p7b、pem")
	}
	data, err := read(spec.Certificate, false)
	if err != nil {
		return m, nil, err
	}
	if mode == "auto" {
		if _, err = pemCertificates(data); err == nil {
			mode = "pem"
		} else {
			mode = "p7b"
		}
	}
	m.Key, err = read(spec.PrivateKey, true)
	if err != nil {
		return m, nil, err
	}
	key, err := privateSigner(m.Key)
	if err != nil {
		return m, nil, err
	}
	ca, err := read(spec.CA, false)
	if err != nil {
		return m, nil, err
	}
	extra, err := read(spec.Intermediates, false)
	if err != nil {
		return m, nil, err
	}
	var certs []*x509.Certificate
	if mode == "pem" {
		certs, err = pemCertificates(data)
	} else {
		certs, err = p7bCertificates(data)
	}
	if err != nil {
		return m, nil, err
	}
	if len(extra) > 0 {
		more, err := pemCertificates(extra)
		if err != nil {
			return m, nil, fmt.Errorf("中间证书: %w", err)
		}
		certs = append(certs, more...)
	}
	if len(ca) > 0 {
		roots, err := pemCertificates(ca)
		if err != nil {
			return m, nil, fmt.Errorf("CA文件: %w", err)
		}
		m.CA = ca
		certs = append(certs, roots...)
	} else {
		for _, cert := range certs {
			if cert.IsCA && bytes.Equal(cert.RawIssuer, cert.RawSubject) && cert.CheckSignatureFrom(cert) == nil {
				m.CA = append(m.CA, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})...)
			}
		}
		if len(m.CA) == 0 {
			return m, nil, errors.New("证书包里没有根 CA，请同时提供 CA 证书；平台不会自己生成或下载 CA")
		}
	}
	var leaf *x509.Certificate
	seen := map[string]bool{}
	for _, cert := range certs {
		if !cert.IsCA && keysMatch(cert, key) && (domain == "" || cert.VerifyHostname(domain) == nil) && !seen[digest(cert.Raw)] {
			if leaf != nil {
				return m, nil, errors.New("符合域名和私钥的服务器证书不止一份，请只留一份")
			}
			leaf = cert
			seen[digest(cert.Raw)] = true
		}
	}
	if leaf == nil {
		return m, nil, leafMismatch(domain, certs, key)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(m.CA)
	intermediates := x509.NewCertPool()
	for _, cert := range certs {
		if cert.IsCA {
			intermediates.AddCert(cert)
		}
	}
	chains, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, CurrentTime: time.Now()})
	if err != nil {
		return m, nil, fmt.Errorf("证书的证书链、用途或有效期有问题：%w", err)
	}
	chain := chains[0]
	if mode == "pem" {
		// Already usable PEM stays byte-for-byte unchanged (including the key).
		m.Server = data
		if len(extra) > 0 {
			m.Server = append(append(bytes.TrimSpace(m.Server), '\n'), extra...)
		}
	} else {
		for _, cert := range chain[:len(chain)-1] {
			m.Server = append(m.Server, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})...)
		}
		m.Key, err = pemKey(key)
		if err != nil {
			return m, nil, err
		}
	}
	if err = validateMaterial(domain, m); err != nil {
		return m, nil, err
	}
	var subjects []string
	for _, cert := range chain {
		subjects = append(subjects, cert.Subject.String())
	}
	report := map[string]any{"input_format": mode, "domain": domain, "chain_signature_verified": true,
		"private_key_matches": true, "san_dns": leaf.DNSNames, "leaf_sha256": digest(leaf.Raw),
		"not_after_utc": leaf.NotAfter.UTC().Format(time.RFC3339), "chain": subjects,
		"pem_preserved": mode == "pem", "server_execution": "not run"}
	return m, report, nil
}
