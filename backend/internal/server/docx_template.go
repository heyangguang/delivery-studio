package server

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// An organisation's own Word template. The platform keeps everything that makes the file look like theirs — styles,
// page size and margins, header and footer, theme, fonts, images — and pours its content in:
//
//   - where a paragraph of the template says {{content}}, the generated chapters go there (along with the TOC unless
//     the template already embeds its own TOC field before {{content}}), while the template's own cover and revision
//     pages stay; placeholders such as {{title}}, {{subtitle}}, {{cluster}}, {{org}}, {{date}}, {{confidential}},
//     {{version}}, {{project}}, {{author}}, {{reviewer}}, and {{slogan}} are filled anywhere (including DrawingML
//     textboxes, headers, and footers);
//   - without {{content}}, the platform's own cover and front matter are used, styled by the template.
//
// Headings use the template's own heading styles (found by built-in English or Chinese Word style names); styles the
// platform needs and the template lacks (Code, Note, Criteria, TOC levels, etc.) are added cleanly.

const maxTemplate = 5 << 20

type docxTemplate struct {
	files map[string][]byte
	order []string
}

func parseTemplate(b []byte) (*docxTemplate, error) {
	if len(b) > maxTemplate {
		return nil, fmt.Errorf("模板不能超过 5 MiB")
	}
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, fmt.Errorf("这不是 Word 文档（.docx）")
	}
	t := &docxTemplate{files: map[string][]byte{}}
	total := int64(0)
	for _, f := range z.File {
		if strings.Contains(f.Name, "..") || strings.HasPrefix(f.Name, "/") {
			return nil, fmt.Errorf("模板里有不安全的文件路径")
		}
		total += int64(f.UncompressedSize64)
		if total > 50<<20 {
			return nil, fmt.Errorf("模板解开后太大")
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, 50<<20))
		rc.Close()
		if err != nil {
			return nil, err
		}
		t.files[f.Name] = data
		t.order = append(t.order, f.Name)
	}
	for _, need := range []string{"word/document.xml", "word/styles.xml", "[Content_Types].xml"} {
		if t.files[need] == nil {
			return nil, fmt.Errorf("模板缺少 %s，请用 Word 或 WPS 另存为 .docx 后再上传", need)
		}
	}
	if !bytes.Contains(t.files["word/document.xml"], []byte("<w:body")) {
		return nil, fmt.Errorf("模板的正文读不出来")
	}
	return t, nil
}

var (
	reStyle    = regexp.MustCompile(`(?s)<w:style\b[^>]*>.*?</w:style>`)
	reStyleID  = regexp.MustCompile(`w:styleId="([^"]+)"`)
	reStyleNm  = regexp.MustCompile(`<w:name w:val="([^"]+)"`)
	reText     = regexp.MustCompile(`(?s)<w:t(?:\s[^>]*)?>(.*?)</w:t>`)
	reFirstRPr = regexp.MustCompile(`(?s)<w:r\b[^>]*>\s*(<w:rPr>.*?</w:rPr>)`)
	rePPr      = regexp.MustCompile(`(?s)^<w:p\b[^>]*>\s*(<w:pPr>.*?</w:pPr>)`)
)

// builtinStyleNames maps platform style IDs to English and Chinese Word built-in style names (lowercase).
var builtinStyleNames = map[string][]string{
	"Normal":     {"normal", "正文"},
	"Title":      {"title", "标题"},
	"Subtitle":   {"subtitle", "副标题"},
	"Heading1":   {"heading 1", "标题 1", "标题1"},
	"Heading2":   {"heading 2", "标题 2", "标题2"},
	"Heading3":   {"heading 3", "标题 3", "标题3"},
	"Heading4":   {"heading 4", "标题 4", "标题4"},
	"TOCHeading": {"toc heading", "目录标题"},
	"TOC1":       {"toc 1", "目录 1", "目录1"},
	"TOC2":       {"toc 2", "目录 2", "目录2"},
	"TOC3":       {"toc 3", "目录 3", "目录3"},
	"Header":     {"header", "页眉"},
	"Footer":     {"footer", "页脚"},
}

// mergeStyles maps platform style IDs to existing template style IDs and appends missing donor styles.
func mergeStyles(tpl []byte, theme docxTheme) (string, map[string]string) {
	have := map[string]bool{}
	byName := map[string]string{}
	for _, st := range reStyle.FindAll(tpl, -1) {
		id := reStyleID.FindSubmatch(st)
		if id == nil {
			continue
		}
		have[string(id[1])] = true
		if nm := reStyleNm.FindSubmatch(st); nm != nil {
			byName[strings.ToLower(strings.TrimSpace(string(nm[1])))] = string(id[1])
		}
	}
	idMap := map[string]string{}
	var add strings.Builder
	for _, st := range reStyle.FindAllString(stylesXML(theme), -1) {
		id := reStyleID.FindStringSubmatch(st)[1]
		if aliases, ok := builtinStyleNames[id]; ok {
			matched := false
			for _, name := range aliases {
				if tid, ok := byName[name]; ok {
					idMap[id] = tid
					matched = true
					break
				}
			}
			if matched {
				continue
			}
		}
		if !have[id] {
			add.WriteString(st)
		}
	}
	out := string(tpl)
	if add.Len() > 0 {
		if i := strings.LastIndex(out, "</w:styles>"); i >= 0 {
			out = out[:i] + add.String() + out[i:]
		}
	}
	return out, idMap
}

func remapStyles(body string, idMap map[string]string) string {
	for from, to := range idMap {
		if from == to {
			continue
		}
		body = strings.ReplaceAll(body, `<w:pStyle w:val="`+from+`"/>`, `<w:pStyle w:val="`+to+`"/>`)
	}
	return body
}

// replaceLeafParagraphs visits only innermost <w:p>...</w:p> elements so nested paragraphs inside DrawingML
// (<w:txbxContent><w:p>...</w:p></w:txbxContent>) or VML containers remain intact without regex corruption.
func replaceLeafParagraphs(xml string, fn func(p string) string) string {
	type frame struct {
		start    int
		hasChild bool
	}
	var stack []frame
	var out strings.Builder
	cursor := 0
	n := len(xml)

	for i := 0; i < n; {
		nextOpen := strings.Index(xml[i:], "<w:p")
		nextClose := strings.Index(xml[i:], "</w:p>")
		if nextOpen < 0 && nextClose < 0 {
			break
		}
		pickOpen := nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)
		if pickOpen {
			pos := i + nextOpen
			if pos+4 >= n {
				break
			}
			ch := xml[pos+4]
			if ch != '>' && ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n' && ch != '/' {
				i = pos + 4
				continue
			}
			gt := strings.IndexByte(xml[pos:], '>')
			if gt < 0 {
				break
			}
			if xml[pos+gt-1] == '/' {
				// Self-closing <w:p/> cannot contain child text or child paragraphs.
				i = pos + gt + 1
				continue
			}
			if len(stack) > 0 {
				stack[len(stack)-1].hasChild = true
			}
			stack = append(stack, frame{start: pos})
			i = pos + gt + 1
			continue
		}

		pos := i + nextClose
		end := pos + len("</w:p>")
		if len(stack) > 0 {
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if !top.hasChild && top.start >= cursor {
				out.WriteString(xml[cursor:top.start])
				out.WriteString(fn(xml[top.start:end]))
				cursor = end
			}
		}
		i = end
	}
	if cursor == 0 {
		return xml
	}
	out.WriteString(xml[cursor:])
	return out.String()
}

func paragraphPlainText(p string) string {
	var text strings.Builder
	for _, m := range reText.FindAllStringSubmatch(p, -1) {
		text.WriteString(m[1])
	}
	return text.String()
}

// fillPlaceholders replaces {{name}} in every leaf paragraph. If placeholders stay whole inside individual <w:t>
// elements, it edits those runs in place (preserving page fields, drawings, and tabs); if Word split {{key}} across
// adjacent runs in a plain text paragraph, it coalesces runs cleanly.
func fillPlaceholders(xml string, vals map[string]string) string {
	return replaceLeafParagraphs(xml, func(p string) string {
		if !strings.Contains(p, "{{") {
			return p
		}
		joined := paragraphPlainText(p)
		if !strings.Contains(joined, "{{") {
			return p
		}
		hasKnown := false
		for k := range vals {
			if strings.Contains(joined, "{{"+k+"}}") {
				hasKnown = true
				break
			}
		}
		if !hasKnown {
			return p
		}

		// Stage 1: in-place run substitution keeps <w:fldChar>, tabs, breaks, and mixed run styles intact.
		direct := reText.ReplaceAllStringFunc(p, func(tag string) string {
			m := reText.FindStringSubmatchIndex(tag)
			if m == nil {
				return tag
			}
			inner := tag[m[2]:m[3]]
			if !strings.Contains(inner, "{{") {
				return tag
			}
			updated := inner
			for k, v := range vals {
				updated = strings.ReplaceAll(updated, "{{"+k+"}}", esc(v))
			}
			if updated == inner {
				return tag
			}
			return tag[:m[2]] + updated + tag[m[3]:]
		})
		rem := paragraphPlainText(direct)
		stillSplit := false
		for k := range vals {
			if strings.Contains(rem, "{{"+k+"}}") {
				stillSplit = true
				break
			}
		}
		if !stillSplit {
			return direct
		}

		// Stage 2: Word split {{key}} across adjacent runs. Only collapse if the paragraph carries no fields/drawings.
		if strings.Contains(p, "<w:fldChar") || strings.Contains(p, "<w:drawing") || strings.Contains(p, "<w:pict") {
			return direct
		}
		t := joined
		for k, v := range vals {
			t = strings.ReplaceAll(t, "{{"+k+"}}", esc(v))
		}
		ppr, rpr := "", ""
		if m := rePPr.FindStringSubmatch(p); m != nil {
			ppr = m[1]
		}
		if m := reFirstRPr.FindStringSubmatch(p); m != nil {
			rpr = m[1]
		}
		return `<w:p>` + ppr + `<w:r>` + rpr + `<w:t xml:space="preserve">` + t + `</w:t></w:r></w:p>`
	})
}

func ensureUpdateFieldsSettings(raw []byte) []byte {
	s := string(raw)
	if strings.Contains(s, "w:updateFields") {
		return raw
	}
	if i := strings.LastIndex(s, "</w:settings>"); i >= 0 {
		return []byte(s[:i] + `<w:updateFields w:val="true"/>` + s[i:])
	}
	return raw
}

func ensureDocNamespaces(docTag string) string {
	add := ""
	if !strings.Contains(docTag, "xmlns:r=") {
		add += ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	}
	if !strings.Contains(docTag, "xmlns:wp=") {
		add += ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`
	}
	if add == "" {
		return docTag
	}
	return strings.TrimSuffix(docTag, ">") + add + ">"
}

// templateHasOwnTOC checks whether the portion of rest preceding {{content}} already embeds a Word TOC field.
func templateHasOwnTOC(rest, marker string) bool {
	prefix := rest
	if idx := strings.Index(rest, marker); idx >= 0 {
		prefix = rest[:idx]
	}
	upper := strings.ToUpper(prefix)
	return strings.Contains(upper, "TOC \\O") || strings.Contains(upper, "PAGEREF _TOC")
}

// render pours cover/toc/body into the uploaded template while keeping template covers, sections, styles, and artwork.
func (t *docxTemplate) render(cover, toc, body string, coverMedia, tocMedia, bodyMedia []docxMedia, vals map[string]string, title, author string, theme docxTheme) ([]byte, error) {
	styles, idMap := mergeStyles(t.files["word/styles.xml"], theme)
	cover = remapStyles(cover, idMap)
	toc = remapStyles(toc, idMap)
	body = remapStyles(body, idMap)

	doc := string(t.files["word/document.xml"])
	if openStart := strings.Index(doc, "<w:document"); openStart >= 0 {
		if openEnd := strings.IndexByte(doc[openStart:], '>'); openEnd >= 0 {
			oldTag := doc[openStart : openStart+openEnd+1]
			doc = doc[:openStart] + ensureDocNamespaces(oldTag) + doc[openStart+openEnd+1:]
		}
	}

	bi, end := strings.Index(doc, "<w:body>"), strings.LastIndex(doc, "</w:body>")
	if bi < 0 || end < bi {
		return nil, fmt.Errorf("模板的正文读不出来")
	}
	head, rest, tail := doc[:bi+len("<w:body>")], doc[bi+len("<w:body>"):end], doc[end:]

	// Preserve the trailing section properties carrying the template's page geometry and header/footer links.
	sect := ""
	if i := strings.LastIndex(rest, "<w:sectPr"); i >= 0 && strings.HasSuffix(strings.TrimSpace(rest), "</w:sectPr>") {
		sect, rest = rest[i:], rest[:i]
	}

	const marker = "\x00CONTENT\x00"
	placed := false
	rest = replaceLeafParagraphs(rest, func(p string) string {
		if !placed && strings.TrimSpace(paragraphPlainText(p)) == "{{content}}" {
			placed = true
			return marker
		}
		return p
	})

	var inner string
	var media []docxMedia
	if placed {
		insert := body
		if toc != "" && !templateHasOwnTOC(rest, marker) {
			insert = toc + body
			media = append(media, tocMedia...)
		}
		media = append(media, bodyMedia...)
		inner = strings.Replace(fillPlaceholders(rest, vals), marker, insert, 1)
	} else {
		media = append(media, coverMedia...)
		media = append(media, tocMedia...)
		media = append(media, bodyMedia...)
		inner = cover + toc + body
	}
	newDoc := head + inner + sect + tail

	var out bytes.Buffer
	z := zip.NewWriter(&out)
	put := func(name string, data []byte) error {
		f, err := z.Create(name)
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	mrels, mtypes := mediaParts(media)
	for _, name := range t.order {
		data := t.files[name]
		switch {
		case name == "word/_rels/document.xml.rels" && mrels != "":
			data = []byte(strings.Replace(string(data), "</Relationships>", mrels+"</Relationships>", 1))
		case name == "[Content_Types].xml" && len(mtypes) > 0:
			ct := string(data)
			for _, e := range []string{"png", "jpg", "jpeg", "gif", "webp"} {
				if mtypes[e] && !strings.Contains(strings.ToLower(ct), `extension="`+e+`"`) {
					mime := "image/" + e
					if e == "jpg" {
						mime = "image/jpeg"
					}
					ct = strings.Replace(ct, "<Override", `<Default Extension="`+e+`" ContentType="`+mime+`"/><Override`, 1)
				}
			}
			data = []byte(ct)
		case name == "word/document.xml":
			data = []byte(newDoc)
		case name == "word/styles.xml":
			data = []byte(styles)
		case name == "word/settings.xml":
			data = ensureUpdateFieldsSettings(data)
		case name == "docProps/core.xml":
			data = []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>` + esc(title) + `</dc:title><dc:creator>` + esc(author) + `</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">` + now + `</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">` + now + `</dcterms:modified></cp:coreProperties>`)
		case strings.HasPrefix(name, "word/header") || strings.HasPrefix(name, "word/footer"):
			data = []byte(fillPlaceholders(string(data), vals))
		}
		if err := put(name, data); err != nil {
			return nil, err
		}
	}
	for _, m := range media {
		if err := put("word/media/"+m.Name, m.Data); err != nil {
			return nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
