#!/usr/bin/env python3
from pgcommon import *

def inspect():
 log('Node '+node['name']+' recovery='+sql('SELECT pg_is_in_recovery();'));log('Test directory='+str(testroot)+' exists='+str(testroot.exists()))
 if testroot.exists():
  for d in sorted(testroot.iterdir()):log('  '+d.name+('/ (instance running)' if (d/'postmaster.pid').exists() else ''))
 backrest(['info'])

if __name__ == '__main__':
 need(action == 'inspect', 'Step entry/action mismatch')
 execute(inspect)
