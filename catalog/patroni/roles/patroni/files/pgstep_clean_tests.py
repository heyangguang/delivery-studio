#!/usr/bin/env python3
from pgcommon import *

def clean_tests():
 if sql('SELECT pg_is_in_recovery();')=='f':
  if sql("SELECT to_regclass('middleware_acceptance.marker') IS NOT NULL;")=='t':
   need(sql('SELECT cluster_id FROM middleware_acceptance.marker WHERE id=1;')==scope,'Test marker does not belong to scope');sql('DROP SCHEMA middleware_acceptance CASCADE;')
 log('Scoped test schema removed; production data, PGDATA and keys preserved')

if __name__ == '__main__':
 need(action == 'clean-tests', 'Step entry/action mismatch')
 execute(clean_tests)
