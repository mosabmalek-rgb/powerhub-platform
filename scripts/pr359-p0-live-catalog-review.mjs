import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha64 = /^[a-f0-9]{64}$/;
export const P0 = Object.freeze({
 admin_subscription_upgrade_enrichment_rpc: ['function:public.powerhub_admin_subscription_upgrade_requests'],
 platform_capability_resolver: ['function:private.powerhub_has_platform_capability'],
 chat_rls_security_v1: ['policy:public.chat_messages.chat_messages_select_conversation_access'],
 chat_realtime_authorization_v1: ['policy:realtime.messages.chat_conversation_receive','policy:realtime.messages.chat_conversation_send'],
 chat_realtime_authorization_v1_harden: ['policy:realtime.messages.chat_support_receive_conversation','policy:realtime.messages.chat_support_send_conversation'],
 chat_storage_rls_v1: ['policy:storage.objects.chat_storage_select_conversation_access'],
 chat_storage_grants_hardening_v1: ['table:storage.objects'],
 chat_staging_compatibility_v1: ['function:private.chat_after_support_conversation_create','function:private.chat_notify_message_visibility','function:private.chat_prepare_support_conversation'],
 powerhub_field_user_guards: ['function:public.powerhub_enforce_field_user_quota'],
 powerhub_platform_support_role_reconciliation: ['function:public.powerhub_admin_set_platform_access_role'],
 powerhub_reading_opening_baseline_save_fix: ['function:public.powerhub_create_reading'],
 powerhub_unified_message_history_filters: ['function:public.powerhub_unified_messaging_history']
});
const toMap = a => {
 assert(a && Array.isArray(a.functions) && Array.isArray(a.policies) && Array.isArray(a.tables),'Catalog arrays missing');
 const map = new Map();
 const put = (key,entry) => {assert(!map.has(key),'Duplicate catalog asset: '+key);map.set(key,entry);};
 for(const f of a.functions) {
   assert(sha64.test(f.definition_sha256),'Function fingerprint malformed');
   put('function:'+f.schema_name+'.'+f.function_name+(f.identity_args?('('+f.identity_args+')'):'()'),f);
 }
 for(const p of a.policies) {
   assert(sha64.test(p.predicate_sha256),'Policy fingerprint malformed');
   put('policy:'+p.schemaname+'.'+p.tablename+'.'+p.policyname,p);
 }
 for(const t of a.tables)put('table:'+t.schema_name+'.'+t.table_name,t);
 return map;
};
const lookup=(map,key)=>{
 if(!key.startsWith('function:'))return [...map.entries()].filter(([k])=>k===key).map(([,v])=>v);
 return [...map.entries()].filter(([k])=>k===key+'()'||k.startsWith(key+'(')).map(([,v])=>v);
};
export function buildP0LiveReview(snapshot,crosswalk) {
 assert(snapshot?.schemaVersion===1 && /^[a-f0-9]{40}$/.test(snapshot.sourceHead||''),'Source SHA missing');
 assert(snapshot.releaseDecision==='NO_GO' && snapshot.shadowUpgrade==='NOT_TESTED','Snapshot must never claim release approval');
 assert(crosswalk?.records?.length===28,'28 historical groups required');
 const stage=snapshot.environments?.staging,production=snapshot.environments?.production;
 const a=toMap(stage),b=toMap(production);
 const names=Object.keys(P0);
 const rows=[];
 for(const name of names) {
   const record=crosswalk.records.find(r=>r.name===name);
   assert(record && record.outcome==='NOT_PROVEN','Historical P0 missing or falsely accepted: '+name);
   const assets=P0[name].map(key=>{
     const left=lookup(a,key),right=lookup(b,key);
     assert(left.length>0 || right.length>0,'P0 catalog target missing in both environments: '+key);
     return {key,stagingPresent:left.length>0,productionPresent:right.length>0,
       sameCurrentCatalog:JSON.stringify(left)===JSON.stringify(right)};
   });
   rows.push({name,historicalExecution:'NOT_PROVEN',currentSourceContract:record.live_object_reconciliation?.status||'SCOPED_ONLY',
     assets,allCurrentAssetsEqual:assets.every(x=>x.sameCurrentCatalog),
     historicalReplayAuthorized:false,behavioralProof:'NOT_TESTED'});
 }
 const has=(map,key)=>lookup(map,key).length>0;
 const m=(map,key)=>lookup(map,key)[0];
 const stageMessage=m(a,'policy:public.chat_messages.chat_messages_select_conversation_access');
 const prodMessage=m(b,'policy:public.chat_messages.chat_messages_select_conversation_access');
 assert(stageMessage && prodMessage,'Missing message SELECT RLS audit');
 const stageFn=m(a,'function:public.powerhub_dashboard_financial_overview');
 const prodFn=m(b,'function:public.powerhub_dashboard_financial_overview');
 assert(stageFn && prodFn,'Missing financial overview RPC audit');
 assert(Array.isArray(stage.financeColumns) && Array.isArray(production.financeColumns) &&
   Array.isArray(stage.coreMigrations) && Array.isArray(production.coreMigrations),'Financial metadata missing');
 return {
   sourceHead:snapshot.sourceHead,groupsCount:rows.length,scope:'P0 catalog differences only; NOT historical execution/behavior proof',
   groups:rows,
   findings:{
     productionSupportChatSelectHasUnrestrictedCapabilityBranch:
       /manageSupportChat/.test(prodMessage.predicate_prefix||'') && !/conversation_type/.test(prodMessage.predicate_prefix||''),
     stagingSupportChatSelectRestrictsSupport:
       /conversation_type/.test(stageMessage.predicate_prefix||''),
     financialDashboardDefinitionDiffers:stageFn.definition_sha256!==prodFn.definition_sha256,
     financePrerequisitesAbsentInProduction:['payment_purpose','invoice_applied_amount','subscriber_credit_amount']
       .every(k=>stage.financeColumns.some(c=>c.column_name===k) && !production.financeColumns.some(c=>c.column_name===k))
       && !!stage.creditLedger && !production.creditLedger,
     fourFoundationalFinanceMigrationsNotRecordedInProduction:
       ['20261103131052','20261103131104','20261103131125','20261103145232']
       .every(v=>stage.coreMigrations.some(m=>m.version===v&&m.sql_available===true)
         && !production.coreMigrations.some(m=>m.version===v)),
     privateAnonSchemaUsageProduction:production.privateAnonUsage,
     privateAnonExecuteGrantDrift:
       P0.chat_staging_compatibility_v1.some(k=>!m(a,k)?.anon_execute && m(b,k)?.anon_execute)
   },
   migrationReconciliation:'NOT_ACCEPTED',productionShadowUpgrade:'NOT_TESTED',
   releaseDecision:'NO_GO_UNPROVEN_P0_AND_SHADOW',
   warning:'Current pg_catalog ACL/policy fingerprints do not demonstrate authorized row-level behavior or historical SQL execution'
 };
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const snapshot=JSON.parse(readFileSync('docs/security/pr359-phase1-p0-live-catalog-20261117.json','utf8'));
 const historical=JSON.parse(readFileSync('docs/security/pr359-migration-history-crosswalk-20261108.json','utf8'));
 const report=buildP0LiveReview(snapshot,historical),ix=process.argv.indexOf('--out');
 if(ix>=0){assert(!!process.argv[ix+1],'Missing output path');writeFileSync(process.argv[ix+1],JSON.stringify(report,null,2)+'\n');}
 console.log('PR359 P0 live catalog review',report.groupsCount,'groups; release:',report.releaseDecision);
 if(process.argv.includes('--require-accepted'))throw Error('NO_GO: P0 history and Production Shadow not independently proved');
}
