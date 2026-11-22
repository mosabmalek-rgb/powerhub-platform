import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const categories=['column_acl','default_acl','schema'];
const counts={column_acl:0,default_acl:4,schema:3};
export function parseBoundary(raw){
 assert.equal(typeof raw,'string');
 const lines=raw.trim().split(String.fromCharCode(10)).map(x=>x.trim()).filter(Boolean);
 assert.equal(lines.length,3,'incomplete privilege evidence');
 const records=new Map();
 for(const line of lines){
  const row=JSON.parse(line);
  assert.deepEqual(Object.keys(row).sort(),['category','objects','sha256']);
  assert.ok(categories.includes(row.category),'unreviewed privilege category');
  assert.ok(Number.isSafeInteger(row.objects)&&row.objects>=0,'invalid count');
  assert.match(row.sha256,/^[a-f0-9]{64}$/);
  assert.ok(!records.has(row.category),'duplicate category');
  records.set(row.category,row);
 }
 assert.deepEqual([...records.keys()].sort(),categories);
 return records;
}
export function verifySource(raw){
 const records=parseBoundary(raw);
 for(const category of categories)
  assert.equal(records.get(category).objects,counts[category],
    'unreviewed source privilege inventory '+category);
 return {pass:true};
}
export function compareBoundary(source,target){
 const a=parseBoundary(source),b=parseBoundary(target);
 const drift=categories.filter(cat=>a.get(cat).objects!==b.get(cat).objects||
   a.get(cat).sha256!==b.get(cat).sha256);
 return {pass:drift.length===0,drift,stagingInplaceGo:false,mergeGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,first,second]=process.argv.slice(2);
 if(mode==='--verify-source'){
  assert.ok(first&&!second);
  verifySource(readFileSync(first,'utf8'));
  console.log('PR359_REVIEWED_SOURCE_PRIVILEGE_INVENTORY_PASS');
 }else if(mode==='--compare'){
  assert.ok(first&&second);
  const outcome=compareBoundary(readFileSync(first,'utf8'),readFileSync(second,'utf8'));
  for(const category of outcome.drift)console.error('PR359_PRIVILEGE_DRIFT='+category);
  if(!outcome.pass){console.error('PR359_PRIVILEGE_BOUNDARY_MISMATCH_BLOCKED');process.exitCode=2;}
  else console.log('PR359_PRIVILEGE_BOUNDARY_PARITY_PASS');
 }else throw Error('Usage: --verify-source source | --compare source target');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 console.log('PR359_MERGE_GO=FALSE');
}
