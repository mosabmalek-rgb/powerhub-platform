import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadPinnedProjectors,auditProjectorEvidence} from './cb-a-real-projectors-audit.mjs';
const base='scripts/pr359-canonical/fixtures/';
const args=process.argv.slice(2);
assert.ok(args.length===2&&args[0]==='--out');
const evidence=loadPinnedProjectors();
auditProjectorEvidence(evidence);
const candidate=readFileSync(base+'append-payload-candidate-disposable.sql','utf8');
const start='DO $candidate$';
const end='END $candidate$;';
assert.equal(candidate.split(start).length,2);
assert.equal(candidate.split(end).length,2);
const block=candidate.slice(candidate.indexOf(start),candidate.indexOf(end)+end.length);
assert.ok(block.includes('PR359_CANDIDATE_ARCHIVE_ANCHOR_DRIFT'));
assert.ok(block.includes('PR359_CANDIDATE_PAYLOAD_INVALID'));
let sql=readFileSync(base+'candidate-projector-integration-disposable.sql.in','utf8');
for(const [marker,value] of [
 ['-- PR359_PINNED_FULL_PROJECTORS',evidence.functions.map(f=>f.executable_ddl.trimEnd().replace(/;?$/,';')).join('\n')],
 ['-- PR359_SHARED_CANDIDATE_PREFLIGHT',block]
]){
 assert.equal(sql.split(marker).length,2);
 sql=sql.replace(marker,()=>value);
}
assert.ok(!/\\connect\b|\\copy\b|dblink|postgres(?:ql)?:\/\//i.test(sql));
writeFileSync(args[1],sql,{flag:'wx',mode:0o600});
