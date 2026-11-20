import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const expectedTotals=Object.freeze({functions:641,catalog:2125});
const hex=/^[a-f0-9]{64}$/;
const sourcePaths={
 functions:'docs/security/pr359-r0-staging-functions-20261119.json',
 catalog:'docs/security/pr359-r0-staging-indexes-constraints-20261119.json'
};

const functionActual="SELECT\n  CASE WHEN n.nspname='public'\n    THEN regexp_replace(p.oid::regprocedure::text,'^public\\.', '')\n    ELSE CASE WHEN left(p.oid::regprocedure::text,length(n.nspname)+1)=n.nspname||'.'\n      THEN p.oid::regprocedure::text\n      ELSE n.nspname||'.'||p.oid::regprocedure::text END\n  END AS identity,\n  encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') AS sha\nFROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace\nWHERE n.nspname IN ('public','private','powerhub_private') AND p.prokind='f'";
const catalogActual="SELECT 'INDEX'::text AS category,n.nspname::text AS schema,\n  t.relname||'.'||idx.relname AS identity,\n  encode(extensions.digest(pg_get_indexdef(i.indexrelid),'sha256'),'hex') AS sha\nFROM pg_index i\nJOIN pg_class t ON t.oid=i.indrelid\nJOIN pg_class idx ON idx.oid=i.indexrelid\nJOIN pg_namespace n ON n.oid=t.relnamespace\nWHERE n.nspname IN ('public','private','powerhub_private')\nUNION ALL\nSELECT 'CONSTRAINT'::text,n.nspname::text,t.relname||'.'||c.conname,\n encode(extensions.digest(pg_get_constraintdef(c.oid,true),'sha256'),'hex')\nFROM pg_constraint c\nJOIN pg_class t ON t.oid=c.conrelid\nJOIN pg_namespace n ON n.oid=t.relnamespace\nWHERE n.nspname IN ('public','private','powerhub_private')";


function checkedObjects(kind,inventory){
  if(kind==='functions'){
    assert.equal(inventory?.format,'R0 functions inventory v1');
    assert.equal(inventory.project_ref,'iyuryuhaylhisjfcrwkz');
  }else{
    assert.equal(inventory?.format,'R0 indexes and constraints inventory v1');
    assert.equal(inventory.project_ref,'iyuryuhaylhisjfcrwkz');
  }
  assert.ok(Array.isArray(inventory.objects));
  const seen=new Set();
  const rows=inventory.objects.map(x=>{
    const row=kind==='functions'
      ? {identity:x.signature,sha:x.definition_sha256}
      : {category:x.category,schema:x.schema,identity:x.identity,sha:x.details?.definition_sha256};
    if(kind==='catalog') {
      assert.ok(['INDEX','CONSTRAINT'].includes(row.category));
      assert.ok(['public','private','powerhub_private'].includes(row.schema));
    }
    assert.ok(typeof row.identity==='string'&&row.identity.length>1);
    assert.ok(hex.test(row.sha||''));
    const key=kind==='functions'?row.identity:row.category+':'+row.schema+':'+row.identity;
    assert.ok(!seen.has(key),'duplicate catalog identity: '+key);
    seen.add(key);
    return row;
  });
  assert.equal(rows.length,expectedTotals[kind]);
  return rows;
}

export function makeReadOnlyBatch(kind,expected,batchIndex,totalBatches){
  assert.ok(['functions','catalog'].includes(kind));
  assert.ok(Array.isArray(expected)&&expected.length>0&&expected.length<=150);
  assert.ok(Number.isInteger(batchIndex)&&batchIndex>=1);
  assert.ok(Number.isInteger(totalBatches)&&batchIndex<=totalBatches);
  const json=JSON.stringify(expected).replaceAll("'","''");
  const descriptor=kind==='functions'
    ? "identity text, sha text"
    : "category text, schema text, identity text, sha text";
  const keys=kind==='functions'
    ? "e.identity=a.identity"
    : "e.category=a.category AND e.schema=a.schema AND e.identity=a.identity";
  const hasMissing=kind==='functions'?"a.identity IS NULL":"a.identity IS NULL";
  const actual=kind==='functions'?functionActual:catalogActual;
  const statement=[
    '-- PR359 R4: read-only digest comparison for historical Staging catalog.',
    '-- No DDL/DML, no secrets, no business rows. Each file is one SQL statement.',
    'WITH expected AS (SELECT * FROM jsonb_to_recordset(\''+json+'\'::jsonb) AS e('+descriptor+')),',
    'actual AS ('+actual+'),',
    'cmp AS (SELECT e.identity,'+hasMissing+' AS missing,',
    '       e.sha IS DISTINCT FROM a.sha AS changed FROM expected e LEFT JOIN actual a ON '+keys+')',
    "SELECT jsonb_build_object(",
    " 'kind','"+kind+"','batch',"+batchIndex+",'total_batches',"+totalBatches+",",
    " 'expected_batch',(SELECT count(*) FROM expected),",
    " 'actual_total',(SELECT count(*) FROM actual),",
    " 'missing',(SELECT count(*) FROM cmp WHERE missing),",
    " 'changed',(SELECT count(*) FROM cmp WHERE NOT missing AND changed),",
    " 'sample',(SELECT coalesce(jsonb_agg(identity),'[]'::jsonb)",
    "           FROM (SELECT identity FROM cmp WHERE missing OR changed ORDER BY identity LIMIT 5) x)",
    ")::text AS pr359_r4_attestation;"
  ].join('\n')+'\n';
  return statement;
}

export function buildReadOnlyBatchPlan(fnInventory,idxInventory) {
  const inputs={
    functions:checkedObjects('functions',fnInventory),
    catalog:checkedObjects('catalog',idxInventory)
  };
  const plan=[];
  for(const kind of ['functions','catalog']){
    const rows=inputs[kind];
    const size=kind==='functions'?100:150;
    const pages=Math.ceil(rows.length/size);
    for(let i=0;i<pages;i++){
      const number=String(i+1).padStart(2,'0');
      plan.push({
        kind,batch:i+1,total_batches:pages,
        expected_count:rows.slice(i*size,(i+1)*size).length,
        filename:kind+'-'+number+'.sql',
        resultFilename:kind+'-'+number+'.result.json',
        sql:makeReadOnlyBatch(kind,rows.slice(i*size,(i+1)*size),i+1,pages)
      });
    }
  }
  return plan;
}

export function assessBatchReports(plan,reports){
  const blockers=[];
  if(!Array.isArray(plan)||!Array.isArray(reports)||reports.length!==plan.length)
    blockers.push('INCOMPLETE_REPORT_COLLECTION');
  const byKey=new Map();
  if(Array.isArray(reports))for(const r of reports){
    const key=String(r?.kind)+':'+String(r?.batch);
    if(byKey.has(key))blockers.push('DUPLICATE_REPORT:'+key);
    byKey.set(key,r);
  }
  const totals={functions:0,catalog:0};
  for(const item of plan||[]){
    const report=byKey.get(item.kind+':'+item.batch);
    if(!report){blockers.push('MISSING_REPORT:'+item.filename);continue;}
    if(report.total_batches!==item.total_batches||
       report.expected_batch!==item.expected_count||
       report.actual_total!==expectedTotals[item.kind])
      blockers.push('COUNT_OR_BATCH_DRIFT:'+item.filename);
    if(report.missing!==0||report.changed!==0||
       !Array.isArray(report.sample)||report.sample.length!==0)
      blockers.push('DDL_PARITY_MISMATCH:'+item.filename);
    totals[item.kind]+=report.expected_batch;
  }
  for(const kind of ['functions','catalog'])if(totals[kind]!==expectedTotals[kind])
    blockers.push('INCOMPLETE_COVERAGE:'+kind);
  return {
    metadataParityPassed:blockers.length===0,
    blockers,
    totals,
    // Multi-statement, read-only results are NOT an atomic snapshot or
    // sufficient authorization for removal, baseline rebuild, or merge.
    stagingInplaceGo:false,
    dropAuthorized:false
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [command,output]=process.argv.slice(2);
  assert.ok(output&&['--emit-sql','--check-results'].includes(command),
    'Usage: live-ddl-parity.mjs --emit-sql DIR | --check-results DIR');
  const fn=JSON.parse(readFileSync(sourcePaths.functions,'utf8'));
  const indexes=JSON.parse(readFileSync(sourcePaths.catalog,'utf8'));
  const plan=buildReadOnlyBatchPlan(fn,indexes);
  if(command==='--emit-sql'){
    mkdirSync(output,{recursive:true,mode:0o700});
    for(const item of plan)writeFileSync(path.join(output,item.filename),item.sql,{mode:0o600,flag:'wx'});
    console.log('PR359_R4_READ_ONLY_SQL_BATCHES='+plan.length);
    console.log('PR359_R4_STAGING_INPLACE_GO=false');
  }else{
    const reports=plan.map(item=>
      JSON.parse(readFileSync(path.join(output,item.resultFilename),'utf8')));
    const result=assessBatchReports(plan,reports);
    console.log('PR359_R4_HASH_PARITY='+result.metadataParityPassed);
    console.log('PR359_R4_STAGING_INPLACE_GO=false');
    for(const msg of result.blockers)console.error('PR359_R4_PARITY_BLOCKER='+msg);
    if(!result.metadataParityPassed)process.exitCode=2;
  }
}
