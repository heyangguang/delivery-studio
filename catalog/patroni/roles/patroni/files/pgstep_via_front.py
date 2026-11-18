#!/usr/bin/env python3
from pgcommon import *

def elb():
 got=sql('SELECT NOT pg_is_in_recovery();',host=c['elb']['host'],port=c['elb']['port']);need(got=='t','ELB did not reach writable primary')
 actual=socket.gethostbyname(c['elb']['host'])
 if c['elb'].get('ip'):need(actual==c['elb']['ip'],'DNS resolves to '+actual+', plan expects '+c['elb']['ip']);log('ELB DNS, primary routing, authentication and selected TLS mode passed')

if __name__ == '__main__':
 need(action == 'via-front', 'Step entry/action mismatch')
 execute(elb)
