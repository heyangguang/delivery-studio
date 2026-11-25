package pkglib

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
)

func newGzip(w io.Writer) *gzip.Writer                { g, _ := gzip.NewWriterLevel(w, gzip.BestSpeed); return g }
func newTar(w io.Writer) *tar.Writer                  { return tar.NewWriter(w) }
func newGzipReader(r io.Reader) (*gzip.Reader, error) { return gzip.NewReader(r) }
func newTarReader(r io.Reader) *tar.Reader            { return tar.NewReader(r) }

func tarFile(tw *tar.Writer, name, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: st.Size(), ModTime: fixedTime, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}
