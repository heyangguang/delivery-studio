#!/usr/bin/env python3
from pgcommon import *

def failover_test():
 need_replicas();p=wait_cluster();ensure_marker(p);log_table(p);note(p,'before-failover')
 cluster_state('before failover')
 log('Stopping Patroni on '+p['name']+' (an orderly stop: Patroni gives up the leader lock at once, so the election is fast; a crash or a cut network waits for the lease, ttl '+str(opt.get('patroni_ttl',30))+' s)');t0=time.time();on(p,['systemctl','stop','patroni'])
 try:
  t=wait_leader(avoid=p);log('New primary '+t['name']+' elected '+took(t0)+' after the old primary was stopped');need(seen(t,'before-failover'),'Committed row missing on the new primary');note(t,'after-failover')
  cluster_state('after the election, old primary still stopped')
 finally:
  t1=time.time();on(p,['systemctl','start','patroni'])
 wait_cluster();need(seen(p,'after-failover',120),'Old primary did not catch up after rejoining');log('Old primary '+p['name']+' rejoined as a replica and caught up '+took(t1)+' after Patroni was started again')
 cluster_state('after the old primary rejoined');log('Failover verified; '+p['name']+' rejoined as replica. New primary '+t['name']+' is kept for the next step')

if __name__ == '__main__':
 need(action == 'failover', 'Step entry/action mismatch')
 execute(failover_test)
