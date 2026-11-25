#!/usr/bin/env python3
from pgcommon import *

def elb_switchover():
 need_replicas();p=wait_cluster();elb_to(p);t=front_candidates(p)[0];switch(t);elb_to(t);log('ELB followed the switchover to '+t['name']);switch(p);elb_to(p);log('ELB followed the return to '+p['name'])

if __name__ == '__main__':
 need(action == 'front-switchover', 'Step entry/action mismatch')
 execute(elb_switchover)
