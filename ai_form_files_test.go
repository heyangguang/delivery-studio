package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

// One file with the certificate and what signed it, and a key file: the assistant must see the parts for what they are
// and know which certificate the key belongs to.
func TestReadCertFileSortsBundleAndKey(t *testing.T) {
	mk := func(cn string, ca bool, parent *x509.Certificate, pk *ecdsa.PrivateKey, signer *ecdsa.PrivateKey) *x509.Certificate {
		tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: ca, BasicConstraintsValid: true}
		if ca {
			tpl.KeyUsage = x509.KeyUsageCertSign
		} else {
			tpl.DNSNames = []string{"db.example.com"}
		}
		if parent == nil {
			parent = tpl
		}
		der, err := x509.CreateCertificate(rand.Reader, tpl, parent, &pk.PublicKey, signer)
		if err != nil {
			t.Fatal(err)
		}
		c, _ := x509.ParseCertificate(der)
		return c
	}
	k1, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	k2, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	k3, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	root := mk("root", true, nil, k1, k1)
	inter := mk("inter", true, root, k2, k1)
	leaf := mk("db.example.com", false, inter, k3, k2)
	var bundle []byte
	for _, c := range []*x509.Certificate{leaf, inter, root} {
		bundle = append(bundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})...)
	}
	cf := readCertFile(fileNode{Name: "all.pem"}, bundle)
	if len(cf.parts) != 3 || certRole(cf.parts[0].cert) != "服务器证书" || certRole(cf.parts[1].cert) != "中间 CA" || certRole(cf.parts[2].cert) != "根 CA（自签）" {
		t.Fatalf("bundle read wrong: %+v", cf)
	}
	kb, _ := x509.MarshalPKCS8PrivateKey(k3)
	kf := readCertFile(fileNode{Name: "k.key"}, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}))
	if len(kf.parts) != 1 || kf.parts[0].signer == nil || !keysMatch(leaf, kf.parts[0].signer) || keysMatch(inter, kf.parts[0].signer) {
		t.Fatalf("key not matched to its certificate: %+v", kf)
	}
	der := readCertFile(fileNode{Name: "x.cer"}, leaf.Raw)
	if len(der.parts) != 1 || der.parts[0].cert == nil {
		t.Fatalf("DER certificate not read: %+v", der)
	}
	if bad := readCertFile(fileNode{Name: "a.txt"}, []byte("hello")); len(bad.parts) != 0 {
		t.Fatalf("text read as certificate: %+v", bad)
	}
}

// A certificate package arrives as one archive: its files are opened, not refused.
func TestUnpackArchives(t *testing.T) {
	var tb bytes.Buffer
	gz := gzip.NewWriter(&tb)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{"pkg/server.crt": "crt", "pkg/README.txt": "hi", "../evil": "x"} {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	files, _ := unpack(tb.Bytes())
	if string(files["pkg/server.crt"]) != "crt" || files["pkg/README.txt"] == nil || files["../evil"] != nil {
		t.Fatalf("tar.gz not read, or a path escaped: %v", files)
	}
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	f, _ := zw.Create("a/ca.crt")
	f.Write([]byte("ca"))
	zw.Close()
	if z, _ := unpack(zb.Bytes()); string(z["a/ca.crt"]) != "ca" {
		t.Fatal("zip not read")
	}
	if f, _ := unpack([]byte("just text")); f != nil {
		t.Fatal("text taken for an archive")
	}
}
