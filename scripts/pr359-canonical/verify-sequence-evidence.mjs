import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildIndex} from './source-index.mjs';
import {validateMigrationProvenance} from '../pr359-r4/verify-legacy-migration-provenance.mjs';

// Git blob evidence from an isolated catalog-only SELECT against Staging.
// NO migrated/managed content is written, and these checks do NOT certify a baseline.
export const EXPECTED_EVIDENCE_BLOB='d7960b4abfa24ff4a8d1d0d80be50a8f147e272e';
export const EXPECTED_SQL_BLOB='448414db3612c3944c28368eb6d7ce97b0271ba2';
const BLOB=/^[0-9a-f]{40}$/;
const sha=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
export function checkPinnedBytes(raw,expected) {
 const b=Buffer.isBuffer(raw)?raw:Buffer.from(raw,'utf8');
 assert.match(expected,BLOB);
 assert.equal(sha(b),expected,'unreviewed catalog evidence / SQL changed');
 return b.toString('utf8');
}
const key=r=>r.sequence_schema+'.'+r.sequence_name;
const seqkey=id=>id.slice(0,-2);
export function verifySequenceEvidence(idx, evidence, historicalRelations){
 assert.equal(idx.format,'PR359_CB_A_SOURCE_INDEX_V1');
 assert.equal(idx.object_count,978);
 assert.equal(idx.legacy_files,700);
 assert.equal(idx.objects.length,978);
 assert.equal(idx.canonical_baseline_approved,false);
 assert.equal(idx.staging_inplace_go,false);
 assert.deepEqual(idx.destructive_allowlist,[]);
 assert.equal(evidence.format,'PR359_CB_A_STAGING_SEQUENCE_OWNERSHIP_CATALOG_V1');
 assert.equal(evidence.project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(evidence.source_pr_head,'9d2d1a135dadfea24bb1c8827b903f9b6814a1f0');
 assert.equal(evidence.capture_mode,'read-only pg_catalog SELECT; no hosted mutation');
 assert.equal(evidence.expected_sequences,154);
 assert.equal(evidence.identity_owned_count,147);
 assert.equal(evidence.non_owned_count,7);
 assert.equal(evidence.approved_app_owned,false);
 assert.equal(evidence.staging_inplace_go,false);
 assert.equal(evidence.production_inplace_go,false);
 assert.equal(historicalRelations.objects.length,337);
 const relationMap=new Map();
 for(const r of historicalRelations.objects){
  const id=r.schema+'.'+r.name;
  assert.ok(!relationMap.has(id),'duplicate relation catalog identity '+id);
  relationMap.set(id,r);
 }
 const inIndex=idx.objects.filter(x=>x.kind==='relation'&&x.id.endsWith('#S'));
 assert.equal(inIndex.length,154,'sequence root count changed');
 const sequenceMap=new Map();
 for(const o of inIndex){
  const name=seqkey(o.id);
  assert.ok(!sequenceMap.has(name),'duplicate sequence root '+name);
  assert.equal(o.approved,false,'unreviewed sequence authorized');
  sequenceMap.set(name,o);
 }
 assert.ok(Array.isArray(evidence.rows)&&evidence.rows.length===154);
 const rows=new Map();
 let generated=0,explicit=0;
 const violations=[];
 for(const row of evidence.rows){
  const name=key(row);
  assert.ok(!rows.has(name),'duplicate live sequence '+name);
  rows.set(name,row);
  const root=sequenceMap.get(name);
  assert.ok(root,'live sequence outside 978-object R4 register: '+name);
  assert.ok(Array.isArray(root.source_candidates));
  assert.ok(root.source_candidates.length===0||root.source_candidates.every(s=>s.statement_kind==='SEQUENCE'));
  if(root.source_candidates.length===0){
   generated++;
   assert.equal(row.ownership_dependency_type,'i','missing CREATE not proven identity: '+name);
   assert.ok(['a','d'].includes(row.owning_column_identity_kind),'identity kind drift: '+name);
   assert.equal(row.pg_get_serial_sequence_result,name,'sequence resolved name drift: '+name);
   const tableName=row.owning_table_schema+'.'+row.owning_table_name;
   const relation=relationMap.get(tableName);
   assert.ok(relation,'identity owner table not in R0 root catalog: '+name);
   assert.ok(['r','p'].includes(relation.kind),'unexpected owner table kind: '+name);
   const col=relation.columns?.find(x=>x.name===row.owning_column_name);
   assert.ok(col,'owned column missing from R0 catalog: '+name);
   assert.equal(col.identity,row.owning_column_identity_kind,
     'identity property differs from historical R0: '+name);
  }else{
   explicit++;
   assert.equal(row.ownership_dependency_type,null,
      'explicit-source sequence unexpectedly has identity owner: '+name);
   assert.equal(row.owning_table_schema,null);
   assert.equal(row.owning_table_name,null);
   assert.equal(row.owning_column_name,null);
   assert.equal(row.pg_get_serial_sequence_result,null);
  }
 }
 assert.equal(rows.size,sequenceMap.size,'missing evidence for sequence root');
 assert.equal(generated,147);
 assert.equal(explicit,7);
 assert.equal(idx.objects.filter(x=>x.source_candidates.length===0).length,158,
   'CB-A original missing source count changed');
 assert.equal(idx.objects.filter(x=>x.source_candidates.length===0&&
  !(x.kind==='relation'&&x.id.endsWith('#S'))).length,11,
  'non-sequence source gap count changed');
 return {
  format:'PR359_CB_A_SEQUENCE_OWNERSHIP_EVIDENCE_RESULT_V1',
  source_head:evidence.source_pr_head,
  catalog_sequences:rows.size,
  implicit_identity_sequences_with_catalog_and_R0_owner_evidence:generated,
  explicit_historical_create_sequences_without_owned_column:explicit,
  non_sequence_missing_static_create:11,
  full_executable_schema_ddl_proven:false,
  final_object_ownership_approved:false,
  remaining_unresolved_object_count:978,
  clean_bootstrap_pass:false,canonical_baseline_approved:false,
  destructive_allowlist:[],staging_inplace_go:false,
  production_inplace_go:false,pr359_merge_go:false
 };
}
const cli=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(cli){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),'Usage: verify-sequence-evidence.mjs [--out file.json]');
 const load=p=>JSON.parse(readFileSync(p,'utf8'));
 const base='docs/security/pr359-cb-a-staging-sequence-ownership-20261123.json';
 const ev=JSON.parse(checkPinnedBytes(readFileSync(base),EXPECTED_EVIDENCE_BLOB));
 checkPinnedBytes(readFileSync('scripts/pr359-canonical/staging-sequence-ownership.sql'),EXPECTED_SQL_BLOB);
 const manifest=load('docs/security/pr359-r4-legacy-migration-provenance-20261123.json');
 validateMigrationProvenance(manifest);
 const index=buildIndex(load('docs/security/pr359-r4-staging-object-register-20261120.json'),
  manifest.files.map(f=>({path:f.path,sha:f.sha,bytes:readFileSync(f.path)})));
 const result=verifySequenceEvidence(index,ev,
  load('docs/security/pr359-r0-staging-relations-20261119.json'));
 if(args.length)writeFileSync(args[1],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}
