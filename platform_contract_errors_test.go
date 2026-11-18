package main

import (
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestHostContractErrorsLocateRule(t *testing.T) {
	data := []byte(strings.Replace(string(mwpack.PlatformFiles()[mwpack.PlatformContractPath]), "{field: initialize, equals: false}", "{field: initialize, equals: true}", 1))
	_, err := mwpack.ParseHostContract(data)
	if err == nil {
		t.Fatal("unsafe rule accepted")
	}
	line, path := hostContractErrorLocation(data, err.Error())
	if path != "rules[0].require[2].equals" || line < 2 {
		t.Fatal(line, path, err)
	}
	if !strings.Contains(strings.Split(string(data), "\n")[line-1], "equals: true") {
		t.Fatal("wrong line", line)
	}
	if !strings.Contains(err.Error(), "改为关闭") {
		t.Fatal(err)
	}
}
