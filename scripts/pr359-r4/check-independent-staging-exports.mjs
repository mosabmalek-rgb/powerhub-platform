import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// All these attestations were computed under separate MVCC source snapshots.
// Byte-level equality rejects any source drift between independent exports.
// pg_dump SQL may differ in harmless randomly generated restriction comments;
// each SQL file must still have a valid manifest and independently restored
// source-vs-target content, schema, FK, managed-row and history signatures.
export const INDEPENDENT_SOURCE_EVIDENCE_FILES=Object.freeze([
 'source-counts',
 'staging-realtime-messages-source',
 'source-history-attestation.json',
 'staging-tables-source.jsonl',
 'staging-content-source.jsonl',
 'staging-managed-source.jsonl',
 'staging-source-object-acl-replay.sql',
 'staging-schema-source.jsonl',
 'staging-schema-semantic-source.jsonl',
 'staging-schema-semantic-attributes-source.jsonl',
 'staging-acl-grant-census-source.jsonl',
 'staging-privilege-boundary-source.jsonl',
 'staging-schema-object-source.jsonl',
 'staging-schema-attribute-source.jsonl',
 'staging-ownership-source.json',
 'staging-managed-policy-source.json',
 'staging-managed-policy-replay.sql',
 'staging-managed-reverse-source.json',
 'staging-managed-fks-source.jsonl',
 'staging-managed-fk-orphans-source.jsonl',
 'staging-all-fks-source.jsonl',
 'staging-managed-catalog-snapshot.json',
 'staging-managed-migrations-snapshot.json',
 'staging-managed-relations-snapshot.json',
 'source-managed-catalog.json',
 'source-managed-migrations.json',
 'source-managed-relations.json'
]);
const SQL_NAMES=Object.freeze(['roles.sql','schema.sql','data.sql','history-schema.sql','history-data.sql']);
const sha256=/^[0-9a-f]{64}$/;
export function assessIndependentStagingExports(first,second) {
 assert.equal(typeof first,'string');
 assert.equal(typeof second,'string');
 assert.notEqual(resolve(first),resolve(second),'independent export directories must differ');
 const snapshotDigest=directory=>{
   const value=readFileSync(join(directory,'staging-snapshot-token.sha256'),'utf8').trim();
   assert.match(value,sha256,'invalid exported source snapshot digest');
   return value;
 };
 const a=snapshotDigest(first),b=snapshotDigest(second);
 assert.notEqual(a,b,'two exports reused the same source snapshot');
 for(const file of INDEPENDENT_SOURCE_EVIDENCE_FILES){
   const firstValue=readFileSync(join(first,file));
   const secondValue=readFileSync(join(second,file));
   assert.ok(firstValue.length>0,'empty source evidence: '+file);
   assert.ok(firstValue.equals(secondValue),'independent source drift: '+file);
 }
 for(const name of SQL_NAMES){
   assert.ok(statSync(join(first,'dump',name)).size>0,'missing first SQL '+name);
   assert.ok(statSync(join(second,'dump',name)).size>0,'missing second SQL '+name);
 }
 const rolesA=readFileSync(join(first,'dump','roles.sql'));
 const rolesB=readFileSync(join(second,'dump','roles.sql'));
 assert.ok(rolesA.equals(rolesB),'global role metadata drift across exports');
 return {independentSourceSnapshots:true,matchingSourceEvidence:true,
   independentLogicalExports:2,stagingInplaceGo:false,productionInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4,'Usage: check-independent-staging-exports.mjs source-one source-two');
 const result=assessIndependentStagingExports(process.argv[2],process.argv[3]);
 console.log('PR359_STAGING_DISTINCT_SOURCE_SNAPSHOTS='+result.independentSourceSnapshots);
 console.log('PR359_STAGING_TWO_SOURCE_EXPORTS_CONTENT_MATCH='+result.matchingSourceEvidence);
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 console.log('PR359_PRODUCTION_INPLACE_GO=FALSE');
}
