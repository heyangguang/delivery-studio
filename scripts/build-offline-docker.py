"""
Build a self-contained offline Docker + PostgreSQL deployment bundle for Linux amd64.

Works without requiring a local Docker daemon on the build machine:
  1. Builds frontend assets + Linux amd64 & Windows amd64 `delivery-studio` binaries.
  2. Exports the live PostgreSQL database (all schemas, clusters, IAM, AI providers/keys,
     MCP, skills, sandbox, KB, security advisories/scans, audit & AI usage) via `store db-export`.
  3. Pulls `postgres:16-alpine` (linux/amd64) and `python:3.12-slim-bookworm` (linux/amd64)
     from Docker Registry V2 over HTTPS (cached in `dist/.oci-cache`) and constructs standard
     `docker load`-compatible image tarballs (`postgres-16-alpine-amd64.tar` &
     `delivery-studio-1.0.0-amd64.tar`).
  4. Packages runtimes, user attachment blobs, optional OS package library, `install.sh`
     (default port 8080), `docker-compose.yml`, and `SHA256SUMS` into a single `.tar.gz`.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def registry_token(repo: str) -> str:
    url = f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))["token"]


def registry_get_json(repo: str, ref: str, token: str, accept: str) -> dict:
    req = urllib.request.Request(
        f"https://registry-1.docker.io/v2/{repo}/manifests/{ref}",
        headers={"Authorization": f"Bearer {token}", "Accept": accept},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_blob(repo: str, digest: str, token: str, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    hex_id = digest.split(":", 1)[1]
    dest = cache_dir / hex_id
    if dest.exists() and sha256_file(dest) == hex_id:
        return dest
    print(f"    downloading blob {hex_id[:12]}...")
    req = urllib.request.Request(
        f"https://registry-1.docker.io/v2/{repo}/blobs/{digest}",
        headers={"Authorization": f"Bearer {token}"},
    )
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(req, timeout=300) as resp, tmp.open("wb") as out:
        while chunk := resp.read(1024 * 1024):
            out.write(chunk)
    actual = sha256_file(tmp)
    if actual != hex_id:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Blob digest mismatch for {digest}: got {actual}")
    tmp.replace(dest)
    return dest


def _try_offline_cached_parts(repo: str, tag: str, cache_dir: Path) -> tuple[dict, list[Path]] | None:
    """Resolve (config, layer_tars) directly from cache_dir if all unpacked layers are already present."""
    unpacked_dir = cache_dir / "unpacked"
    if not unpacked_dir.exists():
        return None
    manifest_cache = cache_dir / "manifests" / f"{repo.replace('/', '_')}_{tag}.json"
    if manifest_cache.exists():
        try:
            manifest = json.loads(manifest_cache.read_text(encoding="utf-8"))
            cfg_hex = manifest["config"]["digest"].split(":", 1)[1]
            cfg_file = cache_dir / cfg_hex
            if cfg_file.exists():
                cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
                layers = [unpacked_dir / f"{d.split(':', 1)[1]}.tar" for d in cfg["rootfs"]["diff_ids"]]
                if all(p.exists() for p in layers):
                    return cfg, layers
        except Exception:
            pass

    # Fallback: match cached OCI config JSON in cache_dir by image environment signature + complete diff_ids
    want_marker = "PG_MAJOR=16" if "postgres" in repo else ("PYTHON_VERSION=3.12" if "python" in repo else "")
    if not want_marker:
        return None
    for f in cache_dir.iterdir():
        if not f.is_file() or f.stat().st_size > 128 * 1024:
            continue
        try:
            cfg = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        envs = (cfg.get("config") or {}).get("Env") or []
        diff_ids = (cfg.get("rootfs") or {}).get("diff_ids") or []
        if not diff_ids or not any(want_marker in e for e in envs):
            continue
        layers = [unpacked_dir / f"{d.split(':', 1)[1]}.tar" for d in diff_ids]
        if all(p.exists() for p in layers):
            return cfg, layers
    return None


def pull_amd64_image_parts(repo: str, tag: str, cache_dir: Path) -> tuple[dict, list[Path]]:
    """Return (image_config_dict, list_of_uncompressed_layer_tar_paths)."""
    cached = _try_offline_cached_parts(repo, tag, cache_dir)
    if cached is not None:
        print(f"==> Using local cached OCI image {repo}:{tag} (linux/amd64, {len(cached[1])} layers)")
        return cached
    print(f"==> Resolving OCI image {repo}:{tag} (linux/amd64)...")
    token = registry_token(repo)
    accept_index = ", ".join(
        [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        ]
    )
    top = registry_get_json(repo, tag, token, accept_index)
    if "manifests" in top:
        chosen = None
        for m in top["manifests"]:
            plat = m.get("platform") or {}
            if plat.get("os") == "linux" and plat.get("architecture") == "amd64":
                chosen = m["digest"]
                break
        if not chosen:
            raise RuntimeError(f"No linux/amd64 manifest found in {repo}:{tag}")
        manifest = registry_get_json(
            repo,
            chosen,
            token,
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        )
    else:
        manifest = top

    manifest_cache = cache_dir / "manifests" / f"{repo.replace('/', '_')}_{tag}.json"
    manifest_cache.parent.mkdir(parents=True, exist_ok=True)
    manifest_cache.write_text(json.dumps(manifest), encoding="utf-8")

    cfg_blob = download_blob(repo, manifest["config"]["digest"], token, cache_dir)
    cfg = json.loads(cfg_blob.read_text(encoding="utf-8"))

    uncompressed_layers: list[Path] = []
    unpacked_dir = cache_dir / "unpacked"
    unpacked_dir.mkdir(parents=True, exist_ok=True)

    for idx, layer in enumerate(manifest["layers"]):
        compressed_path = download_blob(repo, layer["digest"], token, cache_dir)
        media_type = layer.get("mediaType", "")
        diff_id = cfg["rootfs"]["diff_ids"][idx]
        diff_hex = diff_id.split(":", 1)[1]
        raw_tar = unpacked_dir / f"{diff_hex}.tar"
        if not (raw_tar.exists() and sha256_file(raw_tar) == diff_hex):
            tmp_tar = raw_tar.with_suffix(".tar.part")
            if "gzip" in media_type or compressed_path.read_bytes()[:2] == b"\x1f\x8b":
                with gzip.open(compressed_path, "rb") as gz, tmp_tar.open("wb") as out:
                    shutil.copyfileobj(gz, out, length=1024 * 1024)
            else:
                shutil.copyfile(compressed_path, tmp_tar)
            got = sha256_file(tmp_tar)
            if got != diff_hex:
                tmp_tar.unlink(missing_ok=True)
                raise RuntimeError(f"Uncompressed layer diff_id mismatch: expected {diff_hex}, got {got}")
            tmp_tar.replace(raw_tar)
        uncompressed_layers.append(raw_tar)

    return cfg, uncompressed_layers


def write_docker_save_tar(
    output_tar: Path,
    repo_tag: str,
    config_obj: dict,
    layer_tars: list[Path],
) -> None:
    config_bytes = json.dumps(config_obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    config_name = f"{sha256_bytes(config_bytes)}.json"
    layer_names: list[str] = []

    output_tar.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output_tar, "w") as tf:
        for lt in layer_tars:
            layer_dir = sha256_file(lt)
            arc = f"{layer_dir}/layer.tar"
            layer_names.append(arc)
            ti = tarfile.TarInfo(name=arc)
            ti.size = lt.stat().st_size
            ti.mtime = 1700000000
            ti.mode = 0o644
            with lt.open("rb") as f:
                tf.addfile(ti, f)

        ci = tarfile.TarInfo(name=config_name)
        ci.size = len(config_bytes)
        ci.mtime = 1700000000
        ci.mode = 0o644
        tf.addfile(ci, io.BytesIO(config_bytes))

        manifest_bytes = json.dumps(
            [{"Config": config_name, "RepoTags": [repo_tag], "Layers": layer_names}],
            indent=2,
        ).encode("utf-8")
        mi = tarfile.TarInfo(name="manifest.json")
        mi.size = len(manifest_bytes)
        mi.mtime = 1700000000
        mi.mode = 0o644
        tf.addfile(mi, io.BytesIO(manifest_bytes))


def build_app_layer_tar(linux_bin: Path, entrypoint_sh: Path, dest_tar: Path) -> str:
    """Create an uncompressed tar layer adding delivery-studio binary, entrypoint, and dirs."""
    ep_bytes = entrypoint_sh.read_bytes().replace(b"\r\n", b"\n")
    with tarfile.open(dest_tar, "w") as tf:
        for d in [
            "usr",
            "usr/local",
            "usr/local/bin",
            "opt",
            "opt/delivery-studio",
            "opt/delivery-studio/seed",
            "var",
            "var/lib",
            "var/lib/delivery-studio",
        ]:
            di = tarfile.TarInfo(name=d)
            di.type = tarfile.DIRTYPE
            di.mode = 0o755
            di.uid = di.gid = 0
            di.uname = di.gname = "root"
            di.mtime = int(time.time())
            tf.addfile(di)

        bi = tarfile.TarInfo(name="usr/local/bin/delivery-studio")
        bi.size = linux_bin.stat().st_size
        bi.mode = 0o755
        bi.uid = bi.gid = 0
        bi.uname = bi.gname = "root"
        bi.mtime = int(time.time())
        with linux_bin.open("rb") as f:
            tf.addfile(bi, f)

        ei = tarfile.TarInfo(name="usr/local/bin/docker-entrypoint.sh")
        ei.size = len(ep_bytes)
        ei.mode = 0o755
        ei.uid = ei.gid = 0
        ei.uname = ei.gname = "root"
        ei.mtime = int(time.time())
        tf.addfile(ei, io.BytesIO(ep_bytes))

    return sha256_file(dest_tar)


def add_bytes_to_tar(tf: tarfile.TarFile, arcname: str, data: bytes, mode: int = 0o644) -> None:
    ti = tarfile.TarInfo(name=arcname)
    ti.size = len(data)
    ti.mode = mode
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = "root"
    ti.mtime = int(time.time())
    tf.addfile(ti, io.BytesIO(data))


def add_file_to_tar(tf: tarfile.TarFile, arcname: str, src: Path, mode: int = 0o644) -> None:
    ti = tarfile.TarInfo(name=arcname)
    ti.size = src.stat().st_size
    ti.mode = mode
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = "root"
    ti.mtime = int(src.stat().st_mtime)
    with src.open("rb") as f:
        tf.addfile(ti, f)


def main() -> None:
    ap = argparse.ArgumentParser(description="Build offline Docker + PostgreSQL bundle (default port 8080)")
    ap.add_argument("--go", default="D:/BMW/_go_runtime/go/bin/go.exe" if Path("D:/BMW/_go_runtime/go/bin/go.exe").exists() else "go")
    ap.add_argument("--run-dir", type=Path, default=WORKSPACE / "delivery-studio-run")
    ap.add_argument("--skip-frontend", action="store_true")
    ap.add_argument("--skip-library", action="store_true", help="Omit the large OS RPM/DEB package pool if a slim bundle is desired")
    args = ap.parse_args()

    backend = ROOT / "backend"
    frontend = ROOT / "frontend"
    dist = ROOT / "dist"
    dist.mkdir(parents=True, exist_ok=True)
    cache_dir = dist / ".oci-cache"

    version = re.search(r'version\s*=\s*"([^"]+)"', (backend / "internal/server/main.go").read_text(encoding="utf-8")).group(1)
    stamp = time.strftime("%Y%m%d%H%M%S")
    build_id = f"docker-{stamp}"

    if not args.skip_frontend:
        print("==> [1/5] Building frontend production bundle...")
        npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
        subprocess.run([npm_cmd, "run", "build"], cwd=frontend, check=True)

    print("==> [2/5] Compiling Linux amd64 & host binaries...")
    linux_bin = dist / "delivery-studio-linux-amd64"
    host_bin = dist / ("delivery-studio.exe" if os.name == "nt" else "delivery-studio-host")

    env_linux = dict(os.environ, CGO_ENABLED="0", GOOS="linux", GOARCH="amd64")
    subprocess.run(
        [args.go, "build", "-trimpath", "-ldflags", f"-s -w -X main.buildID={build_id}", "-o", str(linux_bin), "./cmd/studio"],
        cwd=backend,
        env=env_linux,
        check=True,
    )
    env_host = dict(os.environ, CGO_ENABLED="0")
    env_host.pop("GOOS", None)
    env_host.pop("GOARCH", None)
    subprocess.run(
        [args.go, "build", "-trimpath", "-ldflags", f"-X main.buildID={build_id}", "-o", str(host_bin), "./cmd/studio"],
        cwd=backend,
        env=env_host,
        check=True,
    )

    print("==> [3/5] Exporting full PostgreSQL database snapshot...")
    db_url = ""
    for cand in [args.run_dir / "db.windows.url", args.run_dir / "db.url"]:
        if cand.exists():
            db_url = cand.read_text(encoding="utf-8").strip()
            if db_url:
                break
    cfg_file = args.run_dir / ("config.windows.json" if (args.run_dir / "config.windows.json").exists() else "config.json")

    with tempfile.TemporaryDirectory(prefix="ds-offline-docker-") as tmp_str:
        stage = Path(tmp_str)
        seed_sql = stage / "01-delivery-studio-seed.sql"
        cmd = [str(host_bin), "store", "db-export", "--output", str(seed_sql)]
        if cfg_file.exists():
            cmd += ["--config", str(cfg_file)]
        if db_url:
            cmd += ["--db-url", db_url]
        res = subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8")
        print("    DB export summary:", res.stdout.strip())

        print("==> [4/5] Building offline Docker image tarballs (postgres:16-alpine + delivery-studio)...")
        pg_cfg, pg_layers = pull_amd64_image_parts("library/postgres", "16-alpine", cache_dir)
        pg_tar = stage / "postgres-16-alpine-amd64.tar"
        write_docker_save_tar(pg_tar, "postgres:16-alpine", pg_cfg, pg_layers)

        py_cfg, py_layers = pull_amd64_image_parts("library/python", "3.12-slim-bookworm", cache_dir)
        app_layer = stage / "app-layer.tar"
        app_diff_hex = build_app_layer_tar(linux_bin, ROOT / "deploy/linux/docker-entrypoint.sh", app_layer)

        app_cfg = json.loads(json.dumps(py_cfg))
        app_cfg["created"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        app_cfg.setdefault("config", {})
        base_env = [e for e in app_cfg["config"].get("Env", []) if not e.startswith(("PORT=", "TZ=", "DELIVERY_STUDIO_"))]
        app_cfg["config"]["Env"] = base_env + [
            "TZ=Asia/Shanghai",
            "PORT=8080",
            "DELIVERY_STUDIO_DATA_DIR=/var/lib/delivery-studio",
        ]
        app_cfg["config"]["WorkingDir"] = "/var/lib/delivery-studio"
        app_cfg["config"]["ExposedPorts"] = {"8080/tcp": {}}
        app_cfg["config"]["Entrypoint"] = ["/usr/local/bin/docker-entrypoint.sh"]
        app_cfg["config"]["Cmd"] = []
        app_cfg["rootfs"]["diff_ids"] = list(app_cfg["rootfs"]["diff_ids"]) + [f"sha256:{app_diff_hex}"]
        app_cfg.setdefault("history", []).append(
            {"created": app_cfg["created"], "created_by": f"delivery-studio offline builder v{version}"}
        )

        app_tar = stage / f"delivery-studio-{version}-amd64.tar"
        write_docker_save_tar(app_tar, f"delivery-studio:{version}", app_cfg, py_layers + [app_layer])

        print("==> [5/5] Assembling final offline deployment archive...")
        bundle_name = f"delivery-studio-v{version}-offline-docker-amd64"
        out_archive = dist / f"{bundle_name}.tar.gz"

        install_text = (ROOT / "deploy/linux/docker-deploy.sh").read_text(encoding="utf-8")
        install_text = re.sub(r'^APP_VERSION="[^"]+"', f'APP_VERSION="{version}"', install_text, flags=re.MULTILINE)
        install_bytes = install_text.replace("\r\n", "\n").encode("utf-8")

        compose_text = (ROOT / "deploy/linux/docker-compose.offline.yml").read_text(encoding="utf-8")
        compose_text = re.sub(
            r"image:\s*delivery-studio:[^\s]+",
            f"image: delivery-studio:{version}",
            compose_text,
        )
        compose_bytes = compose_text.replace("\r\n", "\n").encode("utf-8")
        readme_bytes = (
            f"Kyndryl Delivery Studio v{version} 离线 Docker 全量安装包（含 PostgreSQL 16 + 全量数据库数据）\n"
            "=========================================================================\n\n"
            "1. 上传本压缩包至离线 Linux x86_64 服务器（需已安装 Docker）。\n"
            "2. 解压并一键启动（默认监听 8080 端口）：\n\n"
            f"   tar -xzf {bundle_name}.tar.gz\n"
            f"   cd {bundle_name}\n"
            "   sudo bash install.sh\n\n"
            "   （如需自定义端口或目录：sudo bash install.sh --port 8080 --dir /opt/delivery-studio-docker）\n\n"
            "3. 浏览器直接打开：\n"
            "   http://<服务器IP>:8080  或  https://<服务器IP>:8080\n"
            "   所有原有账户密码、集群基线、AI 供应商（含密钥）、MCP、沙箱与安全库均已自动恢复就绪。\n"
        ).encode("utf-8")

        data_root = args.run_dir / "data"
        extra_files: list[tuple[str, Path]] = []

        # Include offline Ansible & Sandbox runtimes
        art_dir = data_root / "artifacts"
        if art_dir.exists():
            for p in sorted(art_dir.iterdir()):
                if p.is_file() and p.name.endswith((".tar.gz", ".sha256")):
                    extra_files.append((f"data/artifacts/{p.name}", p))

        # Include user uploaded attachment / KB blobs & extracted texts
        users_dir = data_root / "settings" / "users"
        if users_dir.exists():
            for p in sorted(users_dir.rglob("*")):
                if p.is_file() and ("blobs" in p.parts or "text" in p.parts):
                    rel = p.relative_to(data_root).as_posix()
                    extra_files.append((f"data/{rel}", p))

        # Include offline OS RPM/DEB library unless --skip-library
        lib_dir = data_root / "library"
        if not args.skip_library and lib_dir.exists():
            for p in sorted(lib_dir.rglob("*")):
                if p.is_file() and not any(part.startswith(".") or part == "built" for part in p.relative_to(lib_dir).parts):
                    rel = p.relative_to(lib_dir).as_posix()
                    extra_files.append((f"data/library/{rel}", p))

        checksum_lines: list[str] = [
            f"{sha256_bytes(install_bytes)}  install.sh",
            f"{sha256_bytes(compose_bytes)}  docker-compose.yml",
            f"{sha256_file(seed_sql)}  db/01-delivery-studio-seed.sql",
            f"{sha256_file(pg_tar)}  images/postgres-16-alpine-amd64.tar",
            f"{sha256_file(app_tar)}  images/delivery-studio-{version}-amd64.tar",
        ]
        for rel, src in extra_files:
            checksum_lines.append(f"{sha256_file(src)}  {rel}")
        sums_bytes = ("\n".join(checksum_lines) + "\n").encode("utf-8")

        # Use compresslevel=1 so already-compressed image layers / RPMs / tar.gz archives pack in seconds
        with out_archive.open("wb") as raw_out:
            with gzip.GzipFile(filename=f"{bundle_name}.tar", mode="wb", fileobj=raw_out, compresslevel=1) as gz_out:
                with tarfile.open(mode="w", fileobj=gz_out) as tf:
                    add_bytes_to_tar(tf, f"{bundle_name}/install.sh", install_bytes, mode=0o755)
                    add_bytes_to_tar(tf, f"{bundle_name}/docker-compose.yml", compose_bytes, mode=0o644)
                    add_bytes_to_tar(tf, f"{bundle_name}/README.txt", readme_bytes, mode=0o644)
                    add_bytes_to_tar(tf, f"{bundle_name}/SHA256SUMS", sums_bytes, mode=0o644)
                    add_file_to_tar(tf, f"{bundle_name}/db/01-delivery-studio-seed.sql", seed_sql, mode=0o600)
                    add_file_to_tar(tf, f"{bundle_name}/images/postgres-16-alpine-amd64.tar", pg_tar, mode=0o644)
                    add_file_to_tar(tf, f"{bundle_name}/images/delivery-studio-{version}-amd64.tar", app_tar, mode=0o644)
                    for rel, src in extra_files:
                        add_file_to_tar(tf, f"{bundle_name}/{rel}", src, mode=0o644)

        out_sha = sha256_file(out_archive)
        (dist / f"{bundle_name}.tar.gz.sha256").write_text(f"{out_sha}  {out_archive.name}\n", encoding="ascii")

    print(
        json.dumps(
            {
                "bundle": str(out_archive),
                "size_mb": round(out_archive.stat().st_size / (1024 * 1024), 2),
                "sha256": out_sha,
                "default_port": 8080,
                "extra_data_files": len(extra_files),
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
