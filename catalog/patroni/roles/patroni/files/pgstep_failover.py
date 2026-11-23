#!/usr/bin/env python3
from pgcommon import *

def _failover_prepare():
 need_replicas();p=wait_cluster();ensure_marker(p);log_table(p);note(p,'before-failover')
 cluster_state('before failover')
 log('Stopping Patroni on '+p['name']+' (an orderly stop: Patroni gives up the leader lock at once, so the election is fast; a crash or a cut network waits for the lease, ttl '+str(opt.get('patroni_ttl',30))+' s)')
 write(state/'failover-ctx.json',json.dumps({'leader':p['name'],'t0':time.time()}))
 print('FAILOVER_META:'+json.dumps({'leader':p['name']}),flush=True)

def _failover_after_stop():
 meta=json.loads((state/'failover-ctx.json').read_text())
 p=next(n for n in c['nodes'] if n['name']==meta['leader'])
 t=wait_leader(avoid=p);log('New primary '+t['name']+' elected '+took(meta['t0'])+' after the old primary was stopped');need(seen(t,'before-failover'),'Committed row missing on the new primary');note(t,'after-failover')
 cluster_state('after the election, old primary still stopped')
 meta['new_leader']=t['name'];meta['t1']=time.time()
 write(state/'failover-ctx.json',json.dumps(meta))

def _failover_verify():
 meta=json.loads((state/'failover-ctx.json').read_text())
 p=next(n for n in c['nodes'] if n['name']==meta['leader'])
 t=next(n for n in c['nodes'] if n['name']==meta['new_leader'])
 wait_cluster();need(seen(p,'after-failover',120),'Old primary did not catch up after rejoining');log('Old primary '+p['name']+' rejoined as a replica and caught up '+took(meta['t1'])+' after Patroni was started again')
 cluster_state('after the old primary rejoined');log('Failover verified; '+p['name']+' rejoined as replica. New primary '+t['name']+' is kept for the next step')

def failover_test():
 phase=os.environ.get('MW_PG_PHASE','all')
 if phase=='prepare':return _failover_prepare()
 if phase=='after_stop':return _failover_after_stop()
 if phase=='verify':return _failover_verify()
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
