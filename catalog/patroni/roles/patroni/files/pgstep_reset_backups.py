#!/usr/bin/env python3
from pgcommon import *

def reset_backups():
 # No filesystem rmtree against the backup repository. pgBackRest owns metadata and WAL removal.
 need(not any((d/'postmaster.pid').exists() for d in testroot.glob('*') if d.is_dir()),'Stop isolated instances (clean-artifacts) before resetting backup history')
 backrest(['stop'])
 try:
  backrest(['--force','stanza-delete']);backrest(['start']);backrest(['stanza-create'],offline=sql('SELECT pg_is_in_recovery();')=='t')
 finally:backrest(['start'])
 if sql('SELECT pg_is_in_recovery();')=='f':backrest(['check'])
 if (state/'backup-created').exists():(state/'backup-created').unlink()
 log('Stanza reset. No base backups remain; new archived WAL on the primary is expected.')

if __name__ == '__main__':
 need(action == 'reset-backups', 'Step entry/action mismatch')
 execute(reset_backups)
