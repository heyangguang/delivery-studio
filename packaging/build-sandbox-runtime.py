"""Build the Python runtime the code sandbox runs: a standalone CPython plus the libraries the assistant uses to read
and make documents. It needs the network once, here; the finished archive is installed as artifacts/sandbox-runtime.tar.gz
and nothing is fetched where the platform runs.

  python3 packaging/build-sandbox-runtime.py [--python-archive FILE] [--out FILE]

--python-archive is a python-build-standalone "install_only_stripped" archive (cpython-3.12 x86_64-unknown-linux-gnu);
without it the pinned release below is downloaded and its SHA-256 checked."""
import argparse, hashlib, shutil, subprocess, sys, tarfile, tempfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = '20261021'
NAME = 'cpython-3.12.15+20261021-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
SHA = '6d7521138fd33afddc1ccd08abb007d9a2829e38117c2576f9efdc0ec73ce772'
URL = 'https://github.com/astral-sh/python-build-standalone/releases/download/%s/%s' % (RELEASE, NAME.replace('+', '%2B'))
# exact versions: the same runtime every time
PACKAGES = ['numpy==2.5.4', 'pandas==3.1.0', 'openpyxl==3.1.5', 'xlsxwriter==3.3.0', 'python-docx==1.2.0',
            'python-pptx==1.0.2', 'pymupdf==1.28.2', 'pillow==13.0.0', 'pypdf==6.21.2', 'matplotlib==3.11.2', 'pyyaml==6.0.3']
# what the assistant is told it can import (the import name, with the package in brackets when it differs)
MANIFEST = 'pandas numpy openpyxl xlsxwriter docx(python-docx) pptx(python-pptx) pymupdf(也可写fitz) PIL(pillow) pypdf matplotlib yaml(pyyaml)\n'

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--python-archive', type=Path)
    ap.add_argument('--out', type=Path, default=ROOT.parent / 'sandbox-runtime' / 'sandbox-runtime.tar.gz')
    a = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix='sandbox-runtime-') as tmp:
        tmp = Path(tmp)
        arc = a.python_archive
        if arc is None:
            arc = tmp / NAME
            print('downloading', URL)
            urllib.request.urlretrieve(URL, arc)
        assert sha(arc) == SHA, 'Python archive checksum mismatch'
        with tarfile.open(arc) as t:
            t.extractall(tmp, filter='data')
        py = tmp / 'python'
        subprocess.run([str(py / 'bin/python3'), '-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '--root-user-action=ignore', '-q'] + PACKAGES, check=True)
        # what a program reading and writing documents does not need
        for d in ['include', 'share', 'lib/tcl9.0', 'lib/tk9.0', 'lib/python3.12/test', 'lib/python3.12/idlelib', 'lib/python3.12/tkinter',
                  'lib/python3.12/turtledemo', 'lib/python3.12/ensurepip', 'lib/python3.12/lib2to3', 'lib/python3.12/site-packages/pip']:
            shutil.rmtree(py / d, ignore_errors=True)
        for p in list(py.rglob('lib*tcl*')) + list(py.rglob('lib*tk*')) + list(py.rglob('_tkinter*')):
            if p.is_file(): p.unlink()
        for p in list(py.rglob('__pycache__')) + [q for q in py.rglob('*') if q.is_dir() and q.name in ('tests', 'test', 'testing') and 'site-packages' in q.parts]:
            shutil.rmtree(p, ignore_errors=True)
        shutil.rmtree(py / 'lib/python3.12/site-packages/matplotlib/mpl-data/sample_data', ignore_errors=True)
        for p in py.glob('lib/python3.12/site-packages/pip-*'):
            shutil.rmtree(p, ignore_errors=True)
        (py / 'manifest.txt').write_text(MANIFEST, encoding='utf-8')
        # prove it works before it is packed
        subprocess.run([str(py / 'bin/python3'), '-c', 'import numpy, pandas, openpyxl, xlsxwriter, docx, pptx, pymupdf, PIL, pypdf, matplotlib, yaml; print("imports ok")'], check=True)
        a.out.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(a.out, 'w:gz') as t:
            for p in sorted(py.rglob('*')):
                info = t.gettarinfo(str(p), arcname='python/' + str(p.relative_to(py)))
                info.uid = info.gid = 0; info.uname = info.gname = 'root'
                if p.is_file():
                    with p.open('rb') as f: t.addfile(info, f)
                else:
                    t.addfile(info)
    Path(str(a.out) + '.sha256').write_text(sha(a.out) + '  ' + a.out.name + '\n')
    print(a.out, a.out.stat().st_size, sha(a.out))

if __name__ == '__main__':
    sys.exit(main())
