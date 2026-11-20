import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const REFERENCE_PATH='docs/security/pr359-r0-staging-policies-triggers-20261119.json';
const sha256=/^[0-9a-f]{64}$/;
const APP_TOTAL={POLICY:129,TRIGGER:202};
const ACTUAL_SQL=String.raw`SELECT 'TRIGGER'::text category,n.nspname::text schema,
  c.relname||'.'||t.tgname identity,
  encode(extensions.digest(pg_get_triggerdef(t.oid,true),'sha256'),'hex') def_sha,
  t.tgenabled::text enabled,t.tgfoid::regprocedure::text fn,
  NULL::text using_sha,NULL::text check_sha,NULL::jsonb roles,
  NULL::text cmd,NULL::boolean permissive
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname='public'
UNION ALL
SELECT 'POLICY',n.nspname,c.relname||'.'||p.polname,
  NULL,NULL,NULL,
  encode(extensions.digest(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'sha256'),'hex'),
  encode(extensions.digest(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'sha256'),'hex'),
  (SELECT coalesce(jsonb_agg(pg_get_userbyid(r) ORDER BY pg_get_userbyid(r)),'[]'::jsonb)
   FROM unnest(p.polroles) r),
  p.polcmd::text,p.polpermissive
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'`;

function normalized(o){
  assert.ok(o&&['POLICY','TRIGGER'].includes(o.category));
  assert.equal(o.schema,'public','only app public policies/triggers are in scope');
  assert.ok(typeof o.identity==='string'&&o.identity.includes('.'));
  assert.equal(o.classification,'APP_OWNED_CANDIDATE');
  assert.equal(o.classification_reviewed,false);
  if(o.category==='TRIGGER'){
    assert.ok(sha256.test(o.details?.definition_sha256||''));
    assert.ok(typeof o.details?.function==='string');
    assert.ok(typeof o.details?.enabled==='string');
    return {category:'TRIGGER',schema:'public',identity:o.identity,
      def_sha:o.details.definition_sha256,enabled:o.details.enabled,
      fn:o.details.function};
  }
  assert.ok(sha256.test(o.details?.using_sha256||''));
  assert.ok(sha256.test(o.details?.check_sha256||''));
  assert.ok(Array.isArray(o.details?.roles)&&o.details.roles.every(r=>typeof r==='string'));
  assert.ok(typeof o.details.command==='string');
  assert.equal(typeof o.details.permissive,'boolean');
  return {category:'POLICY',schema:'public',identity:o.identity,
    using_sha:o.details.using_sha256,check_sha:o.details.check_sha256,
    roles:[...o.details.roles].sort(),cmd:o.details.command,
    permissive:o.details.permissive};
}

export function buildSurfacePlan(snapshot) {
  assert.equal(snapshot?.format,'R0 policies and triggers inventory v1');
  assert.equal(snapshot.project_ref,'iyuryuhaylhisjfcrwkz');
  assert.ok(Array.isArray(snapshot.objects));
  const app=snapshot.objects.filter(o=>o.schema==='public').map(normalized);
  const seen=new Set();
  for(const x of app){
    const key=x.category+':'+x.identity;
    assert.ok(!seen.has(key),'duplicate source identity');
    seen.add(key);
  }
  for(const [kind,total] of Object.entries(APP_TOTAL))
    assert.equal(app.filter(x=>x.category===kind).length,total,'incomplete source '+kind);
  // Verify the R0 managed objects are not accidentally added to app scope.
  assert.equal(snapshot.objects.filter(o=>o.schema!=='public').length,19);
  assert.equal(snapshot.objects.length,350);
  const plan=[];
  for(let offset=0;offset<app.length;offset+=75){
    const rows=app.slice(offset,offset+75),n=offset/75+1,pages=Math.ceil(app.length/75);
    const sql=makeSurfaceBatch(rows,n,pages);
    const number=String(n).padStart(2,'0');
    plan.push({
      number:n,filename:'surface-'+number+'.sql',
      resultFilename:'surface-'+number+'.result.json',
      expected:rows.length,totalBatches:pages,sql
    });
  }
  return plan;
}

export function makeSurfaceBatch(rows,n,pages) {
  assert.ok(Array.isArray(rows)&&rows.length>0&&rows.length<=75);
  assert.ok(Number.isInteger(n)&&Number.isInteger(pages)&&n>=1&&n<=pages);
  const payload=JSON.stringify(rows).replaceAll("'","''");
  return [
    '-- R4 Staging read-only application policy/trigger SHA parity only.',
    '-- This is NOT a change, a provider-managed allowlist or a DROP authorization.',
    "WITH expected AS(SELECT * FROM jsonb_to_recordset('"+payload+"'::jsonb)",
    ' AS e(category text,schema text,identity text,def_sha text,enabled text,fn text,',
    ' using_sha text,check_sha text,roles jsonb,cmd text,permissive boolean)),',
    'actual AS('+ACTUAL_SQL+'),',
    'cmp AS(SELECT e.identity, a.identity IS NULL AS missing,',
    " CASE WHEN e.category='TRIGGER' THEN",
    ' (e.def_sha IS DISTINCT FROM a.def_sha OR e.enabled IS DISTINCT FROM a.enabled',
    ' OR e.fn IS DISTINCT FROM a.fn)',
    ' ELSE (e.using_sha IS DISTINCT FROM a.using_sha OR',
    ' e.check_sha IS DISTINCT FROM a.check_sha OR e.roles IS DISTINCT FROM a.roles',
    ' OR e.cmd IS DISTINCT FROM a.cmd OR e.permissive IS DISTINCT FROM a.permissive)',
    ' END AS changed FROM expected e LEFT JOIN actual a USING(category,schema,identity))',
    "SELECT jsonb_build_object('kind','rls_trigger','batch',"+n+",'total_batches',"+pages+",",
    " 'expected_batch',(SELECT count(*) FROM expected),",
    " 'actual_total',(SELECT count(*) FROM actual),",
    " 'missing',(SELECT count(*) FROM cmp WHERE missing),",
    " 'changed',(SELECT count(*) FROM cmp WHERE NOT missing AND changed),",
    " 'sample',(SELECT coalesce(jsonb_agg(identity),'[]'::jsonb)",
    " FROM (SELECT identity FROM cmp WHERE missing OR changed ORDER BY identity LIMIT 5)x)",
    ')::text AS pr359_r4_surface_attestation;'
  ].join('\n')+'\n';
}

export function assessSurfaceReports(plan,reports){
  const blockers=[];
  if(!Array.isArray(plan)||!Array.isArray(reports)||plan.length!==5||reports.length!==plan.length)
    blockers.push('INCOMPLETE_SURFACE_REPORTS');
  const seen=new Set(),byNumber=new Map();
  for(const r of reports||[]){
    if(!r || r.kind!=='rls_trigger' || !Number.isInteger(r.batch)){
      blockers.push('INVALID_SURFACE_REPORT');continue;
    }
    if(seen.has(r.batch)) blockers.push('DUPLICATE_SURFACE_REPORT:'+r.batch);
    seen.add(r.batch);byNumber.set(r.batch,r);
  }
  let total=0;
  for(const p of plan||[]){
    const r=byNumber.get(p.number);
    if(!r){blockers.push('MISSING_SURFACE_REPORT:'+p.number);continue;}
    total+=r.expected_batch;
    if(r.total_batches!==p.totalBatches||r.expected_batch!==p.expected||r.actual_total!==331)
      blockers.push('SURFACE_COUNT_OR_BATCH_DRIFT:'+p.number);
    if(r.missing!==0||r.changed!==0||!Array.isArray(r.sample)||r.sample.length!==0)
      blockers.push('SURFACE_SECURITY_DRIFT:'+p.number);
  }
  if(total!==331)blockers.push('SURFACE_COVERAGE_DRIFT');
  return {validated:blockers.length===0,blockers,appPolicyCount:129,appTriggerCount:202,
    providerManagedStillExcluded:true,stagingInplaceGo:false,dropAuthorized:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [mode,output]=process.argv.slice(2);
  assert.ok(output&&['--emit-sql','--check-results'].includes(mode),
    'Usage: rls-trigger-parity.mjs --emit-sql DIR | --check-results DIR');
  const inventory=JSON.parse(readFileSync(REFERENCE_PATH,'utf8'));
  const plan=buildSurfacePlan(inventory);
  if(mode==='--emit-sql'){
    mkdirSync(output,{recursive:true,mode:0o700});
    for(const item of plan)writeFileSync(path.join(output,item.filename),item.sql,{mode:0o600,flag:'wx'});
    console.log('PR359_R4_RLS_TRIGGER_READ_ONLY_BATCHES='+plan.length);
  }else{
    const reports=plan.map(item=>JSON.parse(readFileSync(path.join(output,item.resultFilename),'utf8')));
    const result=assessSurfaceReports(plan,reports);
    console.log('PR359_R4_RLS_TRIGGER_PARITY='+result.validated);
    for(const item of result.blockers)console.error('PR359_R4_SURFACE_BLOCKER='+item);
    if(!result.validated)process.exitCode=2;
  }
  console.log('PR359_R4_STAGING_INPLACE_GO=false');
}
