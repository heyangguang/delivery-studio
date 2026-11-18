#!/usr/bin/env python3
from pgcommon import *

def elb_write_switchover():
 need_replicas();p=wait_cluster();elb_to(p);ensure_marker(p)
 via_elb("CREATE TABLE IF NOT EXISTS middleware_acceptance.elb_writes(id int PRIMARY KEY, at timestamptz DEFAULT now());TRUNCATE middleware_acceptance.elb_writes;")
 acked=[];stop=threading.Event();errors=[]
 def writer():
  i=1
  while not stop.is_set():
   try:via_elb("INSERT INTO middleware_acceptance.elb_writes(id) VALUES("+str(i)+") ON CONFLICT DO NOTHING;");acked.append(i);i+=1
   except Exception:errors.append(i);time.sleep(1)
   time.sleep(0.2)
 t=threading.Thread(target=writer);t.start()
 try:
  time.sleep(10);nxt=front_candidates(p)[0];switch(nxt);elb_to(nxt);time.sleep(10);switch(p);elb_to(p);time.sleep(10)
 finally:stop.set();t.join()
 need(acked,'No write was ever acknowledged');ids=set(int(x) for x in via_elb("SELECT string_agg(id::text,',') FROM middleware_acceptance.elb_writes;").split(','))
 missing=[i for i in acked if i not in ids];need(not missing,'Acknowledged writes missing: '+str(missing[:20]))
 log('Continuous writes through the ELB: '+str(len(acked))+' acknowledged, 0 lost, '+str(len(errors))+' attempts retried during the switchovers')

if __name__ == '__main__':
 need(action == 'front-write-switchover', 'Step entry/action mismatch')
 execute(elb_write_switchover)
