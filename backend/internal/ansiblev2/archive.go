package ansiblev2

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"path"
	"strings"
)

const (
	maxImportFiles      = 1000
	maxImportTotalBytes = 32 << 20 // 32 MiB uncompressed cap
	maxImportFileBytes  = 4 << 20  // 4 MiB per file cap
)

// UnpackUpload extracts a .zip, .tar.gz/.tgz, .tar, or single .yml/.yaml playbook into a clean file map.
func UnpackUpload(filename string, raw []byte) (map[string][]byte, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("上传内容为空")
	}
	lower := strings.ToLower(strings.TrimSpace(filename))
	switch {
	case strings.HasSuffix(lower, ".yml") || strings.HasSuffix(lower, ".yaml"):
		base := path.Base(strings.ReplaceAll(filename, "\\", "/"))
		if base == "" || base == "." || base == "/" {
			base = "deploy.yml"
		}
		return map[string][]byte{base: append([]byte(nil), raw...)}, nil
	case strings.HasSuffix(lower, ".zip") || (len(raw) >= 4 && raw[0] == 'P' && raw[1] == 'K'):
		return unpackZip(raw)
	case strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz") || (len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b):
		return unpackTarGz(raw)
	case strings.HasSuffix(lower, ".tar"):
		return unpackTar(bytes.NewReader(raw))
	default:
		// Attempt YAML fallback for pasted/renamed single playbooks
		if looksLikePlaybook(raw) {
			return map[string][]byte{"deploy.yml": append([]byte(nil), raw...)}, nil
		}
		return nil, fmt.Errorf("不支持的文件格式 %q：请上传 .zip、.tar.gz/.tgz 或单个 .yml/.yaml Playbook", filename)
	}
}

func unpackZip(raw []byte) (map[string][]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("解压 ZIP 失败: %w", err)
	}
	files := make(map[string][]byte)
	var total int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || f.Mode()&0o120000 == 0o120000 {
			continue
		}
		rel, ok := cleanArchivePath(f.Name)
		if !ok {
			continue
		}
		if len(files) >= maxImportFiles {
			return nil, fmt.Errorf("归档文件数超过上限 (%d)", maxImportFiles)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxImportFileBytes+1))
		_ = rc.Close()
		if err != nil {
			return nil, err
		}
		if len(data) > maxImportFileBytes {
			return nil, fmt.Errorf("文件 %s 超过单文件大小限制 (4MB)", rel)
		}
		total += int64(len(data))
		if total > maxImportTotalBytes {
			return nil, fmt.Errorf("归档解压总大小超过上限 (32MB)")
		}
		files[rel] = data
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("ZIP 归档中没有可用文件")
	}
	return files, nil
}

func unpackTarGz(raw []byte) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("解压 gzip 失败: %w", err)
	}
	defer gz.Close()
	return unpackTar(gz)
}

func unpackTar(r io.Reader) (map[string][]byte, error) {
	tr := tar.NewReader(r)
	files := make(map[string][]byte)
	var total int64
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("读取 tar 归档失败: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			continue
		}
		rel, ok := cleanArchivePath(hdr.Name)
		if !ok {
			continue
		}
		if len(files) >= maxImportFiles {
			return nil, fmt.Errorf("归档文件数超过上限 (%d)", maxImportFiles)
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxImportFileBytes+1))
		if err != nil {
			return nil, err
		}
		if len(data) > maxImportFileBytes {
			return nil, fmt.Errorf("文件 %s 超过单文件大小限制 (4MB)", rel)
		}
		total += int64(len(data))
		if total > maxImportTotalBytes {
			return nil, fmt.Errorf("归档解压总大小超过上限 (32MB)")
		}
		files[rel] = data
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("归档中没有可用文件")
	}
	return files, nil
}

func cleanArchivePath(raw string) (string, bool) {
	p := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	p = strings.TrimPrefix(path.Clean("/"+p), "/")
	if p == "" || p == "." || strings.HasPrefix(p, "..") || strings.Contains(p, "/../") {
		return "", false
	}
	if strings.HasPrefix(p, ".git/") || strings.HasPrefix(p, "__MACOSX/") || strings.HasSuffix(p, "/.DS_Store") || p == ".DS_Store" {
		return "", false
	}
	return p, true
}
