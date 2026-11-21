import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Actual Staging history read-only attestation from 2026-11-20.
// Drift requires a fresh review, never an automatic history overwrite.
export const STAGING_LEDGER_REFERENCE=Object.freeze({
 row_count:553,
 min_version:'20260905170000',
 max_version:'20261116231000',
 whole_row_sha256:'52b3006440effe431299a2a58b2150c18acd02ab78ffc79ffcb13075538bb613'
});
export function verifyStagingLedger(x){
 assert.ok(x && typeof x==='object' && !Array.isArray(x));
 const errors=[];
 for(const [k,value] of Object.entries(STAGING_LEDGER_REFERENCE))
   if(x[k]!==value)errors.push('STAGING_LEDGER_DRIFT:'+k);
 for(const k of Object.keys(x))
   if(!Object.hasOwn(STAGING_LEDGER_REFERENCE,k))errors.push('UNEXPECTED_LEDGER_FIELD');
 return {verified:errors.length===0,errors,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,3,'Usage: check-staging-legacy-ledger.mjs attestation.json');
 const result=verifyStagingLedger(JSON.parse(readFileSync(process.argv[2],'utf8')));
 for(const err of result.errors)console.error('PR359_STAGING_BLOCKER='+err);
 console.log('PR359_STAGING_HISTORICAL_LEDGER_MATCH='+result.verified);
 console.log('PR359_R4_STAGING_INPLACE_GO=false');
 if(!result.verified)process.exitCode=2;
}
