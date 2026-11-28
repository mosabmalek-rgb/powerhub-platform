import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Archived legacy migrations are immutable historical evidence, not a v2
// baseline or instructions to replay all files on a hosted database.
const manifestPath='docs/security/pr359-r4-legacy-migration-provenance-20261123.json';
const expectedHead='7b59c33b98fb5a6da03858caa51fa71c0f12217c';
const expectedKeys=[
 'all_historical_files_replayable','app_owned_approved','canonical_baseline_approved',
 'destructive_allowlist','duplicate_file_versions','files','files_not_present_in_ledger',
 'format','git_migration_count','migration_epoch_v2_approved',
 'non_14_digit_versions','pr359_merge_go','production_inplace_go',
 'source_repository','source_review_head','staging_inplace_go',
 'staging_ledger_rows','staging_ledger_unique_versions','staging_ledger_versions',
 'project_ref','unmatched_ledger_versions'
].sort();
const sorted=a=>[...a].sort((x,y)=>x<y?-1:x>y?1:0);
function assertEqualSet(a,b,message){
 assert.deepEqual(sorted(a),sorted(b),message);
}
function gitBlobSha(buf){
 return createHash('sha1').update('blob '+buf.length+'\0').update(buf).digest('hex');
}
const versionOf=filepath=>{
 const match=filepath.match(/^supabase\/migrations\/([0-9]+)_[^/]+\.sql$/);
 assert.ok(match,'unrecognized migration filename: '+filepath);
 return match[1];
};
function actualPaths(){
 return readdirSync('supabase/migrations',{withFileTypes:true})
  .filter(x=>x.isFile()&&x.name.endsWith('.sql'))
  .map(x=>'supabase/migrations/'+x.name);
}
export function validateMigrationProvenance(m,paths=actualPaths(),readBytes=p=>readFileSync(p)){
 assert.deepEqual(Object.keys(m).sort(),expectedKeys,'unexpected provenance manifest keys');
 assert.equal(m.format,'PR359_CANONICAL_LEGACY_MIGRATION_PROVENANCE_V1');
 assert.equal(m.project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(m.source_repository,'mosabmalek-rgb/powerhub-platform');
 assert.equal(m.source_review_head,expectedHead);
 for(const key of ['all_historical_files_replayable','canonical_baseline_approved',
   'migration_epoch_v2_approved','app_owned_approved','staging_inplace_go',
   'production_inplace_go','pr359_merge_go'])assert.equal(m[key],false,key);
 assert.deepEqual(m.destructive_allowlist,[]);
 assert.ok(Array.isArray(m.files)&&m.files.length===700,'legacy files count drift');
 assert.equal(m.git_migration_count,m.files.length);
 assert.equal(m.staging_ledger_rows,553);
 assert.equal(m.staging_ledger_unique_versions,553);
 assert.ok(Array.isArray(m.staging_ledger_versions)&&m.staging_ledger_versions.length===553);
 const versions=m.staging_ledger_versions.map(v=>{
  assert.match(v,/^[0-9]+$/,'invalid migration ledger version');return v;
 });
 assert.equal(new Set(versions).size,553,'duplicate or missing Staging ledger version');
 assert.deepEqual(versions,sorted(versions),'ledger versions must be sorted');
 const entries=m.files;
 const actual=sorted(paths);
 assert.equal(new Set(actual).size,actual.length,'duplicate repository file');
 assertEqualSet(entries.map(x=>x.path),actual,'added/removed historical migration SQL');
 const seen=new Set();
 for(const f of entries){
  assert.deepEqual(Object.keys(f).sort(),['bytes','path','sha','version']);
  assert.ok(!seen.has(f.path),'duplicate migration path');seen.add(f.path);
  assert.equal(f.version,versionOf(f.path));
  assert.match(f.sha,/^[0-9a-f]{40}$/,'invalid Git blob SHA1');
  const data=readBytes(f.path);
  assert.ok(Buffer.isBuffer(data),'migration content must be byte buffer');
  assert.equal(data.length,f.bytes,'historical migration size changed: '+f.path);
  assert.equal(gitBlobSha(data),f.sha,'historical migration content changed: '+f.path);
 }
 const sourceVersions=new Set(entries.map(x=>x.version));
 const ledgerSet=new Set(versions);
 const unmatched=versions.filter(x=>!sourceVersions.has(x));
 const unrecorded=entries.filter(x=>!ledgerSet.has(x.version)).map(x=>x.path);
 const invalidDates=entries.filter(x=>!/^.{0}$/.test(x.version) && !/^[0-9]{14}$/.test(x.version)).map(x=>x.path);
 const versionCounts=new Map();
 for(const f of entries)versionCounts.set(f.version,(versionCounts.get(f.version)||0)+1);
 const duplicates=[...versionCounts.entries()]
   .filter(([v,count])=>count>1).map(([version,count])=>({version,count}))
   .sort((a,b)=>a.version<b.version?-1:a.version>b.version?1:0);
 assert.deepEqual(m.unmatched_ledger_versions,unmatched,'source Staging history mismatch');
 assertEqualSet(m.files_not_present_in_ledger,unrecorded,'unrecorded file classification drift');
 assert.deepEqual(m.duplicate_file_versions,duplicates,'duplicate version classification drift');
 assertEqualSet(m.non_14_digit_versions,invalidDates,'legacy version format drift');
 assert.equal(unmatched.length,245);
 assert.equal(unrecorded.length,392);
 assert.equal(duplicates.length,6);
 assert.equal(invalidDates.length,77);
 return {
  format:'PR359_CANONICAL_PROVENANCE_VALIDATED_V1',
  files:700,unique_file_versions:sourceVersions.size,
  staging_ledger_rows:553,staging_versions_matched:553-unmatched.length,
  staging_versions_without_matching_git_sql:unmatched.length,
  git_files_not_recorded_in_staging:unrecorded.length,
  duplicate_file_version_groups:duplicates.length,
  legacy_non_14_digit_version_files:invalidDates.length,
  legacy_history_replayable:false,full_canonical_ddl_proven:false,
  source_of_truth_review_signed:false,
  baseline_approved:false,epoch_v2_approved:false,
  staging_inplace_go:false,production_inplace_go:false,pr_merge_go:false
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2,'No SQL or hosted connection permitted');
 const m=JSON.parse(readFileSync(manifestPath,'utf8'));
 console.log(JSON.stringify(validateMigrationProvenance(m)));
}
