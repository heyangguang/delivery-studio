#!/usr/bin/env python3
from pgcommon import *

def tde_test():
 need(opt['tde'],'TDE is not enabled in this delivery');p=leader();ensure_marker(p);mark='TDE-SENTINEL-'+scope
 sql("DROP TABLE IF EXISTS middleware_acceptance.tde_plain, middleware_acceptance.tde_enc;CREATE TABLE middleware_acceptance.tde_enc(id int PRIMARY KEY, v text) USING tde_heap;SET pg_tde.enforce_encryption = off;CREATE TABLE middleware_acceptance.tde_plain(id int PRIMARY KEY, v text) USING heap;RESET pg_tde.enforce_encryption;INSERT INTO middleware_acceptance.tde_enc SELECT g,'"+mark+"' FROM generate_series(1,2000) g;INSERT INTO middleware_acceptance.tde_plain SELECT g,'"+mark+"' FROM generate_series(1,2000) g;CREATE INDEX ON middleware_acceptance.tde_enc(v);CHECKPOINT;",host=p['ip'])
 need(sql("SELECT pg_tde_is_encrypted('middleware_acceptance.tde_enc'::regclass);",host=p['ip'])=='t','Encrypted table is not reported as encrypted')
 rel=lambda tbl:str(data/sql("SELECT pg_relation_filepath('middleware_acceptance."+tbl+"');",host=p['ip']))
 plain_path,enc_path=rel('tde_plain'),rel('tde_enc')
 if os.environ.get('MW_PG_PHASE','all')=='setup':
  print('TDE_META:'+json.dumps({'leader':p['name'],'mark':mark,'plain_path':plain_path,'enc_path':enc_path}),flush=True)
  return
 def hits(path):return int(on(p,['sh','-c','grep -c -a '+mark+' '+path+' || true']).splitlines()[-1])
 need(hits(plain_path)>0,'Control table does not contain the sentinel; test is not conclusive');need(hits(enc_path)==0,'Sentinel is readable in the encrypted table file')
 log('TDE verified: encrypted table file holds no plaintext while the heap control table does')

if __name__ == '__main__':
 need(action == 'tde', 'Step entry/action mismatch')
 execute(tde_test)
