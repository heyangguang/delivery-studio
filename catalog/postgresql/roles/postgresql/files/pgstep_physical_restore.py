#!/usr/bin/env python3
from pgcommon import *

def physical_restore():
 need((state/'physical-created').exists(),'Run physical-backup first');target=testroot/'basebackup';need(target.exists(),'Base backup directory is gone')
 def check(port):
  got=sql("SELECT cluster_id FROM middleware_acceptance.marker WHERE id=1;",port=port,sock=testroot);need(got==scope,'Restored marker differs');log('Isolated physical restore verified')
 isolated('basebackup',15433,check)

if __name__ == '__main__':
 need(action == 'physical-restore', 'Step entry/action mismatch')
 execute(physical_restore)
