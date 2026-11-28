import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPinnedProducerEvidence,auditRealDeltaProducerEvidence} from './cb-a-real-delta-producer-audit.mjs';

export const CAPTURE_TEMPLATE='scripts/pr359-canonical/fixtures/real-capture-disposable.sql.in';
const MARKERS=[
 '-- PR359_PINNED_CAPTURE_APPEND',
 '-- PR359_PINNED_CAPTURE_EMIT',
 '-- PR359_PINNED_CAPTURE_TRIGGER_FUNCTION',
 '-- PR359_PINNED_CAPTURE_OPERATIONAL_TRIGGERS'
];
function ddlStatement(source){
 assert.ok(source.startsWith('CREATE OR REPLACE FUNCTION public.'));
 return source.trimEnd().replace(/;?$/,';');
}
export function buildRealCaptureDisposableSql(evidence=loadPinnedProducerEvidence(),template=readFileSync(CAPTURE_TEMPLATE,'utf8')){
 auditRealDeltaProducerEvidence(evidence);
 const fn=name=>evidence.functions.find(x=>x.identity.startsWith(name+'('))?.executable_ddl;
 const captureRow=evidence.functions.find(x=>x.identity==='powerhub_capture_fuel_maintenance_delta_sync_change()');
 assert.ok(captureRow);
 const triggers=captureRow.direct_triggers;
 assert.equal(triggers.length,3);
 const definitions=[
  ddlStatement(fn('powerhub_append_fuel_maintenance_delta_sync_change')),
  ddlStatement(fn('powerhub_emit_fuel_maintenance_delta_sync_change')),
  ddlStatement(fn('powerhub_capture_fuel_maintenance_delta_sync_change')),
  triggers.map(t=>t.definition.trimEnd().replace(/;?$/,';')).join('\n')
 ];
 assert.ok(!/\\connect\b|\\copy\b|dblink|postgres(?:ql)?:\/\//i.test(template));
 let sql=template;
 for(let i=0;i<MARKERS.length;i++){
  assert.equal(sql.split(MARKERS[i]).length,2,'missing/duplicate fixture marker');
  sql=sql.replace(MARKERS[i],()=>definitions[i]);
 }
 assert.ok(MARKERS.every(m=>!sql.includes(m)));
 assert.ok(sql.includes('PR359_REAL_CAPTURE_SOURCE_LOG_ROLLBACK_PASS'));
 assert.ok(sql.includes('PR359_CANONICAL_BASELINE_APPROVED=FALSE'));
 return sql;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===2&&args[0]==='--out',
  'Usage: generate-real-capture-disposable.mjs --out local-temporary-file');
 writeFileSync(args[1],buildRealCaptureDisposableSql(),{flag:'wx',mode:0o600});
 console.log('PR359_DISPOSABLE_REAL_CAPTURE_SQL_GENERATED');
}