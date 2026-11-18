package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
)

// Exact figures from a spreadsheet. A model reading rows as text cannot add up thousands of them reliably, so it asks
// for the figure instead: the platform filters, groups and sums the rows itself and returns a small table. Nothing is
// run besides this fixed set of operations, and the files are the person's own.

const tableMaxRows = 200000

type sheetTable struct {
	Name   string
	Header []string
	Rows   [][]string
}

func tableTools() []aiToolDef {
	obj := func(props map[string]any, req ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": req}
	}
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	file := str("文件名（或编号），是用户存储空间里的 .xlsx / .csv 文件")
	sheet := str("工作表名；csv 不用填，xlsx 不填则用第一张")
	hdr := map[string]any{"type": "integer", "description": "表头在第几行（从 1 开始）；默认 1。表格上面有标题行时要指定"}
	return []aiToolDef{
		{"table_describe", "查看一个表格文件：有哪些工作表、每张表多少行、每列叫什么、是数字还是文字，并给出前几行。统计之前先用它弄清列名。", obj(map[string]any{"file": file, "sheet": sheet, "header_row": hdr}, "file")},
		{"table_query", "对表格做精确的筛选、分组、求和、计数、平均、最大最小、去重计数。需要数字结果（一共多少、各类别多少、总和是多少）时必须用它，不要自己数或估算。不写 aggs 和 group_by 时返回符合条件的行。", obj(map[string]any{
			"file": file, "sheet": sheet, "header_row": hdr,
			"where": map[string]any{"type": "array", "description": "筛选条件，全部满足才算", "items": obj(map[string]any{
				"column": str("列名"),
				"op":     map[string]any{"type": "string", "enum": []string{"eq", "ne", "gt", "ge", "lt", "le", "contains", "in", "empty", "notempty"}},
				"value":  str("比较的值；op 为 in 时用英文逗号分隔多个值"),
			}, "column", "op")},
			"group_by": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "按哪些列分组"},
			"aggs": map[string]any{"type": "array", "description": "要计算的指标", "items": obj(map[string]any{
				"fn":     map[string]any{"type": "string", "enum": []string{"count", "sum", "avg", "min", "max", "distinct"}, "description": "count 数行数（可不填 column）；distinct 数不重复的值"},
				"column": str("列名"),
				"as":     str("结果列的名字"),
			}, "fn")},
			"select":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "不做汇总、只列出行时，要显示哪些列"},
			"order_by": obj(map[string]any{"column": str("按哪列排序（可以是汇总结果的列名）"), "desc": map[string]any{"type": "boolean"}}, "column"),
			"limit":    map[string]any{"type": "integer", "description": "最多返回几行，默认 50，最多 200"},
		}, "file")},
	}
}

// hasSpreadsheet says whether the person has a spreadsheet in their storage space.
func (s *storeServer) hasSpreadsheet(user string) bool {
	if !userNameOK(user) {
		return false
	}
	filesMu.Lock()
	ix := s.filesLoad(user)
	filesMu.Unlock()
	for _, n := range ix.Nodes {
		if n.Kind != "folder" && isSheetName(n.Name) {
			return true
		}
	}
	return false
}

func isSheetName(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".xlsx", ".csv", ".tsv":
		return true
	}
	return false
}

func (s *storeServer) findSheetFile(user, ref string) (fileNode, error) {
	filesMu.Lock()
	ix := s.filesLoad(user)
	filesMu.Unlock()
	ref = strings.TrimSpace(ref)
	var hit []fileNode
	for _, n := range ix.Nodes {
		if n.Kind == "folder" || !isSheetName(n.Name) {
			continue
		}
		if n.ID == ref || n.Name == ref {
			return n, nil
		}
		if ref != "" && strings.Contains(strings.ToLower(n.Name), strings.ToLower(ref)) {
			hit = append(hit, n)
		}
	}
	switch len(hit) {
	case 1:
		return hit[0], nil
	case 0:
		return fileNode{}, fmt.Errorf("没有找到这个表格文件：%s（只能用用户存储空间里的 .xlsx / .csv 文件）", ref)
	}
	var names []string
	for _, n := range hit {
		names = append(names, n.Name)
	}
	sort.Strings(names)
	return fileNode{}, fmt.Errorf("有多个文件都叫这个名字，请写完整的文件名：%s", strings.Join(names, "、"))
}

// loadSheets reads every sheet of a file as rows of cells.
func (s *storeServer) loadSheets(user string, n fileNode, headerRow int) ([]sheetTable, error) {
	b, err := os.ReadFile(s.blobPath(user, n.ID))
	if err != nil {
		return nil, fmt.Errorf("读不到这个文件")
	}
	var raw []sheetTable
	if strings.ToLower(path.Ext(n.Name)) == ".xlsx" {
		txt, err := xlsxTextN(b, tableMaxRows)
		if err != nil {
			return nil, err
		}
		var cur *sheetTable
		for _, ln := range strings.Split(txt, "\n") {
			if strings.HasPrefix(ln, "## 工作表：") {
				raw = append(raw, sheetTable{Name: strings.TrimPrefix(ln, "## 工作表：")})
				cur = &raw[len(raw)-1]
				continue
			}
			if cur != nil && strings.TrimSpace(ln) != "" {
				cur.Rows = append(cur.Rows, strings.Split(ln, "\t"))
			}
		}
	} else {
		r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))))
		r.FieldsPerRecord = -1
		r.LazyQuotes = true
		if strings.ToLower(path.Ext(n.Name)) == ".tsv" {
			r.Comma = '\t'
		}
		rows, err := r.ReadAll()
		if err != nil && len(rows) == 0 {
			return nil, fmt.Errorf("csv 读取失败：%v", err)
		}
		if len(rows) > tableMaxRows {
			rows = rows[:tableMaxRows]
		}
		raw = []sheetTable{{Name: "csv", Rows: rows}}
	}
	if headerRow < 1 {
		headerRow = 1
	}
	for i := range raw {
		rows := raw[i].Rows
		// blank leading rows do not count as the header row
		if headerRow > len(rows) {
			raw[i].Rows = nil
			continue
		}
		h := rows[headerRow-1]
		seen := map[string]int{}
		for c := range h {
			name := strings.TrimSpace(h[c])
			if name == "" {
				name = fmt.Sprintf("列%d", c+1)
			}
			if seen[name]++; seen[name] > 1 {
				name = fmt.Sprintf("%s(%d)", name, seen[name])
			}
			raw[i].Header = append(raw[i].Header, name)
		}
		raw[i].Rows = rows[headerRow:]
	}
	return raw, nil
}

func pickSheet(all []sheetTable, name string) (sheetTable, error) {
	if len(all) == 0 {
		return sheetTable{}, fmt.Errorf("这个文件里没有工作表")
	}
	if name == "" {
		return all[0], nil
	}
	for _, t := range all {
		if t.Name == name {
			return t, nil
		}
	}
	var names []string
	for _, t := range all {
		names = append(names, t.Name)
	}
	return sheetTable{}, fmt.Errorf("没有叫「%s」的工作表，这个文件的工作表有：%s", name, strings.Join(names, "、"))
}

func cellAt(row []string, i int) string {
	if i < len(row) {
		return strings.TrimSpace(row[i])
	}
	return ""
}

func parseNum(s string) (float64, bool) {
	s = strings.NewReplacer(",", "", " ", "", "，", "").Replace(strings.TrimSpace(s))
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func fmtNum(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(math.Round(f*1e6)/1e6, 'f', -1, 64)
}

func colIndex(t sheetTable, name string) (int, error) {
	name = strings.TrimSpace(name)
	for i, h := range t.Header {
		if h == name {
			return i, nil
		}
	}
	for i, h := range t.Header {
		if strings.EqualFold(h, name) {
			return i, nil
		}
	}
	return -1, fmt.Errorf("没有叫「%s」的列，这张表的列有：%s", name, strings.Join(t.Header, "、"))
}

type tableWhere struct{ Column, Op, Value string }
type tableAgg struct{ Fn, Column, As string }

func (w tableWhere) match(cell string) bool {
	switch w.Op {
	case "empty":
		return cell == ""
	case "notempty":
		return cell != ""
	case "contains":
		return strings.Contains(strings.ToLower(cell), strings.ToLower(w.Value))
	case "in":
		for _, v := range strings.Split(w.Value, ",") {
			if strings.TrimSpace(v) == cell {
				return true
			}
			a, ok1 := parseNum(cell)
			b, ok2 := parseNum(v)
			if ok1 && ok2 && a == b {
				return true
			}
		}
		return false
	}
	a, ok1 := parseNum(cell)
	b, ok2 := parseNum(w.Value)
	cmp := 0
	if ok1 && ok2 {
		switch {
		case a < b:
			cmp = -1
		case a > b:
			cmp = 1
		}
	} else {
		cmp = strings.Compare(cell, strings.TrimSpace(w.Value))
	}
	switch w.Op {
	case "eq":
		return cmp == 0
	case "ne":
		return cmp != 0
	case "gt":
		return cmp > 0
	case "ge":
		return cmp >= 0
	case "lt":
		return cmp < 0
	case "le":
		return cmp <= 0
	}
	return false
}

type aggState struct {
	n, nums int
	sum     float64
	min     float64
	max     float64
	set     map[string]bool
	skipped int
}

func mdTable(head []string, rows [][]string) string {
	var b strings.Builder
	b.WriteString("| " + strings.Join(head, " | ") + " |\n|" + strings.Repeat(" --- |", len(head)) + "\n")
	for _, r := range rows {
		cells := make([]string, len(head))
		for i := range head {
			if i < len(r) {
				cells[i] = strings.ReplaceAll(r[i], "|", "\\|")
			}
		}
		b.WriteString("| " + strings.Join(cells, " | ") + " |\n")
	}
	return b.String()
}

func (s *storeServer) runTable(user, name, args string) string {
	var a struct {
		File      string
		Sheet     string
		HeaderRow int `json:"header_row"`
		Where     []tableWhere
		GroupBy   []string `json:"group_by"`
		Aggs      []tableAgg
		Select    []string
		OrderBy   *struct {
			Column string
			Desc   bool
		} `json:"order_by"`
		Limit int
	}
	if json.Unmarshal([]byte(args), &a) != nil {
		return "参数不对，请检查后重试。"
	}
	n, err := s.findSheetFile(user, a.File)
	if err != nil {
		return err.Error()
	}
	all, err := s.loadSheets(user, n, a.HeaderRow)
	if err != nil {
		return err.Error()
	}
	if name == "table_describe" {
		var b strings.Builder
		fmt.Fprintf(&b, "文件 %s，共 %d 张工作表：\n", n.Name, len(all))
		for _, t := range all {
			fmt.Fprintf(&b, "\n## %s（%d 行数据）\n", t.Name, len(t.Rows))
			if a.Sheet != "" && t.Name != a.Sheet {
				continue
			}
			var rows [][]string
			for c, h := range t.Header {
				num, filled := 0, 0
				for _, r := range t.Rows {
					if v := cellAt(r, c); v != "" {
						filled++
						if _, ok := parseNum(v); ok {
							num++
						}
					}
				}
				typ := "文字"
				if filled > 0 && num*10 >= filled*9 {
					typ = "数字"
				}
				rows = append(rows, []string{h, typ, strconv.Itoa(filled), cellAt(firstRowWith(t, c), c)})
			}
			b.WriteString(mdTable([]string{"列名", "类型", "有值的行数", "示例"}, rows))
			var sample [][]string
			for i := 0; i < len(t.Rows) && i < 5; i++ {
				r := make([]string, len(t.Header))
				for c := range r {
					r[c] = cellAt(t.Rows[i], c)
				}
				sample = append(sample, r)
			}
			b.WriteString("\n前几行：\n" + mdTable(t.Header, sample))
		}
		return b.String()
	}
	t, err := pickSheet(all, a.Sheet)
	if err != nil {
		return err.Error()
	}
	limit := a.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	// filter
	type cond struct {
		idx int
		w   tableWhere
	}
	var conds []cond
	var human []string
	for _, w := range a.Where {
		i, err := colIndex(t, w.Column)
		if err != nil {
			return err.Error()
		}
		conds = append(conds, cond{i, w})
		human = append(human, fmt.Sprintf("%s %s %s", w.Column, w.Op, w.Value))
	}
	var rows [][]string
	for _, r := range t.Rows {
		ok := true
		for _, c := range conds {
			if !c.w.match(cellAt(r, c.idx)) {
				ok = false
				break
			}
		}
		if ok {
			rows = append(rows, r)
		}
	}
	scope := fmt.Sprintf("《%s》工作表「%s」共 %d 行数据，符合条件的 %d 行", n.Name, t.Name, len(t.Rows), len(rows))
	if len(human) > 0 {
		scope += "（条件：" + strings.Join(human, "；") + "）"
	}
	note := ""
	if len(t.Rows) >= tableMaxRows {
		note = fmt.Sprintf("\n注意：表格行数超过 %d，只统计了前 %d 行。", tableMaxRows, tableMaxRows)
	}
	var head []string
	var out [][]string
	if len(a.Aggs) == 0 && len(a.GroupBy) == 0 {
		sel := a.Select
		if len(sel) == 0 {
			sel = t.Header
		}
		var idx []int
		for _, c := range sel {
			i, err := colIndex(t, c)
			if err != nil {
				return err.Error()
			}
			idx = append(idx, i)
			head = append(head, t.Header[i])
		}
		for _, r := range rows {
			line := make([]string, len(idx))
			for k, i := range idx {
				line[k] = cellAt(r, i)
			}
			out = append(out, line)
		}
	} else {
		var gidx []int
		for _, g := range a.GroupBy {
			i, err := colIndex(t, g)
			if err != nil {
				return err.Error()
			}
			gidx = append(gidx, i)
			head = append(head, t.Header[i])
		}
		aggs := a.Aggs
		if len(aggs) == 0 {
			aggs = []tableAgg{{Fn: "count"}}
		}
		aidx := make([]int, len(aggs))
		for k, g := range aggs {
			aidx[k] = -1
			if g.Column != "" {
				i, err := colIndex(t, g.Column)
				if err != nil {
					return err.Error()
				}
				aidx[k] = i
			} else if g.Fn != "count" {
				return "sum、avg、min、max、distinct 需要指定 column。"
			}
			label := g.As
			if label == "" {
				label = g.Fn
				if g.Column != "" {
					label += "(" + g.Column + ")"
				}
			}
			head = append(head, label)
		}
		type group struct {
			key  []string
			aggs []*aggState
		}
		groups := map[string]*group{}
		var order []string
		for _, r := range rows {
			key := make([]string, len(gidx))
			for k, i := range gidx {
				key[k] = cellAt(r, i)
			}
			id := strings.Join(key, "\x00")
			g := groups[id]
			if g == nil {
				g = &group{key: key}
				for range aggs {
					g.aggs = append(g.aggs, &aggState{set: map[string]bool{}})
				}
				groups[id] = g
				order = append(order, id)
			}
			for k, ag := range aggs {
				st := g.aggs[k]
				st.n++
				if aidx[k] < 0 {
					continue
				}
				v := cellAt(r, aidx[k])
				if ag.Fn == "distinct" {
					if v != "" {
						st.set[v] = true
					}
					continue
				}
				if ag.Fn == "count" {
					if v == "" {
						st.n--
					}
					continue
				}
				f, ok := parseNum(v)
				if !ok {
					if v != "" {
						st.skipped++
					}
					continue
				}
				if st.nums == 0 || f < st.min {
					st.min = f
				}
				if st.nums == 0 || f > st.max {
					st.max = f
				}
				st.sum += f
				st.nums++
			}
		}
		skipped := 0
		for _, id := range order {
			g := groups[id]
			line := append([]string{}, g.key...)
			for k, ag := range aggs {
				st := g.aggs[k]
				skipped += st.skipped
				switch ag.Fn {
				case "count":
					line = append(line, strconv.Itoa(st.n))
				case "distinct":
					line = append(line, strconv.Itoa(len(st.set)))
				case "sum":
					line = append(line, fmtNum(st.sum))
				case "avg":
					if st.nums == 0 {
						line = append(line, "")
					} else {
						line = append(line, fmtNum(st.sum/float64(st.nums)))
					}
				case "min":
					line = append(line, map[bool]string{true: fmtNum(st.min), false: ""}[st.nums > 0])
				case "max":
					line = append(line, map[bool]string{true: fmtNum(st.max), false: ""}[st.nums > 0])
				default:
					return "不认识的计算方式：" + ag.Fn
				}
			}
			out = append(out, line)
		}
		if skipped > 0 {
			note += fmt.Sprintf("\n注意：有 %d 个不是数字的单元格没有计入求和或平均。", skipped)
		}
		// a total row helps for a quick check against the sheet
	}
	if ob := a.OrderBy; ob != nil {
		ci := -1
		for i, h := range head {
			if h == ob.Column {
				ci = i
			}
		}
		if ci < 0 {
			return fmt.Sprintf("排序的列「%s」不在结果里，结果的列有：%s", ob.Column, strings.Join(head, "、"))
		}
		sort.SliceStable(out, func(x, y int) bool {
			a, ok1 := parseNum(out[x][ci])
			b, ok2 := parseNum(out[y][ci])
			less := out[x][ci] < out[y][ci]
			if ok1 && ok2 {
				less = a < b
			}
			if ob.Desc {
				if ok1 && ok2 {
					return a > b
				}
				return out[x][ci] > out[y][ci]
			}
			return less
		})
	}
	total := len(out)
	if len(out) > limit {
		out = out[:limit]
		note += fmt.Sprintf("\n结果共 %d 行，只显示前 %d 行。", total, limit)
	}
	return scope + "：\n\n" + mdTable(head, out) + note
}

func firstRowWith(t sheetTable, c int) []string {
	for _, r := range t.Rows {
		if cellAt(r, c) != "" {
			return r
		}
	}
	return nil
}
