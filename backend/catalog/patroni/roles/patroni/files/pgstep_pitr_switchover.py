#!/usr/bin/env python3
from pgcommon import *

def _pitr_sw_prepare():
 need_replicas();need((state/'backup-created').exists(),'Run the pgBackRest full backup first');need(sql('SELECT pg_is_in_recovery();')=='f','Run while the controller node is primary')
 p=wait_cluster();ensure_marker(p);mkdir(testroot,'postgres');target=testroot/'pitr-switchover';need(not target.exists(),'Path exists; run clean-artifacts before rerun')
 sql("DROP TABLE IF EXISTS middleware_acceptance.pitr_sw;CREATE TABLE middleware_acceptance.pitr_sw(id int PRIMARY KEY, phase text);INSERT INTO middleware_acceptance.pitr_sw SELECT g,'before-switch' FROM generate_series(1,100) g;")
 t=switch(others(p)[0]);sql("INSERT INTO middleware_acceptance.pitr_sw SELECT g,'after-switch' FROM generate_series(101,200) g;",host=t['ip'])
 time.sleep(3);when=sql("SELECT clock_timestamp()::text;",host=t['ip']);time.sleep(3)
 sql("INSERT INTO middleware_acceptance.pitr_sw SELECT g,'late' FROM generate_series(201,300) g;",host=t['ip'])
 seg=sql('SELECT pg_walfile_name(pg_current_wal_lsn());',host=t['ip']);sql('SELECT pg_switch_wal();',host=t['ip'])
 for _ in range(60):
  if sql('SELECT coalesce(last_archived_wal,\'\') FROM pg_stat_archiver;',host=t['ip'])>=seg:break
  time.sleep(1)
 else:raise RuntimeError('Segment '+seg+' was not archived in time')
 stage=testroot/'pitr-stage';need(not stage.exists(),'Stage path exists; run clean-artifacts before rerun');mkdir(stage,'postgres')
 meta={'p_name':p['name'],'t_name':t['name'],'when':when,'target':str(target),'stage':str(stage),'repo':str(repo),'scope':scope}
 write(state/'pitr-sw-ctx.json',json.dumps(meta))
 print('PITR_SW_META:'+json.dumps(meta),flush=True)

def _pitr_sw_verify():
 meta=json.loads((state/'pitr-sw-ctx.json').read_text())
 p=next(n for n in c['nodes'] if n['name']==meta['p_name'])
 when=meta['when'];target=Path(meta['target']);stage=Path(meta['stage'])
 run(['runuser','-u','postgres','--','pgbackrest','--stanza='+scope,'--pg1-path='+str(target),'--type=time','--target='+when,'--target-action=promote','restore'],show=True)
 write(target/'postgresql.auto.conf',(target/'postgresql.auto.conf').read_text()+"\nrestore_command = '"+stagecmd(stage).replace("'","''")+"'\n",0o600,'postgres')
 def check(port):
  wait_promoted(port);q=lambda ph:sql("SELECT count(*) FROM middleware_acceptance.pitr_sw WHERE phase='"+ph+"';",port=port,sock=testroot)
  a,b,l=q('before-switch'),q('after-switch'),q('late');need((a,b,l)==('100','100','0'),'Cross-timeline PITR mismatch: '+str((a,b,l)))
  tl=sql('SELECT timeline_id FROM pg_control_checkpoint();',port=port,sock=testroot);need(int(tl)>2,'Restored instance did not follow the switchover timeline');log('Cross-timeline PITR verified: rows from both primaries present, later rows absent, timeline='+tl)
 try:isolated('pitr-switchover',15435,check)
 finally:switch(p)

def _pitr_sw_restore_leader():
 ctx=state/'pitr-sw-ctx.json'
 if not ctx.exists():return
 meta=json.loads(ctx.read_text());p=next(n for n in c['nodes'] if n['name']==meta['p_name'])
 if leader()['name']!=p['name']:switch(p)

def pitr_switchover():
 phase=os.environ.get('MW_PG_PHASE','all')
 if phase=='prepare':return _pitr_sw_prepare()
 if phase=='verify':return _pitr_sw_verify()
 if phase=='restore_leader':return _pitr_sw_restore_leader()
 need_replicas();need((state/'backup-created').exists(),'Run the pgBackRest full backup first');need(sql('SELECT pg_is_in_recovery();')=='f','Run while the controller node is primary')
 p=wait_cluster();ensure_marker(p);mkdir(testroot,'postgres');target=testroot/'pitr-switchover';need(not target.exists(),'Path exists; run clean-artifacts before rerun')
 sql("DROP TABLE IF EXISTS middleware_acceptance.pitr_sw;CREATE TABLE middleware_acceptance.pitr_sw(id int PRIMARY KEY, phase text);INSERT INTO middleware_acceptance.pitr_sw SELECT g,'before-switch' FROM generate_series(1,100) g;")
 t=switch(others(p)[0]);sql("INSERT INTO middleware_acceptance.pitr_sw SELECT g,'after-switch' FROM generate_series(101,200) g;",host=t['ip'])
 time.sleep(3);when=sql("SELECT clock_timestamp()::text;",host=t['ip']);time.sleep(3)
 # Commit the later rows first and switch the segment in a separate statement: in one multi-statement query the commit
 # would land in the next segment, which is not archived yet, and recovery could never see a commit past the target time.
 sql("INSERT INTO middleware_acceptance.pitr_sw SELECT g,'late' FROM generate_series(201,300) g;",host=t['ip'])
 seg=sql('SELECT pg_walfile_name(pg_current_wal_lsn());',host=t['ip']);sql('SELECT pg_switch_wal();',host=t['ip'])
 for _ in range(60):
  if sql('SELECT coalesce(last_archived_wal,\'\') FROM pg_stat_archiver;',host=t['ip'])>=seg:break
  time.sleep(1)
 else:raise RuntimeError('Segment '+seg+' was not archived in time')
 stage=testroot/'pitr-stage';need(not stage.exists(),'Stage path exists; run clean-artifacts before rerun');gather_wal(stage)
 run(['runuser','-u','postgres','--','pgbackrest','--stanza='+scope,'--pg1-path='+str(target),'--type=time','--target='+when,'--target-action=promote','restore'],show=True)
 write(target/'postgresql.auto.conf',(target/'postgresql.auto.conf').read_text()+"\nrestore_command = '"+stagecmd(stage).replace("'","''")+"'\n",0o600,'postgres')
 def check(port):
  wait_promoted(port);q=lambda ph:sql("SELECT count(*) FROM middleware_acceptance.pitr_sw WHERE phase='"+ph+"';",port=port,sock=testroot)
  a,b,l=q('before-switch'),q('after-switch'),q('late');need((a,b,l)==('100','100','0'),'Cross-timeline PITR mismatch: '+str((a,b,l)))
  tl=sql('SELECT timeline_id FROM pg_control_checkpoint();',port=port,sock=testroot);need(int(tl)>2,'Restored instance did not follow the switchover timeline');log('Cross-timeline PITR verified: rows from both primaries present, later rows absent, timeline='+tl)
 try:isolated('pitr-switchover',15435,check)
 finally:switch(p)

if __name__ == '__main__':
 need(action == 'pitr-switchover', 'Step entry/action mismatch')
 execute(pitr_switchover)
