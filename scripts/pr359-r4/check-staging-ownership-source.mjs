import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessR4OwnershipBoundary} from './ownership-boundary.mjs';

// The caller imports ownership-boundary.sql into an exported READ ONLY snapshot.
// No project ID or capture mode is accepted from DB output; source identity is
// validated independently by the Staging-only connection guard.
export function assessCapturedSourceOwnership(raw) {
 assert.equal(typeof raw,'string','ownership evidence must be text');
 const lines=raw.trim().split(/\r?\n/);
 assert.equal(lines.length,1,'expected exactly one ownership catalog JSON row');
 const metadata=JSON.parse(lines[0]);
 const result=assessR4OwnershipBoundary({
   project_ref:'iyuryuhaylhisjfcrwkz',
   capture_mode:'single-statement-read-only',
   metadata
 });
 return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,3,'Usage: check-staging-ownership-source.mjs source.json');
 const result=assessCapturedSourceOwnership(readFileSync(process.argv[2],'utf8'));
 console.log('PR359_STAGING_OWNERSHIP_INVENTORY_MATCH='+result.inventoryMatches);
 console.log('PR359_STAGING_OWNERSHIP_CANDIDATE_COUNT='+result.provisionalObjectCount);
 console.log('PR359_R4_APP_OWNED_APPROVED=FALSE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!result.inventoryMatches){
   for(const blocker of result.blockers) console.error('PR359_STAGING_OWNERSHIP_BLOCKER='+blocker);
   process.exitCode=2;
 }
}
