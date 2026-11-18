package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// compStore keeps what the component workbench needs beside the published components: one working draft per
// component, and a numbered revision for every publish. Directories starting with a dot are ignored by the catalog
// loader, so none of this can be mistaken for a component.
//
//	<components>/<name>/                  the published component (what deliveries are generated from)
//	<components>/.work/<name>/            the draft: meta.json and files/
//	<components>/.history/<name>/<0001>/  a revision: meta.json and files/
type compStore struct {
	root    string // the components directory
	builtin fs.FS  // the built-in components
}

type draftMeta struct {
	// Source says what the draft started from: "live" (the published component), "builtin", "template:<kind>" or
	// "revision:<n>".
	Source  string `json:"source"`
	BaseRev int    `json:"base_rev"` // the published revision the draft started from
	Created string `json:"created"`
	Updated string `json:"updated"`
	User    string `json:"user"`
}

type revMeta struct {
	Rev     int    `json:"rev"`
	Time    string `json:"time"`
	User    string `json:"user"`
	Note    string `json:"note,omitempty"`
	Files   int    `json:"files"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Changed int    `json:"changed"`
}

var errNoDraft = errors.New("没有草稿")

func (c *compStore) live(name string) string {
	if name == sharedPlatformName {
		return filepath.Join(c.root, ".platform")
	}
	return filepath.Join(c.root, name)
}
func (c *compStore) work(name string) string    { return filepath.Join(c.root, ".work", name) }
func (c *compStore) history(name string) string { return filepath.Join(c.root, ".history", name) }
func now() string                               { return time.Now().UTC().Format(time.RFC3339Nano) }

// liveSet reads the component as published: the custom one if there is one, otherwise the built-in. source is
// "custom", "builtin" or "override".
func (c *compStore) liveSet(name string) (fileSet, string, error) {
	_, isBuiltin := builtinNamesIn(c.builtin)[name]
	if name == sharedPlatformName {
		isBuiltin = true
	}
	if st, err := os.Stat(filepath.Join(c.live(name), "component.yaml")); err == nil && st.Mode().IsRegular() {
		set, err := readFileSetDir(c.live(name))
		if err != nil {
			return nil, "", err
		}
		if isBuiltin {
			return set, "override", nil
		}
		return set, "custom", nil
	}
	if name == sharedPlatformName {
		return sharedBuiltin(), "builtin", nil
	}
	if isBuiltin {
		set, err := readFileSet(c.builtin, name)
		return set, "builtin", err
	}
	return nil, "", fs.ErrNotExist
}

// builtinSet reads the built-in original of a component, even while an override replaces it.
func (c *compStore) builtinSet(name string) (fileSet, error) {
	if name == sharedPlatformName {
		return sharedBuiltin(), nil
	}
	if _, ok := builtinNamesIn(c.builtin)[name]; !ok {
		return nil, fs.ErrNotExist
	}
	return readFileSet(c.builtin, name)
}

func builtinNamesIn(fsys fs.FS) map[string]struct{} {
	out := map[string]struct{}{}
	if entries, err := fs.ReadDir(fsys, "."); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				if _, err := fs.Stat(fsys, path.Join(e.Name(), "component.yaml")); err == nil {
					out[e.Name()] = struct{}{}
				}
			}
		}
	}
	return out
}

// ---- revisions ----

func (c *compStore) revNumbers(name string) []int {
	entries, _ := os.ReadDir(c.history(name))
	var out []int
	for _, e := range entries {
		if n, err := strconv.Atoi(e.Name()); err == nil && e.IsDir() {
			out = append(out, n)
		}
	}
	sort.Ints(out)
	return out
}

// liveRev is the number of the newest revision, 0 when the component has never been published through the workbench.
func (c *compStore) liveRev(name string) int {
	n := c.revNumbers(name)
	if len(n) == 0 {
		return 0
	}
	return n[len(n)-1]
}

func (c *compStore) revisions(name string) []revMeta {
	var out []revMeta
	for _, n := range c.revNumbers(name) {
		var m revMeta
		if b, err := os.ReadFile(filepath.Join(c.history(name), fmt.Sprintf("%04d", n), "meta.json")); err == nil && json.Unmarshal(b, &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func (c *compStore) revisionSet(name string, rev int) (fileSet, error) {
	dir := filepath.Join(c.history(name), fmt.Sprintf("%04d", rev), "files")
	if _, err := os.Stat(dir); err != nil {
		return nil, fs.ErrNotExist
	}
	return readFileSetDir(dir)
}

// snapshot stores a revision and returns its number. prev is what the component was before, for the change counts.
func (c *compStore) snapshot(name string, files, prev fileSet, user, note string) (int, error) {
	rev := c.liveRev(name) + 1
	dir := filepath.Join(c.history(name), fmt.Sprintf("%04d", rev))
	if err := writeFileSet(filepath.Join(dir, "files"), files); err != nil {
		return 0, err
	}
	a, r, ch := diffSets(prev, files)
	meta := revMeta{Rev: rev, Time: now(), User: user, Note: note, Files: len(files), Added: len(a), Removed: len(r), Changed: len(ch)}
	b, _ := json.MarshalIndent(meta, "", "  ")
	return rev, os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o600)
}

// ---- the draft ----

func (c *compStore) hasDraft(name string) bool {
	_, err := os.Stat(filepath.Join(c.work(name), "meta.json"))
	return err == nil
}

func (c *compStore) readDraft(name string) (fileSet, draftMeta, error) {
	var meta draftMeta
	b, err := os.ReadFile(filepath.Join(c.work(name), "meta.json"))
	if err != nil {
		return nil, meta, errNoDraft
	}
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil, meta, fmt.Errorf("草稿信息损坏：%w", err)
	}
	set, err := readFileSetDir(filepath.Join(c.work(name), "files"))
	return set, meta, err
}

// writeDraft replaces the draft atomically: the new files are written beside it and swapped in.
func (c *compStore) writeDraft(name string, files fileSet, meta draftMeta) error {
	if err := files.check(); err != nil {
		return err
	}
	parent := filepath.Join(c.root, ".work")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, "."+name+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := writeFileSet(filepath.Join(stage, "files"), files); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(filepath.Join(stage, "meta.json"), b, 0o600); err != nil {
		return err
	}
	old := ""
	if _, err := os.Stat(c.work(name)); err == nil {
		old = filepath.Join(parent, "."+name+".old-"+randomStoreToken(4))
		if err := os.Rename(c.work(name), old); err != nil {
			return err
		}
	}
	if err := os.Rename(stage, c.work(name)); err != nil {
		if old != "" {
			_ = os.Rename(old, c.work(name))
		}
		return err
	}
	if old != "" {
		_ = os.RemoveAll(old)
	}
	return nil
}

func (c *compStore) discardDraft(name string) error { return os.RemoveAll(c.work(name)) }

// publishFiles installs a validated set as the published component. The caller has already proved the catalog loads
// with it; install only swaps directories, and reload (called by the caller through done) can still undo it.
func (c *compStore) installLive(name string, files fileSet, reload func() error) (restore func(), err error) {
	scratch := filepath.Dir(c.root)
	stage, err := os.MkdirTemp(scratch, ".component-stage-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stage)
	if err := writeFileSet(filepath.Join(stage, name), files); err != nil {
		return nil, err
	}
	target := c.live(name)
	backup := ""
	if _, err := os.Stat(target); err == nil {
		backup = filepath.Join(scratch, ".component-trash-"+name+"-"+randomStoreToken(4))
		if err := os.Rename(target, backup); err != nil {
			return nil, err
		}
	}
	undo := func() {
		_ = os.RemoveAll(target)
		if backup != "" {
			_ = os.Rename(backup, target)
		}
	}
	if err := os.Rename(filepath.Join(stage, name), target); err != nil {
		undo()
		return nil, err
	}
	if err := reload(); err != nil {
		undo()
		_ = reload()
		return nil, err
	}
	return func() {
		if backup != "" {
			_ = os.RemoveAll(backup)
		}
	}, nil
}

// removeAll deletes a custom component with its draft and history.
func (c *compStore) removeAll(name string) error {
	for _, d := range []string{c.live(name), c.work(name), c.history(name)} {
		if err := os.RemoveAll(d); err != nil {
			return err
		}
	}
	return nil
}

// summary of a draft against what is published, for the header of the workbench.
type draftStatus struct {
	Exists  bool       `json:"exists"`
	Meta    *draftMeta `json:"meta,omitempty"`
	Added   []string   `json:"added"`
	Removed []string   `json:"removed"`
	Changed []string   `json:"changed"`
	Stale   bool       `json:"stale"` // the published component moved on since the draft started
}

func (c *compStore) status(name string) draftStatus {
	st := draftStatus{Added: []string{}, Removed: []string{}, Changed: []string{}}
	files, meta, err := c.readDraft(name)
	if err != nil {
		return st
	}
	st.Exists, st.Meta = true, &meta
	base, _, err := c.liveSet(name)
	if err != nil {
		st.Added = files.paths()
		return st
	}
	a, r, ch := diffSets(base, files)
	st.Added, st.Removed, st.Changed = nz(a), nz(r), nz(ch)
	st.Stale = c.liveRev(name) != meta.BaseRev
	return st
}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func safeName(n string) bool { return nameRE.MatchString(n) && !strings.HasPrefix(n, ".") }
