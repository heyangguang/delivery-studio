#!/usr/bin/env python3
import pgcommon
from pgcommon import *

def _front_fo_prepare():
 need_replicas();need(c['elb']['host'] and int(c['elb']['port'])>0,'Writer entry address and port are required')
 need(len(c['nodes'])>=3,'Entry failover requires at least three database nodes so a replica remains available as client')
 p=wait_cluster();replicas=others(p)
 for r in replicas:
  tags=info(r).get('tags',{})
  need(not tags.get('nofailover',False) and int(tags.get('failover_priority',1))>0,'Entry failover requires normal election eligibility on '+r['name'])
 write(state/'front-failover-ctx.json',json.dumps({'leader':p['name']}))
 print('FRONT_FO_META:'+json.dumps({'leader':p['name'],'expected_ip':p['ip'],'replicas':[r['name'] for r in replicas]}),flush=True)

def _front_fo_probe_elb():
 expected_ip=os.environ['MW_EXPECT_PRIMARY_IP']
 end=time.time()+int(os.environ.get('MW_ELB_TIMEOUT','180'));next_log=0;detail='No entry response received'
 log('Waiting for entry '+c['elb']['host']+':'+str(c['elb']['port'])+' -> '+expected_ip+', client='+node['name'])
 while time.time()<end:
  try:
   writable=via_elb('SELECT NOT pg_is_in_recovery();');actual=via_elb('SELECT host(inet_server_addr());')
   if writable=='t' and actual==expected_ip:
    log('Entry verified on '+node['name']+' -> '+expected_ip);return
   detail='writable='+writable+', backend='+actual+', expected='+expected_ip
  except Exception as e:detail=clean(str(e))
  if time.time()>=next_log:log('Waiting for entry: '+detail);next_log=time.time()+15
  time.sleep(3)
 raise RuntimeError('ELB did not route to '+expected_ip+' in time: '+detail)

def _front_fo_after_stop():
 meta=json.loads((state/'front-failover-ctx.json').read_text())
 p=next(n for n in c['nodes'] if n['name']==meta['leader'])
 t=wait_leader(avoid=p)
 clients=[n for n in c['nodes'] if n['name'] not in (p['name'],t['name']) and info(n).get('role') in ('replica','standby_leader') and info(n).get('state')=='running']
 need(clients,'No running surviving replica is available as an entry client')
 log('New primary '+t['name']+' elected while '+p['name']+' was stopped; checking ELB from '+clients[0]['name'])
 print('FRONT_FO_AFTER:'+json.dumps({'new_leader':t['name'],'expected_ip':t['ip'],'client':clients[0]['name']}),flush=True)

def _front_fo_verify():
 q=wait_cluster();clients=others(q);need(clients,'No running replica available')
 log('Old primary rejoined; cluster converged on primary '+q['name'])
 print('FRONT_FO_VERIFY:'+json.dumps({'final_leader':q['name'],'expected_ip':q['ip'],'client':clients[0]['name']}),flush=True)

def elb_failover():
 phase=os.environ.get('MW_PG_PHASE','all')
 if phase=='prepare':return _front_fo_prepare()
 if phase=='probe_elb':return _front_fo_probe_elb()
 if phase=='after_stop':return _front_fo_after_stop()
 if phase=='verify':return _front_fo_verify()
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
