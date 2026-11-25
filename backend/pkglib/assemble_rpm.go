package pkglib

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

var locationRE = regexp.MustCompile(`<location [^>]*/>`)

func (l *Library) writeRpm(tw *tar.Writer, put func(string, []byte) error, files []repoFile) error {
	var primary, filelists, other []string
	for _, f := range files {
		if !strings.HasSuffix(f.ref.File, ".rpm") {
			return fmt.Errorf("%s 不是 .rpm 文件", f.ref.File)
		}
		if f.meta.Primary == "" || f.meta.Filelists == "" || f.meta.Other == "" {
			return fmt.Errorf("%s 缺少仓库元数据，请重新获取", f.ref.File)
		}
		if _, err := writeFile(tw, f); err != nil {
			return err
		}
		// The file may have been stored under a safe name that differs from the one in the original metadata.
		primary = append(primary, locationRE.ReplaceAllString(f.meta.Primary, `<location href="`+f.ref.File+`"/>`))
		filelists = append(filelists, f.meta.Filelists)
		other = append(other, f.meta.Other)
	}
	n := len(files)
	docs := []struct {
		kind, head, tail string
		frags            []string
	}{
		{"primary", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+`<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="%d">`+"\n", n), "</metadata>\n", primary},
		{"filelists", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+`<filelists xmlns="http://linux.duke.edu/metadata/filelists" packages="%d">`+"\n", n), "</filelists>\n", filelists},
		{"other", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+`<otherdata xmlns="http://linux.duke.edu/metadata/other" packages="%d">`+"\n", n), "</otherdata>\n", other},
	}
	var repomd strings.Builder
	repomd.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n" + `<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">` + "\n  <revision>1577836800</revision>\n")
	for _, d := range docs {
		raw := []byte(d.head + strings.Join(d.frags, "\n") + "\n" + d.tail)
		var gzb bytes.Buffer
		gz, _ := gzip.NewWriterLevel(&gzb, gzip.BestCompression)
		gz.Write(raw)
		gz.Close()
		rawSum, gzSum := sha256.Sum256(raw), sha256.Sum256(gzb.Bytes())
		name := fmt.Sprintf("repodata/%s-%s.xml.gz", hex.EncodeToString(gzSum[:]), d.kind)
		if err := put(name, gzb.Bytes()); err != nil {
			return err
		}
		fmt.Fprintf(&repomd, "  <data type=\"%s\">\n    <checksum type=\"sha256\">%s</checksum>\n    <open-checksum type=\"sha256\">%s</open-checksum>\n    <location href=\"%s\"/>\n    <timestamp>1577836800</timestamp>\n    <size>%d</size>\n    <open-size>%d</open-size>\n  </data>\n",
			d.kind, hex.EncodeToString(gzSum[:]), hex.EncodeToString(rawSum[:]), name, gzb.Len(), len(raw))
	}
	repomd.WriteString("</repomd>\n")
	return put("repodata/repomd.xml", []byte(repomd.String()))
}
