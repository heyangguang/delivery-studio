package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

type deliveryFile struct {
	Data []byte
	Mode int64
}

func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func privateWriteNew(filename string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	ce := f.Close()
	if err != nil {
		return err
	}
	return ce
}

// loadDeliveryAutomation reads and verifies the offline Ansible runtime release archive.
func loadDeliveryAutomation(filename string) (map[string]deliveryFile, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	checksum, err := os.ReadFile(filename + ".sha256")
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(string(checksum))
	if len(fields) < 1 || fields[0] != digest(data) {
		return nil, errors.New("Ansible发行包SHA256不一致")
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	t := tar.NewReader(gz)
	files := map[string]deliveryFile{}
	var total int64
	for {
		h, err := t.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		name := h.Name
		clean := path.Clean(name)
		if clean != name || strings.ContainsAny(name, "\\\x00\r\n") || !strings.HasPrefix(name, "middleware-automation/") || path.IsAbs(name) || strings.HasPrefix(clean, "../") || h.Mode&0077 != 0 || h.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("Ansible发行包条目/权限无效: %s", name)
		}
		if _, ok := files[name]; ok {
			return nil, errors.New("Ansible发行包包含重复路径")
		}
		total += h.Size
		if h.Size < 0 || h.Size > 64<<20 || total > 256<<20 || len(files) > 5000 {
			return nil, errors.New("Ansible发行包超过限制")
		}
		b, err := io.ReadAll(io.LimitReader(t, h.Size+1))
		if err != nil || int64(len(b)) != h.Size {
			return nil, errors.New("Ansible发行包条目不完整")
		}
		files[name] = deliveryFile{b, h.Mode}
	}
	manifest, ok := files["middleware-automation/SHA256SUMS"]
	if !ok {
		return nil, errors.New("Ansible发行包缺少内部SHA256SUMS")
	}
	seen := map[string]bool{}
	for _, row := range strings.Split(strings.TrimSpace(string(manifest.Data)), "\n") {
		parts := strings.SplitN(row, "  ", 2)
		if len(parts) != 2 {
			return nil, errors.New("内部清单格式无效")
		}
		name := "middleware-automation/" + parts[1]
		entry, ok := files[name]
		if !ok || seen[name] || parts[0] != digest(entry.Data) {
			return nil, fmt.Errorf("内部文件校验失败: %s", name)
		}
		seen[name] = true
	}
	if len(seen) != len(files)-1 {
		return nil, errors.New("Ansible发行包包含未登记文件")
	}
	for _, name := range []string{"bootstrap/bootstrap-ansible.sh", "bootstrap/run-ansible.py", "bootstrap/requirements.lock"} {
		if _, ok := files["middleware-automation/"+name]; !ok {
			return nil, fmt.Errorf("Ansible运行环境缺少%s", name)
		}
	}
	return files, nil
}

func writeDeliveryTar(filename string, files map[string]deliveryFile) error {
	f, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	var names []string
	dirs := map[string]bool{}
	for n := range files {
		names = append(names, n)
		for p := path.Dir(n); p != "."; p = path.Dir(p) {
			dirs[p] = true
		}
	}
	sort.Strings(names)
	var directoryNames []string
	for name := range dirs {
		directoryNames = append(directoryNames, name)
	}
	sort.Strings(directoryNames)
	for _, name := range directoryNames {
		if err = tw.WriteHeader(&tar.Header{Name: name + "/", Mode: 0700, Typeflag: tar.TypeDir, Uname: "root", Gname: "root"}); err != nil {
			break
		}
	}
	for _, n := range names {
		if err != nil {
			break
		}
		x := files[n]
		if err = tw.WriteHeader(&tar.Header{Name: n, Mode: x.Mode, Size: int64(len(x.Data)), Typeflag: tar.TypeReg, Uname: "root", Gname: "root"}); err != nil {
			break
		}
		if _, err = tw.Write(x.Data); err != nil {
			break
		}
	}
	for _, close := range []func() error{tw.Close, gz.Close, f.Close} {
		if e := close(); err == nil {
			err = e
		}
	}
	return err
}

func copyDeliveryFile(source, dest string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	ce := out.Close()
	if err != nil {
		return err
	}
	return ce
}

func writeJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	b = append(b, '\n')
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".mwctl-*")
	if e != nil {
		return e
	}
	temp := f.Name()
	defer os.Remove(temp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(temp, path)
}
