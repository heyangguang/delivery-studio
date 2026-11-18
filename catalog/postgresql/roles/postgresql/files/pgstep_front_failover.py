#!/usr/bin/env python3
import pgcommon
from pgcommon import *

def elb_failover():
 need_replicas();p=wait_cluster();elb_to(p)
 # The coordinator may itself be elected; only the SQL source moves to a surviving replica.
 try:
  on(p,['systemctl','stop','patroni'])
  t=wait_leader(avoid=p);elb_to(t);log('ELB reached the new primary '+t['name']+' from replica '+pgcommon.front_client['name']+' while '+p['name']+' was down')
 finally:on(p,['systemctl','start','patroni'])
 q=wait_cluster();elb_to(q);log('Old primary rejoined; ELB routes to '+q['name']+'. Run switchback if the controller node should be primary again')

if __name__ == '__main__':
 need(action == 'front-failover', 'Step entry/action mismatch')
 execute(elb_failover)
