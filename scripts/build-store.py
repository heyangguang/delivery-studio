"""Build the Linux shared store with the already-verified PG delivery assets."""
import argparse
import hashlib
import io
import re
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[1]
WORKSPACE=ROOT.parent

def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def build(go, runtime, library, extra=()):
    """Package the platform: the program (front end and built-in components are embedded), the offline Ansible runtime
    and the prepared package library. Nothing is downloaded here; prepare the library first with `library fetch-all`."""
    assert sha(runtime)==Path(str(runtime)+'.sha256').read_text().split()[0], 'Ansible runtime checksum mismatch'
    closures=sorted(library.glob('*/closures/*.json'))
    assert closures, 'the package library is empty; run: delivery-studio library fetch-all --library '+str(library)
    backend=ROOT/'backend'
    version=re.search(r'const version = "([^"]+)"',(backend/'internal/server/main.go').read_text(encoding='utf-8')).group(1)
    out=ROOT/'dist';out.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='delivery-studio-build-') as tmp:
        stage=Path(tmp);env=dict(os.environ,GOOS='linux',GOARCH='amd64',CGO_ENABLED='0')
        # the full test run takes minutes: it is done on request (MW_TEST=1), the build itself only has to compile
        if os.environ.get('MW_TEST')=='1':subprocess.run([go,'test','./...'],cwd=backend,env=dict(os.environ),check=True)
        else:subprocess.run([go,'vet','./cmd/studio','./internal/...'],cwd=backend,env=dict(os.environ),check=True)
        subprocess.run([go,'build','-trimpath','-ldflags','-s -w','-o',str(stage/'delivery-studio'),'./cmd/studio'],cwd=backend,env=env,check=True)
        files={'bin/delivery-studio':stage/'delivery-studio',
               'assets/ansible-runtime.tar.gz':runtime,'assets/ansible-runtime.tar.gz.sha256':Path(str(runtime)+'.sha256'),
               'README.md':ROOT/'README.md'}
        # the Python runtime of the code sandbox (see scripts/build-sandbox-runtime.py); without it the sandbox stays off
        sb=WORKSPACE/'sandbox-runtime/sandbox-runtime.tar.gz'
        if sb.exists() and Path(str(sb)+'.sha256').exists():
            assert sha(sb)==Path(str(sb)+'.sha256').read_text().split()[0], 'sandbox runtime checksum mismatch'
            files['assets/sandbox-runtime.tar.gz']=sb;files['assets/sandbox-runtime.tar.gz.sha256']=Path(str(sb)+'.sha256')
        else: print('NOTE: no sandbox runtime found; the package will not include the code sandbox runtime')
        # runtimes of other systems, installed as ansible-runtime-<system>.tar.gz with their checksum files
        for system,rt in extra:
            assert sha(rt)==Path(str(rt)+'.sha256').read_text().split()[0], rt.name+' checksum mismatch'
            files['assets/ansible-runtime-%s.tar.gz'%system]=rt;files['assets/ansible-runtime-%s.tar.gz.sha256'%system]=Path(str(rt)+'.sha256')
        # The library ships as files (pool, meta, closures per system); working directories and cached repositories do not.
        for p in sorted(library.rglob('*')):
            rel=p.relative_to(library)
            if p.is_file() and rel.parts[0] not in ('built',) and not any(x.startswith('.') for x in rel.parts):
                files['library/'+rel.as_posix()]=p
        for name in ['store-config.example.json','service.env.example']:files['config/'+name]=ROOT/'deploy/linux'/name
        for name in ['delivery-studio.service','nginx.example.conf']:files['deploy/'+name]=ROOT/'deploy/linux'/name
        files['install.sh']=ROOT/'deploy/linux/install.sh'
        (stage/'SHA256SUMS').write_text(''.join(sha(p)+'  '+n+'\n' for n,p in sorted(files.items())),encoding='utf-8',newline='\n')
        files['SHA256SUMS']=stage/'SHA256SUMS'
        target=out/f'delivery-studio-v{version}-linux-amd64.tar.gz'
        with tarfile.open(target,'w:gz') as tar:
            for name,path in sorted(files.items()):
                info=tar.gettarinfo(str(path),arcname='delivery-studio/'+name);info.uid=info.gid=0;info.uname=info.gname='root'
                info.mode=0o755 if name.startswith('bin/') or name=='install.sh' else 0o644
                with path.open('rb') as f:tar.addfile(info,f)
        with tarfile.open(target) as tar:
            members=tar.getmembers();assert len(members)==len(files)
            for item in members:
                assert item.isfile() and '..' not in Path(item.name).parts
                name=item.name.removeprefix('delivery-studio/')
                assert hashlib.sha256(tar.extractfile(item).read()).hexdigest()==sha(files[name])
        Path(str(target)+'.sha256').write_text(sha(target)+'  '+target.name+'\n',encoding='ascii')
    print(json.dumps({'archive':str(target),'bytes':target.stat().st_size,'sha256':sha(target),'files':len(files),'package_closures':len(closures),'server_deployment':'not run'},indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--go',default='go')
    p.add_argument('--runtime',type=Path,default=WORKSPACE/'middleware-automation/dist/middleware-automation-ansible-v0.1.4-linux-amd64.tar.gz',help='offline Ansible runtime archive (with .sha256)')
    p.add_argument('--library',type=Path,default=WORKSPACE/'package-library',help='prepared package library directory')
    p.add_argument('--extra-runtime',action='append',default=None,metavar='SYSTEM=FILE',help='offline Ansible runtime of another system, e.g. el9-amd64=....tar.gz (with .sha256); default: the newest middleware-automation-ansible-v*-<system>.tar.gz beside --runtime')
    a=p.parse_args()
    if a.extra_runtime is not None: extra=[(x.split('=',1)[0],Path(x.split('=',1)[1])) for x in a.extra_runtime]
    else: extra=[(s,sorted(a.runtime.parent.glob('middleware-automation-ansible-v*-%s.tar.gz'%s))[-1]) for s in ('el9-amd64',) if sorted(a.runtime.parent.glob('middleware-automation-ansible-v*-%s.tar.gz'%s))]
    build(a.go,a.runtime,a.library,extra)
