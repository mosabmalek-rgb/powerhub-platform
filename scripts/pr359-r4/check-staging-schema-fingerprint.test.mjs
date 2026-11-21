import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EXPECTED_SURFACE,REVIEWED_STAGING_SHA256,parseSchemaFingerprint,assessSchemaFingerprint,assessReviewedStagingSource} from './check-staging-schema-fingerprint.mjs';
import {parseSchemaObjectDigests,diagnoseSchemaObjectDrift} from './diagnose-staging-schema-object-drift.mjs';
import {parseAttributeDigests,compareSchemaAttributes} from './diagnose-staging-schema-attribute-drift.mjs';
import {reviewRestoredSchemaSemanticParity} from './review-staging-schema-semantic-parity.mjs';
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
 assert.ok(restore.includes('staging-schema-object-drift-$stage'));
 assert.ok(restore.includes('PR359_R4_UNREVIEWED_RESTORED_SCHEMA_DRIFT_BLOCKED'));
 assert.ok(restore.includes('exit 2'));
 assert.ok(restore.indexOf('check_staging_restored_schema pre-data')<restore.indexOf('SHADOW_STAGE=staging-managed-fks-before-data'));
});

test('diagnostic per-object hash uses the exact aggregate catalog delimiter',()=>{
 const source=readFileSync('scripts/pr359-r4/staging-schema-fingerprint.sql','utf8');
 const detail=readFileSync('scripts/pr359-r4/staging-schema-object-digests.sql','utf8');
 const fragment=String.raw`identity||E'\x1F'||attributes::text`;
 assert.ok(source.includes(fragment));
 assert.ok(detail.includes(fragment));
});

test('catalog per-attribute mismatch identifies exact field without disclosing values',()=>{
 const row=(category,identity,field,digest)=>JSON.stringify({category,identity,field,sha256:digest.repeat(64)});
 const original=[row('functions','public.f()','acl','a'),
                 row('functions','public.f()','def','b'),
                 row('relations','public.r','owner','c'),
                 row('columns','public.r.1','name','d')].join('\n')+'\n';
 const restored=[row('functions','public.f()','acl','e'),
                 row('functions','public.f()','def','b'),
                 row('relations','public.r','owner','c'),
                 row('columns','public.r.2','name','d')].join('\n')+'\n';
 const r=compareSchemaAttributes(original,restored);
 assert.equal(r.match,false);
 assert.deepEqual(r.summary.map(x=>x.category+'/'+x.field),['columns/name','functions/acl']);
 assert.deepEqual(r.summary.find(x=>x.category==='functions').changed,['public.f()']);
 assert.equal(r.appOwnedApproved,false);
 assert.equal(r.stagingInplaceGo,false);
 assert.throws(()=>parseAttributeDigests(original+row('functions','public.f()','acl','a')+'\n'),/duplicate/);
 assert.throws(()=>parseAttributeDigests(''));
 assert.throws(()=>parseAttributeDigests(row('functions','public.f()','acl','x')));
 assert.equal(compareSchemaAttributes(original,original).match,true);
});
test('per-attribute R4 diagnostics have identical source snapshot and fail-closed restore scope',()=>{
 const source=readFileSync('scripts/pr359-r4/staging-schema-fingerprint.sql','utf8');
 const detail=readFileSync('scripts/pr359-r4/staging-schema-attribute-digests.sql','utf8');
 const exportSh=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const restore=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const cteStart='WITH inventory AS (',cteEnd='\nSELECT jsonb_build_object(';
 assert.equal(detail.slice(detail.indexOf(cteStart),detail.indexOf('\n-- Emit only')),
   source.slice(source.indexOf(cteStart),source.indexOf(cteEnd)));
 assert.match(detail,/jsonb_each\(i\.attributes\)/);
 assert.match(detail,/a\.value::text,'sha256'/);
 assert.match(detail,/WHERE i\.category IN \('columns','functions','relations'\)/);
 assert.ok(exportSh.includes('source_psql "$workdir/staging-schema-attribute-source.jsonl"'));
 assert.ok(exportSh.indexOf('staging-schema-attribute-source.jsonl')<exportSh.indexOf('dump_schema schema.sql'));
 assert.ok(restore.includes('staging-schema-attribute-drift-$stage'));
 assert.ok(restore.includes('PR359_R4_UNREVIEWED_RESTORED_SCHEMA_DRIFT_BLOCKED'));
 assert.ok(restore.indexOf('check_staging_restored_schema pre-data')<restore.indexOf('staging-managed-fks-before-data'));
});

test('canonical schema snapshot retains all categories and faithfully normalizes every ACL privilege',()=>{
 const oldSql=readFileSync('scripts/pr359-r4/staging-schema-fingerprint.sql','utf8');
 const canonical=readFileSync('scripts/pr359-r4/staging-schema-semantic-fingerprint.sql','utf8');
 assert.equal((canonical.match(/SELECT '[a-z]+'/g)||[]).length,(oldSql.match(/SELECT '[a-z]+'/g)||[]).length);
 assert.match(canonical,/aclexplode\(coalesce\(p\.proacl,acldefault\('f'::"char",p\.proowner\)\)\)/);
 assert.match(canonical,/aclexplode\(coalesce\(c\.relacl,acldefault\(CASE WHEN c\.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c\.relowner\)\)\)/);
 assert.match(canonical,/acl\.is_grantable/);
 assert.match(canonical,/acl\.privilege_type/);
 assert.match(canonical,/pg_get_userbyid\(acl\.grantor\)/);
 assert.match(canonical,/CASE WHEN acl\.grantee=0 THEN 'PUBLIC'/);
 assert.match(canonical,/quote_ident\(a\.attname\)/);
 assert.ok(!canonical.includes("'acl',p.proacl::text"));
 assert.ok(!canonical.includes("'acl',c.relacl::text"));
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const twins=readFileSync('scripts/pr359-r4/check-independent-staging-exports.mjs','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 assert.ok(exporter.includes('staging-schema-semantic-source.jsonl'));
 assert.ok(twins.includes("'staging-schema-semantic-source.jsonl'"));
 assert.equal((runner.match(/check_staging_restored_schema (?:pre-data|restored)/g)||[]).length,2);
 assert.ok(runner.indexOf('check_staging_restored_schema pre-data')<runner.indexOf('SHADOW_STAGE=restore-data'));
 assert.ok(runner.includes('PR359_R4_UNREVIEWED_RESTORED_SCHEMA_DRIFT_BLOCKED'));
 assert.ok(runner.includes('staging-schema-semantic-restored.jsonl'));
});
test('semantic parity permits only the exact reviewed raw ACL/physical ordinal differences',()=>{
 const hex=n=>n.repeat(64);
 const row=(category,identity,sha)=>JSON.stringify({category,identity,sha256:hex(sha)});
 const attr=(category,identity,field,sha)=>JSON.stringify({category,identity,field,sha256:hex(sha)});
 const objs1=[],objs2=[],attrs1=[],attrs2=[];
 for(let i=0;i<579;i++){
  const id='public.f_'+i+'()';
  objs1.push(row('functions',id,'a'));objs2.push(row('functions',id,'b'));
  attrs1.push(attr('functions',id,'acl','a'));attrs2.push(attr('functions',id,'acl','b'));
 }
 for(let i=0;i<216;i++){
  const id='public.r_'+i;
  objs1.push(row('relations',id,'a'));objs2.push(row('relations',id,'b'));
  attrs1.push(attr('relations',id,'acl','a'));attrs2.push(attr('relations',id,'acl','b'));
 }
 const prefix='public.tenant_invoice_message_templates.';
 for(let n=4;n<=9;n++){
  objs1.push(row('columns',prefix+n,'a'));
  attrs1.push(attr('columns',prefix+n,'name','a'));
 }
 for(let n=3;n<=8;n++){
  objs2.push(row('columns',prefix+n,'b'));
  attrs2.push(attr('columns',prefix+n,'name','b'));
 }
 const sem=Object.entries(EXPECTED_SURFACE).map(([category,objects])=>
  JSON.stringify({category,objects,sha256:hex('c')})).join('\n')+'\n';
 const serialize=x=>x.join('\n')+'\n';
 const args=[sem,sem,serialize(objs1),serialize(objs2),serialize(attrs1),serialize(attrs2)];
 assert.equal(reviewRestoredSchemaSemanticParity(...args).canonicalSemanticParity,true);
 const alt=Object.entries(EXPECTED_SURFACE).map(([category,objects])=>
  JSON.stringify({category,objects,sha256:hex(category==='functions'?'d':'c')})).join('\n')+'\n';
 assert.throws(()=>reviewRestoredSchemaSemanticParity(...[args[0],alt,...args.slice(2)]),
  /effective PostgreSQL privileges or semantic schema/);
 assert.throws(()=>reviewRestoredSchemaSemanticParity(...[...args.slice(0,5),
   args[5]+attr('functions','public.f_0()','def','b')+'\n']),
  /unreviewed function definition/);
 assert.throws(()=>reviewRestoredSchemaSemanticParity(...[...args.slice(0,5),
   args[5]+attr('relations','public.r_0','rls','b')+'\n']),
  /unreviewed relation RLS/);
});

test('semantic guard runs before data COPY and after restoration, preserving fail-closed paths',()=>{
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const helper=runner.slice(runner.indexOf('check_staging_restored_schema(){'),runner.indexOf('\nrestore(){'));
 assert.ok(helper.includes('staging-schema-object-drift-$stage'));
 assert.ok(helper.includes('staging-schema-attribute-drift-$stage'));
 assert.ok(helper.includes('PR359_R4_UNREVIEWED_RESTORED_SCHEMA_DRIFT_BLOCKED'));
 assert.equal((runner.match(/check_staging_restored_schema (?:pre-data|restored)/g)||[]).length,2);
 assert.ok(runner.indexOf('check_staging_restored_schema pre-data')<runner.indexOf('SHADOW_STAGE=restore-data'));
 assert.ok(runner.indexOf('check_staging_restored_schema restored')>runner.indexOf('SHADOW_STAGE=restore-data'));
 assert.ok(helper.includes('review-staging-schema-semantic-parity.mjs'));
});
