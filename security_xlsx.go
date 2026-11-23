package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Pure-Go standards-compliant OOXML (.xlsx) workbook writer with zero external dependencies.
// Strictly follows ECMA-376 element ordering so Microsoft Excel, WPS Office, and LibreOffice Calc
// open generated workbooks cleanly without any repair prompts.

const (
	xlsxStyleBody     = 0  // default wrapped body cell with thin border
	xlsxStyleBanner   = 1  // bold white 13pt title banner on theme primary fill
	xlsxStyleHeader   = 2  // bold white 10pt table header on theme primary fill
	xlsxStyleSubhead  = 3  // bold ink 10pt subheader / KPI label on theme header fill
	xlsxStyleZebra    = 4  // light alternate row fill
	xlsxStyleCritical = 5  // crimson critical badge
	xlsxStyleHigh     = 6  // orange high badge
	xlsxStyleMedium   = 7  // amber medium badge
	xlsxStyleLow      = 8  // emerald low/pass badge
	xlsxStyleMuted    = 9  // muted gray waived/info cell
	xlsxStyleNum      = 10 // right-aligned numeric cell
	xlsxStyleNumZebra = 11 // right-aligned numeric cell on zebra row
)

type xlsxCell struct {
	Str     string
	Num     *float64
	Style   int
}

func xlsxStr(s string, style int) xlsxCell {
	return xlsxCell{Str: s, Style: style}
}

func xlsxInt(n int, style int) xlsxCell {
	v := float64(n)
	return xlsxCell{Num: &v, Style: style}
}

func xlsxFloat(v float64, style int) xlsxCell {
	vv := v
	return xlsxCell{Num: &vv, Style: style}
}

type xlsxSheet struct {
	Name       string
	Rows       [][]xlsxCell
	FreezeRow  int      // freeze top N rows (e.g. 1 for standard table sheets)
	AutoFilter string   // e.g. "A1:L1"
	Merges     []string // e.g. "A1:F1"
	MinWidths  []int
}

type xlsxWorkbook struct {
	Title   string
	Author  string
	Theme   docxTheme
	Sheets  []xlsxSheet
	strIdx  map[string]int
	strings []string
}

func newXlsxWorkbook(title, author string, theme docxTheme) *xlsxWorkbook {
	if theme.Primary == "" {
		theme = docxThemes["teal"]
	}
	return &xlsxWorkbook{
		Title:  title,
		Author: firstNonEmptyStr(author, "Middleware Hub"),
		Theme:  theme,
		strIdx: make(map[string]int),
	}
}

func (wb *xlsxWorkbook) intern(s string) int {
	clean := stripIllegalXMLRunes(s)
	if idx, ok := wb.strIdx[clean]; ok {
		return idx
	}
	idx := len(wb.strings)
	wb.strings = append(wb.strings, clean)
	wb.strIdx[clean] = idx
	return idx
}

func stripIllegalXMLRunes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '\t' || r == '\n' || r == '\r' ||
			(r >= 0x20 && r <= 0xD7FF) ||
			(r >= 0xE000 && r <= 0xFFFD) ||
			(r >= 0x10000 && r <= 0x10FFFF) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func xlsxColName(col0 int) string {
	n := col0 + 1
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		n--
		i--
		buf[i] = byte('A' + (n % 26))
		n /= 26
	}
	return string(buf[i:])
}

func sanitizeSheetName(name string, used map[string]bool) string {
	repl := strings.NewReplacer("\\", " ", "/", " ", "?", "", "*", "", "[", "(", "]", ")", ":", "-")
	clean := strings.TrimSpace(repl.Replace(name))
	if clean == "" {
		clean = "Sheet"
	}
	runes := []rune(clean)
	if len(runes) > 31 {
		clean = string(runes[:31])
	}
	base := clean
	for idx := 2; used[strings.ToLower(clean)]; idx++ {
		suf := fmt.Sprintf(" %d", idx)
		r := []rune(base)
		maxLen := 31 - len([]rune(suf))
		if len(r) > maxLen {
			r = r[:maxLen]
		}
		clean = string(r) + suf
	}
	used[strings.ToLower(clean)] = true
	return clean
}

func (wb *xlsxWorkbook) addSheet(sh xlsxSheet) {
	wb.Sheets = append(wb.Sheets, sh)
}

func (wb *xlsxWorkbook) stylesXML() string {
	th := wb.Theme
	primary := strings.ToUpper(firstNonEmptyStr(th.Primary, "115248"))
	headerFill := strings.ToUpper(firstNonEmptyStr(th.HeaderFill, "EBF2F1"))
	ink := strings.ToUpper(firstNonEmptyStr(th.Ink, "0F172A"))
	// ECMA-376 requires fills 0=none and 1=gray125; custom solid fills start at fillId=2.
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="8">
    <font><sz val="10"/><color rgb="FF1E293B"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="13"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="10"/><color rgb="FF%s"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="10"/><color rgb="FF991B1B"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="10"/><color rgb="FF9A3412"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="10"/><color rgb="FF854D0E"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="10"/><color rgb="FF166534"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF%s"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF%s"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFEDD5"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF9C3"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE2E8F0"/></left>
      <right style="thin"><color rgb="FFE2E8F0"/></right>
      <top style="thin"><color rgb="FFE2E8F0"/></top>
      <bottom style="thin"><color rgb="FFE2E8F0"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="12">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="7" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="9" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`, ink, primary, headerFill)
}

func (wb *xlsxWorkbook) sheetXML(sh xlsxSheet, tabSelected bool) string {
	maxCols := 0
	for _, r := range sh.Rows {
		if len(r) > maxCols {
			maxCols = len(r)
		}
	}
	if maxCols == 0 {
		maxCols = 1
	}

	// Calculate clean column widths from display widths (ignoring merged banner rows).
	widths := make([]int, maxCols)
	for j := 0; j < maxCols; j++ {
		w := 12
		if j < len(sh.MinWidths) && sh.MinWidths[j] > w {
			w = sh.MinWidths[j]
		}
		widths[j] = w
	}
	sampleRows := len(sh.Rows)
	if sampleRows > 120 {
		sampleRows = 120
	}
	for i := 0; i < sampleRows; i++ {
		// Skip single-cell banner rows when sizing columns.
		if len(sh.Rows[i]) == 1 && sh.Rows[i][0].Style == xlsxStyleBanner {
			continue
		}
		for j, c := range sh.Rows[i] {
			if j >= maxCols {
				break
			}
			txt := c.Str
			if c.Num != nil {
				txt = strconv.FormatFloat(*c.Num, 'f', -1, 64)
			}
			if utf8.RuneCountInString(txt) > 54 {
				txt = string([]rune(txt)[:54])
			}
			// Handle multi-line cells by taking longest line
			longest := 0
			for _, ln := range strings.Split(txt, "\n") {
				dw := displayWidth(ln)
				if dw > longest {
					longest = dw
				}
			}
			est := longest + 4
			if est > widths[j] {
				widths[j] = est
			}
		}
	}
	for j := range widths {
		if widths[j] < 10 {
			widths[j] = 10
		}
		if widths[j] > 56 {
			widths[j] = 56
		}
	}

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)

	// 1. sheetViews (tabSelected + optional frozen header pane)
	selAttr := ""
	if tabSelected {
		selAttr = ` tabSelected="1"`
	}
	b.WriteString(`<sheetViews><sheetView workbookViewId="0"` + selAttr + `>`)
	if sh.FreezeRow > 0 {
		fmt.Fprintf(&b, `<pane ySplit="%d" topLeftCell="A%d" activePane="bottomLeft" state="frozen"/>`, sh.FreezeRow, sh.FreezeRow+1)
	}
	b.WriteString(`</sheetView></sheetViews>`)

	// 2. sheetFormatPr
	b.WriteString(`<sheetFormatPr defaultRowHeight="21"/>`)

	// 3. cols
	b.WriteString(`<cols>`)
	for j, w := range widths {
		fmt.Fprintf(&b, `<col min="%d" max="%d" width="%d" customWidth="1"/>`, j+1, j+1, w)
	}
	b.WriteString(`</cols>`)

	// 4. sheetData
	b.WriteString(`<sheetData>`)
	for i, row := range sh.Rows {
		rowNum := i + 1
		htAttr := ""
		if len(row) > 0 && row[0].Style == xlsxStyleBanner {
			htAttr = ` ht="30" customHeight="1"`
		} else if len(row) > 0 && row[0].Style == xlsxStyleHeader {
			htAttr = ` ht="24" customHeight="1"`
		}
		fmt.Fprintf(&b, `<row r="%d"%s>`, rowNum, htAttr)
		for j, c := range row {
			ref := fmt.Sprintf("%s%d", xlsxColName(j), rowNum)
			if c.Num != nil {
				fmt.Fprintf(&b, `<c r="%s" s="%d"><v>%s</v></c>`, ref, c.Style, strconv.FormatFloat(*c.Num, 'f', -1, 64))
			} else if c.Str != "" {
				si := wb.intern(c.Str)
				fmt.Fprintf(&b, `<c r="%s" t="s" s="%d"><v>%d</v></c>`, ref, c.Style, si)
			} else {
				fmt.Fprintf(&b, `<c r="%s" s="%d"/>`, ref, c.Style)
			}
		}
		b.WriteString(`</row>`)
	}
	b.WriteString(`</sheetData>`)

	// 5. mergeCells (must follow sheetData and precede autoFilter per ECMA-376)
	if len(sh.Merges) > 0 {
		fmt.Fprintf(&b, `<mergeCells count="%d">`, len(sh.Merges))
		for _, m := range sh.Merges {
			fmt.Fprintf(&b, `<mergeCell ref="%s"/>`, esc(m))
		}
		b.WriteString(`</mergeCells>`)
	}

	// 6. autoFilter
	if strings.TrimSpace(sh.AutoFilter) != "" {
		fmt.Fprintf(&b, `<autoFilter ref="%s"/>`, esc(sh.AutoFilter))
	}

	b.WriteString(`</worksheet>`)
	return b.String()
}

func (wb *xlsxWorkbook) sharedStringsXML() string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	fmt.Fprintf(&b, `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">`, len(wb.strings), len(wb.strings))
	for _, s := range wb.strings {
		b.WriteString(`<si><t xml:space="preserve">`)
		b.WriteString(esc(s))
		b.WriteString(`</t></si>`)
	}
	b.WriteString(`</sst>`)
	return b.String()
}

func (wb *xlsxWorkbook) build() ([]byte, error) {
	if len(wb.Sheets) == 0 {
		wb.addSheet(xlsxSheet{
			Name: "总览摘要",
			Rows: [][]xlsxCell{{xlsxStr("暂无数据", xlsxStyleBody)}},
		})
	}

	usedNames := map[string]bool{}
	type builtSheet struct {
		name string
		xml  string
	}
	built := make([]builtSheet, len(wb.Sheets))
	for i, sh := range wb.Sheets {
		sname := sanitizeSheetName(sh.Name, usedNames)
		built[i] = builtSheet{
			name: sname,
			xml:  wb.sheetXML(sh, i == 0),
		}
	}

	var ctOverrides strings.Builder
	var wbSheets strings.Builder
	var wbRels strings.Builder

	for i, bs := range built {
		idx := i + 1
		fmt.Fprintf(&ctOverrides, `<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, idx)
		fmt.Fprintf(&wbSheets, `<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, esc(bs.name), idx, idx)
		fmt.Fprintf(&wbRels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, idx, idx)
	}
	styleRID := len(built) + 1
	ssRID := len(built) + 2
	fmt.Fprintf(&wbRels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`, styleRID)
	fmt.Fprintf(&wbRels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`, ssRID)

	createdISO := time.Now().UTC().Format(time.RFC3339)
	parts := []struct{ name, body string }{
		{"[Content_Types].xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>%s<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`, ctOverrides.String())},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`},
		{"docProps/core.xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>%s</dc:title><dc:creator>%s</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">%s</dcterms:created></cp:coreProperties>`, esc(wb.Title), esc(wb.Author), createdISO)},
		{"xl/workbook.xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>%s</sheets></workbook>`, wbSheets.String())},
		{"xl/_rels/workbook.xml.rels", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>`, wbRels.String())},
		{"xl/styles.xml", wb.stylesXML()},
		{"xl/sharedStrings.xml", wb.sharedStringsXML()},
	}
	for i, bs := range built {
		parts = append(parts, struct{ name, body string }{
			fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1),
			bs.xml,
		})
	}

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
	if err := z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
