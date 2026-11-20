import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EXPECTED_SURFACE,parseSchemaFingerprint,assessSchemaFingerprint} from './check-staging-schema-fingerprint.mjs';
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
