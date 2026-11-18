#!/usr/bin/env python3
from pgcommon import *

def backup_info():backrest(['info'])

if __name__ == '__main__':
 need(action == 'backup-info', 'Step entry/action mismatch')
 execute(backup_info)
