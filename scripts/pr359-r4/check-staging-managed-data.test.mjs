import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REQUIRED_MANAGED_TABLES,parseManagedDataFingerprint,assessManagedDataParity} from './check-staging-managed-data.mjs';
const fixture=()=>REQUIRED_MANAGED_TABLES.map(([schema,table],i)=>
 JSON.stringify({schema,table,rows:i+1,content_sha256:'a'.repeat(64)})).join('\n')+'\n';
test('four exact managed identity fingerprints required and cannot authorize reset',()=>{
 const f=fixture(),r=assessManagedDataParity(f,f);
 assert.equal(parseManagedDataFingerprint(f).size,4);
 assert.equal(r.contentMatch,true);
 assert.equal(r.rowCountsMatch,true);
 assert.equal(r.storageObjectBytesProven,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('auth and storage equal-count row mutation changes SHA',()=>{
 const s=fixture(),items=s.trim().split('\n');
 items[1]=JSON.stringify({...JSON.parse(items[1]),content_sha256:'b'.repeat(64)});
 items[3]=JSON.stringify({...JSON.parse(items[3]),content_sha256:'c'.repeat(64)});
 const r=assessManagedDataParity(s,items.join('\n')+'\n');
 assert.equal(r.rowCountsMatch,true);
 assert.equal(r.contentMatch,false);
 assert.equal(r.hashDrift,2);
});
test('incomplete duplicate unexpected and invalid rows rejected',()=>{
 const a=fixture().trim().split('\n');
 assert.throws(()=>parseManagedDataFingerprint(a.slice(1).join('\n')));
 const b=[...a];b[0]=b[1];assert.throws(()=>parseManagedDataFingerprint(b.join('\n')));
 const c=[...a];c[0]=JSON.stringify({...JSON.parse(c[0]),schema:'public'});assert.throws(()=>parseManagedDataFingerprint(c.join('\n')));
 const d=[...a];d[2]=JSON.stringify({...JSON.parse(d[2]),rows:-1});assert.throws(()=>parseManagedDataFingerprint(d.join('\n')));
});
test('managed SQL is read-only and emits only digest and metadata',()=>{
 const s=readFileSync('scripts/pr359-r4/staging-managed-data-content.sql','utf8');
 assert.match(s,/REPEATABLE READ READ ONLY/);
 assert.match(s,/extensions\.digest\(to_jsonb\(t\)::text/);
 assert.match(s,/\\gexec/);
 assert.match(s,/WHERE to_regclass/);
 assert.doesNotMatch(s,/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
});
test('source and both disposable restores include managed row parity gate',()=>{
 const s=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const r=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 for(const x of ['staging-managed-source.jsonl','staging-managed-after-export.jsonl'])assert.ok(s.includes(x));
 assert.ok(r.includes('staging-managed-restored.jsonl'));
 assert.match(r,/SHADOW_STAGE=staging-restored-managed-data/);
 assert.match(r,/check-staging-managed-data\.mjs --compare/);
 assert.ok(r.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});
