import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// This renders policy DDL for a disposable Supabase Local Stack only.
// The source PG query requires a separately reviewed SHA256 of all source
// policy expressions and identities, and the renderer independently pins
// exact schemas, names, modes and roles before writing an ephemeral file.
export const SOURCE_POLICY_SHA='d74afb852ed0b498164be47f91c736f7a53538cad3f0bfd59b6e74e93352297d';
const allowed=new Map([
 ['realtime.messages.chat_conversation_receive','SELECT'],
 ['realtime.messages.chat_conversation_send','INSERT'],
 ['realtime.messages.chat_support_receive_conversation','SELECT'],
 ['realtime.messages.chat_support_send_conversation','INSERT'],
 ['realtime.messages.chat_user_notification_receive','SELECT'],
 ['realtime.messages.powerhub_delta_revision_receive','SELECT'],
 ['storage.objects.chat_storage_select_conversation_access','SELECT']
]);
const quote=value=>'"'+value.replaceAll('"','""')+'"';
export function renderManagedPolicyReplay(raw){
 assert.equal(typeof raw,'string');
 const lines=raw.trim().split(/\r?\n/);
 assert.equal(lines.length,1,'one source snapshot policy inventory required');
 const doc=JSON.parse(lines[0]);
 assert.deepEqual(Object.keys(doc).sort(),['format','policies','sha256']);
 assert.equal(doc.format,'PR359_R4_MANAGED_POLICY_REPLAY_V1');
 assert.equal(doc.sha256,SOURCE_POLICY_SHA,'source RLS policy fingerprint drift');
 assert.ok(Array.isArray(doc.policies)&&doc.policies.length===7,'seven source policies required');
 const seen=new Set();
 const sql=['BEGIN;'];
 for(const p of doc.policies){
  assert.deepEqual(Object.keys(p).sort(),['check','command','name','permissive','roles','schema','table','using']);
  const id=p.schema+'.'+p.table+'.'+p.name;
  assert.equal(p.command,allowed.get(id),'unreviewed managed policy or operation: '+id);
  assert.ok(!seen.has(id),'duplicate provider policy: '+id);
  seen.add(id);
  assert.equal(p.permissive,true,'RESTRICTIVE policy not reviewed');
  assert.deepEqual(p.roles,['authenticated'],'provider policy role drift');
  assert.ok(/^[a-z][a-z0-9_]*$/.test(p.schema));
  assert.ok(/^[a-z][a-z0-9_]*$/.test(p.table));
  assert.ok(/^[a-z][a-z0-9_]*$/.test(p.name));
  const expression=p.command==='SELECT'?p.using:p.check;
  assert.equal(p.command==='SELECT'?p.check:p.using,null,
    'unexpected RLS clause');
  assert.ok(typeof expression==='string'&&expression.trim().length>0,
    'missing RLS predicate');
  // SHA pinning is the decisive protection for arbitrary predicate contents.
  // Never log the predicate and never execute this output on hosted databases.
  assert.ok(expression.length<10000,'unexpected predicate size');
  sql.push('CREATE POLICY '+quote(p.name)+' ON '+quote(p.schema)+'.'+quote(p.table)+
   ' AS PERMISSIVE FOR '+p.command+' TO authenticated '+
   (p.command==='SELECT'?'USING':'WITH CHECK')+' ('+expression+');');
 }
 assert.deepEqual([...seen].sort(),[...allowed.keys()].sort());
 sql.push('COMMIT;');
 return sql.join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4,'Usage: render-managed-policies.mjs SOURCE_JSON LOCAL_OUTPUT_SQL');
 const rendered=renderManagedPolicyReplay(readFileSync(process.argv[2],'utf8'));
 writeFileSync(process.argv[3],rendered,{mode:0o600,flag:'wx'});
 console.log('PR359_STAGING_MANAGED_RLS_POLICY_RENDER_VALIDATED_COUNT=7');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
}
