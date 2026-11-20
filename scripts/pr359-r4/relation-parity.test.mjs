import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditedRows,buildRelationsPlan,assessRelationsReports,makeRelationsQuery,SOURCE} from './relation-parity.mjs';
const source=()=>JSON.parse(readFileSync(SOURCE,'utf8'));
const plan=()=>buildRelationsPlan(source());
const passing=p=>p.map(x=>({scope:'PR359_R4_RELATIONS_READ_ONLY_V1',batch:x.batch,
 batches:x.batches,expected:x.expected,actual_total:337,missing:0,changed:0,samples:[]}));

test('exactly 337 relations and 2723 ordered columns have traceable R0 evidence',()=>{
 const rows=auditedRows(source()),p=plan();
 assert.equal(rows.length,337);
 assert.equal(rows.reduce((a,r)=>a+r.columns.length,0),2723);
 assert.equal(p.length,14);
 assert.equal(p.reduce((a,x)=>a+x.expected,0),337);
 for(const entry of p){
  assert.ok(entry.sql.startsWith('-- PR359 R4: read-only'));
  assert.match(entry.sql,/encode\(extensions\.digest\(coalesce\(c\.relacl::text,''\),'sha256'\)/);
  assert.match(entry.sql,/has_table_privilege\('authenticated',c\.oid,'SELECT'\)/);
  assert.match(entry.sql,/pg_get_expr\(ad\.adbin,ad\.adrelid\)/);
  assert.match(entry.sql,/a\.attidentity/);
  assert.match(entry.sql,/to_jsonb\(e\) IS DISTINCT FROM to_jsonb\(a\)/);
  assert.ok(entry.sql.trimEnd().endsWith('AS pr359_r4_relation_attestation;'));
 }
});
test('positive observation report never grants reset, drop or merge approval',()=>{
 const r=assessRelationsReports(plan(),passing(plan()));
 assert.deepEqual(r.blockers,[]);
 assert.equal(r.verified,true);
 assert.equal(r.stagingInplaceGo,false);
 assert.equal(r.atomicStagingSnapshot,false);
 assert.equal(r.dropAuthorized,false);
});
test('missing relation, changed ACL or role privilege, or lost column fails',()=>{
 const p=plan();
 const a=passing(p);a[0].changed=1;a[0].samples=['public.users'];
 assert.ok(assessRelationsReports(p,a).blockers.some(x=>x.startsWith('RELATION_DEFINITION_OR_ACL_DRIFT')));
 const b=passing(p);b[0].actual_total=336;
 assert.ok(assessRelationsReports(p,b).blockers.some(x=>x.startsWith('RELATION_COUNT_DRIFT')));
 const c=source();c.objects[0].columns.shift();
 assert.throws(()=>auditedRows(c),/2723/);
 const d=source();d.objects[0].acl_sha256='tampered';
 assert.throws(()=>auditedRows(d));
 const e=source();e.objects[0].auth_select=null;
 assert.throws(()=>auditedRows(e));
});
test('duplicated object and a provider extension cannot enter the observed app manifest',()=>{
 const a=source();a.objects[1].name=a.objects[0].name;
 assert.throws(()=>auditedRows(a),/duplicate relation/);
 const b=source();b.objects[0].extension_name='postgis';
 assert.throws(()=>auditedRows(b));
 const c=source();c.objects[0].classification_reviewed=true;
 assert.throws(()=>auditedRows(c));
});
test('SQL metadata literals do not accept unescaped apostrophes',()=>{
 const row=auditedRows(source())[0];
 row.columns[0].name="hello' OR 1=1 --";
 const sql=makeRelationsQuery([row],1,1);
 assert.match(sql,/hello'' OR 1=1 --/);
 assert.equal((sql.match(/AS pr359_r4_relation_attestation;/g)||[]).length,1);
});
test('missing and duplicated batch results fail closed',()=>{
 const p=plan();
 assert.equal(assessRelationsReports(p,passing(p).slice(1)).verified,false);
 const a=passing(p);a[1]=a[0];
 assert.ok(assessRelationsReports(p,a).blockers.some(x=>x.startsWith('DUPLICATE_BATCH')));
});
