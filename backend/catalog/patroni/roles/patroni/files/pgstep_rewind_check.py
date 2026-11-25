#!/usr/bin/env python3
from pgcommon import *

def rewind_check():
 # pg_rewind is what lets a former primary that holds WAL the new primary never received rejoin as a replica without a full
 # re-clone. Patroni runs it by itself when needed; this test checks the four things it depends on, and reports the times it
 # really ran on this node. It does not run pg_rewind.
 log('What this checks: the four conditions pg_rewind depends on. It does not run pg_rewind.')
 tp=tool('rewind');cfg=http(node['ip'],'config').get('postgresql',{}).get('use_pg_rewind')
 cs=sql('SHOW data_checksums;');wl=sql('SHOW wal_log_hints;');acct=sql("SELECT count(*) FROM pg_roles WHERE rolname='rewind_user';")
 checks=[('Rewind tool present',Path(tp).exists(),tp),('Patroni use_pg_rewind enabled',cfg is True,'use_pg_rewind='+str(cfg)),
  ('Data checksums or wal_log_hints on',cs=='on' or wl=='on','data_checksums='+cs+', wal_log_hints='+wl),('Account rewind_user exists',acct=='1','rewind_user rows='+acct)]
 for name,ok,val in checks:log(('[PASS] ' if ok else '[FAIL] ')+name+'  ('+val+')')
 need(all(c[1] for c in checks),'pg_rewind prerequisites not met: '+', '.join(c[0] for c in checks if not c[1]))
 # Was a rewind ever run on this node? Only lines that report running one count (lines that merely mention the setting,
 # such as use_pg_rewind in the configuration dump, say nothing). One rewind writes two lines; they are shown as one.
 out=run(['sh','-c',"journalctl -u patroni --no-pager | grep -iE 'pg_(tde_)?rewind' | grep -viE 'use_pg_rewind|bin_name|pg_rewind:' || true"])
 ran=[l for l in out.splitlines() if re.search(r'running pg_(tde_)?rewind|rewind (process|completed|finished|failed)|Failed to rewind|pg_(tde_)?rewind from',l,re.I)]
 seen=[]
 for l in ran:
  m=re.search(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)',l);when=m.group(1) if m else '?'
  src=re.search(r'host=([\w.\-]+)',l) or re.search(r'pg_(?:tde_)?rewind from (\S+)',l);src=src.group(1) if src else 'unknown'
  if not seen or seen[-1][0][:16]!=when[:16]:seen.append((when,src))
 if seen:
  log('Patroni ran pg_rewind on this node '+str(len(seen))+' time(s) (each time a former primary rejoined as a replica); latest:')
  for when,src in seen[-5:]:log('  '+when+'  source = '+src)
 else:log('Patroni has not run pg_rewind on this node yet (none is needed unless a former primary holds WAL the new primary never received)')
 log('Result: pg_rewind is ready to be used by Patroni on this node. Whether a specific rejoin succeeds is only shown when one happens.')

if __name__ == '__main__':
 need(action == 'rewind-check', 'Step entry/action mismatch')
 execute(rewind_check)
