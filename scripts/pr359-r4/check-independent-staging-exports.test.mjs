import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assessIndependentStagingExports,INDEPENDENT_SOURCE_EVIDENCE_FILES} from './check-independent-staging-exports.mjs';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'powerhub-r4-twin-export-'));
 const dirs=[join(root,'first'),join(root,'second')];
 for(const [i,d] of dirs.entries()){
   mkdirSync(join(d,'dump'),{recursive:true});
   writeFileSync(join(d,'staging-snapshot-token.sha256'),(i?'b':'a').repeat(64)+'\n');
   for(const f of INDEPENDENT_SOURCE_EVIDENCE_FILES)
     writeFileSync(join(d,f),'{"ok":true}\n');
   for(const f of ['roles.sql','schema.sql','data.sql','history-schema.sql','history-data.sql'])
     writeFileSync(join(d,'dump',f),'-- isolated fixture\n');
 }
 return {root,dirs};
}
test('two independent MVCC sources require different snapshot tokens and matching evidence',()=>{
 const {root,dirs}=fixture();
 try{
  const r=assessIndependentStagingExports(...dirs);
  assert.equal(r.independentLogicalExports,2);
  assert.equal(r.stagingInplaceGo,false);
  assert.equal(r.productionInplaceGo,false);
  assert.throws(()=>assessIndependentStagingExports(dirs[0],dirs[0]));
  writeFileSync(join(dirs[1],'staging-snapshot-token.sha256'),'a'.repeat(64)+'\n');
  assert.throws(()=>assessIndependentStagingExports(...dirs),/reused the same source snapshot/);
 }finally{rmSync(root,{force:true,recursive:true});}
});
test('equal-count but differing content, RLS, or managed dependencies must reject second export',()=>{
 const {root,dirs}=fixture();
 try{
  for(const f of ['staging-content-source.jsonl','staging-schema-source.jsonl',
                  'staging-managed-reverse-source.json','source-history-attestation.json']){
   const saved=readFileSync(join(dirs[1],f));
   writeFileSync(join(dirs[1],f),'{"ok":false}\n');
   assert.throws(()=>assessIndependentStagingExports(...dirs),/independent source drift/);
   writeFileSync(join(dirs[1],f),saved);
  }
  writeFileSync(join(dirs[1],'dump','roles.sql'),'-- roles changed\n');
  assert.throws(()=>assessIndependentStagingExports(...dirs),/global role metadata drift/);
 }finally{rmSync(root,{force:true,recursive:true});}
});
test('missing SQL dump or source attestation never qualifies',()=>{
 const {root,dirs}=fixture();
 try{
  writeFileSync(join(dirs[1],'dump','history-data.sql'),'');
  assert.throws(()=>assessIndependentStagingExports(...dirs),/missing second SQL/);
 }finally{rmSync(root,{force:true,recursive:true});}
});
