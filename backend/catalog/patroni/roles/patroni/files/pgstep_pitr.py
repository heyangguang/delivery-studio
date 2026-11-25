#!/usr/bin/env python3
from pgcommon import *

def pitr():
 need((state/'backup-created').exists(),'Run the pgBackRest full backup first');need(sql('SELECT pg_is_in_recovery();')=='f','PITR test runs on the controller node while it is primary')
 p=leader();ensure_marker(p);sql("DROP TABLE IF EXISTS middleware_acceptance.pitr;CREATE TABLE middleware_acceptance.pitr(id int PRIMARY KEY, phase text);INSERT INTO middleware_acceptance.pitr SELECT g,'before' FROM generate_series(1,100) g;")
 time.sleep(3);when=sql("SELECT clock_timestamp()::text;");time.sleep(3)
 sql("INSERT INTO middleware_acceptance.pitr SELECT g,'after' FROM generate_series(101,200) g;");backrest(['check'])
 mkdir(testroot,'postgres');target=testroot/'pitr';need(not target.exists(),'PITR path exists; run clean-artifacts before rerun')
 run(['runuser','-u','postgres','--','pgbackrest','--stanza='+scope,'--pg1-path='+str(target),'--type=time','--target='+when,'--target-action=promote','restore'],show=True)
 write(target/'postgresql.auto.conf',(target/'postgresql.auto.conf').read_text()+"\nrestore_command = '"+restorecmd(target).replace("'","''")+"'\n",0o600,'postgres')
 def check(port):
  wait_promoted(port);before=sql("SELECT count(*) FROM middleware_acceptance.pitr WHERE phase='before';",port=port,sock=testroot);after=sql("SELECT count(*) FROM middleware_acceptance.pitr WHERE phase='after';",port=port,sock=testroot)
  need(before=='100' and after=='0','PITR target mismatch: before='+before+' after='+after);log('PITR to '+when+' verified: 100 earlier rows present, 100 later rows absent')
 isolated('pitr',15434,check)

if __name__ == '__main__':
 need(action == 'pitr', 'Step entry/action mismatch')
 execute(pitr)
