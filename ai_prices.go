package main

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// What a model costs. The platform ships the vendors' published API prices as defaults (ai_prices.json, with where each
// came from and the day it was read); an administrator can add or change entries of their own, and a price typed on a
// model itself beats both. Prices are per million tokens.

//go:embed ai_prices.json
var builtinPricesJSON []byte

type priceEntry struct {
	Vendor   string   `json:"vendor"`
	Models   []string `json:"models"`
	In       float64  `json:"in"`
	Cached   float64  `json:"cached"`
	Out      float64  `json:"out"`
	Currency string   `json:"currency"`
	Source   string   `json:"source,omitempty"`
	Note     string   `json:"note,omitempty"`
}

type priceBook struct {
	Updated string       `json:"updated"`
	Entries []priceEntry `json:"entries"`
}

func builtinPrices() priceBook {
	var b priceBook
	_ = json.Unmarshal(builtinPricesJSON, &b)
	return b
}

type priceSettings struct {
	Custom []priceEntry `json:"custom"`
	// Display is the currency the cost pages add up in, and Rate how many yuan one dollar is, for converting.
	Display string  `json:"display"`
	Rate    float64 `json:"rate"`
}

func (s *storeServer) pricesPath() string { return filepath.Join(s.settingsDir(), "ai-prices.json") }

func (s *storeServer) loadPriceSettings() priceSettings {
	ps := priceSettings{Display: "CNY", Rate: 7.2}
	if b, err := os.ReadFile(s.pricesPath()); err == nil {
		_ = json.Unmarshal(b, &ps)
	}
	if ps.Display != "USD" {
		ps.Display = "CNY"
	}
	if ps.Rate <= 0 {
		ps.Rate = 7.2
	}
	return ps
}

// normModel drops a gateway's prefix ("zerotoken/", "codex/") and the case, so a model is found by its own name.
func normModel(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	return id
}

// modelMatches says whether a model id is the table's name, or that name plus a date or version suffix
// (claude-opus-4-5-20251101, deepseek-v4-pro-0813), but not a different model that merely starts the same
// (gpt-5.4-mini against gpt-5.4).
func modelMatches(id, name string) bool {
	id, name = normModel(id), normModel(name)
	if id == name {
		return true
	}
	if !strings.HasPrefix(id, name+"-") {
		return false
	}
	c := id[len(name)+1]
	return c >= '0' && c <= '9'
}

func (b priceBook) find(model string) (priceEntry, bool) {
	var best priceEntry
	bestLen, found := -1, false
	for _, e := range b.Entries {
		for _, n := range e.Models {
			if modelMatches(model, n) && len(n) > bestLen {
				best, bestLen, found = e, len(n), true
			}
		}
	}
	return best, found
}

// defaultPrice is the table's price for a model: the administrator's own entries first, then the shipped ones.
func (s *storeServer) defaultPrice(model string) (priceEntry, string, bool) {
	if e, ok := (priceBook{Entries: s.loadPriceSettings().Custom}).find(model); ok {
		return e, "custom", true
	}
	if e, ok := builtinPrices().find(model); ok {
		return e, "builtin", true
	}
	return priceEntry{}, "", false
}

// modelPrice is what a call to this model costs per million tokens, and in which currency.
func (s *storeServer) modelPrice(p aiProvider, m aiModel) (in, cached, out float64, cur string) {
	if m.PriceIn > 0 || m.PriceOut > 0 || m.PriceCached > 0 {
		cur = p.Currency
		if cur == "" {
			cur = "CNY"
		}
		return m.PriceIn, m.PriceCached, m.PriceOut, cur
	}
	if e, _, ok := s.defaultPrice(m.ID); ok {
		return e.In, e.Cached, e.Out, e.Currency
	}
	return 0, 0, 0, ""
}

func (ps priceSettings) convert(cost float64, from string) float64 {
	if from == "" || from == ps.Display {
		return cost
	}
	if from == "USD" {
		return cost * ps.Rate
	}
	return cost / ps.Rate
}

func (s *storeServer) handleAIPrices(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		ps := s.loadPriceSettings()
		if ps.Custom == nil {
			ps.Custom = []priceEntry{}
		}
		b := builtinPrices()
		s.writeJSON(w, 200, map[string]any{"updated": b.Updated, "builtin": b.Entries, "custom": ps.Custom, "display": ps.Display, "rate": ps.Rate})
	case "PUT":
		var in priceSettings
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<18)).Decode(&in) != nil || len(in.Custom) > 300 || in.Rate < 0 || in.Rate > 1000 {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		for i := range in.Custom {
			e := &in.Custom[i]
			e.Vendor, e.Source, e.Note = strings.TrimSpace(e.Vendor), strings.TrimSpace(e.Source), strings.TrimSpace(e.Note)
			var names []string
			for _, n := range e.Models {
				if n = strings.TrimSpace(n); n != "" {
					names = append(names, n)
				}
			}
			e.Models = names
			if len(names) == 0 || len(names) > 40 || e.In < 0 || e.Cached < 0 || e.Out < 0 || e.In > 100000 || e.Cached > 100000 || e.Out > 100000 || (e.Currency != "CNY" && e.Currency != "USD") {
				s.fail(w, 400, "每条价格要有模型名、币种（人民币或美元），价格不能为负")
				return
			}
		}
		if in.Display != "USD" {
			in.Display = "CNY"
		}
		if in.Rate == 0 {
			in.Rate = 7.2
		}
		sort.SliceStable(in.Custom, func(a, b int) bool { return in.Custom[a].Vendor < in.Custom[b].Vendor })
		if err := writeJSONFile(s.pricesPath(), in); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		if sess, ok := s.session(r); ok {
			s.auditReq(r, "ai-prices", sess.User, "")
		}
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		s.fail(w, 405, "方法不支持")
	}
}
