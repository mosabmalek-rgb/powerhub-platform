import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const ident = /^[a-z_][a-z0-9_]*$/;
function validate(rows,origin) {
  assert.ok(Array.isArray(rows)&&rows.length>0,origin+': empty/malformed managed catalog');
  const map=new Map();
  for(const r of rows) {
    assert.ok(r&&ident.test(r.schema||'')&&ident.test(r.table||'')&&ident.test(r.column||''),
      origin+': unexpected identifier');
    assert.ok(['auth','storage','realtime'].includes(r.schema),origin+': unexpected schema');
    assert.ok(typeof r.type==='string'&&r.type.length>0&&r.type.length<256,origin+': invalid data type');
    const key=r.schema+'.'+r.table+'.'+r.column;
    assert.ok(!map.has(key),origin+': duplicate column '+key);
    map.set(key,r.type);
  }
  return map;
}
export function checkManagedCatalog(source,target) {
  const a=validate(source,'source'),b=validate(target,'Docker');
  const missing=[],typeMismatch=[];
  for(const [key,typ] of a){
    if(!b.has(key))missing.push(key);
    else if(b.get(key)!==typ)typeMismatch.push({column:key,source:typ,docker:b.get(key)});
  }
  missing.sort();
  typeMismatch.sort((x,y)=>x.column.localeCompare(y.column));
  return {sourceColumns:a.size,dockerColumns:b.size,missing,typeMismatch,
    compatible:missing.length===0&&typeMismatch.length===0};
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
      ' incompatibleTypes='+result.typeMismatch.length);
    for(const name of result.missing.slice(0,35))console.error('PR359_MISSING_MANAGED_COLUMN: '+name);
    for(const row of result.typeMismatch.slice(0,25))
      console.error('PR359_MANAGED_COLUMN_TYPE_DRIFT: '+JSON.stringify(row));
    process.exitCode=2;
  } else {
    console.log('PR359_SHADOW_MANAGED_SCHEMA_PRECHECK_PASS: '+result.sourceColumns+' source columns covered');
  }
}
