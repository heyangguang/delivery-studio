package mwpack

import (
	"io/fs"
	"testing/fstest"
)

// PlatformFiles returns a detached copy of the built-in automation files.
func PlatformFiles() map[string][]byte {
	out := map[string][]byte{}
	_ = fs.WalkDir(platformFS, "platform", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			b, e := fs.ReadFile(platformFS, p)
			if e != nil {
				return e
			}
			out[p[len("platform/"):]] = b
		}
		return nil
	})
	return out
}

// WithPlatformFiles takes a snapshot: publishing cannot change a generation already in progress.
func (c *Catalog) WithPlatformFiles(files map[string][]byte) *Catalog {
	next := *c
	next.platform = fstest.MapFS{}
	for p, b := range files {
		next.platform[p] = &fstest.MapFile{Data: append([]byte(nil), b...), Mode: 0600}
	}
	return &next
}
func (c *Catalog) platformFS() fs.FS {
	if c != nil && c.platform != nil {
		return c.platform
	}
	f, _ := fs.Sub(platformFS, "platform")
	return f
}

func (c *Catalog) PlatformSnapshot() map[string][]byte {
	out := map[string][]byte{}
	fs.WalkDir(c.platformFS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if !d.IsDir() {
			b, err := fs.ReadFile(c.platformFS(), p)
			if err != nil {
				return err
			}
			out[p] = b
		}
		return nil
	})
	return out
}
