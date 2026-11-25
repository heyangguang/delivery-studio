package mwpack

import (
	"testing"
	"unicode"
)

func hasCJK(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

func TestCatalogLocalizationCompleteness(t *testing.T) {
	// Ensure no English translation inside catalog_en.json leaked Chinese characters.
	for k, v := range catalogEnMap {
		if v == "" {
			t.Fatalf("empty English value for catalog key %q", k)
		}
		if hasCJK(v) {
			t.Fatalf("CJK character leaked into English translation of %q: %q", k, v)
		}
	}
}

func TestPhaseTitlesTranslated(t *testing.T) {
	for ph, zh := range PhaseTitles {
		en := TranslateCatalogText("en-US", zh)
		if en == "" || hasCJK(en) {
			t.Fatalf("phase %s (%q) missing clean English translation: got %q", ph, zh, en)
		}
	}
	for _, pl := range Platforms {
		en := LocalizePlatformTitle("en-US", pl.Title)
		if en == "" || hasCJK(en) {
			t.Fatalf("platform %s (%q) missing clean English title: got %q", pl.ID, pl.Title, en)
		}
	}
	stepSamples := []string{
		"生成并保存密码",
		"核对机器与系统",
		"数据盘",
		"离线软件仓库",
		"安装扩展",
		"解包并准备 node-1",
		"在 node-2 接受公钥并取回主机公钥",
		"在控制节点信任 node-2 并核对",
		"阶段：离线源与软件安装",
		"[pg-ha] 检查归档",
		"只读，不需要回退。",
	}
	for _, s := range stepSamples {
		en := TranslateCatalogText("en-US", s)
		if en == "" || hasCJK(en) {
			t.Fatalf("step sample %q missing clean English translation: got %q", s, en)
		}
	}
}
