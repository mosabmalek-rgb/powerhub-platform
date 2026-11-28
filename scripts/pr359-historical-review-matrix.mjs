import {readFileSync,lstatSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const verify=(v,reason)=>{if(!v)throw new Error(reason)};
const hex64=/^[0-9a-f]{64}$/;
const sourcePath=/^supabase\/migrations\/[0-9]+_[a-zA-Z0-9_]+\.sql$/;
const sha256=x=>createHash('sha256').update(x).digest('hex');
const detectPriority=status=>{
 if(/DRIFT|AMBIGUOUS|RLS_REQUIRED|FORWARD_CORRECTION|FORWARD_CORRECTIONS/.test(status))return 'P0';
 return 'P1';
};

export function buildReviewMatrix(crosswalk,live,{repositoryRoot=process.cwd()}={}){
 verify(Array.isArray(crosswalk?.records),'Historical crosswalk records required');
 verify(crosswalk.records.length===28,'Expected 28 reviewed crosswalk groups; re-baseline under review');
 verify(live?.schemaVersion===1 && live?.environments?.staging && live?.environments?.production,
  'Missing source-pinned live ledger snapshot');
 const observed={},groups=[],sourceSeen=new Set();
 for(const env of ['staging','production']){
   const source=live.environments[env];
   verify(Array.isArray(source.rows),'Missing ledger rows in '+env);
   observed[env]=new Map();
   for(const row of source.rows){
     verify(!observed[env].has(row.version),'Duplicate recorded version '+env+': '+row.version);
     observed[env].set(row.version,row);
   }
 }
 const groupNames=new Set();
 for(const record of crosswalk.records){
  verify(record && /^[a-z0-9_]+$/.test(record.name),'Invalid review group name');
  verify(!groupNames.has(record.name),'Duplicate group name');
  groupNames.add(record.name);
  verify(Array.isArray(record.source_files) && record.source_files.length>0,'Missing source files: '+record.name);
  const checkedSources=[];
  for(const src of record.source_files){
   verify(sourcePath.test(src.path),'Noncanonical/unsafe source path: '+src.path);
   verify(!sourceSeen.has(src.path),'Source referenced by multiple review groups');
   sourceSeen.add(src.path);
   const localPath=path.join(repositoryRoot,src.path);
   const stat=lstatSync(localPath);
   verify(stat.isFile()&&!stat.isSymbolicLink(),'Source must be regular non-symlink SQL: '+src.path);
   const currentHash=sha256(readFileSync(localPath));
   verify(hex64.test(src.sha256) && currentHash===src.sha256,
    'Historical source hash has changed; fresh SQL review required: '+src.path);
   checkedSources.push({path:src.path,sourceSha256:currentHash,version:src.version});
  }
  const historical={};
  for(const env of ['staging','production']){
    const rows=record[env+'_rows']||[];
    verify(Array.isArray(rows),'Invalid historical rows: '+record.name+' '+env);
    historical[env]=[];
    for(const prior of rows){
      const found=observed[env].get(prior.version);
      verify(found, 'Archived historical row missing: '+record.name+' '+env+'/'+prior.version);
      verify(hex64.test(prior.stored_sql_sha256) &&
        found.retained_sql_sha256===prior.stored_sql_sha256,
        'Archived SQL hash no longer matches pinned live ledger: '+record.name+' '+env+'/'+prior.version);
      historical[env].push({version:prior.version,liveName:found.name,sqlSha256:found.retained_sql_sha256});
    }
  }
  const current=record.live_object_reconciliation?.status ||
     record.schema_postconditions?.staging?.result || 'NOT_REVIEWED';
  const priority=detectPriority(current);
  const status={
    sourceContractStatus:current,
    historicalExecutionProof:'NOT_ACCEPTED_FOR_RELEASE',
    currentCatalogProof:'PARTIAL_OR_SCOPED',
    stageVersionCount:historical.staging.length,
    productionVersionCount:historical.production.length,
    directReplayAllowed:false,
    priority
  };
  // Historical version-name alignment cannot be promoted from scoped catalog findings.
  groups.push({name:record.name,status,sources:checkedSources,history:historical,
    reviewerAction:priority==='P0'
      ? 'Resolve material source/current contract drift or ambiguity with current DB catalog and behavioral proof'
      : 'Collect environment-specific catalog/ACL/RLS/behavior attestations and Shadow upgrade provenance'});
 }
 const counts={P0:groups.filter(g=>g.status.priority==='P0').length,
               P1:groups.filter(g=>g.status.priority==='P1').length};
 verify(counts.P0+counts.P1===28,'Case matrix must enumerate every group');
 return {schemaVersion:1,scope:'28 manually reviewed historical mismatch groups, separate from 82+3 missing SQL payloads and 700-file inventory',
   sourceCrosswalkDate:crosswalk.evidence_refresh_date ?? 'unknown',
   pinnedLiveSnapshotCommit:live.sourceBaselineCommit,
   groupsCount:groups.length,distinctSources:sourceSeen.size,priorities:counts,
   releaseDecision:'NO_GO_UNPROVEN_HISTORY_AND_UNTESTED_PRODUCTION_SHADOW',
   shadowUpgrade:'NOT_TESTED',groups};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const crosswalk=JSON.parse(readFileSync('docs/security/pr359-migration-history-crosswalk-20261108.json','utf8'));
 const live=JSON.parse(readFileSync('docs/security/pr359-phase1-live-ledger-snapshot-20261117.json','utf8'));
 const result=buildReviewMatrix(crosswalk,live);
 const args=process.argv.slice(2),index=args.indexOf('--out');
 if(index>=0){
   verify(args[index+1], 'Missing report path');
   writeFileSync(args[index+1],JSON.stringify(result,null,2)+'\n');
 }
 console.log('PR359 historical version-mismatch evidence groups:',result.groupsCount,
 'sources:',result.distinctSources,'P0:',result.priorities.P0,
 'P1:',result.priorities.P1,'release:',result.releaseDecision);
 if(args.includes('--require-accepted'))throw Error('NO_GO: complete historical/Shadow attestation not available');
}
