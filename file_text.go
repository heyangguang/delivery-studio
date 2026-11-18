package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"compress/zlib"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Taking the readable text out of what people upload, so the assistant can search and read it: plain text, PDF, Word,
// Excel and PowerPoint (the Office formats are zip files of XML). Nothing is run and nothing is fetched; a file that
// has no text (a scan, a picture) simply has none, and the reason is kept so the page can say so.

const maxExtractBytes = 4 << 20 // of text kept per file

// extractText returns the text of a file, or "" and why there is none.
func extractText(file, name, mt string, size int64) (string, string) {
	ext := strings.ToLower(path.Ext(name))
	if strings.HasPrefix(mt, "image/") {
		return "", "图片没有文字；让 AI 看图时，把它附到对话里"
	}
	if size > 80<<20 {
		return "", "文件太大，没有提取文字"
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return "", "读取失败"
	}
	var txt string
	switch {
	case ext == ".pdf" || bytes.HasPrefix(b, []byte("%PDF-")):
		txt, err = pdfText(b)
	case ext == ".docx":
		txt, err = docxText(b)
	case ext == ".xlsx":
		txt, err = xlsxText(b)
	case ext == ".pptx":
		txt, err = pptxText(b)
	case kbTextExt[ext] || strings.HasPrefix(mt, "text/"):
		if !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0 {
			return "", "不是 UTF-8 文本，没有提取文字"
		}
		txt = string(b)
	default:
		return "", "这种文件没法读出文字（压缩包、程序、旧版 Office 文件等）"
	}
	if err != nil {
		return "", err.Error()
	}
	txt = strings.TrimSpace(txt)
	if txt == "" {
		if ext == ".pdf" {
			return "", "这份 PDF 里没有可提取的文字，可能是扫描件；可以把页面当图片附给 AI 看"
		}
		return "", "里面没有文字"
	}
	if len(txt) > maxExtractBytes {
		txt = txt[:maxExtractBytes]
		for !utf8.ValidString(txt) {
			txt = txt[:len(txt)-1]
		}
	}
	return txt, ""
}

// ---- Office files ----

func openZip(b []byte) (*zip.Reader, error) {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, fmt.Errorf("文件打不开，可能已损坏，或者是旧版格式（请另存为新版 .docx/.xlsx/.pptx）")
	}
	return zr, nil
}

func zipFile(zr *zip.Reader, name string) []byte {
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil
			}
			defer rc.Close()
			b, _ := io.ReadAll(io.LimitReader(rc, 64<<20))
			return b
		}
	}
	return nil
}

func docxText(b []byte) (string, error) {
	zr, err := openZip(b)
	if err != nil {
		return "", err
	}
	doc := zipFile(zr, "word/document.xml")
	if doc == nil {
		return "", fmt.Errorf("这不是 Word 文档")
	}
	var out strings.Builder
	dec := xml.NewDecoder(bytes.NewReader(doc))
	in := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				in = true
			case "tab":
				out.WriteByte('\t')
			case "br", "cr":
				out.WriteByte('\n')
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				in = false
			case "p":
				out.WriteByte('\n')
			}
		case xml.CharData:
			if in {
				out.Write(t)
			}
		}
	}
	return out.String(), nil
}

func pptxText(b []byte) (string, error) {
	zr, err := openZip(b)
	if err != nil {
		return "", err
	}
	type slide struct {
		n    int
		name string
	}
	var slides []slide
	re := regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)
	for _, f := range zr.File {
		if m := re.FindStringSubmatch(f.Name); m != nil {
			n, _ := strconv.Atoi(m[1])
			slides = append(slides, slide{n, f.Name})
		}
	}
	if len(slides) == 0 {
		return "", fmt.Errorf("这不是 PowerPoint 文件")
	}
	sort.Slice(slides, func(a, c int) bool { return slides[a].n < slides[c].n })
	var out strings.Builder
	for _, s := range slides {
		fmt.Fprintf(&out, "## 幻灯片 %d\n", s.n)
		dec := xml.NewDecoder(bytes.NewReader(zipFile(zr, s.name)))
		in := false
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "t" {
					in = true
				}
			case xml.EndElement:
				if t.Name.Local == "t" {
					in = false
				}
				if t.Name.Local == "p" {
					out.WriteByte('\n')
				}
			case xml.CharData:
				if in {
					out.Write(t)
				}
			}
		}
		out.WriteByte('\n')
	}
	return out.String(), nil
}

func xlsxText(b []byte) (string, error) { return xlsxTextN(b, 5000) }

// xlsxTextN is xlsxText with a limit on the rows taken from each sheet.
func xlsxTextN(b []byte, maxRows int) (string, error) {
	zr, err := openZip(b)
	if err != nil {
		return "", err
	}
	if zipFile(zr, "xl/workbook.xml") == nil {
		return "", fmt.Errorf("这不是 Excel 文件")
	}
	// shared strings
	var shared []string
	if ss := zipFile(zr, "xl/sharedStrings.xml"); ss != nil {
		dec := xml.NewDecoder(bytes.NewReader(ss))
		var cur strings.Builder
		in, inSI := false, false
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "si" {
					inSI, cur = true, strings.Builder{}
				}
				if t.Name.Local == "t" {
					in = true
				}
			case xml.EndElement:
				if t.Name.Local == "t" {
					in = false
				}
				if t.Name.Local == "si" {
					shared = append(shared, cur.String())
					inSI = false
				}
			case xml.CharData:
				if in && inSI {
					cur.Write(t)
				}
			}
		}
	}
	// sheet names, in order
	names := map[string]string{} // r:id -> name
	var order []string
	rels := map[string]string{}
	if wb := zipFile(zr, "xl/workbook.xml"); wb != nil {
		dec := xml.NewDecoder(bytes.NewReader(wb))
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			if t, ok := tok.(xml.StartElement); ok && t.Name.Local == "sheet" {
				var name, rid string
				for _, a := range t.Attr {
					if a.Name.Local == "name" {
						name = a.Value
					}
					if a.Name.Local == "id" {
						rid = a.Value
					}
				}
				names[rid] = name
				order = append(order, rid)
			}
		}
	}
	if rb := zipFile(zr, "xl/_rels/workbook.xml.rels"); rb != nil {
		dec := xml.NewDecoder(bytes.NewReader(rb))
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			if t, ok := tok.(xml.StartElement); ok && t.Name.Local == "Relationship" {
				var id, target string
				for _, a := range t.Attr {
					if a.Name.Local == "Id" {
						id = a.Value
					}
					if a.Name.Local == "Target" {
						target = a.Value
					}
				}
				rels[id] = strings.TrimPrefix(target, "/")
			}
		}
	}
	var out strings.Builder
	for _, rid := range order {
		target := rels[rid]
		if !strings.HasPrefix(target, "xl/") {
			target = "xl/" + target
		}
		sh := zipFile(zr, target)
		if sh == nil {
			continue
		}
		fmt.Fprintf(&out, "## 工作表：%s\n", names[rid])
		dec := xml.NewDecoder(bytes.NewReader(sh))
		var cell struct{ typ string }
		var row []string
		var val strings.Builder
		inV, inT, rows := false, false, 0
		flush := func() {
			if len(row) > 0 {
				out.WriteString(strings.TrimRight(strings.Join(row, "\t"), "\t"))
				out.WriteByte('\n')
				rows++
			}
			row = row[:0]
		}
		for rows < maxRows {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "c":
					cell.typ = ""
					for _, a := range t.Attr {
						if a.Name.Local == "t" {
							cell.typ = a.Value
						}
					}
					val.Reset()
					// pad to the column of the cell so tabs line up
					for _, a := range t.Attr {
						if a.Name.Local == "r" {
							col := 0
							for _, ch := range a.Value {
								if ch >= 'A' && ch <= 'Z' {
									col = col*26 + int(ch-'A') + 1
								} else {
									break
								}
							}
							for len(row) < col-1 {
								row = append(row, "")
							}
						}
					}
				case "v":
					inV = true
				case "t":
					inT = true
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "v":
					inV = false
				case "t":
					inT = false
				case "c":
					v := val.String()
					if cell.typ == "s" {
						if i, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && i >= 0 && i < len(shared) {
							v = shared[i]
						}
					}
					row = append(row, strings.NewReplacer("\t", " ", "\n", " ").Replace(v))
				case "row":
					flush()
				}
			case xml.CharData:
				if inV || inT {
					val.Write(t)
				}
			}
		}
		out.WriteByte('\n')
	}
	return out.String(), nil
}

// ---- PDF ----

// pdfText takes the text out of a PDF that has text in it. It reads the objects of the file, follows the page tree,
// inflates the content streams and decodes the strings shown by the text operators, through each font's ToUnicode map
// where there is one. Scanned pages (pictures) give nothing.
func pdfText(b []byte) (string, error) {
	p := &pdfDoc{objs: map[int]*pdfObj{}}
	p.scan(b)
	if len(p.objs) == 0 {
		return "", fmt.Errorf("这个 PDF 读不出来，可能已损坏")
	}
	for _, o := range p.objs {
		if o.stream != nil && bytes.Contains(o.dict, []byte("/ObjStm")) {
			p.objStm(o)
		}
	}
	if bytes.Contains(b, []byte("/Encrypt")) {
		return "", fmt.Errorf("这个 PDF 加了密，平台读不了；请先去掉密码再上传")
	}
	pages := p.pages()
	var out strings.Builder
	for i, pg := range pages {
		t := strings.TrimSpace(p.pageText(pg))
		if t == "" {
			continue
		}
		fmt.Fprintf(&out, "## 第 %d 页\n%s\n\n", i+1, t)
		if out.Len() > maxExtractBytes {
			break
		}
	}
	return out.String(), nil
}

type pdfObj struct {
	dict   []byte
	stream []byte
}

type pdfDoc struct {
	objs  map[int]*pdfObj
	fonts map[int]*pdfFont
}

var (
	reObj  = regexp.MustCompile(`(?m)(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b`)
	reRef  = regexp.MustCompile(`(\d+)\s+(\d+)\s+R\b`)
	reKids = regexp.MustCompile(`/Kids\s*\[([^\]]*)\]`)
)

func (p *pdfDoc) scan(b []byte) {
	locs := reObj.FindAllSubmatchIndex(b, -1)
	for i, m := range locs {
		num, _ := strconv.Atoi(string(b[m[2]:m[3]]))
		start := m[1]
		end := len(b)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		body := b[start:end]
		o := &pdfObj{}
		if si := bytes.Index(body, []byte("stream")); si >= 0 {
			o.dict = body[:si]
			data := body[si+6:]
			data = bytes.TrimPrefix(data, []byte("\r\n"))
			data = bytes.TrimPrefix(data, []byte("\n"))
			data = bytes.TrimPrefix(data, []byte("\r"))
			if ei := bytes.LastIndex(data, []byte("endstream")); ei >= 0 {
				data = data[:ei]
			}
			o.stream = bytes.TrimRight(data, "\r\n")
		} else {
			if ei := bytes.Index(body, []byte("endobj")); ei >= 0 {
				body = body[:ei]
			}
			o.dict = body
		}
		p.objs[num] = o
	}
}

// inflate decodes a stream's filters we can: Flate (possibly after ASCII85/Hex are not supported); others return nil.
func (o *pdfObj) data() []byte {
	if o == nil || o.stream == nil {
		return nil
	}
	d := string(o.dict)
	if !strings.Contains(d, "/FlateDecode") && !strings.Contains(d, "/Fl ") {
		if strings.Contains(d, "/Filter") {
			return nil
		}
		return o.stream
	}
	zr, err := zlib.NewReader(bytes.NewReader(o.stream))
	var r io.Reader
	if err == nil {
		r = zr
	} else {
		r = flate.NewReader(bytes.NewReader(o.stream))
	}
	b, _ := io.ReadAll(io.LimitReader(r, 64<<20))
	return b
}

// objStm adds the objects packed inside an object stream.
func (p *pdfDoc) objStm(o *pdfObj) {
	data := o.data()
	if data == nil {
		return
	}
	n := intAfter(o.dict, "/N")
	first := intAfter(o.dict, "/First")
	if n <= 0 || first <= 0 || first > len(data) {
		return
	}
	hdr := strings.Fields(string(data[:first]))
	for i := 0; i+1 < len(hdr) && i/2 < n; i += 2 {
		num, _ := strconv.Atoi(hdr[i])
		off, _ := strconv.Atoi(hdr[i+1])
		end := len(data)
		if i+3 < len(hdr) {
			if e, err := strconv.Atoi(hdr[i+3]); err == nil {
				end = first + e
			}
		}
		if first+off <= end && end <= len(data) {
			if _, exists := p.objs[num]; !exists {
				p.objs[num] = &pdfObj{dict: data[first+off : end]}
			}
		}
	}
}

func intAfter(d []byte, key string) int {
	re := regexp.MustCompile(regexp.QuoteMeta(key) + `\s+(\d+)`)
	if m := re.FindSubmatch(d); m != nil {
		n, _ := strconv.Atoi(string(m[1]))
		return n
	}
	return 0
}

func pdfRef(d []byte, key string) int {
	re := regexp.MustCompile(regexp.QuoteMeta(key) + `\s+(\d+)\s+\d+\s+R`)
	if m := re.FindSubmatch(d); m != nil {
		n, _ := strconv.Atoi(string(m[1]))
		return n
	}
	return 0
}

// pages lists the page objects in reading order: down the page tree from the catalog, or by object number as a fallback.
func (p *pdfDoc) pages() []int {
	var root int
	for n, o := range p.objs {
		if bytes.Contains(o.dict, []byte("/Type/Catalog")) || bytes.Contains(o.dict, []byte("/Type /Catalog")) {
			if r := pdfRef(o.dict, "/Pages"); r != 0 && (root == 0 || n < root) {
				root = r
			}
		}
	}
	var out []int
	seen := map[int]bool{}
	var walk func(n int, depth int)
	walk = func(n int, depth int) {
		o := p.objs[n]
		if o == nil || seen[n] || depth > 30 {
			return
		}
		seen[n] = true
		if m := reKids.FindSubmatch(o.dict); m != nil && !bytes.Contains(o.dict, []byte("/Type/Page/")) && !regexp.MustCompile(`/Type\s*/Page\b[^s]`).Match(o.dict) {
			for _, r := range reRef.FindAllSubmatch(m[1], -1) {
				k, _ := strconv.Atoi(string(r[1]))
				walk(k, depth+1)
			}
			return
		}
		out = append(out, n)
	}
	if root != 0 {
		walk(root, 0)
	}
	if len(out) == 0 {
		var nums []int
		for n, o := range p.objs {
			if regexp.MustCompile(`/Type\s*/Page\b`).Match(o.dict) && !regexp.MustCompile(`/Type\s*/Pages\b`).Match(o.dict) {
				nums = append(nums, n)
			}
		}
		sort.Ints(nums)
		out = nums
	}
	return out
}

// resolve returns the dictionary text of a value that is a reference or inline.
func (p *pdfDoc) dictOf(d []byte, key string) []byte {
	if n := pdfRef(d, key); n != 0 {
		if o := p.objs[n]; o != nil {
			return o.dict
		}
	}
	if i := bytes.Index(d, []byte(key)); i >= 0 {
		rest := d[i+len(key):]
		if j := bytes.Index(rest, []byte("<<")); j >= 0 && j < 6 {
			return balanced(rest[j:])
		}
	}
	return nil
}

func balanced(b []byte) []byte {
	depth := 0
	for i := 0; i+1 < len(b); i++ {
		if b[i] == '<' && b[i+1] == '<' {
			depth++
			i++
		} else if b[i] == '>' && b[i+1] == '>' {
			depth--
			i++
			if depth == 0 {
				return b[:i+1]
			}
		}
	}
	return b
}

func (p *pdfDoc) pageText(pg int) string {
	o := p.objs[pg]
	if o == nil {
		return ""
	}
	// resources, here or inherited from the parent
	res := p.dictOf(o.dict, "/Resources")
	for up, d := pdfRef(o.dict, "/Parent"), 0; res == nil && up != 0 && d < 10; d++ {
		po := p.objs[up]
		if po == nil {
			break
		}
		res = p.dictOf(po.dict, "/Resources")
		up = pdfRef(po.dict, "/Parent")
	}
	fonts := map[string]*pdfFont{}
	if fd := p.dictOf(res, "/Font"); fd != nil {
		for _, m := range regexp.MustCompile(`/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R`).FindAllSubmatch(fd, -1) {
			n, _ := strconv.Atoi(string(m[2]))
			fonts[string(m[1])] = p.font(n)
		}
	}
	// content streams
	var content []byte
	cs := regexp.MustCompile(`/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)`).FindSubmatch(o.dict)
	if cs != nil {
		for _, r := range reRef.FindAllSubmatch(cs[1], -1) {
			n, _ := strconv.Atoi(string(r[1]))
			content = append(content, p.objs[n].data()...)
			content = append(content, '\n')
		}
	}
	return showText(content, fonts)
}

type pdfFont struct {
	wide bool              // two-byte codes
	to   map[uint32]string // code -> text
}

func (p *pdfDoc) font(n int) *pdfFont {
	if p.fonts == nil {
		p.fonts = map[int]*pdfFont{}
	}
	if f, ok := p.fonts[n]; ok {
		return f
	}
	f := &pdfFont{}
	p.fonts[n] = f
	o := p.objs[n]
	if o == nil {
		return f
	}
	f.wide = bytes.Contains(o.dict, []byte("/Type0"))
	if tu := pdfRef(o.dict, "/ToUnicode"); tu != 0 {
		if d := p.objs[tu].data(); d != nil {
			f.to = parseCMap(d)
			for k := range f.to {
				if k > 0xFF {
					f.wide = true
					break
				}
			}
		}
	}
	return f
}

var (
	reBfChar  = regexp.MustCompile(`<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>`)
	reBfRange = regexp.MustCompile(`<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])`)
)

func hexRunes(h string) string {
	if len(h)%2 == 1 {
		h = "0" + h
	}
	b := make([]byte, len(h)/2)
	for i := range b {
		v, _ := strconv.ParseUint(h[2*i:2*i+2], 16, 8)
		b[i] = byte(v)
	}
	// UTF-16BE
	var u []uint16
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, binary.BigEndian.Uint16(b[i:]))
	}
	return string(utf16Decode(u))
}

func utf16Decode(u []uint16) []rune {
	var out []rune
	for i := 0; i < len(u); i++ {
		c := rune(u[i])
		if c >= 0xD800 && c < 0xDC00 && i+1 < len(u) {
			c = 0x10000 + (c-0xD800)<<10 + rune(u[i+1]) - 0xDC00
			i++
		}
		out = append(out, c)
	}
	return out
}

func parseCMap(d []byte) map[uint32]string {
	m := map[uint32]string{}
	s := string(d)
	for {
		i := strings.Index(s, "beginbfchar")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "endbfchar")
		if j < 0 {
			break
		}
		for _, x := range reBfChar.FindAllStringSubmatch(s[i:i+j], -1) {
			c, _ := strconv.ParseUint(x[1], 16, 32)
			m[uint32(c)] = hexRunes(x[2])
		}
		s = s[i+j+9:]
	}
	s = string(d)
	for {
		i := strings.Index(s, "beginbfrange")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "endbfrange")
		if j < 0 {
			break
		}
		for _, x := range reBfRange.FindAllStringSubmatch(s[i:i+j], -1) {
			lo, _ := strconv.ParseUint(x[1], 16, 32)
			hi, _ := strconv.ParseUint(x[2], 16, 32)
			if hi < lo || hi-lo > 0xFFFF {
				continue
			}
			if strings.HasPrefix(x[3], "[") {
				for k, h := range regexp.MustCompile(`<([0-9A-Fa-f]+)>`).FindAllStringSubmatch(x[3], -1) {
					m[uint32(lo)+uint32(k)] = hexRunes(h[1])
				}
			} else {
				base := []rune(hexRunes(strings.Trim(x[3], "<>")))
				if len(base) == 0 {
					continue
				}
				for c := lo; c <= hi; c++ {
					r := append([]rune{}, base...)
					r[len(r)-1] += rune(c - lo)
					m[uint32(c)] = string(r)
				}
			}
		}
		s = s[i+j+10:]
	}
	return m
}

func (f *pdfFont) decode(b []byte) string {
	if f == nil {
		return latin(b)
	}
	var out strings.Builder
	if f.wide {
		for i := 0; i+1 < len(b); i += 2 {
			c := uint32(b[i])<<8 | uint32(b[i+1])
			if t, ok := f.to[c]; ok {
				out.WriteString(t)
			}
		}
		return out.String()
	}
	for _, c := range b {
		if t, ok := f.to[uint32(c)]; ok {
			out.WriteString(t)
		} else if f.to == nil {
			out.WriteRune(rune(c))
		}
	}
	return out.String()
}

func latin(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// showText runs the text operators of a content stream and returns what they show.
func showText(c []byte, fonts map[string]*pdfFont) string {
	var out strings.Builder
	var font *pdfFont
	var stack []any
	lastY, haveY := 0.0, false
	nl := func() {
		s := out.String()
		if s != "" && !strings.HasSuffix(s, "\n") {
			out.WriteByte('\n')
		}
	}
	i := 0
	for i < len(c) {
		ch := c[i]
		switch {
		case ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t' || ch == 0 || ch == '\f':
			i++
		case ch == '%':
			for i < len(c) && c[i] != '\n' && c[i] != '\r' {
				i++
			}
		case ch == '(':
			s, n := pdfString(c[i:])
			stack = append(stack, s)
			i += n
		case ch == '<' && i+1 < len(c) && c[i+1] == '<':
			// inline dictionary: skip it
			d := balanced(c[i:])
			i += len(d)
		case ch == '<':
			j := bytes.IndexByte(c[i:], '>')
			if j < 0 {
				i = len(c)
				break
			}
			h := strings.Map(func(r rune) rune {
				if r == ' ' || r == '\n' || r == '\r' {
					return -1
				}
				return r
			}, string(c[i+1:i+j]))
			if len(h)%2 == 1 {
				h += "0"
			}
			b := make([]byte, len(h)/2)
			for k := range b {
				v, _ := strconv.ParseUint(h[2*k:2*k+2], 16, 8)
				b[k] = byte(v)
			}
			stack = append(stack, b)
			i += j + 1
		case ch == '[':
			stack = append(stack, pdfMark{})
			i++
		case ch == ']':
			var arr []any
			for len(stack) > 0 {
				top := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				if _, ok := top.(pdfMark); ok {
					break
				}
				arr = append([]any{top}, arr...)
			}
			stack = append(stack, arr)
			i++
		case ch == '/':
			j := i + 1
			for j < len(c) && !strings.ContainsRune(" \n\r\t/[]()<>%", rune(c[j])) {
				j++
			}
			stack = append(stack, pdfName(string(c[i+1:j])))
			i = j
		default:
			j := i
			for j < len(c) && !strings.ContainsRune(" \n\r\t/[]()<>%", rune(c[j])) {
				j++
			}
			if j == i {
				i++
				break
			}
			tok := string(c[i:j])
			i = j
			if f, err := strconv.ParseFloat(tok, 64); err == nil {
				stack = append(stack, f)
				break
			}
			switch tok {
			case "Tf":
				if len(stack) >= 2 {
					if n, ok := stack[len(stack)-2].(pdfName); ok {
						font = fonts[string(n)]
					}
				}
			case "Tj", "'", "\"":
				if tok != "Tj" {
					nl()
				}
				if len(stack) > 0 {
					out.WriteString(showOne(stack[len(stack)-1], font))
				}
			case "TJ":
				if len(stack) > 0 {
					if arr, ok := stack[len(stack)-1].([]any); ok {
						for _, e := range arr {
							switch v := e.(type) {
							case float64:
								if v < -250 {
									out.WriteByte(' ')
								}
							default:
								out.WriteString(showOne(e, font))
							}
						}
					}
				}
			case "Td", "TD":
				if len(stack) >= 2 {
					if y, ok := stack[len(stack)-1].(float64); ok && y != 0 {
						nl()
					} else {
						out.WriteByte(' ')
					}
				}
			case "T*":
				nl()
			case "Tm":
				if len(stack) >= 6 {
					if y, ok := stack[len(stack)-1].(float64); ok {
						switch {
						case haveY && (y-lastY > 2 || lastY-y > 2):
							nl()
						case haveY:
							out.WriteByte(' ') // another piece of the same line
						}
						lastY, haveY = y, true
					}
				}
			}
			stack = stack[:0]
		}
	}
	text := out.String()
	text = regexp.MustCompile(`[ \t]+`).ReplaceAllString(text, " ")
	text = regexp.MustCompile(` ?\n ?`).ReplaceAllString(text, "\n")
	return strings.TrimSpace(regexp.MustCompile(`\n{3,}`).ReplaceAllString(text, "\n\n"))
}

type pdfName string
type pdfMark struct{}

func showOne(v any, f *pdfFont) string {
	switch x := v.(type) {
	case string:
		return f.decode([]byte(x))
	case []byte:
		return f.decode(x)
	}
	return ""
}

// pdfString reads a (literal string) with escapes and nested parentheses; it returns the bytes and the length used.
func pdfString(b []byte) (string, int) {
	var out []byte
	depth := 0
	for i := 0; i < len(b); i++ {
		c := b[i]
		switch {
		case c == '\\' && i+1 < len(b):
			i++
			switch b[i] {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b', 'f':
			case '\r', '\n':
			case '0', '1', '2', '3', '4', '5', '6', '7':
				v := int(b[i] - '0')
				for k := 0; k < 2 && i+1 < len(b) && b[i+1] >= '0' && b[i+1] <= '7'; k++ {
					i++
					v = v*8 + int(b[i]-'0')
				}
				out = append(out, byte(v))
			default:
				out = append(out, b[i])
			}
		case c == '(':
			depth++
			if depth > 1 {
				out = append(out, c)
			}
		case c == ')':
			depth--
			if depth == 0 {
				return string(out), i + 1
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return string(out), len(b)
}
