package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
)

// Printable A4 width in dxa: 11906 page width - 1440 left margin - 1440 right margin = 9026 dxa (1 dxa = 635 EMU).
const (
	docxPageW      = 11906
	docxPageH      = 16838
	docxMarginLR   = 1440
	docxMarginTB   = 1260
	docxBodyWidth  = docxPageW - docxMarginLR*2 // 9026 dxa
	docxBodyEMU    = docxBodyWidth * 635        // 5731510 EMU
	docxBannerHMax = 2400000
)

var (
	reHeadingPrefix = regexp.MustCompile(`^(?:第\s*\d+\s*章[\s\x{3000}.:：、]*|Chapter\s+\d+[\s.:]*|\d+(?:\.\d+){0,3}[\s\x{3000}).、:：]+)`)
)

// docxWriter accumulates WordprocessingML body elements and embedded media for one document section.
type docxWriter struct {
	b              strings.Builder
	media          []docxMedia
	theme          docxTheme
	ridPrefix      string
	lang           string
	c1, c2, c3, c4 int
	autoNum        bool
	headings       [][2]string // ordered list of rendered {levelStr, formattedTitle} for TOC preview sync
}

// newDocxWriter creates an auto-numbered corporate docxWriter bound to theme and a relationship ID prefix.
func newDocxWriter(theme docxTheme, ridPrefix string) *docxWriter {
	return newDocxWriterLang(theme, ridPrefix, "")
}

func newDocxWriterLang(theme docxTheme, ridPrefix, lang string) *docxWriter {
	if theme.Primary == "" {
		theme = docxThemes["teal"]
	}
	return &docxWriter{
		theme:     theme,
		ridPrefix: firstNonEmptyStr(ridPrefix, "rIdMw"),
		lang:      lang,
		autoNum:   true,
	}
}

func (w *docxWriter) th() docxTheme {
	if w != nil && w.theme.Primary != "" {
		return w.theme
	}
	return docxThemes["teal"]
}

func (w *docxWriter) prefix() string {
	if w != nil && w.ridPrefix != "" {
		return w.ridPrefix
	}
	return "rIdMw"
}

// docxMedia holds an embedded raster image along with its relationship ID and filename in word/media/.
type docxMedia struct {
	RID  string
	Name string
	Ext  string
	Data []byte
}

// addMedia registers an image payload in this writer's media list and returns its RID, pixel size, and success.
func (w *docxWriter) addMedia(data []byte, prefixName string) (string, int, int, bool) {
	if len(data) == 0 {
		return "", 0, 0, false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return "", 0, 0, false
	}
	// Word and WPS cannot display WebP: store it as PNG so screenshots always show up.
	if format == "webp" {
		img, _, derr := image.Decode(bytes.NewReader(data))
		if derr != nil {
			return "", 0, 0, false
		}
		var buf bytes.Buffer
		if png.Encode(&buf, img) != nil {
			return "", 0, 0, false
		}
		data, format = buf.Bytes(), "png"
	}
	ext := format
	if ext == "jpeg" {
		ext = "jpg"
	}
	n := len(w.media) + 1
	p := w.prefix()
	m := docxMedia{
		RID:  fmt.Sprintf("%s%d", p, n),
		Name: fmt.Sprintf("%s-%d.%s", prefixName, n, ext),
		Ext:  ext,
		Data: data,
	}
	w.media = append(w.media, m)
	return m.RID, cfg.Width, cfg.Height, true
}

// picture embeds an image inline scaled cleanly up to printable width, with an optional centered caption underneath.
func (w *docxWriter) picture(data []byte, caption string) bool {
	rid, pxW, pxH, ok := w.addMedia(data, "mw-image")
	if !ok {
		return false
	}
	const maxW, maxH = int64(5400000), int64(6800000)
	cx, cy := int64(pxW)*9525, int64(pxH)*9525
	if cx > maxW {
		cy = cy * maxW / cx
		cx = maxW
	}
	if cy > maxH {
		cx = cx * maxH / cy
		cy = maxH
	}
	if cx < 1 {
		cx = 1
	}
	if cy < 1 {
		cy = 1
	}
	id := len(w.media) + 10
	w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="100" w:after="60"/><w:jc w:val="center"/></w:pPr>`)
	w.b.WriteString(drawingInlineXML(id, fmt.Sprintf("pic-%d", id), rid, cx, cy))
	w.b.WriteString(`</w:p>`)
	if strings.TrimSpace(caption) != "" {
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="0" w:after="120"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr><w:t xml:space="preserve">`)
		w.b.WriteString(esc(caption))
		w.b.WriteString(`</w:t></w:r></w:p>`)
	}
	return true
}

func drawingInlineXML(id int, name, rid string, cx, cy int64) string {
	return fmt.Sprintf(
		`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="%s"/>`+
			`<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`+
			`<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
			`<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
			`<pic:nvPicPr><pic:cNvPr id="%d" name="%s"/><pic:cNvPicPr/></pic:nvPicPr>`+
			`<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`+
			`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`+
			`</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
		cx, cy, id, esc(name), id, esc(name), esc(rid), cx, cy,
	)
}

func mediaParts(media []docxMedia) (rels string, types map[string]bool) {
	var rb strings.Builder
	types = map[string]bool{}
	for _, m := range media {
		types[m.Ext] = true
		fmt.Fprintf(&rb, `<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/%s"/>`, m.RID, m.Name)
	}
	return rb.String(), types
}

func esc(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		default:
			// Strip illegal XML 1.0 control chars that break Word/WPS open validation.
			if r == '\t' || r == '\n' || r == '\r' || (r >= 0x20 && r <= 0xD7FF) || (r >= 0xE000 && r <= 0xFFFD) || (r >= 0x10000 && r <= 0x10FFFF) {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

// runs converts plain text with inline `code` and **bold** spans into WordprocessingML <w:r> elements.
func runs(text, rpr string) string {
	var out strings.Builder
	writePlain := func(seg, extraRpr string) {
		if seg == "" {
			return
		}
		if rpr == "" && extraRpr == "" {
			out.WriteString(`<w:r><w:t xml:space="preserve">`)
			out.WriteString(esc(seg))
			out.WriteString(`</w:t></w:r>`)
			return
		}
		out.WriteString(`<w:r><w:rPr>`)
		out.WriteString(rpr)
		out.WriteString(extraRpr)
		out.WriteString(`</w:rPr><w:t xml:space="preserve">`)
		out.WriteString(esc(seg))
		out.WriteString(`</w:t></w:r>`)
	}
	writeCodeSpan := func(seg string) {
		if seg == "" {
			return
		}
		out.WriteString(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei" w:cs="Consolas"/><w:color w:val="0F172A"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:rPr><w:t xml:space="preserve"> `)
		out.WriteString(esc(seg))
		out.WriteString(` </w:t></w:r>`)
	}

	// Walk left to right handling **bold** and `code` cleanly while preserving unclosed delimiters literally.
	i := 0
	for i < len(text) {
		nextCode := strings.IndexByte(text[i:], '`')
		nextBold := strings.Index(text[i:], "**")
		if nextCode < 0 && nextBold < 0 {
			writePlain(text[i:], "")
			break
		}
		pickCode := nextCode >= 0 && (nextBold < 0 || nextCode < nextBold)
		if pickCode {
			start := i + nextCode
			writePlain(text[i:start], "")
			end := strings.IndexByte(text[start+1:], '`')
			if end < 0 {
				writePlain(text[start:], "")
				break
			}
			writeCodeSpan(text[start+1 : start+1+end])
			i = start + 1 + end + 1
			continue
		}
		start := i + nextBold
		writePlain(text[i:start], "")
		end := strings.Index(text[start+2:], "**")
		if end < 0 {
			writePlain(text[start:], "")
			break
		}
		writePlain(text[start+2:start+2+end], `<w:b/>`)
		i = start + 2 + end + 2
	}
	return out.String()
}

func (w *docxWriter) para(style, text string) {
	w.b.WriteString(`<w:p>`)
	if style != "" {
		fmt.Fprintf(&w.b, `<w:pPr><w:pStyle w:val="%s"/></w:pPr>`, style)
	}
	w.b.WriteString(runs(text, ""))
	w.b.WriteString(`</w:p>`)
}

func stripLeadingHeadingNum(s string) string {
	t := strings.TrimSpace(s)
	if m := reHeadingPrefix.FindStringIndex(t); m != nil && m[1] < len(t) {
		rest := strings.TrimSpace(t[m[1]:])
		if rest != "" {
			return rest
		}
	}
	return t
}

func (w *docxWriter) heading(level int, text string) {
	if level < 1 {
		level = 1
	}
	if level > 4 {
		level = 4
	}
	display := strings.TrimSpace(text)
	if w.autoNum {
		clean := stripLeadingHeadingNum(display)
		switch level {
		case 1:
			w.c1++
			w.c2, w.c3, w.c4 = 0, 0, 0
			display = tr(w.lang, fmt.Sprintf("第%d章  %s", w.c1, clean), fmt.Sprintf("Chapter %d  %s", w.c1, clean))
		case 2:
			if w.c1 == 0 {
				w.c1 = 1
			}
			w.c2++
			w.c3, w.c4 = 0, 0
			display = fmt.Sprintf("%d.%d  %s", w.c1, w.c2, clean)
		case 3:
			if w.c1 == 0 {
				w.c1 = 1
			}
			if w.c2 == 0 {
				w.c2 = 1
			}
			w.c3++
			w.c4 = 0
			display = fmt.Sprintf("%d.%d.%d  %s", w.c1, w.c2, w.c3, clean)
		case 4:
			if w.c1 == 0 {
				w.c1 = 1
			}
			if w.c2 == 0 {
				w.c2 = 1
			}
			if w.c3 == 0 {
				w.c3 = 1
			}
			w.c4++
			display = fmt.Sprintf("%d.%d.%d.%d  %s", w.c1, w.c2, w.c3, w.c4, clean)
		}
	}
	if level <= 3 {
		w.headings = append(w.headings, [2]string{fmt.Sprintf("%d", level), display})
	}
	w.para(fmt.Sprintf("Heading%d", level), display)
}

var reNumberedItem = regexp.MustCompile(`^\d+\.\s+`)

func (w *docxWriter) text(s string) {
	for _, line := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		switch {
		case strings.HasPrefix(t, "### "):
			w.heading(4, strings.TrimSpace(strings.TrimPrefix(t, "### ")))
		case strings.HasPrefix(t, "## "):
			w.heading(3, strings.TrimSpace(strings.TrimPrefix(t, "## ")))
		case strings.HasPrefix(t, "# "):
			w.heading(2, strings.TrimSpace(strings.TrimPrefix(t, "# ")))
		case strings.HasPrefix(t, "✓") || strings.HasPrefix(t, "✔") ||
			strings.HasPrefix(t, "成功判据：") || strings.HasPrefix(t, "成功判据:") ||
			strings.HasPrefix(t, "回退确认判据：") || strings.HasPrefix(t, "回退确认判据:") ||
			strings.HasPrefix(t, "判据：") || strings.HasPrefix(t, "判据:") ||
			strings.HasPrefix(t, "Pass Criteria:") || strings.HasPrefix(t, "Rollback Verification:") ||
			strings.HasPrefix(t, "Criteria:"):
			w.writeCriteriaLine(t)
		case strings.HasPrefix(t, "注意：") || strings.HasPrefix(t, "注意:") ||
			strings.HasPrefix(t, "警告：") || strings.HasPrefix(t, "警告:") ||
			strings.HasPrefix(t, "Note:") || strings.HasPrefix(t, "Caution:") ||
			strings.HasPrefix(t, "Warning:"):
			w.writeCautionLine(t)
		case strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* "):
			body := strings.TrimSpace(t[2:])
			w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="30" w:after="50" w:line="290" w:lineRule="auto"/><w:ind w:left="380" w:hanging="200"/></w:pPr>`)
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:b/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">•  </w:t></w:r>`, w.th().Primary)
			w.b.WriteString(runs(body, ""))
			w.b.WriteString(`</w:p>`)
		case reNumberedItem.MatchString(t):
			w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="30" w:after="50" w:line="290" w:lineRule="auto"/><w:ind w:left="380" w:hanging="240"/></w:pPr>`)
			w.b.WriteString(runs(t, ""))
			w.b.WriteString(`</w:p>`)
		default:
			w.para("", t)
		}
	}
}

func (w *docxWriter) writeCriteriaLine(line string) {
	th := w.th()
	w.b.WriteString(`<w:p><w:pPr><w:pStyle w:val="Criteria"/></w:pPr>`)
	// Emphasize leading label up to Chinese or ASCII colon.
	if idx := strings.IndexAny(line, "：:"); idx > 0 && idx < 30 {
		sepLen := 1
		if strings.HasPrefix(line[idx:], "：") {
			sepLen = len("：")
		}
		prefix := line[:idx+sepLen]
		rest := strings.TrimSpace(line[idx+sepLen:])
		fmt.Fprintf(&w.b, `<w:r><w:rPr><w:b/><w:color w:val="%s"/><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">%s </w:t></w:r>`, th.Primary, esc(prefix))
		w.b.WriteString(runs(rest, `<w:color w:val="1E293B"/><w:sz w:val="19"/>`))
	} else {
		w.b.WriteString(runs(line, `<w:color w:val="1E293B"/><w:sz w:val="19"/>`))
	}
	w.b.WriteString(`</w:p>`)
}

func (w *docxWriter) writeCautionLine(line string) {
	w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="80" w:after="80" w:line="290" w:lineRule="auto"/></w:pPr>`)
	if idx := strings.IndexAny(line, "：:"); idx > 0 && idx < 18 {
		sepLen := 1
		if strings.HasPrefix(line[idx:], "：") {
			sepLen = len("：")
		}
		w.b.WriteString(`<w:r><w:rPr><w:b/><w:color w:val="B91C1C"/></w:rPr><w:t xml:space="preserve">`)
		w.b.WriteString(esc(line[:idx+sepLen] + " "))
		w.b.WriteString(`</w:t></w:r>`)
		w.b.WriteString(runs(strings.TrimSpace(line[idx+sepLen:]), `<w:color w:val="991B1B"/>`))
	} else {
		w.b.WriteString(runs(line, `<w:color w:val="991B1B"/>`))
	}
	w.b.WriteString(`</w:p>`)
}

// note renders a left-accented corporate callout panel; warnings automatically adopt a crimson accent.
func (w *docxWriter) note(text string) {
	t := strings.TrimSpace(text)
	if t == "" {
		return
	}
	th := w.th()
	accent := th.Primary
	fill := th.NoteFill
	ink := "334155"
	upperT := strings.ToUpper(t)
	isWarn := strings.Contains(t, "注意") || strings.Contains(t, "风险") || strings.Contains(t, "严禁") || strings.Contains(t, "失败") || strings.Contains(t, "不可逆") ||
		strings.Contains(upperT, "WARNING") || strings.Contains(upperT, "CAUTION") || strings.Contains(upperT, "RISK") || strings.Contains(upperT, "DO NOT") || strings.Contains(upperT, "IRREVERSIBLE") || strings.Contains(upperT, "FAILED")
	if isWarn {
		accent = "B91C1C"
		fill = "FEF2F2"
		ink = "7F1D1D"
	}
	w.b.WriteString(`<w:tbl><w:tblPr>`)
	fmt.Fprintf(&w.b, `<w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>`, docxBodyWidth)
	w.b.WriteString(`<w:tblBorders>`)
	w.b.WriteString(`<w:top w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>`)
	fmt.Fprintf(&w.b, `<w:left w:val="single" w:sz="24" w:space="0" w:color="%s"/>`, accent)
	w.b.WriteString(`<w:bottom w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>`)
	w.b.WriteString(`<w:right w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>`)
	w.b.WriteString(`</w:tblBorders>`)
	w.b.WriteString(`<w:tblCellMar><w:top w:w="110" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="110" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar>`)
	fmt.Fprintf(&w.b, `</w:tblPr><w:tblGrid><w:gridCol w:w="%d"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc>`, docxBodyWidth)
	fmt.Fprintf(&w.b, `<w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="%s"/></w:tcPr>`, docxBodyWidth, fill)
	lines := strings.Split(strings.ReplaceAll(t, "\r\n", "\n"), "\n")
	for idx, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		after := "40"
		if idx == len(lines)-1 {
			after = "0"
		}
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pStyle w:val="Note"/><w:spacing w:before="0" w:after="%s" w:line="280" w:lineRule="auto"/></w:pPr>`, after)
		w.b.WriteString(runs(ln, fmt.Sprintf(`<w:color w:val="%s"/>`, ink)))
		w.b.WriteString(`</w:p>`)
	}
	w.b.WriteString(`</w:tc></w:tr></w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr></w:p>`)
}

// struck records an invalidated step or superseded baseline cleanly in muted strike-through styling.
func (w *docxWriter) struck(head, text string, items []string) {
	if strings.TrimSpace(head) == "" && strings.TrimSpace(text) == "" && len(items) == 0 {
		return
	}
	strike := `<w:strike/><w:color w:val="64748B"/>`
	if head != "" {
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="80" w:after="40"/></w:pPr><w:r><w:rPr><w:b/>`)
		w.b.WriteString(strike)
		w.b.WriteString(`</w:rPr><w:t xml:space="preserve">`)
		w.b.WriteString(esc(head + tr(w.lang, "（已归档/失效）", " (Superseded / Archived)")))
		w.b.WriteString(`</w:t></w:r></w:p>`)
	}
	for _, s := range append([]string{text}, items...) {
		if strings.TrimSpace(s) == "" {
			continue
		}
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="20" w:after="40"/><w:ind w:left="260"/></w:pPr>`)
		w.b.WriteString(runs(s, strike))
		w.b.WriteString(`</w:p>`)
	}
}

func isCautionComment(comment string) bool {
	upper := strings.ToUpper(comment)
	for _, kw := range []string{"注意", "警告", "WARN", "严禁", "务必", "不可逆", "必须确认", "慎用", "CAUTION", "CRITICAL", "DO NOT", "MUST CONFIRM"} {
		if strings.Contains(comment, kw) || strings.Contains(upper, kw) {
			return true
		}
	}
	return false
}

// splitInlineShellComment separates trailing " # comment" from executable command text while keeping URLs and strings intact.
func splitInlineShellComment(line string) (cmd, comment string) {
	if idx := strings.Index(line, "  #"); idx > 0 {
		return line[:idx], line[idx:]
	}
	if idx := strings.Index(line, "\t#"); idx > 0 {
		return line[:idx], line[idx:]
	}
	if idx := strings.Index(line, " # "); idx > 0 {
		// Avoid splitting inside quoted URLs/awk strings on rough balance check.
		prefix := line[:idx]
		if strings.Count(prefix, "'")%2 == 0 && strings.Count(prefix, `"`)%2 == 0 {
			return prefix, line[idx:]
		}
	}
	return line, ""
}

var (
	reTerminalPrompt = regexp.MustCompile(`^(\[[^\]]+\][#$]\s+)(.*)$`)
)

func isShellFlagToken(tok string) bool {
	if len(tok) < 2 || tok[0] != '-' {
		return false
	}
	if tok == "-" || tok == "--" {
		return false
	}
	return (tok[1] >= 'a' && tok[1] <= 'z') || (tok[1] >= 'A' && tok[1] <= 'Z') || (tok[1] >= '0' && tok[1] <= '9') || tok[1] == '-'
}

func isShellOpToken(tok string) bool {
	switch tok {
	case "|", "||", "&&", ";", ">", ">>", "<", "2>&1":
		return true
	}
	return false
}

// writeShellCmdRuns emits syntax-highlighted Word runs for one shell command line matching enterprise ops manuals:
// command verbs in deep blue (#1D4ED8), CLI flags in olive green (#4D7C0F), operators in muted steel, args in ink.
func (w *docxWriter) writeShellCmdRuns(cmd string, th docxTheme) {
	writeSeg := func(seg, color string, bold bool) {
		if seg == "" {
			return
		}
		w.b.WriteString(`<w:r><w:rPr>`)
		if bold {
			w.b.WriteString(`<w:b/>`)
		}
		fmt.Fprintf(&w.b, `<w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, color, esc(seg))
	}
	n := len(cmd)
	i := 0
	expectCmd := true
	for i < n {
		// Preserve runs of whitespace verbatim.
		if cmd[i] == ' ' || cmd[i] == '\t' {
			start := i
			for i < n && (cmd[i] == ' ' || cmd[i] == '\t') {
				i++
			}
			writeSeg(cmd[start:i], th.CmdHex, false)
			continue
		}
		// Quoted string stays intact as one token.
		if cmd[i] == '"' || cmd[i] == '\'' {
			q := cmd[i]
			start := i
			i++
			for i < n && cmd[i] != q {
				if cmd[i] == '\\' && q == '"' && i+1 < n {
					i++
				}
				i++
			}
			if i < n {
				i++
			}
			writeSeg(cmd[start:i], "0F766E", false)
			expectCmd = false
			continue
		}
		start := i
		for i < n && cmd[i] != ' ' && cmd[i] != '\t' {
			i++
		}
		tok := cmd[start:i]
		switch {
		case isShellOpToken(tok):
			writeSeg(tok, "64748B", true)
			expectCmd = tok == "|" || tok == "||" || tok == "&&" || tok == ";"
		case expectCmd:
			if strings.Contains(tok, "=") && !strings.HasPrefix(tok, "-") && !strings.Contains(tok, "/") {
				writeSeg(tok, "0F766E", false)
				// Environment assignment before command verb (e.g. PGPASSWORD=... psql).
				continue
			}
			writeSeg(tok, "1D4ED8", false)
			expectCmd = tok == "sudo" || tok == "env" || tok == "nohup" || tok == "time"
		case isShellFlagToken(tok):
			writeSeg(tok, "4D7C0F", false)
		default:
			writeSeg(tok, th.CmdHex, false)
		}
	}
}

func looksLikeAnsibleLogText(text string) bool {
	return strings.Contains(text, "TASK  ") || strings.Contains(text, "PLAY  ") || strings.Contains(text, "STEP_RESULT ") || strings.Contains(text, "\nRECAP\n")
}

// code emits a crisp full-width shaded code block matching enterprise manual typography:
// monospace Consolas/YaHei ink with shell syntax highlighting and muted italic blue-grey (#5F7A8A) comments.
func (w *docxWriter) code(text string) {
	w.codeStyled(text, "")
}

func (w *docxWriter) codeStyled(text, style string) {
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(text, "\r\n", "\n"), "\n"), "\n")
	if len(lines) == 0 {
		return
	}
	th := w.th()
	isAnsible := style == "ansible" || looksLikeAnsibleLogText(text)
	w.b.WriteString(`<w:tbl><w:tblPr>`)
	fmt.Fprintf(&w.b, `<w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>`, docxBodyWidth)
	w.b.WriteString(`<w:tblBorders>`)
	for _, edge := range []string{"top", "left", "bottom", "right"} {
		fmt.Fprintf(&w.b, `<w:%s w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>`, edge)
	}
	w.b.WriteString(`</w:tblBorders>`)
	w.b.WriteString(`<w:tblCellMar><w:top w:w="110" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="110" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar>`)
	fmt.Fprintf(&w.b, `</w:tblPr><w:tblGrid><w:gridCol w:w="%d"/></w:tblGrid><w:tr><w:tc>`, docxBodyWidth)
	fmt.Fprintf(&w.b, `<w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="%s"/></w:tcPr>`, docxBodyWidth, th.CodeFill)

	for i, line := range lines {
		after := "16"
		if i == len(lines)-1 {
			after = "0"
		}
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pStyle w:val="Code"/><w:spacing w:before="0" w:after="%s" w:line="240" w:lineRule="auto"/></w:pPr>`, after)
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			w.b.WriteString(`<w:r><w:t> </w:t></w:r>`)
		case strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "-- "):
			col := th.CommentHex
			if isCautionComment(trimmed) {
				col = "B91C1C"
			}
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:i/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, col, esc(line))
		case isAnsible:
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, th.CmdHex, esc(line))
		default:
			cmd, comment := splitInlineShellComment(line)
			w.writeShellCmdRuns(cmd, th)
			if comment != "" {
				col := th.CommentHex
				if isCautionComment(comment) {
					col = "B91C1C"
				}
				fmt.Fprintf(&w.b, `<w:r><w:rPr><w:i/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, col, esc(comment))
			}
		}
		w.b.WriteString(`</w:p>`)
	}
	w.b.WriteString(`</w:tc></w:tr></w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="90"/></w:pPr></w:p>`)
}

// terminal emits a crisp dark Linux terminal transcript block ([root@host ~]# cmd + stdout/stderr)
// suitable for customer delivery evidence in Word and WPS Office.
func (w *docxWriter) terminal(text string) {
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(text, "\r\n", "\n"), "\n"), "\n")
	if len(lines) == 0 {
		return
	}
	w.b.WriteString(`<w:tbl><w:tblPr>`)
	fmt.Fprintf(&w.b, `<w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>`, docxBodyWidth)
	w.b.WriteString(`<w:tblBorders>`)
	for _, edge := range []string{"top", "left", "bottom", "right"} {
		fmt.Fprintf(&w.b, `<w:%s w:val="single" w:sz="6" w:space="0" w:color="334155"/>`, edge)
	}
	w.b.WriteString(`</w:tblBorders>`)
	w.b.WriteString(`<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="170" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="170" w:type="dxa"/></w:tblCellMar>`)
	fmt.Fprintf(&w.b, `</w:tblPr><w:tblGrid><w:gridCol w:w="%d"/></w:tblGrid><w:tr><w:tc>`, docxBodyWidth)
	fmt.Fprintf(&w.b, `<w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="0F172A"/></w:tcPr>`, docxBodyWidth)

	for i, line := range lines {
		after := "16"
		if i == len(lines)-1 {
			after = "0"
		}
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pStyle w:val="Code"/><w:spacing w:before="0" w:after="%s" w:line="240" w:lineRule="auto"/></w:pPr>`, after)
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			w.b.WriteString(`<w:r><w:t> </w:t></w:r>`)
		case reTerminalPrompt.MatchString(line):
			m := reTerminalPrompt.FindStringSubmatch(line)
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:b/><w:color w:val="4ADE80"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, esc(m[1]))
			if m[2] != "" {
				fmt.Fprintf(&w.b, `<w:r><w:rPr><w:b/><w:color w:val="F8FAFC"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, esc(m[2]))
			}
		case strings.HasPrefix(trimmed, "# ✓") || strings.HasPrefix(trimmed, "✓ "):
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:color w:val="4ADE80"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, esc(line))
		case strings.HasPrefix(trimmed, "# ✗") || strings.HasPrefix(trimmed, "stderr:") || strings.HasPrefix(trimmed, "[FAILED") || strings.HasPrefix(trimmed, "[UNREACHABLE") || strings.HasPrefix(trimmed, "[exit code:"):
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:color w:val="F87171"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, esc(line))
		case strings.HasPrefix(trimmed, "#"):
			col := "94A3B8"
			if strings.Contains(trimmed, "FAILED") {
				col = "F87171"
			} else if strings.Contains(trimmed, "[OK") {
				col = "4ADE80"
			}
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, col, esc(line))
		case strings.HasSuffix(trimmed, ": OK") || trimmed == "active":
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:color w:val="86EFAC"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, esc(line))
		default:
			fmt.Fprintf(&w.b, `<w:r><w:rPr><w:color w:val="E2E8F0"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, esc(line))
		}
		w.b.WriteString(`</w:p>`)
	}
	w.b.WriteString(`</w:tc></w:tr></w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="90"/></w:pPr></w:p>`)
}

func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		if r > 0x2E7F {
			w += 2
		} else {
			w++
		}
	}
	return w
}

// tableWidths distributes docxBodyWidth (9026 dxa) proportionally across columns with sane min/max bounds.
func tableWidths(head []string, rows [][]string) []int {
	n := len(head)
	if n == 0 {
		return nil
	}
	scores := make([]int, n)
	for j, h := range head {
		scores[j] = max(4, displayWidth(h))
	}
	limit := len(rows)
	if limit > 25 {
		limit = 25
	}
	for i := 0; i < limit; i++ {
		for j := 0; j < n && j < len(rows[i]); j++ {
			cell := rows[i][j]
			if utf8.RuneCountInString(cell) > 60 {
				cell = string([]rune(cell)[:60])
			}
			dw := displayWidth(cell)
			if dw > scores[j] {
				scores[j] = dw
			}
		}
	}
	// Dampen extreme outliers so one long value column doesn't crush key/status columns below readability.
	totalScore := 0
	for j := range scores {
		if scores[j] > 48 {
			scores[j] = 48 + (scores[j]-48)/3
		}
		if scores[j] < 8 {
			scores[j] = 8
		}
		totalScore += scores[j]
	}
	widths := make([]int, n)
	used := 0
	minCol := 900
	if n >= 6 {
		minCol = 750
	}
	for j := 0; j < n; j++ {
		w := docxBodyWidth * scores[j] / totalScore
		if w < minCol {
			w = minCol
		}
		widths[j] = w
		used += w
	}
	// Reconcile rounding or minimum-clamp drift cleanly into the widest column.
	for used != docxBodyWidth {
		widest := 0
		for j := 1; j < n; j++ {
			if widths[j] > widths[widest] {
				widest = j
			}
		}
		diff := docxBodyWidth - used
		widths[widest] += diff
		break
	}
	return widths
}

func (w *docxWriter) table(head []string, rows [][]string) {
	if len(head) == 0 {
		return
	}
	widths := tableWidths(head, rows)
	w.tableWithWidths(head, rows, widths, -1, false)
}

func (w *docxWriter) tableWithWidths(head []string, rows [][]string, widths []int, keyCol int, zebra bool) {
	if len(head) == 0 || len(widths) != len(head) {
		return
	}
	th := w.th()
	w.b.WriteString(`<w:tbl><w:tblPr>`)
	fmt.Fprintf(&w.b, `<w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>`, docxBodyWidth)
	w.b.WriteString(`<w:tblBorders>`)
	for _, b := range []string{"top", "left", "bottom", "right", "insideH", "insideV"} {
		fmt.Fprintf(&w.b, `<w:%s w:val="single" w:sz="4" w:space="0" w:color="%s"/>`, b, th.TableBorder)
	}
	w.b.WriteString(`</w:tblBorders>`)
	w.b.WriteString(`<w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="130" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="130" w:type="dxa"/></w:tblCellMar>`)
	w.b.WriteString(`</w:tblPr><w:tblGrid>`)
	for _, cw := range widths {
		fmt.Fprintf(&w.b, `<w:gridCol w:w="%d"/>`, cw)
	}
	w.b.WriteString(`</w:tblGrid>`)

	row := func(cells []string, isHeader bool, zebraFill string) {
		if isHeader {
			w.b.WriteString(`<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>`)
		} else {
			w.b.WriteString(`<w:tr><w:trPr><w:cantSplit/></w:trPr>`)
		}
		for i := range head {
			c := ""
			if i < len(cells) {
				c = cells[i]
			}
			cw := widths[i]
			w.b.WriteString(`<w:tc><w:tcPr>`)
			fmt.Fprintf(&w.b, `<w:tcW w:w="%d" w:type="dxa"/><w:vAlign w:val="center"/>`, cw)
			if isHeader || (keyCol >= 0 && i == keyCol) {
				fmt.Fprintf(&w.b, `<w:shd w:val="clear" w:color="auto" w:fill="%s"/>`, th.HeaderFill)
			} else if zebraFill != "" {
				fmt.Fprintf(&w.b, `<w:shd w:val="clear" w:color="auto" w:fill="%s"/>`, zebraFill)
			}
			w.b.WriteString(`</w:tcPr>`)
			w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="10" w:after="10" w:line="260" w:lineRule="auto"/></w:pPr>`)
			switch {
			case isHeader:
				w.b.WriteString(runs(c, fmt.Sprintf(`<w:b/><w:sz w:val="19"/><w:color w:val="%s"/>`, th.Ink)))
			case keyCol >= 0 && i == keyCol:
				w.b.WriteString(runs(c, fmt.Sprintf(`<w:b/><w:sz w:val="19"/><w:color w:val="%s"/>`, th.Ink)))
			default:
				w.b.WriteString(runs(c, `<w:sz w:val="19"/><w:color w:val="1F2937"/>`))
			}
			w.b.WriteString(`</w:p></w:tc>`)
		}
		w.b.WriteString(`</w:tr>`)
	}
	row(head, true, "")
	for idx, r := range rows {
		fill := ""
		if zebra && idx%2 == 1 {
			fill = "F9FAFB"
		}
		row(r, false, fill)
	}
	w.b.WriteString(`</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="90"/></w:pPr></w:p>`)
}

func (w *docxWriter) pageBreak() {
	w.b.WriteString(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`)
}

// bannerPicture embeds a full-width header/corridor artwork strip when image bytes decode cleanly.
func (w *docxWriter) bannerPicture(data []byte, spaceAfter int) bool {
	rid, pxW, pxH, ok := w.addMedia(data, "mw-banner")
	if !ok {
		return false
	}
	cx, cy := fmtBannerSize(pxW, pxH, docxBodyEMU)
	id := len(w.media) + 50
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="0" w:after="%d"/><w:jc w:val="center"/></w:pPr>`, spaceAfter)
	w.b.WriteString(drawingInlineXML(id, fmt.Sprintf("banner-%d", id), rid, cx, cy))
	w.b.WriteString(`</w:p>`)
	return true
}

// toc builds the formal corporate table of contents page with dotted right tab leaders.
func (w *docxWriter) toc(heads [][2]string) {
	w.para("TOCHeading", tr(w.lang, "目录", "Table of Contents"))
	w.b.WriteString(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \o "1-3" \h \z \u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>`)
	if len(heads) == 0 {
		heads = [][2]string{
			{"1", tr(w.lang, "第1章  正文（在 Word / WPS 中右键“更新域”生成页码）", "Chapter 1  Body (Right-click TOC in Word / LibreOffice -> Update Field)")},
		}
	}
	for _, h := range heads {
		lvl := h[0]
		if lvl != "1" && lvl != "2" && lvl != "3" {
			continue
		}
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pStyle w:val="TOC%s"/></w:pPr><w:r><w:t xml:space="preserve">%s</w:t></w:r><w:r><w:tab/></w:r><w:r><w:rPr><w:color w:val="64748B"/></w:rPr><w:t>—</w:t></w:r></w:p>`, lvl, esc(h[1]))
	}
	w.b.WriteString(`<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`)
	w.pageBreak()
}

// docxCover configures page 1 of a formal enterprise deployment/delivery manual.
type docxCover struct {
	Org          string
	Project      string
	Slogan       string
	Title        string
	Subtitle     string
	DocVersion   string
	Date         string
	Confidential string
	Note         string
	Cluster      string
	Facts        [][2]string
	BannerData   []byte
	CustomBanner bool
	Lang         string
}

func (w *docxWriter) cover(c docxCover) {
	th := w.th()
	lang := firstNonEmptyStr(c.Lang, w.lang)
	slogan := firstNonEmptyStr(c.Slogan, tr(lang, "标准化部署与高可用运维体系", "Standardized Deployment & High-Availability Operations"))
	org := strings.TrimSpace(c.Org)
	project := strings.TrimSpace(c.Project)

	// An organization may upload its own banner in 报告模板; the standard manual itself carries no decorative artwork.
	if c.CustomBanner && len(c.BannerData) > 0 {
		w.bannerPicture(c.BannerData, 60)
	}
	// Brand band: solid theme color with live text only (organization, slogan, project), so it prints and edits cleanly.
	w.b.WriteString(`<w:tbl><w:tblPr>`)
	fmt.Fprintf(&w.b, `<w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>`, docxBodyWidth)
	w.b.WriteString(`<w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>`)
	w.b.WriteString(`<w:tblCellMar><w:top w:w="200" w:type="dxa"/><w:left w:w="280" w:type="dxa"/><w:bottom w:w="200" w:type="dxa"/><w:right w:w="280" w:type="dxa"/></w:tblCellMar>`)
	fmt.Fprintf(&w.b, `</w:tblPr><w:tblGrid><w:gridCol w:w="%d"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc>`, docxBodyWidth)
	fmt.Fprintf(&w.b, `<w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="%s"/></w:tcPr>`, docxBodyWidth, th.Primary)
	if org != "" {
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="E2E8F0"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, esc(org))
	}
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, esc(slogan))
	if project != "" {
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="60" w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="E2E8F0"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, esc(project))
	}
	w.b.WriteString(`</w:tc></w:tr></w:tbl>`)

	// Generous vertical space above left-aligned corporate manual title.
	eyebrow := firstNonEmptyStr(project, org)
	if eyebrow != "" {
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="1300" w:after="100"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, th.Primary, esc(eyebrow))
	} else {
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="1300" w:after="0"/></w:pPr></w:p>`)
	}

	// Main title with bold Microsoft YaHei typography + crisp left vertical accent bar feel via bottom divider.
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="80" w:after="160" w:line="380" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="56"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, th.Ink, esc(c.Title))
	if strings.TrimSpace(c.Subtitle) != "" {
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="10" w:color="%s"/></w:pBdr><w:spacing w:before="40" w:after="240"/></w:pPr><w:r><w:rPr><w:sz w:val="26"/><w:color w:val="475569"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, th.Primary, esc(c.Subtitle))
	} else {
		fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="%s"/></w:pBdr><w:spacing w:before="0" w:after="240"/></w:pPr></w:p>`, th.Primary)
	}

	// Bottom cover metadata block anchored near lower margin.
	ver := firstNonEmptyStr(c.DocVersion, "V1.0")
	dt := firstNonEmptyStr(c.Date, time.Now().Format("2006-01-02"))
	w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="2100" w:after="80"/></w:pPr>`)
	fmt.Fprintf(&w.b, `<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s%s</w:t></w:r></w:p>`, th.Ink, tr(lang, "版    本：", "Version: "), esc(ver))
	w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="20" w:after="80"/></w:pPr>`)
	fmt.Fprintf(&w.b, `<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s%s</w:t></w:r></w:p>`, th.Ink, tr(lang, "日    期：", "Date: "), esc(dt))
	if strings.TrimSpace(c.Cluster) != "" {
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="20" w:after="80"/></w:pPr>`)
		fmt.Fprintf(&w.b, `<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s%s</w:t></w:r></w:p>`, th.Ink, tr(lang, "目标集群：", "Target Cluster: "), esc(c.Cluster))
	}
	if strings.TrimSpace(c.Confidential) != "" {
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="20" w:after="80"/></w:pPr>`)
		fmt.Fprintf(&w.b, `<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="475569"/></w:rPr><w:t xml:space="preserve">%s%s</w:t></w:r></w:p>`, tr(lang, "密    级：", "Classification: "), esc(c.Confidential))
	}
	if strings.TrimSpace(c.Note) != "" {
		w.b.WriteString(`<w:p><w:pPr><w:spacing w:before="140" w:after="0"/></w:pPr>`)
		w.b.WriteString(runs(c.Note, `<w:sz w:val="18"/><w:color w:val="64748B"/>`))
		w.b.WriteString(`</w:p>`)
	}
	w.pageBreak()
}

// docxVersionControl configures the corporate "版本控制信息" page (文档属性 + 文档变更过程) at the end of front matter.
type docxVersionControl struct {
	Project, Title, Version, Date, Author, Reviewer string
	Cluster, Confidential                           string
	Facts                                           [][2]string
	History                                         [][4]string
	Lang                                            string
}

func (w *docxWriter) versionControl(vc docxVersionControl) {
	th := w.th()
	lang := firstNonEmptyStr(vc.Lang, w.lang)
	// Thick horizontal corporate divider matching standard template page header bar.
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="24" w:space="1" w:color="%s"/></w:pBdr><w:spacing w:before="0" w:after="200"/></w:pPr></w:p>`, th.Primary)
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:spacing w:before="80" w:after="220"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="%s"/></w:rPr><w:t>%s</w:t></w:r></w:p>`, th.Ink, tr(lang, "版本控制信息", "Document Control"))

	// ★ 文档属性
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:keepNext/><w:spacing w:before="80" w:after="90"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, th.Primary, tr(lang, "★  文档属性", "★  Document Properties"))

	var attrRows [][]string
	attrRows = append(attrRows,
		[]string{tr(lang, "项目名称", "Project Name"), firstNonEmptyStr(vc.Project, vc.Cluster, "—")},
		[]string{tr(lang, "文档标题", "Document Title"), firstNonEmptyStr(vc.Title, "—")},
		[]string{tr(lang, "文档版本号", "Document Version"), firstNonEmptyStr(vc.Version, "V1.0")},
		[]string{tr(lang, "版本日期", "Release Date"), firstNonEmptyStr(vc.Date, time.Now().Format("2006-01-02"))},
		[]string{tr(lang, "作    者", "Author"), firstNonEmptyStr(vc.Author, "Middleware Hub")},
		[]string{tr(lang, "审 核 人", "Reviewer"), firstNonEmptyStr(vc.Reviewer, "—")},
	)
	if strings.TrimSpace(vc.Confidential) != "" {
		attrRows = append(attrRows, []string{tr(lang, "密级标识", "Classification"), vc.Confidential})
	}
	for _, kv := range vc.Facts {
		if strings.TrimSpace(kv[0]) != "" && strings.TrimSpace(kv[1]) != "" {
			attrRows = append(attrRows, []string{kv[0], kv[1]})
		}
	}
	w.tableWithWidths([]string{tr(lang, "属性", "Property"), tr(lang, "内容", "Value")}, attrRows, []int{2300, docxBodyWidth - 2300}, 0, false)

	// ★ 文档变更过程
	fmt.Fprintf(&w.b, `<w:p><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="90"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="%s"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, th.Primary, tr(lang, "★  文档变更过程", "★  Revision History"))

	var histRows [][]string
	for _, r := range vc.History {
		histRows = append(histRows, []string{r[0], r[1], r[2], r[3]})
	}
	if len(histRows) == 0 {
		histRows = [][]string{
			{firstNonEmptyStr(vc.Version, "V1.0"), firstNonEmptyStr(vc.Date, time.Now().Format("2006-01-02")), firstNonEmptyStr(vc.Author, "Middleware Hub"), tr(lang, "文档生成与基线归档", "Document generated and baselined")},
			{"", "", "", ""},
		}
	}
	w.tableWithWidths([]string{tr(lang, "版本", "Version"), tr(lang, "更新日期", "Date"), tr(lang, "更新人", "Updated By"), tr(lang, "主要更新内容", "Summary")}, histRows, []int{1200, 1550, 1550, docxBodyWidth - 4300}, -1, false)
}

func stylesXML(t docxTheme) string {
	if t.Primary == "" {
		t = docxThemes["teal"]
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:cs="Calibri"/><w:sz w:val="21"/><w:color w:val="1F2937"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:before="20" w:after="95" w:line="295" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="%[1]s"/></w:pBdr><w:spacing w:before="280" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="%[1]s"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="90"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="27"/><w:color w:val="%[1]s"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="150" w:after="65"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="%[2]s"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="110" w:after="45"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/><w:color w:val="334155"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:eastAsia="Microsoft YaHei" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:color w:val="%[2]s"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="20" w:after="40" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="19"/><w:color w:val="334155"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Criteria"><w:name w:val="Criteria"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="30" w:after="50" w:line="280" w:lineRule="auto"/><w:ind w:left="260"/></w:pPr><w:rPr><w:sz w:val="19"/><w:color w:val="1E293B"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="%[1]s"/></w:pBdr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:sz w:val="17"/><w:color w:val="64748B"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:sz w:val="17"/><w:color w:val="64748B"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="18" w:space="6" w:color="%[1]s"/></w:pBdr><w:spacing w:before="100" w:after="180"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="%[1]s"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="%[3]d"/></w:tabs><w:spacing w:before="105" w:after="45"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="%[2]s"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="%[3]d"/></w:tabs><w:spacing w:before="35" w:after="30"/><w:ind w:left="320"/></w:pPr><w:rPr><w:sz w:val="20"/><w:color w:val="334155"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TOC3"><w:name w:val="toc 3"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="%[3]d"/></w:tabs><w:spacing w:before="20" w:after="20"/><w:ind w:left="640"/></w:pPr><w:rPr><w:i/><w:sz w:val="19"/><w:color w:val="64748B"/></w:rPr></w:style>
</w:styles>`, t.Primary, t.Ink, docxBodyWidth)
}

var docxStyles = stylesXML(docxThemes["teal"])

// docxBuildMeta carries document-wide metadata and header/footer controls for docxFileDual.
type docxBuildMeta struct {
	Title        string
	Header       string
	Footer       string
	FrontOrg     string
	Author       string
	Theme        docxTheme
	HasFrontSect bool
	Lang         string
}

func headerBodyXML(text string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p></w:hdr>`, esc(text))
}

func headerEmptyXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:hdr>`
}

// footerRomanBadgeXML renders a full-width top rule, left organization tag, and dark right Roman page-number badge.
func footerRomanBadgeXML(org string, t docxTheme) string {
	if t.Primary == "" {
		t = docxThemes["teal"]
	}
	const badgeW = 600
	leftW := docxBodyWidth - badgeW
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:tbl><w:tblPr>
    <w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/>
    <w:tblBorders><w:top w:val="single" w:sz="8" w:space="0" w:color="%s"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>
    <w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>
  </w:tblPr><w:tblGrid><w:gridCol w:w="%d"/><w:gridCol w:w="%d"/></w:tblGrid><w:tr>
    <w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>
      <w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="17"/><w:color w:val="475569"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>
    </w:tc>
    <w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:vAlign w:val="center"/><w:shd w:val="clear" w:color="auto" w:fill="%s"/></w:tcPr>
      <w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:b/><w:sz w:val="17"/><w:color w:val="FFFFFF"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/><w:sz w:val="17"/><w:color w:val="FFFFFF"/></w:rPr><w:t>I</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
      </w:p>
    </w:tc>
  </w:tr></w:tbl>
</w:ftr>`, docxBodyWidth, t.Primary, leftW, badgeW, leftW, esc(org), badgeW, t.BadgeFill)
}

func footerArabicXML(text string) string {
	return footerArabicXMLLang(text, "")
}

func footerArabicXMLLang(text, lang string) string {
	label := strings.TrimSpace(text)
	prefix := ""
	if label != "" {
		prefix = esc(label + "      ")
	}
	pageBefore := "第 "
	pageAfter := " 页"
	if isEnLang(lang) {
		pageBefore = "Page "
		pageAfter = ""
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Footer"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="CBD5E1"/></w:pBdr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">%s%s</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p></w:ftr>`, prefix, pageBefore, pageAfter)
}

const docxSettingsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:updateFields w:val="true"/>
  <w:defaultTabStop w:val="420"/>
</w:settings>`

func sectPrXML(hdrRID, ftrRID, pgFmt string, startOne bool) string {
	startAttr := ""
	if startOne {
		startAttr = ` w:start="1"`
	}
	return fmt.Sprintf(
		`<w:sectPr><w:headerReference w:type="default" r:id="%s"/><w:footerReference w:type="default" r:id="%s"/><w:pgSz w:w="%d" w:h="%d"/><w:pgMar w:top="%d" w:right="%d" w:bottom="%d" w:left="%d" w:header="600" w:footer="600"/><w:pgNumType w:fmt="%s"%s/></w:sectPr>`,
		hdrRID, ftrRID, docxPageW, docxPageH, docxMarginTB, docxMarginLR, docxMarginTB, docxMarginLR, pgFmt, startAttr,
	)
}

// docxFileDual builds a standards-compliant OOXML package supporting distinct Roman front matter and continuous Arabic body sections.
func docxFileDual(front, body *docxWriter, meta docxBuildMeta) ([]byte, error) {
	if meta.Theme.Primary == "" {
		if body != nil {
			meta.Theme = body.th()
		} else {
			meta.Theme = docxThemes["teal"]
		}
	}
	var allMedia []docxMedia
	if front != nil {
		allMedia = append(allMedia, front.media...)
	}
	if body != nil {
		allMedia = append(allMedia, body.media...)
	}
	imgRels, imgTypes := mediaParts(allMedia)

	var bodyXML strings.Builder
	var docRels strings.Builder
	var overrides strings.Builder

	docRels.WriteString(`<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`)
	docRels.WriteString(`<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`)
	docRels.WriteString(`<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`)
	docRels.WriteString(`<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`)

	parts := []struct{ name, body string }{
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`},
		{"word/styles.xml", stylesXML(meta.Theme)},
		{"word/settings.xml", docxSettingsXML},
		{"docProps/core.xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>%s</dc:title><dc:creator>%s</dc:creator></cp:coreProperties>`, esc(meta.Title), esc(firstNonEmptyStr(meta.Author, "Middleware Hub")))},
	}

	if meta.HasFrontSect && front != nil {
		docRels.WriteString(`<Relationship Id="rIdH2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>`)
		docRels.WriteString(`<Relationship Id="rIdF2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>`)
		overrides.WriteString(`<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`)

		bodyXML.WriteString(front.b.String())
		bodyXML.WriteString(`<w:p><w:pPr>`)
		bodyXML.WriteString(sectPrXML("rIdH1", "rIdF1", "upperRoman", true))
		bodyXML.WriteString(`</w:pPr></w:p>`)
		if body != nil {
			bodyXML.WriteString(body.b.String())
		}
		bodyXML.WriteString(sectPrXML("rIdH2", "rIdF2", "decimal", false))

		parts = append(parts,
			struct{ name, body string }{"word/header1.xml", headerEmptyXML()},
			struct{ name, body string }{"word/footer1.xml", footerRomanBadgeXML(meta.FrontOrg, meta.Theme)},
			struct{ name, body string }{"word/header2.xml", headerBodyXML(meta.Header)},
			struct{ name, body string }{"word/footer2.xml", footerArabicXMLLang(meta.Footer, meta.Lang)},
		)
	} else {
		if front != nil {
			bodyXML.WriteString(front.b.String())
		}
		if body != nil {
			bodyXML.WriteString(body.b.String())
		}
		bodyXML.WriteString(sectPrXML("rIdH1", "rIdF1", "decimal", true))

		parts = append(parts,
			struct{ name, body string }{"word/header1.xml", headerBodyXML(meta.Header)},
			struct{ name, body string }{"word/footer1.xml", footerArabicXMLLang(meta.Footer, meta.Lang)},
		)
	}
	docRels.WriteString(imgRels)

	var extTypes strings.Builder
	for ext := range imgTypes {
		mime := "image/" + ext
		if ext == "jpg" {
			mime = "image/jpeg"
		}
		fmt.Fprintf(&extTypes, `<Default Extension="%s" ContentType="%s"/>`, ext, mime)
	}

	parts = append(parts,
		struct{ name, body string }{"[Content_Types].xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>%s<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>%s<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`, extTypes.String(), overrides.String())},
		struct{ name, body string }{"word/_rels/document.xml.rels", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>`, docRels.String())},
		struct{ name, body string }{"word/document.xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">%s<w:body>%s</w:body></w:document>`, "", bodyXML.String())},
	)

	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for _, p := range parts {
		w, err := z.Create(p.name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(p.body)); err != nil {
			return nil, err
		}
	}
	for _, m := range allMedia {
		w, err := z.Create("word/media/" + m.Name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(m.Data); err != nil {
			return nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// docxFile is the single-section helper preserved for minimal exports and template-building callers.
func docxFile(body *docxWriter, title, header, footer, author string) ([]byte, error) {
	lang := ""
	if body != nil {
		lang = body.lang
	}
	return docxFileDual(nil, body, docxBuildMeta{
		Title:        title,
		Header:       header,
		Footer:       footer,
		Author:       author,
		Theme:        body.th(),
		HasFrontSect: false,
		Lang:         lang,
	})
}
