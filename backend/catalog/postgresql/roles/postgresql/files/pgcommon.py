"""PostgreSQL acceptance and cleanup actions, run by Ansible on one node.

Usage: pgtest.py CONFIG.json NODE-NAME ACTION

The deployment itself is plain Ansible; this helper only holds the acceptance tests (switchover, failover,
PITR, front-end routing) and the scoped cleanup, which are long multi-step procedures. It never removes
production PGDATA and only touches objects it can prove belong to this deployment.
"""

import fcntl,hashlib,ipaddress,json,os,re,shlex,shutil,socket,subprocess,sys,tarfile,threading,time,urllib.request

from pathlib import Path

os.umask(0o077)

c=json.loads(Path(sys.argv[1]).read_text())

node_name=sys.argv[2]

action=sys.argv[3]

names=[n['name'] for n in c['nodes']]

index=names.index(node_name)

node=c['nodes'][index]

opt=c['options']

scope=c['scope']

HA=bool(c['ha'])

state=Path('/var/lib/mwctl')/c['cluster_id']/c['instance']/'pgtest'

data=Path(c['paths']['data'])

repo=Path(c['paths']['repo'])

testroot=Path(c['paths']['testroot'])

BIN=c['paths']['bin'].rstrip('/')+'/'

PGP=int(opt['pg_port'])

RESTP=int(opt['restapi_port'])

accounts=c['accounts']

secrets_to_hide=[v for v in accounts.values() if v]

def clean(v):
 for secret in secrets_to_hide:v=v.replace(secret,'[REDACTED]')
 return v

log_file=None

def log(v):
 text=time.strftime('[%Y-%m-%d %H:%M:%S] ')+clean(str(v))
 print(text,flush=True)
 if log_file is not None:log_file.write(text+'\n');log_file.flush()

def need(ok,message):
 if not ok:raise RuntimeError(message)

def run(args,show=False,env=None):
 # None means remove an inherited variable; an empty PGSERVICE is still a service name to libpq.
 child_env=dict(os.environ)
 for key,value in (env or {}).items():
  if value is None:child_env.pop(key,None)
  else:child_env[key]=value
 p=subprocess.Popen([str(a) for a in args],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=child_env);out=[]
 for line in p.stdout:
  out.append(line)
  if show:log(line.rstrip())
 p.wait();text=''.join(out)
 if p.returncode:raise RuntimeError('Command failed: '+str(args[0])+': '+clean(text[-6000:]))
 return text.strip()

front_client=None

def client_run(client,args,env):
 if client is None or client['ip']==node['ip']:return run(args,env=env)
 # Credentials travel through SSH stdin, never command arguments or a remote file.
 code="import json,os,subprocess,sys; p=json.load(sys.stdin); e=dict(os.environ); [(e.pop(k,None) if v is None else e.update({k:v})) for k,v in p['env'].items()]; r=subprocess.run(p['args'],env=e,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=25); sys.stdout.write(r.stdout); sys.exit(r.returncode)"
 remote=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','root@'+client['ip'],shlex.join(['/usr/bin/python3','-c',code])]
 try:r=subprocess.run(remote,input=json.dumps({'args':args,'env':env}),stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=40)
 except subprocess.TimeoutExpired:raise RuntimeError('Entry SQL timed out on client '+client['name'])
 need(r.returncode==0,'Entry SQL failed on client '+client['name']+': '+clean(r.stdout[-6000:]))
 return r.stdout.strip()

def sql(query,host=None,port=None,sock=None,database="postgres",client=None):
 port=port or PGP
 args=['runuser','-u','postgres','--',BIN+'psql','-X','-v','ON_ERROR_STOP=1','-At','-d',database,'-p',str(port)]
 env={}
 if host:
  mode='verify-ca' if opt['tls'] else 'disable';addr=''
  if action in FRONT_ACTIONS and host==c['elb']['host'] and int(port)==int(c['elb']['port']):
   mode=opt.get('test_sslmode','verify-full') if opt['tls'] else 'disable'
   if mode=='verify-full':host,addr=tls_identities(front_ip())[0][1:]
  args+=['-h',host,'-U','postgres'];env=connection_env(mode,'/etc/pki/pg/ca.crt' if mode in ('verify-ca','verify-full') else None,addr)
 if sock:args+=['-h',str(sock)]
 return client_run(client,args+['-c',query],env)

def size_bytes(v):
 m=re.fullmatch(r'([0-9]+)(kB|MB|GB|TB)',v);need(m,'Invalid size '+v)
 return int(m.group(1))<<{'kB':10,'MB':20,'GB':30,'TB':40}[m.group(2)]

def write(path,text,mode=0o600,user=None):
 p=Path(path);need(not p.is_symlink(),'Refusing symlink: '+str(p));p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);p.chmod(mode)
 if user:shutil.chown(p,user=user,group=user)

def mkdir(path,user=None):
 p=Path(path);need(not p.is_symlink(),'Refusing directory symlink: '+str(p))
 made=[q for q in reversed(p.parents) if not q.exists()]
 p.mkdir(parents=True,exist_ok=True)
 for q in made:q.chmod(0o755)  # ancestors made here must stay traversable for the postgres user whatever the umask
 p.chmod(0o700)
 if user:shutil.chown(p,user=user,group=user)

def http(ip,path='',method='GET',body=None):
 request=urllib.request.Request('http://'+ip+':'+str(RESTP)+'/'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json'})
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=30) as response:
  text=response.read().decode()
  try:return json.loads(text)
  except ValueError:return {'text':text}

def leader():
 if not HA:return node
 leaders=[]
 for n in c['nodes']:
  p=http(n['ip'],'patroni')
  if p.get('role') in ('master','primary') and p.get('state')=='running':leaders.append(n)
 need(len(leaders)==1,'Expected exactly one running primary, found '+str(len(leaders)))
 return leaders[0]

def wait_ready(ip,primary=False):
 if not HA:return
 for _ in range(90):
  try:
   p=http(ip,'patroni')
   if p.get('state')=='running' and (not primary or p.get('role') in ('master','primary')):return
  except Exception:pass
  time.sleep(2)
 raise RuntimeError('PostgreSQL readiness timeout '+ip)

def patch(settings):
 p=leader();http(p['ip'],'config','PATCH',{'postgresql':{'parameters':settings}});log('DCS parameters updated: '+', '.join(settings))

def backrest(args,offline=False):return run(['runuser','-u','postgres','--','pgbackrest','--stanza='+scope]+(['--no-online'] if offline else [])+args,show=True)

def archcmd():return (BIN+'pg_tde_archive_decrypt %f %p "pgbackrest --stanza='+scope+' archive-push %%p"') if opt['tde'] else 'pgbackrest --stanza='+scope+' archive-push %p'

def restorecmd(target):
 # pgBackRest refuses archive-get when the server's directory is not its configured pg1-path, so name the directory being recovered
 pg1='--pg1-path='+str(target)
 return (BIN+'pg_tde_restore_encrypt %f %p "pgbackrest '+pg1+' --stanza='+scope+' archive-get %%f \\\"%%p\\\""') if opt['tde'] else 'pgbackrest '+pg1+' --stanza='+scope+' archive-get %f "%p"'

def topology():
 p=leader()
 for _ in range(60):
  count=int(sql("SELECT count(*) FROM pg_stat_replication WHERE state='streaming';",host=p['ip']))
  if count==opt['replica_count']:break
  time.sleep(2)
 need(count==opt['replica_count'],'Expected '+str(opt['replica_count'])+' streaming replicas, got '+str(count));log('Exactly one primary and '+str(count)+' streaming replicas verified')

def health():
 wait_ready(node['ip']);need(sql('SHOW ssl;')==('on' if opt['tls'] else 'off'),'TLS setting mismatch')
 need(sql('SHOW archive_mode;')=='on','Archiving not enabled')
 if opt['tde']:need(sql('SHOW pg_tde.wal_encrypt;')=='on','WAL encryption not enabled');sql('SELECT pg_tde_verify_server_key(); SELECT pg_tde_verify_default_key();')
 else:need('pg_tde' not in sql('SHOW shared_preload_libraries;'),'Unexpected TDE preload')
 need(sql('SELECT 1;',host=node['ip'])=='1','TCP authentication check failed');log('Role, TLS, TDE, archive and TCP authentication checks passed')
 if index==0:topology()

def ensure_marker(p):
 exists=sql("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='middleware_acceptance');",host=p['ip'])
 if exists=='t':
  need(sql("SELECT to_regclass('middleware_acceptance.marker') IS NOT NULL;",host=p['ip'])=='t','Existing test namespace is not owned by this adapter')
  need(sql("SELECT cluster_id FROM middleware_acceptance.marker WHERE id=1;",host=p['ip'])==scope,'Existing test marker belongs to another scope')
 sql("CREATE SCHEMA IF NOT EXISTS middleware_acceptance; CREATE TABLE IF NOT EXISTS middleware_acceptance.marker (id integer PRIMARY KEY, cluster_id text NOT NULL); INSERT INTO middleware_acceptance.marker VALUES(1,'"+scope+"') ON CONFLICT(id) DO UPDATE SET cluster_id=excluded.cluster_id;",host=p['ip'])

def features():
 topology();p=leader();health();ensure_marker(p)
 am=sql("SELECT am.amname FROM pg_class t JOIN pg_am am ON am.oid=t.relam JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='middleware_acceptance' AND t.relname='marker';",host=p['ip']);need(am==('tde_heap' if opt['tde'] else 'heap'),'Table access method mismatch')
 encrypted=sql('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();',host=p['ip']);need(encrypted==('t' if opt['tls'] else 'f'),'Actual TCP encryption mismatch')
 sql('CHECKPOINT;',host=p['ip']);log('Test marker written, table access method='+am+', TCP TLS='+encrypted)

def _prepare_isolated_conf(target):
 # Debian/Ubuntu pg_createcluster keeps postgresql.conf/pg_hba.conf under /etc/postgresql/<ver>/main
 # outside PGDATA, so restored single-node/native directories lack them. Synthesize safe local copies.
 if not (target/'postgresql.conf').exists():
  ver=(target/'PG_VERSION').read_text().strip() if (target/'PG_VERSION').exists() else ''
  conf_dir=Path('/etc/postgresql')/ver/'main' if ver else None
  skip=re.compile(r'^\s*(data_directory|hba_file|ident_file|external_pid_file|include_dir|include|include_if_exists|ssl_cert_file|ssl_key_file|ssl_ca_file)\s*=')
  if conf_dir and (conf_dir/'conf.d'/'90-middleware.conf').exists():
   src=(conf_dir/'conf.d'/'90-middleware.conf').read_text().splitlines()
  elif conf_dir and (conf_dir/'postgresql.conf').exists():
   src=(conf_dir/'postgresql.conf').read_text().splitlines()
  else:
   src=[]
  lines=[line for line in src if not skip.match(line)]
  lines.append("shared_buffers = '128MB'")
  write(target/'postgresql.conf','\n'.join(lines)+'\n',0o600,'postgres')
 if not (target/'pg_hba.conf').exists():
  write(target/'pg_hba.conf','local all all peer\n',0o600,'postgres')
 if not (target/'pg_ident.conf').exists():
  write(target/'pg_ident.conf','',0o600,'postgres')

def isolated(name,port,check,extra=''):
 # The isolated instance binds only a private unix socket. There is no TCP listener.
 target=testroot/name;logf=testroot/(name+'.log')
 _prepare_isolated_conf(target)
 try:
  try:
   run(['runuser','-u','postgres','--',BIN+'pg_ctl','-D',target,'-l',logf,'-o',"-p "+str(port)+" -k "+str(testroot)+" -c listen_addresses='' -c ssl=off -c archive_mode=off -c shared_buffers=128MB -c huge_pages=off"+extra,'-w','-t','300','start'],show=True)
  except RuntimeError:
   if logf.exists():log('Isolated postgres log ('+str(logf)+'):\n'+logf.read_text()[-4000:])
   raise
  check(port)
 finally:
  if (target/'postmaster.pid').exists():run(['runuser','-u','postgres','--',BIN+'pg_ctl','-D',target,'-m','fast','-w','stop'],show=True)

def wait_promoted(port,timeout=180):
 # pg_ctl -w returns once the restored instance accepts read-only connections, which is before it has replayed up to the
 # recovery target and promoted; a check made earlier sees a half-recovered database.
 end=time.time()+timeout
 while time.time()<end:
  try:
   if sql('SELECT pg_is_in_recovery();',port=port,sock=testroot)=='f':return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('The restored instance did not reach its recovery target and promote in time')

def info(n):
 try:return http(n['ip'],'patroni')
 except Exception as e:return {'_error':clean(str(e))}

def is_primary(i):return i.get('role') in ('master','primary') and i.get('state')=='running'

def wait_leader(want=None,avoid=None,timeout=300):
 end=time.time()+timeout
 while time.time()<end:
  ls=[n for n in c['nodes'] if is_primary(info(n))]
  if len(ls)==1 and (not want or ls[0]['name']==want['name']) and (not avoid or ls[0]['name']!=avoid['name']):return ls[0]
  time.sleep(3)
 raise RuntimeError('Primary did not settle in time')

def wait_cluster(timeout=300):
 end=time.time()+timeout;next_log=0;detail='No member status received'
 log('Waiting for one primary and '+str(opt['replica_count'])+' streaming replicas (timeout '+str(timeout)+' s)')
 while time.time()<end:
  infos=[info(n) for n in c['nodes']]
  detail='; '.join(n['name']+'('+n['ip']+') role='+str(i.get('role','?'))+' state='+str(i.get('state','?'))+(' error='+i['_error'] if '_error' in i else '') for n,i in zip(c['nodes'],infos))
  if sum(is_primary(i) for i in infos)==1 and all(i.get('state')=='running' for i in infos):
   p=next(n for n,i in zip(c['nodes'],infos) if is_primary(i))
   try:
    count=int(sql("SELECT count(*) FROM pg_stat_replication WHERE state='streaming';",host=p['ip']))
    if count==opt['replica_count']:return p
    detail+='; primary='+p['name']+' streaming='+str(count)+' expected='+str(opt['replica_count'])
   except Exception as e:detail+='; replication check error='+clean(str(e))
  if time.time()>=next_log:log('Waiting for cluster: '+detail);next_log=time.time()+15
  time.sleep(3)
 raise RuntimeError('Cluster did not return to one primary with all replicas streaming: '+detail)

def others(p):return [n for n in c['nodes'] if n['name']!=p['name']]

def on(n,args):
 if n['ip']==node['ip']:return run(args,show=True)
 return run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','root@'+n['ip'],shlex.join([str(a) for a in args])],show=True)

def timeline(n):return sql('SELECT timeline_id FROM pg_control_checkpoint();',host=n['ip'])

def log_table(p):sql("CREATE TABLE IF NOT EXISTS middleware_acceptance.ha_log(id serial PRIMARY KEY, note text NOT NULL, at timestamptz DEFAULT now());",host=p['ip'])

def note(p,text):sql("INSERT INTO middleware_acceptance.ha_log(note) VALUES('"+text+"');",host=p['ip'])

def seen(n,text,wait=60):
 for _ in range(wait//2):
  try:
   if sql("SELECT count(*) FROM middleware_acceptance.ha_log WHERE note='"+text+"';",host=n['ip'])!='0':return True
  except Exception:pass
  time.sleep(2)
 return False

def wait_candidate(target,timeout=120):
 # With synchronous replication Patroni only switches over to a member already in the synchronous set, and a member that
 # has just rejoined (after a failover, say) is streaming for a few seconds before it is added; asking earlier gets a 503.
 p=leader()
 if not http(p['ip'],'config').get('synchronous_mode'):return
 end=time.time()+timeout
 while time.time()<end:
  for m in http(p['ip'],'cluster').get('members',[]):
   if m.get('name')==target['name'] and m.get('role') in ('sync_standby','quorum_standby') and m.get('state')=='streaming':return
  time.sleep(2)
 raise RuntimeError(target['name']+' did not become a synchronous standby in time, so Patroni would refuse the switchover')

def cluster_state(label):
 # What Patroni itself says about the cluster (role, state, timeline and lag of every member), as evidence in the log.
 # It reads the DCS, so it also answers while this machine's own Patroni is stopped.
 tool=shutil.which('patronictl') or '/usr/bin/patronictl'
 try:text=run([tool,'-c','/etc/patroni/patroni.yml','list'])
 except Exception as e:text='patronictl list failed: '+str(e)[:400]
 log('Cluster state '+label+':')
 for line in text.splitlines():log('  '+line)

def took(t0):return '%.1f s'%(time.time()-t0)

def switch(target):
 p=leader();need(p['name']!=target['name'],target['name']+' is already primary');wait_candidate(target)
 cluster_state('before switchover to '+target['name'])
 log('Switchover '+p['name']+' -> '+target['name']);t0=time.time();http(p['ip'],'switchover','POST',{'leader':p['name'],'candidate':target['name']})
 wait_leader(want=target);log('New primary '+target['name']+' serving after '+took(t0)+' (from the switchover request)')
 wait_cluster();log('All members streaming again after '+took(t0)+'; timeline='+timeline(target))
 cluster_state('after switchover to '+target['name']);return target

def need_replicas():need(HA and opt['replica_count']>=1,'This topology has no replica, so switchover and failover tests do not apply')

def member_timeline(n,i):
 # Patroni's REST answer carries the timeline only for the primary (a replica says null), so a replica is asked for the
 # timeline it is receiving; pg_control would lag behind a promotion until the next restartpoint.
 t=i.get('timeline')
 if t is not None:return str(t)
 if i.get('role') not in ('master','primary'):
  v=sql('SELECT received_tli FROM pg_stat_wal_receiver;',host=n['ip'])
  if v:return v
 return timeline(n)

def tool(name):return BIN+('pg_tde_'+name if opt['tde'] else 'pg_'+name)

def stagecmd(stage):return (BIN+'pg_tde_restore_encrypt %f %p "cp '+str(stage)+'/%%f \\\"%%p\\\""') if opt['tde'] else 'cp '+str(stage)+'/%f "%p"'

def gather_wal(stage):
 # Each node archives only while it is primary, so after a switchover the WAL chain is split across node-local repositories.
 mkdir(stage,'postgres');pat=re.compile(r'^([0-9A-F]{24}|[0-9A-F]{8}\.history)(-[0-9a-f]{40})?(\.[a-z0-9]+)?$');got={};tmp='/tmp/mw-stage-'+scope
 for n in c['nodes']:
  listing=on(n,['sh','-c','find '+str(repo)+'/archive/'+scope+' -type f 2>/dev/null || true'])
  for line in listing.splitlines():
   m=pat.match(Path(line.strip()).name)
   if m and m.group(1) not in got:got[m.group(1)]=n
 need(got,'No archived WAL found in any node repository')
 for name,n in sorted(got.items()):
  dest=stage/name
  if n['ip']==node['ip']:run(['runuser','-u','postgres','--','pgbackrest','--stanza='+scope,'archive-get',name,dest])
  else:
   on(n,['sh','-c','rm -f '+tmp+'; runuser -u postgres -- pgbackrest --stanza='+scope+' archive-get '+name+' '+tmp+'; chmod 644 '+tmp])
   run(['scp','-q','-o','BatchMode=yes','root@'+n['ip']+':'+tmp,dest]);on(n,['rm','-f',tmp])
  shutil.chown(dest,user='postgres',group='postgres')
 log('Gathered '+str(len(got))+' WAL/history files from '+str(len({v['name'] for v in got.values()}))+' node repositories')

def via_elb(q):return sql(q,host=c['elb']['host'],port=c['elb']['port'],client=front_client)

def elb_to(n,timeout=180):
 global front_client
 if action=='front-failover':
  clients=[r for r in c['nodes'] if r['name']!=n['name'] and info(r).get('role') in ('replica','standby_leader') and info(r).get('state')=='running']
  need(clients,'No running replica is available as an entry client; refusing ELB self-return')
  front_client=next((r for r in clients if r['name']==node['name']),clients[0])
 end=time.time()+timeout;next_log=0;detail='No entry response received'
 log('Waiting for entry '+c['elb']['host']+':'+str(c['elb']['port'])+' -> '+n['name']+'('+n['ip']+'), client='+(front_client or node)['name'])
 while time.time()<end:
  try:
   writable=via_elb('SELECT NOT pg_is_in_recovery();');actual=via_elb('SELECT host(inet_server_addr());')
   if writable=='t' and actual==n['ip']:return
   detail='writable='+writable+', backend='+actual+', expected='+n['ip']
  except Exception as e:detail=clean(str(e))
  if time.time()>=next_log:log('Waiting for entry: '+detail);next_log=time.time()+15
  time.sleep(3)
 raise RuntimeError('ELB did not route to '+n['name']+' in time: '+detail)

def front_ip():
 return c['elb'].get('ip') or socket.gethostbyname(c['elb']['host'])

def tls_identities(addr):
 identity=opt.get('test_tls_identity','dns');need(identity in ('dns','ip','both'),'Invalid TLS identity selection')
 result=[]
 if identity in ('dns','both'):
  name=opt.get('test_tls_name') or c['elb']['host'];need(name,'A certificate DNS name is required')
  try:ipaddress.ip_address(name)
  except ValueError:pass
  else:raise RuntimeError('DNS identity requires a DNS name; set test_tls_name or select ip')
  result.append(('dns',name,addr))
 if identity in ('ip','both'):result.append(('ip',addr,addr))
 return result

def connection_env(mode,root=None,hostaddr=None):
 # Override inherited libpq settings; non-verifying modes must not pick up a default CA.
 unused=testroot/'unused-root-ca.crt';need(root is not None or not unused.exists(),'Unexpected CA file at '+str(unused))
 return {'PGPASSWORD':accounts['postgres'],'PGSSLMODE':mode,'PGCONNECT_TIMEOUT':'10',
  'PGSSLROOTCERT':str(root if root is not None else unused),'PGHOSTADDR':hostaddr or '',
  'PGSERVICE':None,'PGSERVICEFILE':None,'PGSSLCERT':'','PGSSLKEY':'','PGSSLCRL':'','PGSSLCRLDIR':'','LC_ALL':'C'}

def net(host,mode,root,hostaddr=None,port=None):
 return run(['runuser','-u','postgres','--',BIN+'psql','-X','-w','-v','ON_ERROR_STOP=1','-At','-h',host,'-p',str(port if port is not None else c['elb']['port']),'-U','postgres','-d','postgres','-c','SELECT 1;'],env=connection_env(mode,root,hostaddr))

def refused(label,fn,reason):
 patterns={
  'ca':r'certificate verify failed',
  'name':r'server certificate.*does not match host name',
  'plaintext':r'(?:pg_hba.conf rejects connection|no pg_hba.conf entry)[^\n]*(?:no encryption|SSL off)'}
 try:fn()
 except RuntimeError as e:
  text=str(e)
  # A matching line cannot hide another connection failure or a failed retry.
  unexpected=r'timeout|timed out|connection refused|no route to host|network is unreachable|could not translate host name|authentication failed|no password supplied|password authentication failed'
  need(not re.search(unexpected,text,re.I) and re.search(patterns[reason],text,re.I),label+': unexpected or inconclusive rejection: '+text)
  log(label+': rejected for expected '+reason+' reason');return
 raise RuntimeError(label+' was accepted')

def front_candidates(p):
 candidates=[n for n in others(p) if n['name']!=node['name'] and not info(n).get('tags',{}).get('nofailover',False) and int(info(n).get('tags',{}).get('failover_priority',1))>0]
 need(candidates,'No eligible switchover candidate outside the entry-test client '+node['name'])
 return candidates

def prepare_front():
 need(c['elb']['host'] and int(c['elb']['port'])>0,'Writer entry address and port are required')
 if not HA:
  log('Single-node entry test: no replica is available to avoid ELB self-return; the load balancer must support this path');return
 p=None
 log('Preparing entry test: client='+node['name']+'('+node['ip']+'), entry='+c['elb']['host']+':'+str(c['elb']['port']))
 p=wait_cluster();log('Entry-test client='+node['name']+', current primary='+p['name'])
 if action=='front-failover':
  need(len(c['nodes'])>=3,'Entry failover requires at least three database nodes so a replica remains available as client')
  for r in others(p):
   tags=info(r).get('tags',{})
   need(not tags.get('nofailover',False) and int(tags.get('failover_priority',1))>0,'Entry failover requires normal election eligibility on '+r['name']+'; check existing nofailover/failover_priority settings before retrying')
   got=sql("SELECT (NOT pg_is_in_recovery())::text || '|' || host(inet_server_addr());",host=c['elb']['host'],port=c['elb']['port'],client=r)
   need(got=='true|'+p['ip'],'Entry preflight failed from '+r['name']+': '+got)
   log('Entry preflight passed: client='+r['name']+' -> primary='+p['name'])
  elb_to(p);log('Entry failover keeps all election tags unchanged; entry connections will use a running replica, including when the coordinator becomes primary');return
 if action in ('front-switchover','front-write-switchover'):
  need(len(c['nodes'])>=3,'Entry switching tests require at least three database nodes: one client and two other nodes for promotion')
  if p['name']!=node['name']:front_candidates(p)
 if p['name']==node['name']:
  log('Moving primary away from the entry-test client; connections may be briefly interrupted')
  p=switch(front_candidates(p)[0])
 need(p['name']!=node['name'],'Entry-test client must remain a replica')
 elb_to(p);log('Entry routes to '+p['name']+'; client '+node['name']+' remains a replica. Preparatory switchover is not automatically reversed')

def own_scope():
 need(os.geteuid()==0,'Root required');need(re.fullmatch('[a-z][a-z0-9-]{0,80}',scope),'Invalid scope')
 need(socket.gethostname()==node['name'],'Hostname differs from the plan; finish SSH prepare first')
 ips=run(['hostname','-I']).split();need(node['ip'] in ips,'Planned IP is not a local address')
 mkdir(state)

FRONT_ACTIONS={'via-front','tls-negative','front-switchover','front-failover','front-write-switchover'}

def execute(fn):
 global log_file
 try:
  log_path=Path(sys.argv[1]).resolve().parent/('pgstep_'+action.replace('-','_')+'.log')
  need(not log_path.is_symlink(),'Refusing log symlink: '+str(log_path))
  log_file=log_path.open('a');os.chmod(log_path,0o600)
  log('Starting request: action='+action+', client='+node_name+', log='+str(log_path))
  own_scope()
  with (state/'action.lock').open('w') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);log('Starting '+action+' on '+node['name'])
   if action in FRONT_ACTIONS and os.environ.get('MW_PG_PHASE','all')=='all':prepare_front()
   fn();log('Completed '+action)
 except Exception as e:log('FAILED: '+str(e));sys.exit(1)
