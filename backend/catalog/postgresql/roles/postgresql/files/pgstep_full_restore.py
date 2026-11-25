#!/usr/bin/env python3
from pgcommon import *

def restore():
 need((state/'backup-created').exists(),'Run the pgBackRest full backup first');need(sql('SELECT pg_is_in_recovery();')=='f','Restore test runs on the controller node while it is primary')
 mkdir(testroot,'postgres');target=testroot/'restore';need(not target.exists(),'Restore path exists; run clean-artifacts before rerun')
 run(['runuser','-u','postgres','--','pgbackrest','--stanza='+scope,'--pg1-path='+str(target),'--type=immediate','--target-action=promote','restore'],show=True)
 write(target/'postgresql.auto.conf',((target/'postgresql.auto.conf').read_text() if (target/'postgresql.auto.conf').exists() else '')+"\nrestore_command = '"+restorecmd(target).replace("'","''")+"'\n",0o600,'postgres')
 def check(port):
  wait_promoted(port);got=sql("SELECT cluster_id FROM middleware_acceptance.marker WHERE id=1;",port=port,sock=testroot);need(got==scope,'Restored marker differs');log('Isolated pgBackRest restore and marker verification passed')
 isolated('restore',15432,check)

if __name__ == '__main__':
 need(action == 'full-restore', 'Step entry/action mismatch')
 execute(restore)
