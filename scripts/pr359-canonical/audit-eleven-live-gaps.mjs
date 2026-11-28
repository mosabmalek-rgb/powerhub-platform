import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const F_BLOB='a4f3a62680874cef47149f4d908fca0ef05da354';
const T_BLOB='df0b1d008e881a31a9bf779317109e8ccc79097b';
const F_PATH='docs/security/pr359-cb-a-six-function-live-evidence-20261123.json';
const T_PATH='docs/security/pr359-cb-a-five-table-live-evidence-20261123.json';
const HEX=/^[a-f0-9]{64}$/;
const hash=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
export function pinnedJson(bytes,sha){
 const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes,'utf8');
 assert.equal(hash(b),sha,'pinned evidence blob changed');
 return JSON.parse(b.toString('utf8'));
}
const functionNames=[
 'p6_assert_subscription_guard','p6_subscription_access_status',
 'powerhub_ensure_owner_main_site','powerhub_financial_period_cash_flow_raw',
 'powerhub_mobile_touch_session',
 'powerhub_refresh_fuel_maintenance_delta_after_generator_name_up'];
const tableCounts={
 emergency_requests:[12,7,1,0,0],
 payment_documentation_requests:[35,14,8,2,0],
 sms_dispatch_queue:[16,7,1,0,0],
 tenant_feature_entitlements:[8,4,2,0,0],
 tweet_sms_report_snapshots:[10,2,1,0,0]
};
const unique=(a,key)=>{
 const m=new Map();for(const x of a){assert.ok(!m.has(x[key]),'duplicate '+key+': '+x[key]);m.set(x[key],x);}
 return m;
};
export function auditEleven(fEvidence,tEvidence,historicalFns,historicalRelations,register){
 assert.equal(fEvidence.format,'PR359_CB_A_6_MISSING_FUNCTIONS_LIVE_EVIDENCE_V1');
 assert.equal(tEvidence.format,'PR359_CB_A_5_MISSING_TABLES_LIVE_EVIDENCE_V1');
 for(const e of [fEvidence,tEvidence]){
  assert.equal(e.source_project_ref,'iyuryuhaylhisjfcrwkz');
  assert.ok(['read-only catalog select','read-only pg_catalog SELECT'].includes(e.capture_mode),
   'source capture mode changed');
  assert.equal(e.canonical_baseline_approved,false);
  assert.equal(e.staging_inplace_go,false);
  assert.equal(e.production_inplace_go,false);
 }
 assert.equal(fEvidence.app_owned_approved,false);
 assert.equal(tEvidence.approved_app_owned,false);
 assert.equal(fEvidence.previous_r0_definition_sha_match,true);
 assert.equal(register.objects.length,978);
 assert.equal(register.decision.app_owned_signed,false);
 assert.deepEqual(register.decision.destructive_allowlist,[]);
 assert.equal(historicalFns.objects.length,641);
 assert.equal(historicalRelations.objects.length,337);
 assert.equal(fEvidence.functions.length,6);
 assert.equal(tEvidence.tables.length,5);
 const f=unique(fEvidence.functions,'name');
 const t=unique(tEvidence.tables,'table_name');
 const inventory=unique(register.objects,'id');
 const hf=unique(historicalFns.objects,'signature');
 const hr=unique(historicalRelations.objects.map(x=>({...x,id:x.schema+'.'+x.name+'#'+x.kind})),'id');
 let definer=0,tableTriggers=0;
 for(const name of functionNames){
  const row=f.get(name);
  assert.ok(row,'missing live function '+name);
  assert.match(row.sha256,HEX);
  assert.equal(createHash('sha256').update(row.executable_ddl,'utf8').digest('hex'),row.sha256,
   'stored function body does not match captured SHA256: '+name);
  assert.equal(typeof row.executable_ddl,'string');
  assert.ok(row.executable_ddl.startsWith('CREATE OR REPLACE FUNCTION public.'+name+'('));
  assert.ok(!row.anon_execute&&!row.authenticated_execute&&row.service_execute,
   'unexpected client EXECUTE: '+name);
  const hist=[...hf.values()].filter(x=>x.name===name);
  assert.equal(hist.length,1,'missing or overloaded historical function '+name);
  const old=hist[0];
  assert.equal(row.sha256,old.definition_sha256,'current DDL differs from R0: '+name);
  assert.equal(row.security_definer,old.security_definer,'security definer changed: '+name);
  const reg=inventory.get(old.signature);
  assert.ok(reg,'function absent from registered roots: '+name);
  assert.equal(reg.reviewed,false);
  assert.equal(reg.classification,'APP_OWNED_CANDIDATE');
  assert.equal(reg.definition_sha256,row.sha256);
  if(row.security_definer)definer++;
 }
 assert.equal(definer,3,'unexpected privileged function surface');
 for(const [name,counts] of Object.entries(tableCounts)){
  const x=t.get(name);
  assert.ok(x,'missing live table '+name);
  assert.equal(x.schema_name,'public');
  assert.equal(x.relkind,'r');
  assert.equal(x.rls,true);
  assert.equal(x.force_rls,false);
  assert.ok(!x.anon_select&&!x.authenticated_select&&x.service_select,
   'unexpected public table exposure: '+name);
  assert.equal(x.policies.length,0,'new direct policies require review: '+name);
  assert.deepEqual([x.columns.length,x.constraints.length,x.indexes.length,
   x.triggers.length,x.policies.length],counts,'table DDL catalog count drift: '+name);
  const hist=hr.get('public.'+name+'#r');
  assert.ok(hist,'missing historical table: '+name);
  assert.equal(hist.rls,true);
  assert.equal(hist.columns.length,x.columns.length);
  const registered=inventory.get('public.'+name+'#r');
  assert.ok(registered&&!registered.reviewed);
  assert.equal(registered.definition_sha256,null,
   'catalog structure cannot falsely become full executable DDL');
  for(let i=0;i<x.columns.length;i++){
   const a=x.columns[i],b=hist.columns[i];
   assert.equal(a.name,b.name,'column name drift: '+name);
   assert.equal(a.type,b.type,'column type drift: '+name+'.'+a.name);
   assert.equal(a.identity,b.identity,'identity drift: '+name+'.'+a.name);
   assert.equal(a.nullable,b.nullable,'nullability drift: '+name+'.'+a.name);
   assert.equal(a.default_sha256,b.default_sha256,'default expression drift: '+name+'.'+a.name);
  }
  for(const con of x.constraints){
   assert.ok(typeof con.definition==='string'&&con.definition.length>0);
   assert.equal(con.validated,true,'unvalidated table constraint: '+name);
  }
  for(const idx of x.indexes){
   assert.ok(idx.definition?.startsWith('CREATE '));
   assert.equal(idx.valid,true,'invalid index: '+name);
  }
  for(const trigger of x.triggers){
   assert.ok(trigger.definition?.startsWith('CREATE TRIGGER'));
   tableTriggers++;
  }
 }
 assert.equal(tableTriggers,2);
 return {format:'PR359_CB_A_ELEVEN_LIVE_GAP_EVIDENCE_PASS_V1',
  live_functions_reconciled:6,live_tables_reconciled:5,
  security_definer_review_backlog:3,
  rls_tables_without_direct_policies:5,
  table_triggers_seen:2,
  source_of_truth_signed:false,complete_executable_table_ddl_proven:false,
  runtime_callers_verified:false,object_approvals:0,
  remaining_object_reviews:978,canonical_baseline_approved:false,
  clean_bootstrap_pass:false,destructive_allowlist:[],
  staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false};
}
const cli=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(cli){
 assert.equal(process.argv.length,2,'No hosted writes or arguments allowed');
 const load=p=>JSON.parse(readFileSync(p,'utf8'));
 const result=auditEleven(pinnedJson(readFileSync(F_PATH),F_BLOB),
  pinnedJson(readFileSync(T_PATH),T_BLOB),
  load('docs/security/pr359-r0-staging-functions-20261119.json'),
  load('docs/security/pr359-r0-staging-relations-20261119.json'),
  load('docs/security/pr359-r4-staging-object-register-20261120.json'));
 console.log(JSON.stringify(result));
}
