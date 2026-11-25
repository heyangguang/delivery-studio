package server

import (
	"os"
	"testing"
	"unicode/utf8"
)

// a throwaway check against real manuals sitting next to the project
func TestRealPDFs(t *testing.T) {
	for _, f := range []string{"../大众PPG部署手册 v1.1.pdf", "../Region China Virtual Client (vClient) User Guide for Microsoft Authenticator Login for VGC.pdf"} {
		if _, err := os.Stat(f); err != nil {
			t.Skip()
		}
		txt, note := extractText(f, "x.pdf", "application/pdf", 1)
		r := []rune(txt)
		if len(r) > 300 {
			r = r[:300]
		}
		t.Logf("%s: %d chars, note=%q valid=%v\n%s", f, len(txt), note, utf8.ValidString(txt), string(r))
	}
}
