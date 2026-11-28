import test from 'node:test';
import assert from 'node:assert/strict';
import {buildP0Review,loadSources,parsePinned,sources} from './cb-a-p0-review-queue.mjs';
import {readFileSync} from 'node:fs';
const head='a'.repeat(40);
test('joins all 296 P0 candidates without promoting ownership',()=>{
 const r=buildP0Review(loadSources(),head);
 assert.equal(r.records.length,296);
 assert.equal(r.signed_approvals,0);
 assert.equal(r.app_owned_approved,false);
 assert.deepEqual(r.destructive_allowlist,[]);
 assert.ok(r.records.every(x=>x.schema==='public'&&x.security_definer&&x.review_status==='PENDING'&&x.reviewer_approval===null&&x.canonical_source===null));
 assert.deepEqual(r,buildP0Review(loadSources(),head));
});
test('rejects altered pinned bytes and inconsistent evidence',()=>{
 const [name,sha]=sources.live;
 const raw=readFileSync('docs/security/'+name);
 assert.throws(()=>parsePinned(Buffer.concat([raw,Buffer.from(' ')]),sha),/source blob drift/);
 const x=loadSources();x.register.objects[0].reviewed=true;
 assert.throws(()=>buildP0Review(x,head));
 const y=loadSources();y.live.objects[0].definition_sha256='f'.repeat(64);
 assert.throws(()=>buildP0Review(y,head));
});
