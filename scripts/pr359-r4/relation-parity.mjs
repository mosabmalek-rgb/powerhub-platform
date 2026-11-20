import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// R4 diagnostic only. No hosted connection details and no writes.
export const SOURCE='docs/security/pr359-r0-staging-relations-20261119.json';
export const EXPECTED_RELATIONS=337;
export const EXPECTED_COLUMNS=2723;
const hex=/^[a-f0-9]{64}$/;
const GROUPS=Object.freeze({'private.r':10,'private.S':2,'public.r':173,'public.S':152});
const ACTUAL_SQL=String.raw`SELECT
 n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,
 pg_get_userbyid(c.relowner) AS owner,
 c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
 coalesce((SELECT ext.extname FROM pg_depend d JOIN pg_extension ext ON ext.oid=d.refobjid
   WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
     AND d.refclassid='pg_extension'::regclass AND d.deptype='e' LIMIT 1),'') AS extension_name,
 encode(extensions.digest(coalesce(c.relacl::text,''),'sha256'),'hex') AS acl_sha256,
 CASE WHEN c.relkind IN ('r','p','v','m')
   THEN has_table_privilege('anon',c.oid,'SELECT') ELSE NULL END AS anon_select,
 CASE WHEN c.relkind IN ('r','p','v','m')
   THEN has_table_privilege('authenticated',c.oid,'SELECT') ELSE NULL END AS auth_select,
 (SELECT coalesce(jsonb_agg(jsonb_build_object(
   'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'identity',a.attidentity::text,'nullable',NOT a.attnotnull,
   'generated',a.attgenerated::text,
   'default_sha256',CASE WHEN ad.adbin IS NULL THEN NULL ELSE
      encode(extensions.digest(pg_get_expr(ad.adbin,ad.adrelid),'sha256'),'hex') END
 ) ORDER BY a.attnum),'[]'::jsonb)
 FROM pg_attribute a LEFT JOIN pg_attrdef ad
  ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
 WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','powerhub_private')
AND c.relkind IN ('r','p','v','m','S')`;

export function auditedRows(source) {
  assert.equal(source?.format,'R0 relations inventory v1');
  assert.equal(source.project_ref,'iyuryuhaylhisjfcrwkz');
  assert.ok(Array.isArray(source.objects));
  assert.equal(source.objects.length,EXPECTED_RELATIONS);
  const groupCounts={},ids=new Set();
  let columnCount=0;
  const rows=source.objects.map(o=>{
    assert.ok(['private','public'].includes(o.schema),'unknown app schema');
    assert.ok(['r','S'].includes(o.kind),'unexpected relation kind');
    assert.ok(typeof o.name==='string'&&o.name.length>0);
    const id=o.schema+'.'+o.name;
    assert.ok(!ids.has(id),'duplicate relation');
    ids.add(id);
    groupCounts[o.schema+'.'+o.kind]=(groupCounts[o.schema+'.'+o.kind]||0)+1;
    assert.equal(o.owner,'postgres');
    assert.equal(o.extension_name,'','extension-owned object not in release scope');
    assert.equal(o.classification,'APP_OWNED_CANDIDATE');
    assert.equal(o.classification_reviewed,false);
    assert.equal(typeof o.rls,'boolean');
    assert.equal(typeof o.force_rls,'boolean');
    assert.ok(hex.test(o.acl_sha256||''));
    assert.ok(Array.isArray(o.columns)&&o.columns.length>0);
    const names=new Set();
    for(const c of o.columns) {
      assert.ok(typeof c.name==='string'&&c.name.length>0);
      assert.ok(!names.has(c.name),'duplicate attribute');
      names.add(c.name);
      assert.ok(typeof c.type==='string'&&c.type.length>0);
      assert.equal(typeof c.nullable,'boolean');
      assert.ok(['','a','d'].includes(c.identity));
      assert.ok(['','s','v'].includes(c.generated));
      assert.ok(c.default_sha256===null||hex.test(c.default_sha256));
    }
    columnCount+=o.columns.length;
    if(o.kind==='S'){
      assert.equal(o.anon_select,null);
      assert.equal(o.auth_select,null);
    }else{
      assert.equal(typeof o.anon_select,'boolean');
      assert.equal(typeof o.auth_select,'boolean');
    }
    // Keep exact column array order. Array order is critical for DDL parity.
    return {
      schema:o.schema,name:o.name,kind:o.kind,owner:o.owner,
      rls:o.rls,force_rls:o.force_rls,extension_name:o.extension_name,
      acl_sha256:o.acl_sha256,anon_select:o.anon_select,
      auth_select:o.auth_select,columns:o.columns
    };
  });
  assert.deepEqual(groupCounts,GROUPS);
  assert.equal(columnCount,EXPECTED_COLUMNS);
  return rows;
}

export function makeRelationsQuery(rows,index,pages) {
  assert.ok(Array.isArray(rows)&&rows.length>=1&&rows.length<=25);
  assert.ok(Number.isInteger(index)&&Number.isInteger(pages)&&index>=1&&index<=pages);
  for(const o of rows) assert.ok(['public','private'].includes(o.schema));
  const json=JSON.stringify(rows).replaceAll("'","''");
  const sql=[
    '-- PR359 R4: read-only historical Staging relation/column/ACL parity.',
    '-- Diagnostic only; no mutation, no permission to drop application objects.',
    "WITH expected AS (SELECT * FROM jsonb_to_recordset('"+json+"'::jsonb)",
    ' AS e(schema text,name text,kind text,owner text,rls boolean,force_rls boolean,',
    ' extension_name text,acl_sha256 text,anon_select boolean,auth_select boolean,columns jsonb)),',
    'actual AS ('+ACTUAL_SQL+'),',
    'comparison AS (SELECT e.schema,e.name,a.name IS NULL AS missing,',
    ' to_jsonb(e) IS DISTINCT FROM to_jsonb(a) AS changed',
    ' FROM expected e LEFT JOIN actual a USING(schema,name))',
    "SELECT jsonb_build_object('scope','PR359_R4_RELATIONS_READ_ONLY_V1',",
    " 'batch',"+index+",'batches',"+pages+",",
    " 'expected',(SELECT count(*) FROM expected),",
    " 'actual_total',(SELECT count(*) FROM actual),",
    " 'missing',(SELECT count(*) FROM comparison WHERE missing),",
    " 'changed',(SELECT count(*) FROM comparison WHERE NOT missing AND changed),",
    " 'samples',(SELECT coalesce(jsonb_agg(schema||'.'||name),'[]'::jsonb)",
    "   FROM (SELECT schema,name FROM comparison WHERE missing OR changed",
    "   ORDER BY schema,name LIMIT 5)x))::text AS pr359_r4_relation_attestation;"
  ].join('\n')+'\n';
  return sql;
}

export function buildRelationsPlan(source) {
  const rows=auditedRows(source);
  const pages=Math.ceil(rows.length/25);
  return Array.from({length:pages},(_,i)=>{
    const batch=i+1,chunk=rows.slice(i*25,(i+1)*25);
    const pad=String(batch).padStart(2,'0');
    return {batch,batches:pages,expected:chunk.length,
      filename:'relations-'+pad+'.sql',
      reportFilename:'relations-'+pad+'.result.json',
      sql:makeRelationsQuery(chunk,batch,pages)};
  });
}

export function assessRelationsReports(plan,reports) {
  const blockers=[];
  if(!Array.isArray(plan)||plan.length!==14 || !Array.isArray(reports)||reports.length!==14)
    blockers.push('INCOMPLETE_RELATION_ATTESTATION');
  const byBatch=new Map();
  for(const r of reports||[]){
    if(r?.scope!=='PR359_R4_RELATIONS_READ_ONLY_V1'||!Number.isInteger(r.batch)){
      blockers.push('BAD_RELATION_REPORT');continue;
    }
    if(byBatch.has(r.batch)) blockers.push('DUPLICATE_BATCH:'+r.batch);
    byBatch.set(r.batch,r);
  }
  let covered=0;
  for(const item of plan||[]) {
    const r=byBatch.get(item.batch);
    if(!r){blockers.push('MISSING_BATCH:'+item.batch);continue;}
    covered+=r.expected;
    if(r.batches!==item.batches||r.expected!==item.expected||
       r.actual_total!==EXPECTED_RELATIONS)
      blockers.push('RELATION_COUNT_DRIFT:'+item.batch);
    if(r.missing!==0||r.changed!==0||!Array.isArray(r.samples)||r.samples.length!==0)
      blockers.push('RELATION_DEFINITION_OR_ACL_DRIFT:'+item.batch);
  }
  if(covered!==EXPECTED_RELATIONS)blockers.push('INCOMPLETE_RELATION_COVERAGE');
  return {
    verified:blockers.length===0,blockers,relationCount:covered,
    sourceColumnCount:EXPECTED_COLUMNS,
    atomicStagingSnapshot:false,appOwnedSigned:false,
    stagingInplaceGo:false,dropAuthorized:false
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [mode,dir]=process.argv.slice(2);
  assert.ok(dir&&['--emit-sql','--check-results'].includes(mode),
    'Usage: relation-parity.mjs --emit-sql DIR | --check-results DIR');
  const plan=buildRelationsPlan(JSON.parse(readFileSync(SOURCE,'utf8')));
  if(mode==='--emit-sql'){
    mkdirSync(dir,{recursive:true,mode:0o700});
    for(const p of plan)writeFileSync(path.join(dir,p.filename),p.sql,{mode:0o600,flag:'wx'});
    console.log('PR359_R4_RELATION_SQL_BATCHES='+plan.length);
  }else{
    const reports=plan.map(p=>JSON.parse(readFileSync(path.join(dir,p.reportFilename),'utf8')));
    const result=assessRelationsReports(plan,reports);
    console.log('PR359_R4_RELATION_METADATA_PARITY='+result.verified);
    for(const err of result.blockers)console.error('PR359_R4_RELATION_BLOCKER='+err);
    if(!result.verified)process.exitCode=2;
  }
  console.log('PR359_R4_STAGING_INPLACE_GO=false');
}
