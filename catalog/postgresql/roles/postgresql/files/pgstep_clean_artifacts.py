#!/usr/bin/env python3
from pgcommon import *

def clean_artifacts():
 if testroot.exists():
  need(testroot.resolve()==testroot and not testroot.is_symlink(),'Unsafe test directory')
  for d in testroot.iterdir():
   if d.is_dir() and not d.is_symlink():
    if (d/'postmaster.pid').exists():run(['runuser','-u','postgres','--',BIN+'pg_ctl','-D',d,'-m','fast','-w','stop'],show=True)
    shutil.rmtree(d)
   else:d.unlink()
 if (state/'physical-created').exists():(state/'physical-created').unlink()
 log('Isolated instances, restored directories and test files removed from '+str(testroot))

if __name__ == '__main__':
 need(action == 'clean-artifacts', 'Step entry/action mismatch')
 execute(clean_artifacts)
