package server

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// A person's knowledge base: notes and documents they keep for their own conversations (runbooks of their site,
// network layouts, past incidents). The assistant searches it with search_knowledge and reads a document with
// read_knowledge. What it gets is scrubbed like everything else: passwords and keys never reach a model.

const (
	kbMaxBytes = 1 << 20 // one text document
	kbChunk    = 700     // characters in one search hit
)

// kbDoc is a document of the knowledge base as the assistant and the pages see it: a node of the storage space that
// has readable text.
type kbDoc struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Name    string `json:"name,omitempty"`
	Parent  string `json:"parent,omitempty"`
	Size    int    `json:"size"`
	Created string `json:"created"`
	Updated string `json:"updated"`
	Text    string `json:"text,omitempty"`
}

var kbIDRE = regexp.MustCompile(`^[a-f0-9]{12}$`)

// userNameOK accepts the names accounts may have, so a name can be part of a path.
func userNameOK(n string) bool {
	return n != "" && len(n) <= 64 && !strings.ContainsAny(n, `/\.`+"\x00")
}

func docOf(n fileNode) kbDoc {
	return kbDoc{ID: n.ID, Title: n.Name, Name: n.Name, Parent: n.Parent, Size: int(n.Size), Created: n.Created, Updated: n.Updated}
}

// kbList is a person's documents and files that have text, newest first, without the text.
func (s *storeServer) kbList(user string) []kbDoc {
	filesMu.Lock()
	ix := s.filesLoad(user)
	filesMu.Unlock()
	out := []kbDoc{}
	for _, n := range ix.Nodes {
		if n.Text && n.Kind != "folder" {
			out = append(out, docOf(n))
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Updated > out[b].Updated })
	return out
}

func (s *storeServer) kbGet(user, id string) (kbDoc, bool) {
	if !kbIDRE.MatchString(id) {
		return kbDoc{}, false
	}
	filesMu.Lock()
	ix := s.filesLoad(user)
	filesMu.Unlock()
	i, ok := ix.find(id)
	if !ok {
		return kbDoc{}, false
	}
	t, ok := s.fileText(user, ix.Nodes[i])
	if !ok {
		return kbDoc{}, false
	}
	d := docOf(ix.Nodes[i])
	d.Text = t
	return d, true
}

// kbSave writes a text document (see saveDoc); a new one gets an id.
func (s *storeServer) kbSave(user string, d kbDoc) (kbDoc, error) {
	n, err := s.saveDoc(user, d.ID, d.Parent, d.Title, d.Text)
	if err != nil {
		return d, err
	}
	d = docOf(n)
	return d, nil
}

func (s *storeServer) kbDelete(user, id string) bool {
	_, err := s.removeNode(user, id)
	return err == nil
}

// ---- search ----

// kbTerms splits a query into what to look for: words of letters and digits, and pairs of Chinese characters (a
// single character is too common to mean much).
func kbTerms(q string) []string {
	q = strings.ToLower(q)
	var out []string
	seen := map[string]bool{}
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	var word, han []rune
	flushWord := func() {
		if len(word) > 1 {
			add(string(word))
		}
		word = word[:0]
	}
	flushHan := func() {
		if len(han) == 1 {
			add(string(han))
		}
		for i := 0; i+1 < len(han); i++ {
			add(string(han[i : i+2]))
		}
		han = han[:0]
	}
	for _, r := range q {
		switch {
		case unicode.Is(unicode.Han, r):
			flushWord()
			han = append(han, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' || r == '.':
			flushHan()
			word = append(word, r)
		default:
			flushWord()
			flushHan()
		}
	}
	flushWord()
	flushHan()
	return out
}

// kbChunks cuts a document into pieces of about kbChunk characters along paragraph lines.
func kbChunks(text string) []string {
	var out []string
	var cur strings.Builder
	for _, para := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		if cur.Len() > 0 && utf8.RuneCountInString(cur.String())+utf8.RuneCountInString(para) > kbChunk {
			out = append(out, cur.String())
			cur.Reset()
		}
		for utf8.RuneCountInString(para) > kbChunk*2 {
			r := []rune(para)
			out = append(out, string(r[:kbChunk]))
			para = string(r[kbChunk:])
		}
		if cur.Len() > 0 {
			cur.WriteString("\n\n")
		}
		cur.WriteString(para)
	}
	if strings.TrimSpace(cur.String()) != "" {
		out = append(out, cur.String())
	}
	return out
}

type kbHit struct {
	Doc   kbDoc
	Part  int
	Text  string
	Score float64
	Team  bool // from the team knowledge base rather than the person's own
}

// kbSrc is a document to search and whose it is.
type kbSrc struct {
	kbDoc
	Team bool
}

// kbSearch searches a person's own documents.
func (s *storeServer) kbSearch(user, query string, limit int) []kbHit {
	return kbRank(s.kbOwn(user), query, limit)
}

func (s *storeServer) kbOwn(user string) []kbSrc {
	var docs []kbSrc
	for _, d := range s.kbList(user) {
		if full, ok := s.kbGet(user, d.ID); ok {
			docs = append(docs, kbSrc{full, false})
		}
	}
	return docs
}

// kbRank ranks the pieces of documents by the query's terms, rarer terms counting more.
func kbRank(docs []kbSrc, query string, limit int) []kbHit {
	terms := kbTerms(query)
	if len(terms) == 0 {
		return nil
	}
	type piece struct {
		doc  kbSrc
		part int
		text string
		low  string
	}
	var all []piece
	for _, d := range docs {
		for i, c := range kbChunks(d.Title + "\n\n" + d.Text) {
			all = append(all, piece{d, i, c, strings.ToLower(c)})
		}
	}
	df := map[string]int{}
	for _, p := range all {
		for _, t := range terms {
			if strings.Contains(p.low, t) {
				df[t]++
			}
		}
	}
	var hits []kbHit
	for _, p := range all {
		score := 0.0
		for _, t := range terms {
			if n := strings.Count(p.low, t); n > 0 {
				score += (1 + math.Log(float64(n))) * math.Log(1+float64(len(all))/float64(df[t]))
			}
		}
		if score > 0 {
			d := p.doc.kbDoc
			d.Text = ""
			hits = append(hits, kbHit{d, p.part, p.text, score, p.doc.Team})
		}
	}
	sort.SliceStable(hits, func(a, b int) bool { return hits[a].Score > hits[b].Score })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

func kbTools() []aiToolDef {
	return []aiToolDef{
		{"search_knowledge", "在知识库里搜索：用户自己的资料和团队知识库（现场资料、手册、过往问题和处理办法）。返回最相关的片段和出处。", map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string", "description": "要找的内容，可以是关键词或一句话"}}, "required": []string{"query"}}},
		{"read_knowledge", "读取知识库里一份资料的全文（很长时分段，用 from 指定从第几个字开始）。", map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string", "description": "资料编号（search_knowledge 的结果里有）"}, "from": map[string]any{"type": "integer", "description": "从第几个字开始，默认 0"}}, "required": []string{"id"}}},
	}
}

func (s *storeServer) runKB(user, name, args string) string {
	var a struct {
		Query string `json:"query"`
		ID    string `json:"id"`
		From  int    `json:"from"`
	}
	_ = json.Unmarshal([]byte(args), &a)
	switch name {
	case "search_knowledge":
		docs := s.kbOwn(user)
		for _, d := range s.teamDocsFor(user) {
			if full, ok := s.teamDoc(d.ID); ok {
				docs = append(docs, kbSrc{full.kbDoc, true})
			}
		}
		hits := kbRank(docs, a.Query, 6)
		if len(hits) == 0 {
			return "知识库里没有找到相关内容：" + a.Query
		}
		var b strings.Builder
		for _, h := range hits {
			whose := "我的资料"
			if h.Team {
				whose = "团队知识库"
			}
			fmt.Fprintf(&b, "## 《%s》（%s，编号 %s，第 %d 段）\n%s\n\n", h.Doc.Title, whose, h.Doc.ID, h.Part+1, aiScrub(h.Text))
		}
		return strings.TrimSpace(b.String())
	case "read_knowledge":
		d, ok := s.kbGet(user, a.ID)
		if !ok {
			if t, found := s.teamDoc(a.ID); found && s.teamDocVisible(user, t) {
				d, ok = t.kbDoc, true
			}
		}
		if !ok {
			return "没有这份资料：" + a.ID
		}
		r := []rune(aiScrub(d.Text))
		from := a.From
		if from < 0 || from > len(r) {
			from = 0
		}
		end := from + aiMaxResult/3
		more := ""
		if end < len(r) {
			more = fmt.Sprintf("\n…（还有 %d 字，用 from=%d 继续读）", len(r)-end, end)
		} else {
			end = len(r)
		}
		return fmt.Sprintf("# 《%s》\n\n%s%s", d.Title, string(r[from:end]), more)
	}
	return "未知操作"
}
