package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// A warning of the component check that someone looked at and decided is fine can be set aside, so it stops showing up
// (and stops counting) for everyone. It is kept with who said so and why, and can be taken back. Errors cannot be set
// aside. The decision is about the message of the warning in a file, not its line, so editing the file does not undo it.

type compIgnore struct {
	File    string `json:"file"`
	Message string `json:"message"`
	Reason  string `json:"reason,omitempty"`
	By      string `json:"by"`
	At      string `json:"at"`
}

func (s *storeServer) compIgnorePath(name string) string {
	return filepath.Join(s.cfg.DataDir, "comp-ignores", name+".json")
}

func (s *storeServer) loadCompIgnores(name string) []compIgnore {
	var out []compIgnore
	if b, err := os.ReadFile(s.compIgnorePath(name)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func (s *storeServer) compIgnored(name string) map[string]bool {
	m := map[string]bool{}
	for _, x := range s.loadCompIgnores(name) {
		m[x.File+"|"+x.Message] = true
	}
	return m
}
