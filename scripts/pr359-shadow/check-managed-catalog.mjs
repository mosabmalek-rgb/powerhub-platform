import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const ident = /^[a-z_][a-z0-9_]*$/;
const managedSchemas = ['auth','storage','realtime'];
function validate(rows,origin) {
  assert.ok(Array.isArray(rows)&&rows.length>0,origin+': empty/malformed managed catalog');
  const map=new Map();
  for(const r of rows) {
    assert.ok(r&&ident.test(r.schema||'')&&ident.test(r.table||'')&&ident.test(r.column||''),
      origin+': unexpected identifier');
    assert.ok(managedSchemas.includes(r.schema),origin+': unexpected schema');
    assert.ok(typeof r.type==='string'&&r.type.length>0&&r.type.length<256,origin+': invalid data type');
    const key=r.schema+'.'+r.table+'.'+r.column;
    assert.ok(!map.has(key),origin+': duplicate column '+key);
    map.set(key,r.type);
  }
  return map;
}
const tablesOf = (catalog) => new Set([...catalog.keys()].map(k=>k.slice(0,k.lastIndexOf('.'))));
const byManagedSchema = (keys) => Object.fromEntries(managedSchemas.map(schema=>[
  schema,keys.filter(k=>k.startsWith(schema+'.')).length
]));

export function checkManagedCatalog(source,target) {
  const a=validate(source,'source'),b=validate(target,'Docker');
  const missing=[],unexpected=[],typeMismatch=[];
  for(const [key,typ] of a){
    if(!b.has(key))missing.push(key);
    else if(b.get(key)!==typ)typeMismatch.push({column:key,source:typ,docker:b.get(key)});
  }
  // Detect extra local columns too. A one-way check used to admit a local
  // provider schema that contained all source names PLUS incompatible extras.
  for(const key of b.keys())if(!a.has(key))unexpected.push(key);
  const sourceTables=tablesOf(a),dockerTables=tablesOf(b);
  const missingTables=[...sourceTables].filter(key=>!dockerTables.has(key)).sort();
  const unexpectedTables=[...dockerTables].filter(key=>!sourceTables.has(key)).sort();
  missing.sort();
  unexpected.sort();
  typeMismatch.sort((x,y)=>x.column.localeCompare(y.column));
  return {
    sourceColumns:a.size,dockerColumns:b.size,
    sourceTables:sourceTables.size,dockerTables:dockerTables.size,
    missing,unexpected,missingTables,unexpectedTables,typeMismatch,
    missingBySchema:byManagedSchema(missing),
    unexpectedBySchema:byManagedSchema(unexpected),
    compatible:missing.length===0&&unexpected.length===0&&typeMismatch.length===0
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  assert.equal(process.argv.length,4,'Usage: check-managed-catalog.mjs source.json shadow.json');
  const result=checkManagedCatalog(
    JSON.parse(readFileSync(process.argv[2],'utf8').trim()),
    JSON.parse(readFileSync(process.argv[3],'utf8').trim())
  );
  if(!result.compatible) {
    console.error('PR359_SHADOW_MANAGED_SCHEMA_DRIFT: sourceCols='+result.sourceColumns+
      ' dockerCols='+result.dockerColumns+' missing='+result.missing.length+
      ' unexpected='+result.unexpected.length+
      ' incompatibleTypes='+result.typeMismatch.length+
      ' missingTables='+result.missingTables.length+
      ' unexpectedTables='+result.unexpectedTables.length);
    for(const schema of managedSchemas){
      if(result.missingBySchema[schema])
        console.error('PR359_MANAGED_MISSING_SCHEMA_COLUMNS: '+schema+'='+result.missingBySchema[schema]);
      if(result.unexpectedBySchema[schema])
        console.error('PR359_MANAGED_UNEXPECTED_SCHEMA_COLUMNS: '+schema+'='+result.unexpectedBySchema[schema]);
    }
    // Only metadata identifiers; never print source table rows, SQL, or secrets.
    for(const name of result.missingTables.slice(0,25))console.error('PR359_MISSING_MANAGED_TABLE: '+name);
    for(const name of result.unexpectedTables.slice(0,25))console.error('PR359_UNEXPECTED_MANAGED_TABLE: '+name);
    for(const name of result.missing.slice(0,25))console.error('PR359_MISSING_MANAGED_COLUMN: '+name);
    for(const name of result.unexpected.slice(0,25))console.error('PR359_UNEXPECTED_MANAGED_COLUMN: '+name);
    for(const row of result.typeMismatch.slice(0,25))
      console.error('PR359_MANAGED_COLUMN_TYPE_DRIFT: '+JSON.stringify(row));
    process.exitCode=2;
  } else {
    console.log('PR359_SHADOW_MANAGED_COLUMN_PRECHECK_PASS: '+result.sourceColumns+' exact column names and types');
  }
}
