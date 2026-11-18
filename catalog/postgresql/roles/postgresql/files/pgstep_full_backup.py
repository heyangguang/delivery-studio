#!/usr/bin/env python3
from pgcommon import *

def backup():
 need(sql('SELECT pg_is_in_recovery();')=='f','Run backup on the controller node while it is primary; the repository is node-local');ensure_marker(leader());backrest(['--type=full','backup']);(state/'backup-created').write_text(scope);log('Real full backup complete')

if __name__ == '__main__':
 need(action == 'full-backup', 'Step entry/action mismatch')
 execute(backup)
