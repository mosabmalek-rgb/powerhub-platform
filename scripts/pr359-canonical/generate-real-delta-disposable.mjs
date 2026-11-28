import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {loadPinnedProducerEvidence,auditRealDeltaProducerEvidence} from './cb-a-real-delta-producer-audit.mjs';

export function buildRealAppendDisposableSql(evidence=loadPinnedProducerEvidence()){
 auditRealDeltaProducerEvidence(evidence);
 const append=evidence.functions.find(x=>x.identity.startsWith('powerhub_append_fuel_maintenance_delta_sync_change('));
 const pull=evidence.functions.find(x=>x.identity.startsWith('powerhub_pull_fuel_maintenance_sync_delta('));
 assert.ok(append&&pull);
 const ddl=[
  '-- PR359 SYNTHETIC DOCKER-ONLY SCHEMA; NEVER A MIGRATION.',
  'CREATE TABLE public.sites(id bigint PRIMARY KEY, tenant_id bigint NOT NULL);',
  'CREATE TABLE public.powerhub_sync_scope_state(tenant_id bigint NOT NULL,site_id bigint NOT NULL,entity_type text NOT NULL,last_cursor bigint NOT NULL DEFAULT 0,retained_from_cursor bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,site_id,entity_type));',
  'CREATE TABLE public.powerhub_sync_changes(tenant_id bigint NOT NULL,site_id bigint NOT NULL,entity_type text NOT NULL,cursor bigint NOT NULL,entity_id text NOT NULL,change_type text NOT NULL,row_data jsonb,changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,site_id,entity_type,cursor));',
  'INSERT INTO public.sites VALUES(101,1),(201,2);'
 ];
 const checks=[
  'DO $verify$',
  'DECLARE caught boolean:=false;',
  'BEGIN',
  ' BEGIN',
  "  PERFORM public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','11','upsert','{\"id\":\"11\"}'::jsonb);",
  "  RAISE EXCEPTION USING ERRCODE='P3593',MESSAGE='PR359_ROLLBACK_INJECTION';",
  " EXCEPTION WHEN SQLSTATE 'P3593' THEN caught:=true;",
  ' END;',
  ' IF NOT caught OR EXISTS(SELECT 1 FROM public.powerhub_sync_scope_state)',
  ' OR EXISTS(SELECT 1 FROM public.powerhub_sync_changes)',
  " THEN RAISE EXCEPTION 'PR359_REAL_APPEND_ROLLBACK_ATOMICITY_FAILED'; END IF;",
  'END $verify$;',
  "SELECT 'PR359_REAL_APPEND_ROLLBACK_ATOMICITY_PASS';",
  'DO $check$',
  'DECLARE x bigint; y bigint; z bigint;',
  'BEGIN',
  " x:=public.powerhub_append_fuel_maintenance_delta_sync_change(2,201,'fuel_events','31','upsert','{\"id\":\"31\"}'::jsonb);",
  " y:=public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'maintenance_work_orders','41','upsert','{\"id\":\"41\"}'::jsonb);",
  " z:=public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','51','delete',null);",
  ' IF x<>1 OR y<>1 OR z<>1 OR (SELECT count(*) FROM public.powerhub_sync_changes)<>3',
  ' OR EXISTS(SELECT 1 FROM public.powerhub_sync_scope_state WHERE last_cursor<>1)',
  " THEN RAISE EXCEPTION 'PR359_REAL_APPEND_ISOLATED_SCOPES_FAILED'; END IF;",
  'END $check$;',
  "SELECT 'PR359_REAL_APPEND_DISTINCT_SCOPES_PASS';",
  "SELECT 'PR359_REAL_APPEND_PRODUCTION_CONCURRENCY_APPROVED=FALSE';",
  "SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';"
 ];
 return ['\\set ON_ERROR_STOP on',...ddl,
   append.executable_ddl.trimEnd().replace(/;?$/,';'),
   pull.executable_ddl.trimEnd().replace(/;?$/,';'),...checks].join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===2&&args[0]==='--out','Usage: node generate-real-delta-disposable.mjs --out temporary-file');
 writeFileSync(args[1],buildRealAppendDisposableSql(),{flag:'wx',mode:0o600});
 console.log('PR359_DISPOSABLE_REAL_APPEND_SQL_GENERATED');
}
