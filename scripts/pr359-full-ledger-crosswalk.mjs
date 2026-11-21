import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = x => createHash('sha256').update(x).digest('hex');
const assert = (ok,msg) => { if (!ok) throw new Error(msg); };
const canonical = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const hex64 = /^[a-f0-9]{64}$/;
const rowKey = r => r.version + ':' + r.name;
export function validateSnapshot(s) {
 assert(s?.schemaVersion === 1 && /^[a-f0-9]{40}$/.test(s.sourceBaselineCommit || ''),'Invalid baseline snapshot');
 assert(s.shadowUpgrade === 'NOT_TESTED' && /^NO_GO_/.test(s.releaseDecision || ''),'Snapshot is not an approval');
 for (const env of ['staging','production']) {
   const e=s.environments?.[env];
   assert(e && Array.isArray(e.rows) && e.rows.length===e.count,'Ledger count mismatch '+env);
   assert(e.rows.filter(r=>r.retained_sql_sha256===null).length===e.unavailable,'Missing-payload count drift '+env);
   const versions=new Set();
   for (const r of e.rows) {
     assert(/^\d{14}$/.test(r.version) && /^[a-z0-9_]+$/.test(r.name),'Malformed ledger row '+env);
     assert(r.retained_sql_sha256===null || hex64.test(r.retained_sql_sha256),'Invalid history SHA '+env);
     assert(!versions.has(r.version),'Duplicate ledger version '+env);versions.add(r.version);
   }
 }
 return s;
}
export function classifyFile(src,rows,localVersionCount=1) {
 assert(canonical.test(src.filename) && hex64.test(src.sha256),'Invalid SQL source metadata');
 assert(Array.isArray(rows),'No migration ledger');
 if (localVersionCount!==1) return {status:'SOURCE_VERSION_COLLISION',releasable:false};
 const [v,n]=src.filename.slice(0,-4).split(/_(.*)/s).filter((x,i)=>i<2);
 const byV=rows.filter(r=>r.version===v),byN=rows.filter(r=>r.name===n);
 let result;
 if(byV.length>1)result={status:'LEDGER_VERSION_DUPLICATE'};
 else if(byV.length===1){
   if(byV[0].name!==n)result={status:'VERSION_NAME_CONFLICT',matchedVersion:byV[0].version};
   else if(byV[0].retained_sql_sha256===null)result={status:'UNPROVEN_STORED_SQL'};
   else if(byV[0].retained_sql_sha256===src.sha256)result={status:'EXACT_SQL_HISTORY_MATCH'};
   else result={status:'DIVERGENT_STORED_SQL'};
 } else if(byN.length>1)result={status:'MULTIPLE_HISTORIC_VERSIONS',matches:byN.map(x=>x.version)};
 else if(byN.length===1)result={status:'SAME_NAME_DIFFERENT_VERSION',matchedVersion:byN[0].version,retainedSqlSha256:byN[0].retained_sql_sha256};
 else result={status:'NO_DIRECT_LEDGER_MATCH'};
 return {...result,releasable:false};
}
export function buildCrosswalk(snapshot,{repositoryRoot=process.cwd()}={}) {
 validateSnapshot(snapshot);
 const dirname=path.join(repositoryRoot,'supabase','migrations');
 const files=readdirSync(dirname).filter(f=>f.endsWith('.sql')).sort();
 const verCounts=new Map();
 for(const f of files){const m=canonical.exec(f);if(m)verCounts.set(m[1],1+(verCounts.get(m[1])||0));}
 const totals={staging:{},production:{}},records=[];
 for (const filename of files){
   const fullPath=path.join(dirname,filename), stat=lstatSync(fullPath);
   assert(stat.isFile()&&!stat.isSymbolicLink(),'Not a regular migration SQL file: '+filename);
   const m=canonical.exec(filename);
   const r={sourcePath:'supabase/migrations/'+filename,sourceSha256:hash(readFileSync(fullPath)),format:m?'CANONICAL_14_DIGIT':'LEGACY_NONCANONICAL',environments:{}};
   if(m){r.version=m[1];r.name=m[2];}
   for(const env of ['staging','production']){
     const result=m?classifyFile({filename,sha256:r.sourceSha256},snapshot.environments[env].rows,verCounts.get(m[1]))
       :{status:'NONCANONICAL_SOURCE',releasable:false};
     r.environments[env]=result;totals[env][result.status]=(totals[env][result.status]||0)+1;
   }
   records.push(r);
 }
 assert(records.every(r=>Object.values(r.environments).every(v=>v.releasable===false)),'Audit must not authorize automatic replay');
 return {baselineCommit:snapshot.sourceBaselineCommit,sourceFileCount:records.length,
  canonicalFileCount:records.filter(x=>x.format==='CANONICAL_14_DIGIT').length,
  noncanonicalFileCount:records.filter(x=>x.format==='LEGACY_NONCANONICAL').length,
  totals,releaseDecision:'NO_GO_AUDIT_ONLY_NOT_UPGRADE_AUTHORIZATION',
  warning:'Identity presence, and even exact historical SQL payload, does not prove postconditions or Production Shadow upgrade.',
  records};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);const index=args.indexOf('--out');
 const snapshot=JSON.parse(readFileSync('docs/security/pr359-phase1-live-ledger-snapshot-20261117.json','utf8'));
 const report=buildCrosswalk(snapshot);
 console.log('PR359 FULL SOURCE / LIVE LEDGER AUDIT (NO-GO):',JSON.stringify({files:report.sourceFileCount,canonical:report.canonicalFileCount,legacy:report.noncanonicalFileCount,totals:report.totals}));
 if(index>=0){assert(args[index+1],'--out needs path');writeFileSync(args[index+1],JSON.stringify(report,null,2)+'\n');}
 if(args.includes('--require-phase1-pass'))throw new Error('NO_GO: historical equivalence and Production-derived Shadow upgrade not proved');
}
