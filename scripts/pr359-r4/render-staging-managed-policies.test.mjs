import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderManagedPolicyReplay,SOURCE_POLICY_SHA} from './render-staging-managed-policies.mjs';

const definitions=[
 ['realtime','messages','chat_conversation_receive','SELECT'],
 ['realtime','messages','chat_conversation_send','INSERT'],
 ['realtime','messages','chat_support_receive_conversation','SELECT'],
 ['realtime','messages','chat_support_send_conversation','INSERT'],
 ['realtime','messages','chat_user_notification_receive','SELECT'],
 ['realtime','messages','powerhub_delta_revision_receive','SELECT'],
 ['storage','objects','chat_storage_select_conversation_access','SELECT']
];
function sample(){
 return {format:'PR359_R4_MANAGED_POLICY_REPLAY_V1',sha256:SOURCE_POLICY_SHA,
  policies:definitions.map(([schema,table,name,command])=>({
   schema,table,name,command,permissive:true,roles:['authenticated'],
   using:command==='SELECT'?'(auth.uid() IS NOT NULL)':null,
   check:command==='INSERT'?'(auth.uid() IS NOT NULL)':null
  }))};
}
const invoke=v=>renderManagedPolicyReplay(JSON.stringify(v)+'\n');
test('seven reviewed provider policy identifiers render for local SQL only',()=>{
 const s=invoke(sample());
 assert.equal((s.match(/CREATE POLICY /g)||[]).length,7);
 assert.ok(s.startsWith('BEGIN;\n'));
 assert.ok(s.endsWith('COMMIT;\n'));
 assert.match(s,/FOR INSERT TO authenticated WITH CHECK/);
 assert.match(s,/FOR SELECT TO authenticated USING/);
 assert.doesNotMatch(s,/DROP POLICY|ALTER POLICY|GRANT |TRUNCATE|DELETE FROM/);
});
test('drift, unauthorized roles, duplicate policy, or missing predicate fail closed',()=>{
 const v=sample();v.sha256='0'.repeat(64);assert.throws(()=>invoke(v),/fingerprint drift/);
 for(const change of [
  p=>p.policies[0].roles=['anon'],
  p=>p.policies[0].permissive=false,
  p=>p.policies[0].using='',
  p=>p.policies[0].name='unexpected',
  p=>p.policies[1].command='SELECT',
  p=>p.policies[1].using='true',
  p=>p.policies.push(p.policies[0]),
  p=>p.policies[0].table='other'
 ]){
  const x=sample();change(x);assert.throws(()=>invoke(x));
 }
});
test('source is snapshot-scoped, checksum-bound, and applied before dependency parity/COPY',()=>{
 const source=readFileSync('scripts/pr359-r4/staging-managed-policy-source.sql','utf8');
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const twins=readFileSync('scripts/pr359-r4/check-independent-staging-exports.mjs','utf8');
 assert.ok(source.includes('REPEATABLE READ READ ONLY'));
 assert.ok(source.includes(SOURCE_POLICY_SHA));
 assert.ok(source.includes('WHERE objects=7'));
 assert.ok(exporter.includes('source_psql "$workdir/staging-managed-policy-source.json"'));
 assert.ok(exporter.includes('sha256sum "$workdir/staging-managed-policy-source.json"'));
 assert.ok(twins.includes("'staging-managed-policy-replay.sql'"));
 const d=runner.indexOf('SHADOW_STAGE=staging-local-managed-policy-replay-pre-data');
 const reverse=runner.indexOf('SHADOW_STAGE=staging-reverse-managed-dependencies-before-data');
 const copy=runner.indexOf('SHADOW_STAGE=restore-data');
 assert.ok(d>=0&&d<reverse&&reverse<copy);
 assert.ok(runner.includes('PR359_STAGING_MANAGED_POLICY_PREEXISTING_BLOCKED'));
 assert.ok(runner.includes('PR359_STAGING_MANAGED_REVERSE_TARGET_PARITY_FAILED'));
 assert.ok(!source.includes('DROP POLICY'));
});
