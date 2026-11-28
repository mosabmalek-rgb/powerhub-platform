import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const EXPECTED_FIELDS=new Set(['columns','functions','relations']);
const keys=['category','field','identity','sha256'];
export function parseAttributeDigests(raw){
 assert.equal(typeof raw,'string');
 const lines=raw.split(/\r?\n/).filter(Boolean);
 assert.ok(lines.length>0,'attribute evidence is empty');
 const out=new Map();
 for(const line of lines){
   const v=JSON.parse(line);
   assert.deepEqual(Object.keys(v).sort(),keys);
   assert.ok(EXPECTED_FIELDS.has(v.category),'unreviewed catalog category');
   assert.ok(typeof v.identity==='string'&&v.identity.length>0,'invalid identity');
   assert.ok(typeof v.field==='string'&&v.field.length>0,'invalid field');
   assert.match(v.sha256,/^[a-f0-9]{64}$/);
   const key=JSON.stringify([v.category,v.identity,v.field]);
   assert.ok(!out.has(key),'duplicate catalog attribute');
   out.set(key,v);
 }
 return out;
}
export function compareSchemaAttributes(sourceRaw,targetRaw){
 const source=parseAttributeDigests(sourceRaw);
 const target=parseAttributeDigests(targetRaw);
 const summary=[];
 const keysAll=new Set([...source.keys(),...target.keys()]);
 const group=new Map();
 for(const key of keysAll){
   const src=source.get(key),dst=target.get(key),v=src||dst;
   const groupKey=v.category+'/'+v.field;
   const g=group.get(groupKey)||{category:v.category,field:v.field,
     missing:[],extra:[],changed:[]};
   if(!dst)g.missing.push(v.identity);
   else if(!src)g.extra.push(v.identity);
   else if(src.sha256!==dst.sha256)g.changed.push(v.identity);
   group.set(groupKey,g);
 }
 for(const g of group.values()){
   if(g.missing.length||g.extra.length||g.changed.length){
     for(const k of ['missing','extra','changed'])g[k].sort();
     summary.push(g);
   }
 }
 summary.sort((a,b)=>a.category.localeCompare(b.category)||a.field.localeCompare(b.field));
 return {match:summary.length===0,sourceCount:source.size,targetCount:target.size,
   summary,appOwnedApproved:false,stagingInplaceGo:false,productionInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4,'Usage: diagnose-staging-schema-attribute-drift.mjs source.jsonl target.jsonl');
 const result=compareSchemaAttributes(readFileSync(process.argv[2],'utf8'),readFileSync(process.argv[3],'utf8'));
 console.log('PR359_R4_ATTRIBUTE_SOURCE_COUNT='+result.sourceCount);
 console.log('PR359_R4_ATTRIBUTE_TARGET_COUNT='+result.targetCount);
 console.log('PR359_R4_ATTRIBUTE_PARITY='+result.match);
 for(const g of result.summary){
   console.error('PR359_R4_SCHEMA_ATTRIBUTE_DRIFT '+JSON.stringify({
     category:g.category,field:g.field,
     missing:g.missing.length,extra:g.extra.length,changed:g.changed.length,
     sampleMissing:g.missing.slice(0,4),sampleExtra:g.extra.slice(0,4),
     sampleChanged:g.changed.slice(0,4)
   }));
 }
 console.log('PR359_APP_OWNED_APPROVED=FALSE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!result.match)process.exitCode=2;
}
