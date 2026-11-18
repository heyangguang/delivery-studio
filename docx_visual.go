package main

import (
	"fmt"
	"strings"
)

// docxTheme defines a coherent corporate manual palette shared by built-in exports and the downloadable starter template.
type docxTheme struct {
	ID          string
	Name        string
	Primary     string // cover banner, thick divider rules, note left bar
	Dark        string // deep accent for art gradient
	Ink         string // headings and primary labels
	HeaderFill  string // table header background
	TableBorder string // crisp grid border color
	NoteFill    string // callout container background
	BadgeFill   string // front-matter Roman page number box
	CodeFill    string // shaded code block background
	CommentHex  string // muted italic shell/yaml/sql comment color
	CmdHex      string // executable command ink inside code blocks
}

var docxThemes = map[string]docxTheme{
	"teal": {
		ID:          "teal",
		Name:        "深青标准",
		Primary:     "115248",
		Dark:        "0A362F",
		Ink:         "0F172A",
		HeaderFill:  "EBF2F1",
		TableBorder: "356860",
		NoteFill:    "F3F7F6",
		BadgeFill:   "14181C",
		CodeFill:    "F1F2F4",
		CommentHex:  "5F7A8A",
		CmdHex:      "1D3557",
	},
	"navy": {
		ID:          "navy",
		Name:        "经典藏蓝",
		Primary:     "1E3A5F",
		Dark:        "10233D",
		Ink:         "0F172A",
		HeaderFill:  "EDF2F7",
		TableBorder: "35537A",
		NoteFill:    "F4F7FA",
		BadgeFill:   "141C24",
		CodeFill:    "F1F2F4",
		CommentHex:  "5B7083",
		CmdHex:      "1E3A5F",
	},
	"indigo": {
		ID:          "indigo",
		Name:        "科技靛紫",
		Primary:     "3730A3",
		Dark:        "221D6B",
		Ink:         "111827",
		HeaderFill:  "EEF0FA",
		TableBorder: "4B46A8",
		NoteFill:    "F5F6FC",
		BadgeFill:   "18162E",
		CodeFill:    "F2F3F6",
		CommentHex:  "646D82",
		CmdHex:      "232258",
	},
	"slate": {
		ID:          "slate",
		Name:        "石墨深灰",
		Primary:     "27272A",
		Dark:        "18181B",
		Ink:         "111827",
		HeaderFill:  "F1F3F5",
		TableBorder: "4B5563",
		NoteFill:    "F6F7F9",
		BadgeFill:   "111315",
		CodeFill:    "F2F3F5",
		CommentHex:  "64748B",
		CmdHex:      "1F2937",
	},
}

func themeOf(id string) docxTheme {
	if t, ok := docxThemes[strings.TrimSpace(strings.ToLower(id))]; ok {
		return t
	}
	return docxThemes["teal"]
}

func toTemplatePlaceholders(s string) string {
	return strings.NewReplacer(
		"{org}", "{{org}}",
		"{cluster}", "{{cluster}}",
		"{title}", "{{title}}",
		"{subtitle}", "{{subtitle}}",
		"{date}", "{{date}}",
		"{version}", "{{version}}",
		"{project}", "{{project}}",
		"{author}", "{{author}}",
		"{reviewer}", "{{reviewer}}",
		"{slogan}", "{{slogan}}",
		"{app}", "{{app}}",
		"{confidential}", "{{confidential}}",
	).Replace(s)
}

// starterTemplateDocx builds a clean, editable corporate starter .docx pre-wired with {{title}}, {{cluster}}, {{org}},
// {{version}}, {{date}}, {{project}}, {{author}}, {{reviewer}}, {{slogan}}, {{confidential}} and {{content}} so organizations
// can adjust artwork or fonts in Word/WPS and upload it back cleanly.
func starterTemplateDocx(rs reportSettings) ([]byte, error) {
	theme := themeOf(rs.Theme)
	front := newDocxWriter(theme, "rIdF")
	cover := docxCover{
		Org:          firstNonEmptyStr(rs.Org, "{{org}}"),
		Project:      firstNonEmptyStr(toTemplatePlaceholders(rs.Project), "{{project}}"),
		Slogan:       firstNonEmptyStr(toTemplatePlaceholders(rs.Slogan), "{{slogan}}"),
		Title:        "{{title}}",
		Subtitle:     "{{subtitle}}",
		DocVersion:   "{{version}}",
		Date:         "{{date}}",
		Confidential: firstNonEmptyStr(rs.Confidential, "{{confidential}}"),
		Note:         toTemplatePlaceholders(rs.Note),
		Cluster:      "{{cluster}}",
	}
	front.cover(cover)

	front.toc(nil)
	front.versionControl(docxVersionControl{
		Project:  "{{project}}",
		Title:    "{{title}}",
		Version:  "{{version}}",
		Date:     "{{date}}",
		Author:   "{{author}}",
		Reviewer: "{{reviewer}}",
		Cluster:  "{{cluster}}",
		History:  [][4]string{{"{{version}}", "{{date}}", "{{author}}", "模板基线导出"}, {"", "", "", ""}},
	})

	body := newDocxWriter(theme, "rIdMw")
	body.para("", "{{content}}")

	meta := docxBuildMeta{
		Title:        firstNonEmptyStr(rs.Project, "标准交付手册模板"),
		Header:       toTemplatePlaceholders(firstNonEmptyStr(rs.Header, "{{cluster}} · {{title}}")),
		Footer:       toTemplatePlaceholders(firstNonEmptyStr(rs.Footer, "{{org}}")),
		FrontOrg:     firstNonEmptyStr(rs.Org, "{{org}}"),
		Author:       firstNonEmptyStr(rs.Author, "Middleware Hub"),
		Theme:        theme,
		HasFrontSect: true,
	}
	return docxFileDual(front, body, meta)
}

func fmtBannerSize(pxW, pxH int, targetW int64) (int64, int64) {
	if pxW <= 0 || pxH <= 0 {
		return targetW, targetW / 4
	}
	targetH := targetW * int64(pxH) / int64(pxW)
	if targetH > 2700000 {
		targetH = 2700000
	}
	return targetW, targetH
}

func fmtBannerTitle(title, sub string) string {
	t := strings.TrimSpace(title)
	s := strings.TrimSpace(sub)
	if s == "" || strings.Contains(t, s) {
		return t
	}
	return fmt.Sprintf("%s · %s", t, s)
}
