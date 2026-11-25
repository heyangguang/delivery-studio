#!/usr/bin/env python3
from pgcommon import *

def tls_negative():
 need(opt['tls'],'TLS is not enabled in this delivery');mode=opt.get('test_sslmode','verify-full');ca='/etc/pki/pg/ca.crt'
 need(mode in ('disable','allow','prefer','require','verify-ca','verify-full'),'Invalid sslmode')
 targets=[('ELB',front_ip(),int(c['elb']['port']))]+[(n['name'],n['ip'],PGP) for n in c['nodes']]
 cases=[]
 for label,addr,port in targets:
  identities=tls_identities(addr) if mode=='verify-full' else [('connection',addr,addr)]
  for identity,host,hostaddr in identities:
   title=label+' '+identity+' '+host+' -> '+hostaddr+':'+str(port)
   need(net(host,mode,ca if mode in ('verify-ca','verify-full') else None,hostaddr,port)=='1',title+': positive connection failed')
   log(title+': accepted with '+mode);cases.append((title,host,hostaddr,port))
 wrong=testroot/'wrong-ca.crt'
 if mode in ('verify-ca','verify-full'):
  mkdir(testroot,'postgres');run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout','/dev/null','-subj','/CN=wrong-ca','-days','1','-out',wrong])
  # OpenSSL runs as root under umask 077; psql runs as postgres.
  wrong.chmod(0o600);shutil.chown(wrong,user='postgres',group='postgres')
  run(['runuser','-u','postgres','--','test','-r',wrong])
  for title,host,addr,port in cases:refused(title+' wrong CA',lambda:net(host,mode,wrong,addr,port),'ca')
 else:log('SKIP wrong CA: '+mode+' does not require CA verification')
 if mode=='verify-full':
  for label,addr,port in targets:refused(label+' wrong server name',lambda:net('wrong-name.invalid','verify-full',ca,addr,port),'name')
 else:log('SKIP wrong server name: '+mode+' does not verify identity')
 for label,addr,port in targets:refused(label+' plaintext',lambda:net(addr,'disable',None,addr,port),'plaintext')

if __name__ == '__main__':
 need(action == 'tls-negative', 'Step entry/action mismatch')
 execute(tls_negative)
