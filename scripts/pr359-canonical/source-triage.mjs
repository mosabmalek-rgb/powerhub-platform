import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {validateMigrationProvenance} from '../pr359-r4/verify-legacy-migration-provenance.mjs';
import {checkPinnedSnapshot,assessRootDependencies} from '../pr359-r4/verify-root-dependency-digests.mjs';
import {verifyLiveOwnershipCatalog} from '../pr359-r4/verify-live-ownership-catalog.mjs';
import {buildIndex} from './source-index.mjs';

// Triage of known evidence only. This does not declare any canonical ownership.
const HEX=/^[a-f0-9]{64}$/;
const count=rows=>Object.fromEntries([...new Set(rows)].sort().map(x=>[x,rows.filter(y=>x===y).length]));
const keyed=(rows,key)=>{
 const m=new Map();
 for(const row of rows){
  assert.ok(typeof row[key]==='string'&&row[key].length,'missing '+key);
  assert.ok(!m.has(row[key]),'duplicate '+key+': '+row[key]);
  m.set(row[key],row);
 }
 return m;
};
const priority=o=>o.kind==='relation'?'P2_RELATION_DDL_AND_IDENTITY':
 (o.schema==='public'&&o.security_definer)?'P0_PUBLIC_SECURITY_DEFINER':
 (o.security_definer||o.authenticated_execute)?'P1_PRIVILEGED_OR_CALLABLE_FUNCTION':'P3_OTHER_FUNCTION';
const deficiency=(o,n)=>{
 if(n>1)return 'MULTIPLE_HISTORICAL_CREATE_CANDIDATES';
 if(n===1)return 'SINGLE_HISTORICAL_CREATE_CANDIDATE';
 if(o.kind==='function')return 'FUNCTION_WITHOUT_STATIC_CREATE';
 if(o.id.endsWith('#S'))return 'SEQUENCE_WITHOUT_STATIC_CREATE';
 return 'RELATION_WITHOUT_STATIC_CREATE';
};
export function triageSourceIndex(idx,reg,live,deps){
 assert.equal(idx.format,'PR359_CB_A_SOURCE_INDEX_V1');
 assert.equal(idx.object_count,978);
 assert.equal(idx.legacy_files,700);
 assert.equal(idx.unresolved_review_count,978);
 assert.equal(idx.app_owned_approved,false);
 assert.equal(idx.canonical_baseline_approved,false);
 assert.deepEqual(idx.destructive_allowlist,[]);
 assert.equal(idx.staging_inplace_go,false);
 assert.equal(reg.objects.length,978);
 assert.equal(reg.decision.app_owned_signed,false);
 assert.deepEqual(reg.decision.destructive_allowlist,[]);
 assert.equal(live.objects.length,978);
 assert.equal(deps.entries.length,978);
 assert.equal(deps.application_ownership_approved,false);
 const rg=keyed(reg.objects,'id'),lv=keyed(live.objects,'id'),dp=keyed(deps.entries,'identity'),ix=keyed(idx.objects,'id');
 assert.equal(rg.size,978);assert.equal(lv.size,978);assert.equal(dp.size,978);assert.equal(ix.size,978);
 const items=[];
 for(const [id,obj] of rg){
  const row=ix.get(id),l=lv.get(id),d=dp.get(id);
  assert.ok(row&&l&&d,'root missing from crosswalk: '+id);
  assert.equal(row.kind,obj.kind,'kind drift: '+id);
  assert.equal(l.kind,obj.kind,'live catalog kind drift: '+id);
  assert.equal(d.kind,obj.kind,'dependency kind drift: '+id);
  assert.equal(obj.reviewed,false,'unexpected object review: '+id);
  assert.equal(obj.classification,'APP_OWNED_CANDIDATE','unexpected ownership: '+id);
  assert.equal(l.acl_sha256,obj.acl_sha256,'ACL catalog drift: '+id);
  assert.match(l.acl_sha256,HEX);
  assert.match(d.incoming_sha256,HEX);assert.match(d.outgoing_sha256,HEX);
  assert.ok(Number.isSafeInteger(d.incoming_edges)&&d.incoming_edges>=0);
  assert.ok(Number.isSafeInteger(d.outgoing_edges)&&d.outgoing_edges>=0);
  assert.ok(Array.isArray(row.source_candidates));
  assert.equal(row.approved,false,'unapproved source candidate promoted: '+id);
  if(obj.kind==='function'){
    assert.equal(l.definition_sha256,obj.definition_sha256,'function DDL digest mismatch: '+id);
    assert.equal(l.security_definer,obj.security_definer,'SECURITY DEFINER drift: '+id);
  } else {
    assert.equal(obj.definition_sha256,null,'historical complete relation DDL falsified: '+id);
    assert.equal(l.catalog_structure_not_full_ddl,true,'catalog hash misrepresented as executable DDL: '+id);
    assert.match(l.catalog_structure_sha256,HEX);
  }
  const origins=row.source_candidates.map(c=>{
   assert.match(c.source_path,/^supabase\/migrations\/[a-zA-Z0-9_-]+\.sql$/);
   assert.match(c.source_blob_sha,/^[a-f0-9]{40}$/);
   assert.ok(Number.isSafeInteger(c.offset)&&c.offset>=0);
   return {path:c.source_path,git_blob_sha:c.source_blob_sha,offset:c.offset,
    statement_kind:c.statement_kind,match_basis:c.match_basis};
  });
  const level=priority(obj), issue=deficiency(obj,origins.length);
  items.push({identity:id,kind:obj.kind,priority:level,source_issue:issue,
   exact_sql_candidates:origins,source_count:origins.length,
   catalog_definition_sha256:obj.kind==='function'?obj.definition_sha256:null,
   relation_catalog_structure_sha256:obj.kind==='relation'?l.catalog_structure_sha256:null,
   current_acl_sha256:obj.acl_sha256,
   security_definer:obj.kind==='function'?obj.security_definer:null,
   anon_execute:obj.kind==='function'?obj.anon_execute:null,
   authenticated_execute:obj.kind==='function'?obj.authenticated_execute:null,
   incoming_pg_depend_edges:d.incoming_edges,outgoing_pg_depend_edges:d.outgoing_edges,
   incoming_dependency_digest:d.incoming_sha256,outgoing_dependency_digest:d.outgoing_sha256,
   caveat:'Static SQL names and pg_depend digests cannot prove current source, full dynamic dependencies, or final ownership',
   final_ddl_reviewed:false,overloads_or_generated_identity_reviewed:false,
   caller_reviewed:false,managed_dependency_reviewed:false,app_owned_approved:false});
 }
 assert.equal(items.length,978);
 for(const id of [...lv.keys(),...dp.keys(),...ix.keys()])
  assert.ok(rg.has(id),'unregistered object in source evidence: '+id);
 items.sort((a,b)=>a.priority.localeCompare(b.priority)||a.identity.localeCompare(b.identity,'en'));
 const issues=count(items.map(x=>x.source_issue));
 const priorities=count(items.map(x=>x.priority));
 return {format:'PR359_CB_A_SOURCE_EVIDENCE_TRIAGE_V1',
  provenance:'R4 historical manifest, live catalog, root dependencies and CB-A static candidate scan',
  review_head:'UNSIGNED',
  objects_total:978,functions_total:items.filter(x=>x.kind==='function').length,
  relations_total:items.filter(x=>x.kind==='relation').length,
  sources_matched:items.filter(x=>x.source_count>0).length,
  sources_missing:items.filter(x=>x.source_count===0).length,
  sources_ambiguous:items.filter(x=>x.source_count>1).length,
  source_issue_counts:issues,priority_counts:priorities,
  all_objects_review_required:true,object_approvals:0,
  security_definer_signoff_required:true,
  provider_and_dynamic_sql_review_required:true,
  executable_canonical_sql_approved:false,
  clean_supabase_bootstrap_proven:false,app_owned_approved:false,
  migration_epoch_v2_approved:false,destructive_allowlist:[],
  staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false,
  objects:items};
}
const cli=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(cli){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),
   'Usage: node source-triage.mjs [--out output.json]');
 const read=p=>readFileSync(p,'utf8'),load=p=>JSON.parse(read(p));
 const manifest=load('docs/security/pr359-r4-legacy-migration-provenance-20261123.json');
 validateMigrationProvenance(manifest);
 const reg=load('docs/security/pr359-r4-staging-object-register-20261120.json');
 const functions=load('docs/security/pr359-r0-staging-functions-20261119.json');
 const relations=load('docs/security/pr359-r0-staging-relations-20261119.json');
 const live=load('docs/security/pr359-r4-staging-live-ownership-fingerprints-20261123.json');
 const deps=checkPinnedSnapshot(read('docs/security/pr359-r4-staging-root-dependency-digests-20261123.json'));
 verifyLiveOwnershipCatalog(live,reg,functions,relations);
 assessRootDependencies(deps,reg,functions,relations);
 const index=buildIndex(reg,manifest.files.map(f=>({path:f.path,sha:f.sha,bytes:readFileSync(f.path)})));
 const triage=triageSourceIndex(index,reg,live,deps);
 assert.equal(triage.functions_total,641);
 assert.equal(triage.relations_total,337);
 assert.deepEqual(triage.priority_counts,{
  P0_PUBLIC_SECURITY_DEFINER:296,
  P1_PRIVILEGED_OR_CALLABLE_FUNCTION:62,
  P2_RELATION_DDL_AND_IDENTITY:337,
  P3_OTHER_FUNCTION:283
 });
 assert.equal(triage.sources_matched,820,'source candidate distribution drift: review index before adjusting');
 assert.equal(triage.sources_missing,158,'unmatched candidates changed: review source before adjusting');
 if(args.length)writeFileSync(args[1],JSON.stringify(triage,null,2)+'\n');
 console.log(JSON.stringify({format:triage.format,objects:triage.objects_total,
   sources_matched:triage.sources_matched,sources_missing:triage.sources_missing,
   sources_ambiguous:triage.sources_ambiguous,source_issue_counts:triage.source_issue_counts,
   priority_counts:triage.priority_counts,approvals:triage.object_approvals,
   staging_inplace_go:triage.staging_inplace_go}));
}
