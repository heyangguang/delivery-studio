#!/usr/bin/env python3
"""Install a release without interrupting active AI streams. Requires store supervise."""
import argparse,hashlib,json,os,shutil,signal,subprocess,time,urllib.request,ssl
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--binary',type=Path,required=True);a=p.parse_args()
root=a.root.resolve();binary=a.binary.resolve()
app_dir='delivery-studio' if (root/'delivery-studio/bin/delivery-studio').exists() else 'middleware-store'
bin_name=app_dir
target=root/app_dir/'bin'/bin_name
version=subprocess.check_output([str(binary),'version'],text=True,timeout=10).strip()
assert version and version[0].isdigit(),'Invalid release version'
config=root/'config.json';cfg=json.loads(config.read_text());base=cfg['public_url'];pids=[]
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit():continue
 try:
  args=(proc/'cmdline').read_bytes().split(b'\0')
  if b'supervise' in args and b'--config' in args and Path(os.fsdecode(args[args.index(b'--config')+1])).resolve()==config:pids.append(int(proc.name))
 except OSError:pass
assert len(pids)==1,'No unique stable gateway. Refusing a restart that could interrupt AI.'
# No schema/component migrations here: prepare and validate those separately.
bak=root/'backups'/('smooth-'+time.strftime('%Y%m%d-%H%M%S'));bak.mkdir(parents=True,mode=0o700)
shutil.copy2(target,bak/bin_name)
nextfile=target.with_suffix('.next');shutil.copy2(binary,nextfile);nextfile.chmod(0o755);os.replace(nextfile,target)
statusfile=Path(cfg['data_dir'])/'gateway-status.json'
previous=json.loads(statusfile.read_text()).get('id') if statusfile.exists() else None
os.kill(pids[0],signal.SIGUSR2)
print('Release queued:',version,'Existing answers and tasks continue. Gateway PID:',pids[0],flush=True)
context=ssl._create_unverified_context()
last=''
while True:
 try:
  with urllib.request.urlopen(base+'/api/version',context=context,timeout=10) as r:current=json.load(r)['version']
  state=json.loads(statusfile.read_text())
  if state.get('id')!=previous and state['state'] in ['failed','rolled-back']:
   shutil.copy2(bak/bin_name,nextfile);os.replace(nextfile,target)
   raise SystemExit('Update not applied; original service retained: '+state.get('detail',''))
  if current==version and state.get('id')!=previous and state['state']=='ready':break
  if current!=last:print('Serving',current,'while waiting for active work to finish.',flush=True);last=current
 except Exception as e:print('Waiting for readiness:',type(e).__name__,flush=True)
 # Never kill an active worker just because a deployment script timed out.
 time.sleep(2)
f=root/app_dir/'SHA256SUMS'
if f.exists():
 digest=hashlib.sha256(target.read_bytes()).hexdigest()
 f.write_text('\n'.join(digest+'  bin/'+bin_name if l.split() and l.split()[-1]=='bin/'+bin_name else l for l in f.read_text().splitlines())+'\n')
print('Serving',version,'without restarting the public listener. Backup:',bak)
