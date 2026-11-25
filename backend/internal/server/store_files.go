package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Everyone's storage space: folders, text documents and files of any kind. What a person puts into a conversation is
// kept here too (in the folder "对话附件"), so a picture or a PDF can be used again. Documents and files with readable
// text are what the assistant searches as the person's own knowledge. Each person has a quota; an administrator sets
// the default and can give one person more or less.

type fileNode struct {
	ID      string `json:"id"`
	Parent  string `json:"parent,omitempty"` // "" is the top
	Name    string `json:"name"`
	Kind    string `json:"kind"` // folder | doc | file
	Mime    string `json:"mime,omitempty"`
	Size    int64  `json:"size"`
	Created string `json:"created"`
	Updated string `json:"updated"`
	Source  string `json:"source,omitempty"` // "" for what the person put here, "chat" for what came from a conversation
	Text    bool   `json:"text,omitempty"`   // there is readable text (a document, or text taken out of a PDF, Word file…)
	Note    string `json:"note,omitempty"`   // why there is no text, for a file that could have had some
}

type fileIndex struct {
	Nodes []fileNode `json:"nodes"`
}

const (
	chatFolderName = "对话附件"
	maxNameRunes   = 120
	maxFilesPerDir = 5000
)

var filesMu sync.Mutex

func (s *storeServer) filesDir(user string) string {
	return s.aiFile(filepath.Join("users", user, "files"))
}

func (s *storeServer) blobPath(user, id string) string {
	return filepath.Join(s.filesDir(user), "blobs", id)
}

func (s *storeServer) textPath(user, id string) string {
	return filepath.Join(s.filesDir(user), "text", id+".txt")
}

// filesLoad reads a person's index, bringing in the documents they kept before folders existed. Call with filesMu held.
func (s *storeServer) filesLoad(user string) fileIndex {
	var ix fileIndex
	if !userNameOK(user) {
		return ix
	}
	f := filepath.Join(s.filesDir(user), "index.json")
	if b, err := os.ReadFile(f); err == nil {
		_ = json.Unmarshal(b, &ix)
		return ix
	}
	// the old knowledge base: one JSON per document
	old, _ := filepath.Glob(filepath.Join(s.aiFile(filepath.Join("users", user, "kb")), "*.json"))
	for _, o := range old {
		var d struct {
			ID, Title, Created, Updated, Text string
		}
		if b, err := os.ReadFile(o); err != nil || json.Unmarshal(b, &d) != nil || d.ID == "" {
			continue
		}
		if os.MkdirAll(filepath.Dir(s.blobPath(user, d.ID)), 0o700) != nil || os.WriteFile(s.blobPath(user, d.ID), []byte(d.Text), 0o600) != nil {
			continue
		}
		ix.Nodes = append(ix.Nodes, fileNode{ID: d.ID, Name: d.Title, Kind: "doc", Mime: "text/markdown", Size: int64(len(d.Text)), Created: d.Created, Updated: d.Updated, Text: true})
	}
	if len(old) > 0 {
		_ = s.filesSave(user, ix)
		_ = os.Rename(s.aiFile(filepath.Join("users", user, "kb")), s.aiFile(filepath.Join("users", user, "kb.moved")))
	}
	return ix
}

func (s *storeServer) filesSave(user string, ix fileIndex) error {
	return writeJSONFile(filepath.Join(s.filesDir(user), "index.json"), ix)
}

func (ix fileIndex) find(id string) (int, bool) {
	for i, n := range ix.Nodes {
		if n.ID == id {
			return i, true
		}
	}
	return -1, false
}

func (ix fileIndex) children(parent string) []fileNode {
	out := []fileNode{}
	for _, n := range ix.Nodes {
		if n.Parent == parent {
			out = append(out, n)
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		if (out[a].Kind == "folder") != (out[b].Kind == "folder") {
			return out[a].Kind == "folder"
		}
		return strings.ToLower(out[a].Name) < strings.ToLower(out[b].Name)
	})
	return out
}

// path is the folders from the top down to a node.
func (ix fileIndex) path(id string) []fileNode {
	var out []fileNode
	for depth := 0; id != "" && depth < 50; depth++ {
		i, ok := ix.find(id)
		if !ok {
			break
		}
		out = append([]fileNode{ix.Nodes[i]}, out...)
		id = ix.Nodes[i].Parent
	}
	return out
}

func (ix fileIndex) used() int64 {
	var n int64
	for _, x := range ix.Nodes {
		n += x.Size
	}
	return n
}

// descendants are a folder's whole subtree.
func (ix fileIndex) descendants(id string) []string {
	out := []string{}
	var walk func(string)
	walk = func(p string) {
		for _, n := range ix.Nodes {
			if n.Parent == p {
				out = append(out, n.ID)
				if n.Kind == "folder" {
					walk(n.ID)
				}
			}
		}
	}
	walk(id)
	return out
}

// uniqueName keeps names in one folder apart: "a.png", "a (2).png".
func (ix fileIndex) uniqueName(parent, name, except string) string {
	taken := map[string]bool{}
	for _, n := range ix.Nodes {
		if n.Parent == parent && n.ID != except {
			taken[strings.ToLower(n.Name)] = true
		}
	}
	if !taken[strings.ToLower(name)] {
		return name
	}
	ext := path.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if !taken[strings.ToLower(c)] {
			return c
		}
	}
}

// cleanName makes a name safe to show and to keep: no path, no control characters, not too long.
func cleanName(n string) string {
	n = strings.ReplaceAll(n, "\\", "/")
	n = path.Base(n)
	n = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, n)
	n = strings.TrimSpace(n)
	if n == "." || n == ".." || n == "/" {
		return ""
	}
	if utf8.RuneCountInString(n) > maxNameRunes {
		r := []rune(n)
		ext := path.Ext(n)
		if utf8.RuneCountInString(ext) < 16 {
			n = string(r[:maxNameRunes-utf8.RuneCountInString(ext)]) + ext
		} else {
			n = string(r[:maxNameRunes])
		}
	}
	return n
}

// ---- quota ----

type storageSettings struct {
	DefaultGB float64            `json:"default_gb"`
	MaxFileMB int                `json:"max_file_mb"`
	Overrides map[string]float64 `json:"overrides"`
}

func (s *storeServer) storageSettings() storageSettings {
	st := storageSettings{DefaultGB: 20, MaxFileMB: 200, Overrides: map[string]float64{}}
	if b, err := os.ReadFile(filepath.Join(s.settingsDir(), "storage.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.DefaultGB <= 0 {
		st.DefaultGB = 20
	}
	if st.MaxFileMB <= 0 {
		st.MaxFileMB = 200
	}
	if st.Overrides == nil {
		st.Overrides = map[string]float64{}
	}
	return st
}

func (st storageSettings) quotaOf(user string) int64 {
	gb := st.DefaultGB
	if v, ok := st.Overrides[user]; ok {
		gb = v
	}
	return int64(gb * (1 << 30))
}

// ---- text of what was put in ----

// absorb saves the readable text of a stored file next to it, so it can be searched and read by the assistant.
func (s *storeServer) absorb(user string, n *fileNode) {
	n.Text, n.Note = false, ""
	if n.Kind == "doc" {
		n.Text = true
		return
	}
	txt, note := extractText(s.blobPath(user, n.ID), n.Name, n.Mime, n.Size)
	if txt == "" {
		n.Note = note
		_ = os.Remove(s.textPath(user, n.ID))
		return
	}
	if os.MkdirAll(filepath.Dir(s.textPath(user, n.ID)), 0o700) == nil && os.WriteFile(s.textPath(user, n.ID), []byte(txt), 0o600) == nil {
		n.Text = true
	}
}

// fileText is the readable text of a node, if it has any.
func (s *storeServer) fileText(user string, n fileNode) (string, bool) {
	if !n.Text {
		return "", false
	}
	p := s.textPath(user, n.ID)
	if n.Kind == "doc" {
		p = s.blobPath(user, n.ID)
	}
	b, err := os.ReadFile(p)
	return string(b), err == nil
}

// ---- operations ----

var errQuota = errors.New("存储空间不够了")

// storeUpload takes the files of a multipart request into a folder (or "@chat" for the conversation folder).
func (s *storeServer) storeUpload(user string, mr *multipart.Reader, parent string, source string) ([]fileNode, []string, error) {
	st := s.storageSettings()
	quota := st.quotaOf(user)
	var added []fileNode
	var failed []string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return added, failed, fmt.Errorf("上传中断了：%v", err)
		}
		if part.FormName() == "parent" {
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			parent = strings.TrimSpace(string(b))
			continue
		}
		if part.FormName() != "file" || part.FileName() == "" {
			continue
		}
		name := cleanName(part.FileName())
		if name == "" {
			failed = append(failed, "有一个文件没有名字，已跳过")
			continue
		}
		n, err := s.storeOne(user, parent, name, part, st, quota, source)
		switch {
		case err == nil:
			added = append(added, n)
		case errors.Is(err, errQuota):
			failed = append(failed, name+"：存储空间不够了，请先清理一些文件")
		default:
			failed = append(failed, name+"："+err.Error())
		}
	}
	return added, failed, nil
}

// storeOne writes one file of a request into the space, within the quota and the size limit for one file.
func (s *storeServer) storeOne(user, parent, name string, src io.Reader, st storageSettings, quota int64, source string) (fileNode, error) {
	filesMu.Lock()
	ix := s.filesLoad(user)
	if parent == "@chat" {
		parent = s.chatFolder(user, &ix)
	}
	if parent == "@ai" {
		parent = s.namedFolder(user, aiFolderName, "ai", &ix)
	}
	if parent != "" {
		if i, ok := ix.find(parent); !ok || ix.Nodes[i].Kind != "folder" {
			filesMu.Unlock()
			return fileNode{}, errors.New("目标文件夹不存在")
		}
	}
	if len(ix.children(parent)) >= maxFilesPerDir {
		filesMu.Unlock()
		return fileNode{}, errors.New("这个文件夹里的文件太多了")
	}
	room := quota - ix.used()
	filesMu.Unlock()
	if room <= 0 {
		return fileNode{}, errQuota
	}
	limit := int64(st.MaxFileMB) << 20
	if room < limit {
		limit = room
	}
	id := randomStoreToken(6)
	p := s.blobPath(user, id)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return fileNode{}, errors.New("保存失败，请稍后重试")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fileNode{}, errors.New("保存失败，请稍后重试")
	}
	head := make([]byte, 0, 512)
	w := io.MultiWriter(f, writerFunc(func(b []byte) {
		if len(head) < 512 {
			head = append(head, b[:min(len(b), 512-len(head))]...)
		}
	}))
	n, err := io.Copy(w, io.LimitReader(src, limit+1))
	f.Close()
	if err != nil || n > limit {
		os.Remove(p)
		if err == nil {
			if room < int64(st.MaxFileMB)<<20 {
				return fileNode{}, errQuota
			}
			return fileNode{}, fmt.Errorf("单个文件不能超过 %d MB", st.MaxFileMB)
		}
		return fileNode{}, errors.New("上传中断了")
	}
	mt := mime.TypeByExtension(strings.ToLower(path.Ext(name)))
	if mt == "" || strings.HasPrefix(mt, "application/octet") {
		mt = headType(head)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	node := fileNode{ID: id, Parent: parent, Kind: "file", Mime: mt, Size: n, Created: now, Updated: now, Source: source}
	// a small text file is a document: it can be opened and edited here
	if n <= kbMaxBytes && isTextName(name, mt) {
		if b, err := os.ReadFile(p); err == nil && utf8.Valid(b) && !strings.ContainsRune(string(b), 0) {
			node.Kind = "doc"
		}
	}
	node.Name = name
	s.absorb(user, &node)
	filesMu.Lock()
	defer filesMu.Unlock()
	ix = s.filesLoad(user)
	if parent != "" {
		if _, ok := ix.find(parent); !ok {
			os.Remove(p)
			return fileNode{}, errors.New("目标文件夹不存在")
		}
	}
	if ix.used()+n > quota {
		os.Remove(p)
		os.Remove(s.textPath(user, id))
		return fileNode{}, errQuota
	}
	node.Name = ix.uniqueName(parent, name, "")
	ix.Nodes = append(ix.Nodes, node)
	if err := s.filesSave(user, ix); err != nil {
		os.Remove(p)
		return fileNode{}, errors.New("保存失败，请稍后重试")
	}
	return node, nil
}

type writerFunc func([]byte)

func (f writerFunc) Write(b []byte) (int, error) { f(b); return len(b), nil }

func headType(head []byte) string {
	t := httpDetect(head)
	if i := strings.Index(t, ";"); i > 0 {
		t = t[:i]
	}
	return t
}

func httpDetect(b []byte) string { return http.DetectContentType(b) }

func isTextName(name, mt string) bool {
	return kbTextExt[strings.ToLower(path.Ext(name))] || strings.HasPrefix(mt, "text/plain")
}

// chatFolder is the id of the folder for what comes from conversations, made when it is first needed. Call with
// filesMu held; ix is changed and saved when the folder is new.
func (s *storeServer) chatFolder(user string, ix *fileIndex) string {
	return s.namedFolder(user, chatFolderName, "chat", ix)
}

// aiFolderName holds what the assistant makes for a person (converted documents, charts, tables).
const aiFolderName = "AI 生成"

// namedFolder is the folder of that name at the top of the person's space, made when it is not there yet.
func (s *storeServer) namedFolder(user, name, source string, ix *fileIndex) string {
	for _, n := range ix.Nodes {
		if n.Parent == "" && n.Kind == "folder" && n.Name == name {
			return n.ID
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	n := fileNode{ID: randomStoreToken(6), Name: name, Kind: "folder", Created: now, Updated: now, Source: source}
	ix.Nodes = append(ix.Nodes, n)
	_ = s.filesSave(user, *ix)
	return n.ID
}

// newFolder makes a folder.
func (s *storeServer) newFolder(user, parent, name string) (fileNode, error) {
	name = cleanName(name)
	if name == "" {
		return fileNode{}, errors.New("请填写文件夹的名字")
	}
	filesMu.Lock()
	defer filesMu.Unlock()
	ix := s.filesLoad(user)
	if parent != "" {
		if i, ok := ix.find(parent); !ok || ix.Nodes[i].Kind != "folder" {
			return fileNode{}, errors.New("目标文件夹不存在")
		}
	}
	if len(path2ids(ix.path(parent))) >= 12 {
		return fileNode{}, errors.New("文件夹套得太深了，请少套几层")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	n := fileNode{ID: randomStoreToken(6), Parent: parent, Name: ix.uniqueName(parent, name, ""), Kind: "folder", Created: now, Updated: now}
	ix.Nodes = append(ix.Nodes, n)
	return n, s.filesSave(user, ix)
}

func path2ids(ns []fileNode) []string {
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = n.ID
	}
	return out
}

// saveDoc creates or updates a text document.
func (s *storeServer) saveDoc(user, id, parent, name, text string) (fileNode, error) {
	name = cleanName(name)
	if name == "" || utf8.RuneCountInString(name) > maxNameRunes {
		return fileNode{}, fmt.Errorf("请填写标题（%d 字以内）", maxNameRunes)
	}
	if strings.TrimSpace(text) == "" {
		return fileNode{}, errors.New("内容是空的")
	}
	if len(text) > kbMaxBytes {
		return fileNode{}, errors.New("单份文档不能超过 1 MiB")
	}
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return fileNode{}, errors.New("文档只能是文本；图片和其他文件请用「上传」")
	}
	st := s.storageSettings()
	quota := st.quotaOf(user)
	filesMu.Lock()
	defer filesMu.Unlock()
	ix := s.filesLoad(user)
	now := time.Now().UTC().Format(time.RFC3339)
	var n fileNode
	idx := -1
	if id != "" {
		i, ok := ix.find(id)
		if !ok || ix.Nodes[i].Kind != "doc" {
			return fileNode{}, errors.New("没有这份文档")
		}
		idx, n = i, ix.Nodes[i]
	} else {
		if parent != "" {
			if i, ok := ix.find(parent); !ok || ix.Nodes[i].Kind != "folder" {
				return fileNode{}, errors.New("目标文件夹不存在")
			}
		}
		n = fileNode{ID: randomStoreToken(6), Parent: parent, Kind: "doc", Mime: "text/markdown", Created: now, Text: true}
	}
	used := ix.used()
	if idx >= 0 {
		used -= n.Size
	}
	if used+int64(len(text)) > quota {
		return fileNode{}, errQuota
	}
	if err := os.MkdirAll(filepath.Dir(s.blobPath(user, n.ID)), 0o700); err != nil || os.WriteFile(s.blobPath(user, n.ID), []byte(text), 0o600) != nil {
		return fileNode{}, errors.New("保存失败，请稍后重试")
	}
	n.Name, n.Size, n.Updated = ix.uniqueName(n.Parent, name, n.ID), int64(len(text)), now
	if idx >= 0 {
		ix.Nodes[idx] = n
	} else {
		ix.Nodes = append(ix.Nodes, n)
	}
	return n, s.filesSave(user, ix)
}

// moveNode renames and/or moves a node.
func (s *storeServer) moveNode(user, id string, name *string, parent *string) (fileNode, error) {
	filesMu.Lock()
	defer filesMu.Unlock()
	ix := s.filesLoad(user)
	i, ok := ix.find(id)
	if !ok {
		return fileNode{}, errors.New("没有这个文件")
	}
	n := ix.Nodes[i]
	if parent != nil && *parent != n.Parent {
		if *parent != "" {
			j, ok := ix.find(*parent)
			if !ok || ix.Nodes[j].Kind != "folder" {
				return fileNode{}, errors.New("目标文件夹不存在")
			}
			if *parent == id {
				return fileNode{}, errors.New("不能把文件夹放进它自己里面")
			}
			for _, d := range ix.descendants(id) {
				if d == *parent {
					return fileNode{}, errors.New("不能把文件夹放进它自己里面")
				}
			}
		}
		n.Parent = *parent
	}
	if name != nil {
		nm := cleanName(*name)
		if nm == "" {
			return fileNode{}, errors.New("名字不能为空")
		}
		n.Name = nm
	}
	n.Name = ix.uniqueName(n.Parent, n.Name, n.ID)
	n.Updated = time.Now().UTC().Format(time.RFC3339)
	ix.Nodes[i] = n
	return n, s.filesSave(user, ix)
}

// removeNode deletes a file, or a folder with everything in it. It returns how many files went.
func (s *storeServer) removeNode(user, id string) (int, error) {
	filesMu.Lock()
	defer filesMu.Unlock()
	ix := s.filesLoad(user)
	if _, ok := ix.find(id); !ok {
		return 0, errors.New("没有这个文件")
	}
	gone := map[string]bool{id: true}
	for _, d := range ix.descendants(id) {
		gone[d] = true
	}
	keep := ix.Nodes[:0]
	files := 0
	for _, n := range ix.Nodes {
		if gone[n.ID] {
			_ = os.Remove(s.blobPath(user, n.ID))
			_ = os.Remove(s.textPath(user, n.ID))
			if n.Kind != "folder" {
				files++
			}
			continue
		}
		keep = append(keep, n)
	}
	ix.Nodes = keep
	return files, s.filesSave(user, ix)
}

// ---- HTTP ----

// rawTypes are shown in the browser; everything else is downloaded.
var rawTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "application/pdf": true}

func (s *storeServer) handleMeFiles(w http.ResponseWriter, r *http.Request, me string, rest []string) {
	switch {
	case len(rest) == 0 && r.Method == "GET":
		q := r.URL.Query()
		filesMu.Lock()
		ix := s.filesLoad(me)
		filesMu.Unlock()
		st := s.storageSettings()
		usage := map[string]any{"used": ix.used(), "quota": st.quotaOf(me), "max_file": int64(st.MaxFileMB) << 20}
		if q.Get("recent") != "" {
			var files []fileNode
			for _, n := range ix.Nodes {
				if n.Kind != "folder" && (q.Get("recent") != "image" || strings.HasPrefix(n.Mime, "image/")) {
					files = append(files, n)
				}
			}
			sort.Slice(files, func(a, b int) bool { return files[a].Updated > files[b].Updated })
			if len(files) > 40 {
				files = files[:40]
			}
			s.writeJSON(w, 200, map[string]any{"nodes": files, "usage": usage})
			return
		}
		parent := q.Get("parent")
		if parent != "" {
			if _, ok := ix.find(parent); !ok {
				s.fail(w, 404, "没有这个文件夹")
				return
			}
		}
		nodes := ix.children(parent)
		if t := strings.ToLower(strings.TrimSpace(q.Get("name"))); t != "" {
			nodes = nil
			for _, n := range ix.Nodes {
				if strings.Contains(strings.ToLower(n.Name), t) {
					nodes = append(nodes, n)
				}
			}
			sort.Slice(nodes, func(a, b int) bool { return nodes[a].Updated > nodes[b].Updated })
			if len(nodes) > 200 {
				nodes = nodes[:200]
			}
		}
		crumbs := ix.path(parent)
		if crumbs == nil {
			crumbs = []fileNode{}
		}
		s.writeJSON(w, 200, map[string]any{"nodes": nodes, "path": crumbs, "usage": usage})
	case len(rest) == 0 && r.Method == "POST":
		ct := r.Header.Get("Content-Type")
		if strings.HasPrefix(ct, "multipart/") {
			st := s.storageSettings()
			// one request may carry several files, but not more than the room there is
			r.Body = http.MaxBytesReader(w, r.Body, st.quotaOf(me)+(1<<20))
			mr, err := r.MultipartReader()
			if err != nil {
				s.fail(w, 400, "上传失败：请求读不出来")
				return
			}
			added, failed, err := s.storeUpload(me, mr, r.URL.Query().Get("parent"), r.URL.Query().Get("source"))
			if err != nil && len(added) == 0 {
				s.fail(w, 400, err.Error())
				return
			}
			if len(added) > 0 {
				s.auditReq(r, "me-files-upload", me, fmt.Sprintf("%s 等 %d 个", added[0].Name, len(added)))
			}
			s.writeJSON(w, 200, map[string]any{"added": nzNodes(added), "failed": nzStrings(failed)})
			return
		}
		var in struct {
			Kind   string `json:"kind"`
			Name   string `json:"name"`
			Parent string `json:"parent"`
			Text   string `json:"text"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+4096)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		var n fileNode
		var err error
		if in.Kind == "folder" {
			n, err = s.newFolder(me, in.Parent, in.Name)
		} else {
			n, err = s.saveDoc(me, "", in.Parent, in.Name, in.Text)
		}
		if err != nil {
			s.fail(w, map[bool]int{true: 413, false: 400}[errors.Is(err, errQuota)], err.Error())
			return
		}
		s.auditReq(r, "me-files-add", me, n.Name)
		s.writeJSON(w, 201, n)
	case len(rest) == 1 && r.Method == "GET":
		filesMu.Lock()
		ix := s.filesLoad(me)
		filesMu.Unlock()
		i, ok := ix.find(rest[0])
		if !ok {
			s.fail(w, 404, "没有这个文件")
			return
		}
		n := ix.Nodes[i]
		out := map[string]any{"node": n, "path": ix.path(n.Parent)}
		if t, ok := s.fileText(me, n); ok {
			if len(t) > 400_000 {
				t = t[:400_000]
				out["truncated"] = true
			}
			out["text"] = t
		}
		s.writeJSON(w, 200, out)
	case len(rest) == 1 && r.Method == "PUT":
		var in struct{ Name, Text string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+4096)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		n, err := s.saveDoc(me, rest[0], "", in.Name, in.Text)
		if err != nil {
			s.fail(w, map[bool]int{true: 413, false: 400}[errors.Is(err, errQuota)], err.Error())
			return
		}
		s.auditReq(r, "me-files-edit", me, n.Name)
		s.writeJSON(w, 200, n)
	case len(rest) == 1 && r.Method == "PATCH":
		var in struct {
			Name   *string `json:"name"`
			Parent *string `json:"parent"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		n, err := s.moveNode(me, rest[0], in.Name, in.Parent)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		s.auditReq(r, "me-files-move", me, n.Name)
		s.writeJSON(w, 200, n)
	case len(rest) == 1 && r.Method == "DELETE":
		filesMu.Lock()
		ix := s.filesLoad(me)
		filesMu.Unlock()
		name := ""
		if i, ok := ix.find(rest[0]); ok {
			name = ix.Nodes[i].Name
		}
		n, err := s.removeNode(me, rest[0])
		if err != nil {
			s.fail(w, 404, err.Error())
			return
		}
		s.auditReq(r, "me-files-delete", me, name)
		s.writeJSON(w, 200, map[string]any{"ok": true, "files": n})
	case len(rest) == 2 && rest[1] == "raw" && r.Method == "GET":
		filesMu.Lock()
		ix := s.filesLoad(me)
		filesMu.Unlock()
		i, ok := ix.find(rest[0])
		if !ok || ix.Nodes[i].Kind == "folder" {
			s.fail(w, 404, "没有这个文件")
			return
		}
		n := ix.Nodes[i]
		f, err := os.Open(s.blobPath(me, n.ID))
		if err != nil {
			s.fail(w, 404, "文件已经找不到了")
			return
		}
		defer f.Close()
		inline := rawTypes[n.Mime]
		disp := "attachment"
		if inline && r.URL.Query().Get("download") == "" {
			disp = "inline"
		}
		w.Header().Set("Content-Type", map[bool]string{true: n.Mime, false: "application/octet-stream"}[inline])
		w.Header().Set("Content-Disposition", disp+"; filename*=UTF-8''"+pathEscape(n.Name))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
		w.Header().Set("Cache-Control", "private, max-age=300")
		if disp == "attachment" {
			s.auditReq(r, "me-files-download", me, n.Name)
		}
		http.ServeContent(w, r, n.Name, time.Time{}, f)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func pathEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.~", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func nzNodes(x []fileNode) []fileNode {
	if x == nil {
		return []fileNode{}
	}
	return x
}

func nzStrings(x []string) []string {
	if x == nil {
		return []string{}
	}
	return x
}

// ---- settings: the default quota and the limit for one file, and a person's own quota ----

func (s *storeServer) saveStorageSettings(st storageSettings) error {
	return writeJSONFile(filepath.Join(s.settingsDir(), "storage.json"), st)
}

// userUsage is how much of the space a person has used.
func (s *storeServer) userUsage(user string) int64 {
	filesMu.Lock()
	defer filesMu.Unlock()
	return s.filesLoad(user).used()
}

func (s *storeServer) handleStorageSettings(w http.ResponseWriter, r *http.Request, session storeSession) {
	switch r.Method {
	case "GET":
		st := s.storageSettings()
		s.mu.Lock()
		names := make([]string, 0, len(s.users))
		for n := range s.users {
			names = append(names, n)
		}
		s.mu.Unlock()
		sort.Strings(names)
		type row struct {
			User     string   `json:"user"`
			Used     int64    `json:"used"`
			Quota    int64    `json:"quota"`
			Override *float64 `json:"override,omitempty"`
		}
		rows := []row{}
		var total int64
		for _, n := range names {
			x := row{User: n, Used: s.userUsage(n), Quota: st.quotaOf(n)}
			if v, ok := st.Overrides[n]; ok {
				v := v
				x.Override = &v
			}
			total += x.Used
			rows = append(rows, x)
		}
		s.writeJSON(w, 200, map[string]any{"settings": st, "users": rows, "total_used": total})
	case "PUT":
		var in storageSettings
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in) != nil || in.DefaultGB < 0.1 || in.DefaultGB > 100000 || in.MaxFileMB < 1 || in.MaxFileMB > 102400 {
			s.fail(w, 400, "默认额度要在 0.1 GB 到 100000 GB 之间，单个文件上限要在 1 MB 到 100 GB 之间")
			return
		}
		clean := map[string]float64{}
		for u, v := range in.Overrides {
			s.mu.Lock()
			_, ok := s.users[u]
			s.mu.Unlock()
			if ok && v >= 0 && v <= 100000 {
				clean[u] = v
			}
		}
		in.Overrides = clean
		if err := s.saveStorageSettings(in); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "storage-settings", session.User, fmt.Sprintf("默认 %g GB，单个文件 %d MB", in.DefaultGB, in.MaxFileMB))
		s.writeJSON(w, 200, map[string]any{"settings": s.storageSettings()})
	default:
		s.fail(w, 405, "方法不支持")
	}
}

// setUserQuota gives one person their own quota in GB, or goes back to the default (gb < 0).
func (s *storeServer) setUserQuota(w http.ResponseWriter, r *http.Request, session storeSession, user string) {
	var in struct {
		GB *float64 `json:"gb"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil || in.GB == nil || *in.GB > 100000 {
		s.fail(w, 400, "额度要填 0 到 100000 之间的数字（GB）；留空表示用默认额度")
		return
	}
	st := s.storageSettings()
	if *in.GB < 0 {
		delete(st.Overrides, user)
	} else {
		st.Overrides[user] = *in.GB
	}
	if err := s.saveStorageSettings(st); err != nil {
		s.fail(w, 500, "保存失败，请稍后重试")
		return
	}
	s.auditReq(r, "user-quota", session.User, fmt.Sprintf("%s %g GB", user, *in.GB))
	s.writeJSON(w, 200, map[string]any{"quota": st.quotaOf(user), "used": s.userUsage(user)})
}

// ---- what a conversation carries ----

const (
	attachTextEach  = 14000   // characters of one file given to the model at once
	attachTextTotal = 36000   // all files of one message
	attachImageMax  = 6 << 20 // bytes of one picture sent to the model
	attachImages    = 4
)

// attachments looks up the files a message names; they must be the person's own.
func (s *storeServer) attachments(user string, ids []string) ([]fileNode, string) {
	if len(ids) == 0 {
		return nil, ""
	}
	filesMu.Lock()
	ix := s.filesLoad(user)
	filesMu.Unlock()
	var out []fileNode
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		i, ok := ix.find(id)
		if !ok || ix.Nodes[i].Kind == "folder" {
			return nil, "附件已经不存在了，请重新选择"
		}
		out = append(out, ix.Nodes[i])
	}
	return out, ""
}

// attachedContent is the model's view of a message with files: the words, the pictures (when the model can see), and
// the beginning of every file that has text. Secrets are taken out of the text first.
func (s *storeServer) attachedContent(user, message string, files []fileNode, vision bool) (any, string) {
	var text strings.Builder
	text.WriteString(message)
	var parts []map[string]any
	notice := ""
	budget := attachTextTotal
	images := 0
	for _, n := range files {
		switch {
		case strings.HasPrefix(n.Mime, "image/") && rawTypes[n.Mime]:
			if !vision {
				fmt.Fprintf(&text, "\n（附了图片「%s」，当前模型不能看图，没有交给它）", n.Name)
				notice = "当前模型不能看图，图片没有发给它；换一个能看图的模型，或把图里的文字贴出来"
				continue
			}
			if images >= attachImages || n.Size > attachImageMax {
				fmt.Fprintf(&text, "\n（图片「%s」没有交给模型：一次最多 %d 张，每张不超过 %d MB）", n.Name, attachImages, attachImageMax>>20)
				continue
			}
			b, err := os.ReadFile(s.blobPath(user, n.ID))
			if err != nil {
				continue
			}
			images++
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + n.Mime + ";base64," + base64Std(b)}})
			fmt.Fprintf(&text, "\n（附了图片「%s」）", n.Name)
		case n.Text:
			t, _ := s.fileText(user, n)
			t = aiScrub(t)
			total := utf8.RuneCountInString(t)
			limit := min(attachTextEach, max(budget, 0))
			if limit <= 0 {
				fmt.Fprintf(&text, "\n（附件「%s」放不下了；需要时用 read_knowledge 读它，编号 %s）", n.Name, n.ID)
				continue
			}
			r := []rune(t)
			shown := string(r[:min(len(r), limit)])
			budget -= utf8.RuneCountInString(shown)
			fmt.Fprintf(&text, "\n\n【附件「%s」（编号 %s）的内容】\n%s", n.Name, n.ID, shown)
			if total > limit {
				fmt.Fprintf(&text, "\n…（共 %d 字，后面的用 read_knowledge 继续读，编号 %s，from=%d）", total, n.ID, limit)
			}
		default:
			why := n.Note
			if why == "" {
				why = "平台读不出里面的内容"
			}
			fmt.Fprintf(&text, "\n（附了文件「%s」，编号 %s：%s）", n.Name, n.ID, why)
		}
	}
	if len(parts) == 0 {
		return text.String(), notice
	}
	return append([]map[string]any{{"type": "text", "text": text.String()}}, parts...), notice
}

func base64Std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
