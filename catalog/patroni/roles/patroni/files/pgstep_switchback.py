#!/usr/bin/env python3
from pgcommon import *

def switchback():
 need_replicas()
 if is_primary(info(c['nodes'][0])):wait_cluster();log('Controller node is already primary; nothing to switch back');return
 switch(c['nodes'][0])

if __name__ == '__main__':
 need(action == 'switchback', 'Step entry/action mismatch')
 execute(switchback)
