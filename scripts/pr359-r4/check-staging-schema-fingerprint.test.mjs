import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EXPECTED_SURFACE,REVIEWED_STAGING_SHA256,parseSchemaFingerprint,assessSchemaFingerprint,assessReviewedStagingSource} from './check-staging-schema-fingerprint.mjs';
import {parseSchemaObjectDigests,diagnoseSchemaObjectDrift} from './diagnose-staging-schema-object-drift.mjs';
const fixture=()=>Object.entries(EXPECTED_SURFACE).map(([category,objects])=>
 JSON.stringify({category,objects,sha256:'a'.repeat(64)})).join('\n')+'\n';
test('R0 complete schema counts are included but cannot grant destructive permission',()=>{
 const a=fixture(),r=assessSchemaFingerprint(a,a);
 assert.equal(parseSchemaFingerprint(a).size,7);
 assert.equal(r.definitionShaMatch,true);
 assert.equal(r.canonicalBaselineApproved,false);
 assert.equal(r.appOwnedSigned,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('equal counts but different SQL definitions are rejected',()=>{
 const a=fixture(),rows=a.trim().split('\n');
 rows[2]=JSON.stringify({...JSON.parse(rows[2]),sha256:'b'.repeat(64)});
 const r=assessSchemaFingerprint(a,rows.join('\n')+'\n');
 assert.equal(r.identityCountsMatch,true);
 assert.equal(r.definitionShaMatch,false);
 assert.equal(r.changedCategories.length,1);
});
test('missing category, duplicate category, count drift or wrong hash are rejected',()=>{
 const a=fixture().trim().split('\n');
 assert.throws(()=>parseSchemaFingerprint(a.slice(1).join('\n')));
 const b=[...a];b[0]=b[1];assert.throws(()=>parseSchemaFingerprint(b.join('\n')));
 const c=[...a];c[0]=JSON.stringify({...JSON.parse(c[0]),objects:55});assert.throws(()=>parseSchemaFingerprint(c.join('\n')));
 const d=[...a];d[0]=JSON.stringify({...JSON.parse(d[0]),sha256:'invalid'});assert.throws(()=>parseSchemaFingerprint(d.join('\n')));
});
test('SQL covers seven categories, security and ACL, and stays read-only',()=>{
 const s=readFileSync('scripts/pr359-r4/staging-schema-fingerprint.sql','utf8');
 for(const k of Object.keys(EXPECTED_SURFACE))assert.ok(s.includes("'"+k+"'"),k);
 for(const v of ['REPEATABLE READ READ ONLY','pg_get_functiondef','pg_get_indexdef','pg_get_constraintdef','pg_get_triggerdef','pg_get_expr','prosecdef','relrowsecurity','relforcerowsecurity','polroles','relacl'])assert.ok(s.includes(v),v);
 assert.doesNotMatch(s,/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
});
test('snapshot export and pre-data + post-restore checks are wired for Staging only',()=>{
 const a=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const b=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 assert.ok(a.includes('staging-schema-source.jsonl'));
 assert.ok(a.includes('staging-schema-after-export.jsonl'));
 assert.ok(b.includes('staging-schema-pre-data.jsonl'));
 assert.ok(b.includes('staging-schema-restored.jsonl'));
 assert.match(b,/SHADOW_STAGE=staging-schema-before-data/);
 assert.match(b,/SHADOW_STAGE=staging-restored-schema-fingerprint/);
 assert.ok(b.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});

test('reviewed Staging SHA-256 rejects same-count silent DDL changes',()=>{
 const reference=Object.entries(EXPECTED_SURFACE).map(([category,objects])=>
  JSON.stringify({category,objects,sha256:REVIEWED_STAGING_SHA256[category]})).join('\n')+'\n';
 const result=assessReviewedStagingSource(reference);
 assert.equal(result.reviewedSourceMatch,true);
 assert.equal(result.checked,7);
 assert.equal(result.canonicalBaselineApproved,false);
 assert.equal(result.appOwnedSigned,false);
 assert.equal(result.stagingInplaceGo,false);
 const wrong=reference.trim().split('\n');
 wrong[2]=JSON.stringify({...JSON.parse(wrong[2]),sha256:'0'.repeat(64)});
 const drift=assessReviewedStagingSource(wrong.join('\n')+'\n');
 assert.equal(drift.reviewedSourceMatch,false);
 assert.deepEqual(drift.changedCategories,[JSON.parse(wrong[2]).category]);
});
test('snapshot exporter checks pinned Staging SHA before data pg_dump',()=>{
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 assert.ok(exporter.includes('check-staging-schema-fingerprint.mjs --verify-reviewed-source'));
 assert.ok(exporter.indexOf('check-staging-schema-fingerprint.mjs --verify-reviewed-source')<
  exporter.indexOf('dump_schema schema.sql'));
 assert.ok(exporter.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});

test('per-object SHA diagnostics reveal missing/extra/changed identities but no SQL definitions',()=>{
 const item=(category,identity,sha)=>JSON.stringify({category,identity,sha256:sha.repeat(64)});
 const source=[item('relations','public.invoice','a'),item('functions','public.billing()','b'),item('columns','public.invoice.1','c')].join('\n')+'\n';
 const target=[item('relations','public.invoice','d'),item('functions','public.billing()','b'),item('columns','public.invoice.2','c')].join('\n')+'\n';
 const r=diagnoseSchemaObjectDrift(source,target);
 assert.equal(r.match,false);
 assert.equal(r.sourceObjects,3);
 assert.equal(r.targetObjects,3);
 assert.deepEqual(r.summary.map(x=>x.category).sort(),['columns','relations']);
 assert.deepEqual(r.summary.find(x=>x.category==='columns').missing,['public.invoice.1']);
 assert.deepEqual(r.summary.find(x=>x.category==='columns').extra,['public.invoice.2']);
 assert.deepEqual(r.summary.find(x=>x.category==='relations').changed,['public.invoice']);
 assert.equal(r.stagingInplaceGo,false);
 assert.equal(r.productionInplaceGo,false);
 assert.throws(()=>parseSchemaObjectDigests(source+item('relations','public.invoice','a')+'\n'),/duplicate/);
 assert.throws(()=>parseSchemaObjectDigests(''));
 assert.throws(()=>parseSchemaObjectDigests(item('relations','public.invoice','x')));
 assert.equal(diagnoseSchemaObjectDrift(source,source).match,true);
});
test('schema diagnostics stay linked to the identical source snapshot and fail closed before data COPY',()=>{
 const exported=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const restore=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const sql=readFileSync('scripts/pr359-r4/staging-schema-object-digests.sql','utf8');
 assert.match(sql,/pg_get_functiondef/);
 assert.match(sql,/ORDER BY category,identity/);
 assert.match(sql,/extensions\.digest/);
 assert.doesNotMatch(sql,/\b(DROP|DELETE|INSERT|UPDATE|TRUNCATE)\b.*;/i);
 assert.ok(exported.includes('source_psql "$workdir/staging-schema-object-source.jsonl"'));
 assert.ok(exported.indexOf('staging-schema-object-source.jsonl')<exported.indexOf('dump_schema schema.sql'));
 assert.ok(restore.includes('staging-schema-object-drift-diagnostics'));
 assert.ok(restore.includes('PR359_R4_UNREVIEWED_RESTORED_SCHEMA_DRIFT_BLOCKED'));
 assert.ok(restore.includes('exit 2'));
 assert.ok(restore.indexOf('staging-schema-object-drift-diagnostics')<restore.indexOf('SHADOW_STAGE=staging-managed-fks-before-data'));
});

test('diagnostic per-object hash uses the exact aggregate catalog delimiter',()=>{
 const source=readFileSync('scripts/pr359-r4/staging-schema-fingerprint.sql','utf8');
 const detail=readFileSync('scripts/pr359-r4/staging-schema-object-digests.sql','utf8');
 const fragment=String.raw`identity||E'\x1F'||attributes::text`;
 assert.ok(source.includes(fragment));
 assert.ok(detail.includes(fragment));
});
