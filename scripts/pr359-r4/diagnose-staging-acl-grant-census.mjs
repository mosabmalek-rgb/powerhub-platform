import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Explanatory evidence only. This census NEVER authorizes a drift or changes
// the stricter seven-category semantic-security reviewer.
const categories=['functions','relations'];
const schemas=['public','private','powerhub_private'];
const principals=['PUBLIC','postgres','anon','authenticated','service_role','OTHER'];
export function parseAclCensus(raw){
 assert.equal(typeof raw,'string');
 const lines=raw.trim().split(String.fromCharCode(10)).map(s=>s.trim()).filter(Boolean);
 assert.ok(lines.length>0&&lines.length<=600,'invalid bounded ACL census');
 const m=new Map();
 for(const line of lines){
  const r=JSON.parse(line);
  assert.deepEqual(Object.keys(r).sort(),['category','grantable','grantee','grantor','objects','privilege','schema']);
  assert.ok(categories.includes(r.category),'unexpected ACL category');
  assert.ok(schemas.includes(r.schema),'unexpected ACL namespace');
  assert.ok(principals.includes(r.grantor),'unexpected grantor label');
  assert.ok(principals.includes(r.grantee),'unexpected grantee label');
  assert.match(r.privilege,/^[A-Z_]{3,24}$/,'invalid ACL privilege');
  assert.equal(typeof r.grantable,'boolean');
  assert.ok(Number.isSafeInteger(r.objects)&&r.objects>0,'invalid object count');
  const key=JSON.stringify([r.category,r.schema,r.grantor,r.grantee,r.privilege,r.grantable]);
  assert.ok(!m.has(key),'duplicate ACL census group');
  m.set(key,r);
 }
 return m;
}
export function compareAclCensus(a,b){
 const src=parseAclCensus(a),dst=parseAclCensus(b);
 const deviations=[];
 for(const key of new Set([...src.keys(),...dst.keys()])){
  const s=src.get(key),t=dst.get(key),v=s||t;
  if((s?.objects||0)!==(t?.objects||0)){
   deviations.push({category:v.category,schema:v.schema,grantor:v.grantor,
    grantee:v.grantee,privilege:v.privilege,grantable:v.grantable,
    source:s?.objects||0,target:t?.objects||0});
  }
 }
 deviations.sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
 return {match:deviations.length===0,deviations,stagingInplaceGo:false,mergeGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv[2],'--compare','Usage: --compare source.jsonl restored.jsonl');
 assert.equal(process.argv.length,5);
 const result=compareAclCensus(readFileSync(process.argv[3],'utf8'),readFileSync(process.argv[4],'utf8'));
 console.log('PR359_R4_ACL_GRANT_CENSUS_PARITY='+result.match);
 console.log('PR359_R4_ACL_GRANT_CENSUS_GROUP_DIFFS='+result.deviations.length);
 for(const v of result.deviations.slice(0,24))console.error('PR359_R4_ACL_GRANT_COUNT_DELTA '+JSON.stringify(v));
 console.log('PR359_R4_ACL_GRANT_CENSUS_DIAGNOSTIC_ONLY=true');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!result.match)process.exitCode=2;
}
