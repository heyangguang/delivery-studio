#!/usr/bin/env python3
from pgcommon import *

def switchover_test():
 need_replicas();start=wait_cluster();ensure_marker(start);log_table(start);note(start,'before-switchover')
 t=switch(others(start)[0]);need(seen(t,'before-switchover'),'Row written before switchover is missing on the new primary');note(t,'after-switchover')
 switch(start);need(seen(start,'after-switchover'),'Row written on the interim primary is missing after switching back');log('Switchover and return verified; no committed row lost')

if __name__ == '__main__':
 need(action == 'switchover', 'Step entry/action mismatch')
 execute(switchover_test)
