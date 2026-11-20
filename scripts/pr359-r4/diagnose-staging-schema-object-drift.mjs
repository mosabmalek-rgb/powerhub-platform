import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Diagnostics only: never authorizes removal, rebaseline or accepting drift.
// Input consists exclusively of catalog object identity and SHA-256, NOT SQL.
const CATEGORIES=new Set(['columns','constraints','functions','indexes','policies','relations','triggers']);
export function parseSchemaObjectDigests(raw){
 assert.equal(typeof raw,'string');
 const out=new Map();
 const lines=raw.split(/\\r?\\n/).filter(Boolean);
 assert.ok(lines.length>0,'schema object evidence is empty');
 for(const line of lines){
  const obj=JSON.parse(line);
  assert.deepEqual(Object.keys(obj).sort(),['category','identity','sha256']);
  assert.ok(CATEGORIES.has(obj.category),'unknown schema category');
  assert.ok(typeof obj.identity==='string'&&obj.identity.length>0,'missing object identity');
  assert.match(obj.sha256,/^[a-f0-9]{64}$/,'invalid object hash');
  const key=JSON.stringify([obj.category,obj.identity]);
  assert.ok(!out.has(key),'duplicate object identity '+key);
  out.set(key,obj);
 }
 return out;
}
export function diagnoseSchemaObjectDrift(sourceText,targetText){
 const source=parseSchemaObjectDigests(sourceText);
 const target=parseSchemaObjectDigests(targetText);
 const categories=[...CATEGORIES].sort();
 const summary=[];
 for(const category of categories){
  const missing=[],extra=[],changed=[];
  for(const [key,item] of source){
   if(item.category!==category)continue;
   const other=target.get(key);
   if(!other)missing.push(item.identity);
   else if(item.sha256!==other.sha256)changed.push(item.identity);
  }
  for(const [key,item] of target){
   if(item.category===category&&!source.has(key))extra.push(item.identity);
  }
  const count=missing.length+extra.length+changed.length;
  if(count)summary.push({category,missing,extra,changed,count});
 }
 return {match:summary.length===0,sourceObjects:source.size,targetObjects:target.size,
  summary,stagingInplaceGo:false,productionInplaceGo:false,canonicalBaselineApproved:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4,'Usage: diagnose-staging-schema-object-drift.mjs source.jsonl target.jsonl');
 const result=diagnoseSchemaObjectDrift(readFileSync(process.argv[2],'utf8'),
                                       readFileSync(process.argv[3],'utf8'));
 console.log('PR359_R4_OBJECT_DIGEST_SOURCE_COUNT='+result.sourceObjects);
 console.log('PR359_R4_OBJECT_DIGEST_TARGET_COUNT='+result.targetObjects);
 console.log('PR359_R4_OBJECT_DIGEST_PARITY='+result.match);
 for(const item of result.summary){
  console.error('PR359_R4_SCHEMA_OBJECT_DRIFT '+JSON.stringify({
   category:item.category,missing:item.missing.length,
   extra:item.extra.length,changed:item.changed.length,
   // Diagnostic only, bounded log. Identities are catalog names/signatures,
   // never function definitions, grants, query text or table contents.
   sampleMissing:item.missing.slice(0,10),
   sampleExtra:item.extra.slice(0,10),
   sampleChanged:item.changed.slice(0,10)
  }));
 }
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 console.log('PR359_PRODUCTION_INPLACE_GO=FALSE');
 if(!result.match)process.exitCode=2;
}
