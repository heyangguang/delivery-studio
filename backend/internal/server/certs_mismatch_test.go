package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The customer's own certificate for jfrog-xray (vwgroup) against an entry domain typed as wwgroup: the error must
// say which names the certificate carries and point at the typo, not a vague "no matching certificate".
func TestCertificateDomainTypoIsExplained(t *testing.T) {
	dir := "../postgresql-certificates/prepared-jfrog-artifactory"
	if _, err := os.Stat(filepath.Join(dir, "server.crt")); err != nil {
		t.Skip("customer certificates not present")
	}
	tmp := t.TempDir()
	for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
		b, _ := os.ReadFile(filepath.Join(dir, f))
		os.WriteFile(filepath.Join(tmp, f), b, 0o600)
	}
	spec := deliveryCertificates{Mode: "auto", Certificate: "server.crt", PrivateKey: "server.key", CA: "ca.crt"}
	want := "jfrog-artifactory.postgresql.private.toolchain.cn.vwgroup.com"
	// the right domain passes
	if _, _, err := deliveryMaterial(want, spec, tmp); err != nil {
		t.Fatalf("the certificate's own domain was refused: %v", err)
	}
	// another service's domain: the names in the certificate are listed
	_, _, err := deliveryMaterial("jfrog-xray.postgresql.private.toolchain.cn.wwgroup.com", spec, tmp)
	if err == nil || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "jfrog-xray.postgresql.private.toolchain.cn.wwgroup.com") {
		t.Fatalf("the mismatch was not explained: %v", err)
	}
	// one letter off: a typo is pointed out
	_, _, err = deliveryMaterial("jfrog-artifactory.postgresql.private.toolchain.cn.wwgroup.com", spec, tmp)
	if err == nil || !strings.Contains(err.Error(), "写错") {
		t.Fatalf("the typo was not pointed out: %v", err)
	}
	t.Log(err)
}
