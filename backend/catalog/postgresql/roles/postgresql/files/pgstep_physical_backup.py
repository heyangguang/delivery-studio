#!/usr/bin/env python3
from pgcommon import *

def physical_backup():
 need(opt['replica_count']>=1,'A replica is required for the independent physical backup');p=wait_cluster();r=others(p)[-1];ensure_marker(p);sql('CHECKPOINT;',host=p['ip'])
 mkdir(testroot,'postgres');target=testroot/'basebackup';need(not target.exists(),'Base backup exists; run clean-artifacts before rerun')
 if opt['tde']:
  # pg_tde_basebackup needs the server principal key before it starts: the source's pg_tde directory goes into the destination first
  shutil.copytree(data/'pg_tde',target/'pg_tde',symlinks=True);mkdir(target)
  for q in [target]+list(target.rglob('*')):shutil.chown(q,user='postgres',group='postgres')
 run(['runuser','-u','postgres','--',tool('basebackup'),'-h',r['ip'],'-p',str(PGP),'-U','replicator','-D',target,'-X','stream','-c','fast','--no-password']+(['-E'] if opt['tde'] else []),show=True,env={'PGPASSWORD':accounts['replicator'],'PGSSLMODE':'verify-ca' if opt['tls'] else 'disable','PGSSLROOTCERT':'/etc/pki/pg/ca.crt'})
 (state/'physical-created').write_text(r['name']);log('Independent physical backup taken from replica '+r['name'])

if __name__ == '__main__':
 need(action == 'physical-backup', 'Step entry/action mismatch')
 execute(physical_backup)
