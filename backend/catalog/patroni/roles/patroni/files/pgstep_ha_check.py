#!/usr/bin/env python3
from pgcommon import *

def ha_check():
 p=wait_cluster();infos={n['name']:info(n) for n in c['nodes']}
 tls={n['name']:member_timeline(n,infos[n['name']]) for n in c['nodes']}
 for n in c['nodes']:i=infos[n['name']];log(n['name']+' role='+str(i.get('role'))+' state='+str(i.get('state'))+' timeline='+str(tls[n['name']]))
 need(len(set(tls.values()))==1,'Timelines differ across members')
 log(sql("SELECT string_agg(application_name||' '||state||' '||sync_state,'; ' ORDER BY application_name) FROM pg_stat_replication;",host=p['ip']))
 if opt['tls']:need(sql("SELECT count(*) FROM pg_stat_replication r JOIN pg_stat_ssl s ON s.pid=r.pid WHERE s.ssl;",host=p['ip'])==str(opt['replica_count']),'A replication connection is not using TLS')
 health();log('HA check passed: one primary, '+str(opt['replica_count'])+' streaming replicas, one timeline')

if __name__ == '__main__':
 need(action == 'ha-check', 'Step entry/action mismatch')
 execute(ha_check)
