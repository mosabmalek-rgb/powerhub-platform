import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {validateMigrationProvenance} from './verify-legacy-migration-provenance.mjs';
const file='docs/security/pr359-r4-legacy-migration-provenance-20261123.json';
const snapshot=()=>JSON.parse(readFileSync(file,'utf8'));
const paths=()=>readdirSync('supabase/migrations').filter(x=>x.endsWith('.sql')).map(x=>'supabase/migrations/'+x);
test('every one of 700 archived SQL blobs matches and legacy history remains non-replayable',()=>{
 const v=validateMigrationProvenance(snapshot());
 assert.equal(v.files,700);
 assert.equal(v.staging_ledger_rows,553);
 assert.equal(v.staging_versions_matched,308);
 assert.equal(v.staging_versions_without_matching_git_sql,245);
 assert.equal(v.git_files_not_recorded_in_staging,392);
 assert.equal(v.duplicate_file_version_groups,6);
 assert.equal(v.legacy_non_14_digit_version_files,77);
 assert.equal(v.legacy_history_replayable,false);
 assert.equal(v.baseline_approved,false);
 assert.equal(v.pr_merge_go,false);
});
test('tampered or missing Git SQL and newly added historical migration are rejected',()=>{
 const a=snapshot();a.files[0].sha='0'.repeat(40);
 assert.throws(()=>validateMigrationProvenance(a),/content changed/);
 const b=snapshot();b.files[0].bytes++;
 assert.throws(()=>validateMigrationProvenance(b),/size changed/);
 const c=snapshot();c.files.pop();
 assert.throws(()=>validateMigrationProvenance(c),/files count drift|added\/removed/);
 const d=snapshot();assert.throws(()=>validateMigrationProvenance(d,[...paths(),'supabase/migrations/9999_unapproved.sql']),/added\/removed/);
});
test('cannot silently rewrite migration history, approval flags or mismatch accounting',()=>{
 const cases=[
  a=>a.staging_ledger_versions[0]='20280101000000',
  a=>a.unmatched_ledger_versions.pop(),
  a=>a.files_not_present_in_ledger.pop(),
  a=>a.duplicate_file_versions=[],
  a=>a.non_14_digit_versions=[],
  a=>a.canonical_baseline_approved=true,
  a=>a.migration_epoch_v2_approved=true,
  a=>a.app_owned_approved=true,
  a=>a.destructive_allowlist=['public.users'],
  a=>a.staging_inplace_go=true,
  a=>a.all_historical_files_replayable=true,
  a=>a.source_review_head='unreviewed'
 ];
 for(const modify of cases){
  const x=snapshot();modify(x);
  assert.throws(()=>validateMigrationProvenance(x));
 }
});
