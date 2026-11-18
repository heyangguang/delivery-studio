package catalog

import (
	"reflect"
	"strings"
	"testing"
	"unicode"

	"middleware-deployer/mwpack"
)

func findCJKFields(prefix string, v reflect.Value, out *[]string) {
	if !v.IsValid() {
		return
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			findCJKFields(prefix, v.Elem(), out)
		}
	case reflect.String:
		s := v.String()
		for _, r := range s {
			if unicode.In(r, unicode.Han) {
				*out = append(*out, prefix+" = "+s)
				return
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			findCJKFields(prefix, v.Index(i), out)
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			k := iter.Key().String()
			findCJKFields(prefix+"."+k, iter.Value(), out)
		}
	case reflect.Struct:
		t := v.Type()
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			// Raw shell/command lines may contain harmless comments or prompt labels; inspect UI-visible fields everywhere else.
			if f.Name == "Cmd" || f.Name == "Command" || f.Name == "When" || f.Name == "Check" || f.Name == "Pattern" {
				continue
			}
			findCJKFields(prefix+"."+f.Name, v.Field(i), out)
		}
	}
}

func TestAllBuiltinCatalogLocalizedToEnglish(t *testing.T) {
	cat, err := mwpack.LoadCatalog(FS)
	if err != nil {
		t.Fatalf("LoadCatalog(FS): %v", err)
	}
	var leaks []string
	hc, err := cat.HostContract()
	if err != nil {
		t.Fatalf("HostContract: %v", err)
	}
	enHC := mwpack.LocalizeHostContract("en-US", hc)
	findCJKFields("HostContract", reflect.ValueOf(enHC), &leaks)

	for _, info := range cat.Infos() {
		enInfo := mwpack.LocalizeInfo("en-US", info)
		findCJKFields("Info."+info.Name, reflect.ValueOf(enInfo), &leaks)
		comp, ok := cat.Get(info.Name)
		if !ok {
			t.Fatalf("missing component %s", info.Name)
		}
		for _, v := range info.Versions {
			sc, err := comp.Describe(v.ID)
			if err != nil {
				t.Fatalf("Describe(%s, %s): %v", info.Name, v.ID, err)
			}
			enSc := mwpack.LocalizeSchema("en-US", sc)
			findCJKFields("Schema."+info.Name+"@"+v.ID, reflect.ValueOf(enSc), &leaks)
		}
	}
	if len(leaks) > 0 {
		t.Fatalf("found %d untranslated CJK catalog strings in en-US:\n%s", len(leaks), strings.Join(leaks, "\n"))
	}
}
